//! Quantum-resistant vault for Solana.
//!
//! Funds live in a PDA whose withdrawals are authorized not by an Ed25519 key
//! (which Shor's algorithm would break) but by a **Winternitz one-time
//! signature** verified on-chain with cheap Keccak hashing.
//!
//! ## The vault pattern (how the one-time constraint is handled)
//!
//! A WOTS key may sign only once. So every `spend` carries the *next* public key
//! and the signature commits to it. On success the vault rotates `current_pubkey`
//! to that next key — the spent key is retired forever and can never be reused.
//! The vault's address (derived from the immutable `genesis_pubkey`) never
//! changes, so deposits always go to the same place.
//!
//! Authorization is purely cryptographic: the Solana transaction can be sent by
//! anyone (a relayer pays the fee); only a valid WOTS signature moves funds.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

/// WOTS signature size on the wire (30 chains * 28 bytes = 840).
const SIG_LEN: usize = wots::SIGNATURE_BYTES;

/// Domain-separation tags so a signature for one action type can never be
/// replayed as another (e.g. a SOL spend reused as a token spend).
const DOMAIN_SPEND_SOL: u8 = 0x01;
const DOMAIN_SPEND_TOKEN: u8 = 0x02;

#[program]
pub mod quantum_vault {
    use super::*;

    /// Create a vault bound to `genesis_pubkey` and fund it with `deposit` lamports.
    pub fn open_vault(
        ctx: Context<OpenVault>,
        genesis_pubkey: [u8; 28],
        deposit: u64,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.current_pubkey = genesis_pubkey;
        vault.bump = ctx.bumps.vault;

        // Top up the vault PDA beyond its rent-exempt minimum.
        if deposit > 0 {
            let ix = system_instruction::transfer(
                &ctx.accounts.funder.key(),
                &vault.key(),
                deposit,
            );
            anchor_lang::solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.funder.to_account_info(),
                    vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        Ok(())
    }

    /// Withdraw `amount` lamports to `destination`, authorized by a WOTS
    /// signature over the spend, then rotate the vault to `next_pubkey`.
    pub fn spend(
        ctx: Context<Spend>,
        genesis_pubkey: [u8; 28],
        amount: u64,
        next_pubkey: [u8; 28],
        signature: Vec<u8>,
    ) -> Result<()> {
        require!(signature.len() == SIG_LEN, VaultError::BadSignatureLength);

        let vault = &mut ctx.accounts.vault;
        let destination = &ctx.accounts.destination;

        // Rebuild the exact bytes the owner signed off-chain. Binding all of
        // these makes the signature un-redirectable and vault-specific.
        let message = spend_message(&genesis_pubkey, amount, &destination.key(), &next_pubkey);

        // Verify against the vault's CURRENT one-time public key.
        let mut sig_bytes = [0u8; SIG_LEN];
        sig_bytes.copy_from_slice(&signature);
        let sig = wots::Signature::from_bytes(&sig_bytes);
        let pk = wots::PublicKey(vault.current_pubkey);
        require!(pk.verify(&message, &sig), VaultError::InvalidSignature);

        // Move lamports out of the program-owned vault, keeping it rent-exempt.
        let vault_ai = vault.to_account_info();
        let rent_min = Rent::get()?.minimum_balance(vault_ai.data_len());
        let available = vault_ai.lamports().saturating_sub(rent_min);
        require!(amount <= available, VaultError::InsufficientFunds);

        **vault_ai.try_borrow_mut_lamports()? -= amount;
        **destination.to_account_info().try_borrow_mut_lamports()? += amount;

        // Rotate: the spent key is now dead; the next one controls the vault.
        vault.current_pubkey = next_pubkey;
        Ok(())
    }

    /// Deposit SPL tokens into the vault's token account. Permissionless: anyone
    /// may add funds. Creates the vault's associated token account on first use.
    pub fn deposit_token(
        ctx: Context<DepositToken>,
        genesis_pubkey: [u8; 28],
        amount: u64,
    ) -> Result<()> {
        // `genesis_pubkey` is consumed by the #[instruction(..)] seeds check on
        // the accounts struct; nothing further to do with it in the body.
        let _ = genesis_pubkey;
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        );
        token::transfer(cpi, amount)?;
        Ok(())
    }

    /// Withdraw `amount` SPL tokens to `destination_token_account`, authorized by
    /// a WOTS signature, then rotate the vault to `next_pubkey`. The vault PDA
    /// signs the token transfer as the token account's owner.
    pub fn spend_token(
        ctx: Context<SpendToken>,
        genesis_pubkey: [u8; 28],
        amount: u64,
        next_pubkey: [u8; 28],
        signature: Vec<u8>,
    ) -> Result<()> {
        require!(signature.len() == SIG_LEN, VaultError::BadSignatureLength);

        // Rebuild and verify the signed message against the vault's current key.
        let message = spend_token_message(
            &genesis_pubkey,
            &ctx.accounts.mint.key(),
            amount,
            &ctx.accounts.destination_token_account.key(),
            &next_pubkey,
        );
        let mut sig_bytes = [0u8; SIG_LEN];
        sig_bytes.copy_from_slice(&signature);
        let sig = wots::Signature::from_bytes(&sig_bytes);
        let pk = wots::PublicKey(ctx.accounts.vault.current_pubkey);
        require!(pk.verify(&message, &sig), VaultError::InvalidSignature);

        // Transfer tokens out, signed by the vault PDA as token-account owner.
        let bump = ctx.accounts.vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", genesis_pubkey.as_ref(), &[bump]]];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi, amount)?;

        // Rotate to the next one-time key.
        ctx.accounts.vault.current_pubkey = next_pubkey;
        Ok(())
    }
}

/// Canonical message bound by a SOL spend signature.
/// `0x01 || genesis || amount_le || destination || next_pubkey`.
fn spend_message(
    genesis: &[u8; 28],
    amount: u64,
    destination: &Pubkey,
    next: &[u8; 28],
) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 28 + 8 + 32 + 28);
    data.push(DOMAIN_SPEND_SOL);
    data.extend_from_slice(genesis);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(destination.as_ref());
    data.extend_from_slice(next);
    data
}

/// Canonical message bound by a token spend signature.
/// `0x02 || genesis || mint || amount_le || destination_token_account || next_pubkey`.
fn spend_token_message(
    genesis: &[u8; 28],
    mint: &Pubkey,
    amount: u64,
    destination: &Pubkey,
    next: &[u8; 28],
) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 28 + 32 + 8 + 32 + 28);
    data.push(DOMAIN_SPEND_TOKEN);
    data.extend_from_slice(genesis);
    data.extend_from_slice(mint.as_ref());
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(destination.as_ref());
    data.extend_from_slice(next);
    data
}

#[account]
pub struct Vault {
    /// The currently-authorized WOTS public key (224-bit). Rotates every spend.
    pub current_pubkey: [u8; 28],
    pub bump: u8,
}

impl Vault {
    /// 8-byte discriminator + 28-byte pubkey + 1-byte bump.
    const LEN: usize = 8 + 28 + 1;
}

#[derive(Accounts)]
#[instruction(genesis_pubkey: [u8; 28])]
pub struct OpenVault<'info> {
    #[account(
        init,
        payer = funder,
        space = Vault::LEN,
        seeds = [b"vault", genesis_pubkey.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(genesis_pubkey: [u8; 28])]
pub struct Spend<'info> {
    #[account(
        mut,
        seeds = [b"vault", genesis_pubkey.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: a plain lamport recipient; it only ever receives funds.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(genesis_pubkey: [u8; 28])]
pub struct DepositToken<'info> {
    #[account(
        seeds = [b"vault", genesis_pubkey.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    /// The vault's associated token account, created on first deposit.
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        constraint = depositor_token_account.mint == mint.key() @ VaultError::MintMismatch,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(genesis_pubkey: [u8; 28])]
pub struct SpendToken<'info> {
    #[account(
        mut,
        seeds = [b"vault", genesis_pubkey.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = destination_token_account.mint == mint.key() @ VaultError::MintMismatch,
    )]
    pub destination_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum VaultError {
    #[msg("signature must be exactly 840 bytes")]
    BadSignatureLength,
    #[msg("WOTS signature verification failed")]
    InvalidSignature,
    #[msg("insufficient unlocked funds in vault")]
    InsufficientFunds,
    #[msg("token account mint does not match")]
    MintMismatch,
}
