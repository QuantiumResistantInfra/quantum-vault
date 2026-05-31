//! End-to-end test: open a vault, spend from it with a Winternitz one-time
//! signature, and confirm the vault rotates to the next key. Runs the real BPF
//! program inside LiteSVM and reports the actual compute-unit cost of on-chain
//! WOTS verification.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use wots::SecretKey;

const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Locate the freshest compiled program, regardless of where the target dir lives.
fn program_so() -> std::path::PathBuf {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest.join("../../target/deploy/quantum_vault.so"),
        std::path::PathBuf::from(r"D:\cargo-target\deploy\quantum_vault.so"),
    ];
    candidates
        .iter()
        .filter(|p| p.exists())
        .max_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
        })
        .unwrap_or_else(|| panic!("quantum_vault.so not found; run `anchor build` first"))
        .clone()
}

/// Rebuild the exact bytes the program binds in a SOL spend signature:
/// `0x01 || genesis || amount_le || destination || next`.
fn spend_message(genesis: &[u8; 28], amount: u64, destination: &Pubkey, next: &[u8; 28]) -> Vec<u8> {
    let mut m = Vec::with_capacity(1 + 28 + 8 + 32 + 28);
    m.push(0x01);
    m.extend_from_slice(genesis);
    m.extend_from_slice(&amount.to_le_bytes());
    m.extend_from_slice(destination.as_ref());
    m.extend_from_slice(next);
    m
}

/// Rebuild the bytes bound by a token spend signature:
/// `0x02 || genesis || mint || amount_le || destination_token_account || next`.
fn spend_token_message(
    genesis: &[u8; 28],
    mint: &Pubkey,
    amount: u64,
    destination: &Pubkey,
    next: &[u8; 28],
) -> Vec<u8> {
    let mut m = Vec::with_capacity(1 + 28 + 32 + 8 + 32 + 28);
    m.push(0x02);
    m.extend_from_slice(genesis);
    m.extend_from_slice(mint.as_ref());
    m.extend_from_slice(&amount.to_le_bytes());
    m.extend_from_slice(destination.as_ref());
    m.extend_from_slice(next);
    m
}

fn vault_pda(genesis: &[u8; 28], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", genesis], program_id)
}

#[test]
fn open_spend_and_rotate() {
    let program_id = quantum_vault::ID;
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id, program_so())
        .expect("load program");

    // Whoever pays the network fee — note: NOT the spending authority.
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();

    // The vault's genesis one-time key (derived from a 32-byte backup seed).
    let sk0 = SecretKey::from_seed(&[1u8; 32]);
    let genesis: [u8; 28] = sk0.public_key().0;
    let (vault, _bump) = vault_pda(&genesis, &program_id);

    // --- open_vault: create + fund with 2 SOL ---
    let deposit = 2 * LAMPORTS_PER_SOL;
    let open_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::OpenVault {
            vault,
            funder: payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: quantum_vault::instruction::OpenVault {
            genesis_pubkey: genesis,
            deposit,
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[open_ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("open_vault should succeed");

    let vault_balance = svm.get_account(&vault).unwrap().lamports;
    assert!(vault_balance >= deposit, "vault should hold the deposit");

    // --- spend: withdraw 1 SOL to a fresh destination, rotate to next key ---
    let destination = Keypair::new().pubkey();
    let sk1 = SecretKey::from_seed(&[2u8; 32]);
    let next: [u8; 28] = sk1.public_key().0;
    let amount = 1 * LAMPORTS_PER_SOL;

    // Sign the spend with the vault's CURRENT (genesis) one-time key.
    let message = spend_message(&genesis, amount, &destination, &next);
    let signature = sk0.sign(&message).to_bytes().to_vec();
    assert_eq!(signature.len(), 840);

    let spend_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::Spend { vault, destination }.to_account_metas(None),
        data: quantum_vault::instruction::Spend {
            genesis_pubkey: genesis,
            amount,
            next_pubkey: next,
            signature,
        }
        .data(),
    };
    // WOTS verification is hash-heavy; raise the compute budget above the 200k default.
    let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let tx = Transaction::new_signed_with_payer(
        &[budget_ix, spend_ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    let meta = svm.send_transaction(tx).expect("spend should succeed");

    println!(
        "\n>>> on-chain WOTS verify + transfer cost: {} compute units\n",
        meta.compute_units_consumed
    );

    // Funds arrived.
    assert_eq!(
        svm.get_account(&destination).unwrap().lamports,
        amount,
        "destination should receive the withdrawal"
    );

    // Vault rotated to the next one-time key.
    let data = svm.get_account(&vault).unwrap().data;
    let state = quantum_vault::Vault::try_deserialize(&mut &data[..]).unwrap();
    assert_eq!(state.current_pubkey, next, "vault must rotate to next_pubkey");
}

#[test]
fn forged_signature_is_rejected() {
    let program_id = quantum_vault::ID;
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id, program_so()).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10 * LAMPORTS_PER_SOL).unwrap();

    let sk0 = SecretKey::from_seed(&[3u8; 32]);
    let genesis: [u8; 28] = sk0.public_key().0;
    let (vault, _) = vault_pda(&genesis, &program_id);

    let open_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::OpenVault {
            vault,
            funder: payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: quantum_vault::instruction::OpenVault {
            genesis_pubkey: genesis,
            deposit: 2 * LAMPORTS_PER_SOL,
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[open_ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).unwrap();

    // A signature from the WRONG key (an attacker who doesn't hold the seed).
    let attacker = SecretKey::from_seed(&[99u8; 32]);
    let destination = Keypair::new().pubkey();
    let next: [u8; 28] = SecretKey::from_seed(&[4u8; 32]).public_key().0;
    let amount = 1 * LAMPORTS_PER_SOL;
    let message = spend_message(&genesis, amount, &destination, &next);
    let bad_sig = attacker.sign(&message).to_bytes().to_vec();

    let spend_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::Spend { vault, destination }.to_account_metas(None),
        data: quantum_vault::instruction::Spend {
            genesis_pubkey: genesis,
            amount,
            next_pubkey: next,
            signature: bad_sig,
        }
        .data(),
    };
    let budget_ix = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let tx = Transaction::new_signed_with_payer(
        &[budget_ix, spend_ix],
        Some(&payer.pubkey()),
        &[&payer],
        svm.latest_blockhash(),
    );
    assert!(
        svm.send_transaction(tx).is_err(),
        "a forged signature must be rejected on-chain"
    );
}

// ---------------------------------------------------------------------------
// SPL-token vault tests
// ---------------------------------------------------------------------------

use anchor_spl::associated_token::{get_associated_token_address, spl_associated_token_account};
use anchor_spl::token::spl_token;
use anchor_spl::token::spl_token::solana_program::program_pack::Pack;
use anchor_spl::token::TokenAccount;
use solana_sdk::system_instruction;

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> litesvm::types::TransactionMetadata {
    let tx = Transaction::new_signed_with_payer(
        ixs,
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("transaction should succeed")
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, authority: &Pubkey, decimals: u8) -> Pubkey {
    let mint = Keypair::new();
    let len = spl_token::state::Mint::LEN;
    let rent = solana_sdk::rent::Rent::default().minimum_balance(len);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        len as u64,
        &spl_token::ID,
    );
    let init =
        spl_token::instruction::initialize_mint2(&spl_token::ID, &mint.pubkey(), authority, None, decimals)
            .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[create, init],
        Some(&payer.pubkey()),
        &[payer, &mint],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("create mint");
    mint.pubkey()
}

fn create_ata(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ix = spl_associated_token_account::instruction::create_associated_token_account(
        &payer.pubkey(),
        owner,
        mint,
        &spl_token::ID,
    );
    send(svm, payer, &[ix]);
    get_associated_token_address(owner, mint)
}

fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, dest: &Pubkey, authority: &Keypair, amount: u64) {
    let ix = spl_token::instruction::mint_to(
        &spl_token::ID,
        mint,
        dest,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer, authority],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("mint_to");
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let acc = svm.get_account(ata).expect("token account exists");
    TokenAccount::try_deserialize(&mut &acc.data[..]).expect("unpack token account").amount
}

#[test]
fn token_vault_deposit_spend_and_rotate() {
    let program_id = quantum_vault::ID;
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id, program_so()).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * LAMPORTS_PER_SOL).unwrap();

    // A 6-decimal mint; depositor starts with 1000 tokens.
    let decimals = 6u8;
    let mint = create_mint(&mut svm, &payer, &payer.pubkey(), decimals);
    let depositor_ata = create_ata(&mut svm, &payer, &payer.pubkey(), &mint);
    mint_to(&mut svm, &payer, &mint, &depositor_ata, &payer, 1_000_000_000);

    // Vault identity (genesis one-time key).
    let sk0 = SecretKey::from_seed(&[10u8; 32]);
    let genesis: [u8; 28] = sk0.public_key().0;
    let (vault, _) = vault_pda(&genesis, &program_id);

    // open_vault: just the state account (no extra lamports).
    let open_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::OpenVault {
            vault,
            funder: payer.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: quantum_vault::instruction::OpenVault {
            genesis_pubkey: genesis,
            deposit: 0,
        }
        .data(),
    };
    send(&mut svm, &payer, &[open_ix]);

    // deposit_token: 600 tokens into the vault's associated token account.
    let vault_ata = get_associated_token_address(&vault, &mint);
    let deposit_amount = 600_000_000u64;
    let dep_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::DepositToken {
            vault,
            mint,
            vault_token_account: vault_ata,
            depositor: payer.pubkey(),
            depositor_token_account: depositor_ata,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: quantum_vault::instruction::DepositToken {
            genesis_pubkey: genesis,
            amount: deposit_amount,
        }
        .data(),
    };
    send(&mut svm, &payer, &[dep_ix]);
    assert_eq!(token_balance(&svm, &vault_ata), deposit_amount, "vault should hold deposit");

    // spend_token: withdraw 250 tokens to a fresh recipient, signed by the
    // vault's current one-time key, and rotate.
    let recipient = Keypair::new().pubkey();
    let recipient_ata = create_ata(&mut svm, &payer, &recipient, &mint);
    let sk1 = SecretKey::from_seed(&[11u8; 32]);
    let next: [u8; 28] = sk1.public_key().0;
    let amount = 250_000_000u64;

    let message = spend_token_message(&genesis, &mint, amount, &recipient_ata, &next);
    let signature = sk0.sign(&message).to_bytes().to_vec();

    let spend_ix = Instruction {
        program_id,
        accounts: quantum_vault::accounts::SpendToken {
            vault,
            mint,
            vault_token_account: vault_ata,
            destination_token_account: recipient_ata,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: quantum_vault::instruction::SpendToken {
            genesis_pubkey: genesis,
            amount,
            next_pubkey: next,
            signature,
        }
        .data(),
    };
    let budget = ComputeBudgetInstruction::set_compute_unit_limit(1_400_000);
    let meta = send(&mut svm, &payer, &[budget, spend_ix]);
    println!(
        "\n>>> on-chain token spend (WOTS verify + SPL transfer): {} compute units\n",
        meta.compute_units_consumed
    );

    assert_eq!(token_balance(&svm, &recipient_ata), amount, "recipient receives tokens");
    assert_eq!(
        token_balance(&svm, &vault_ata),
        deposit_amount - amount,
        "vault balance decreases by amount"
    );

    let data = svm.get_account(&vault).unwrap().data;
    let state = quantum_vault::Vault::try_deserialize(&mut &data[..]).unwrap();
    assert_eq!(state.current_pubkey, next, "vault rotates to next key");
}
