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

/// Locate the compiled program, regardless of where the target dir lives.
fn program_so() -> std::path::PathBuf {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest.join("../../target/deploy/quantum_vault.so"),
        std::path::PathBuf::from(r"D:\cargo-target\deploy\quantum_vault.so"),
    ];
    candidates
        .iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| panic!("quantum_vault.so not found; run `anchor build` first"))
        .clone()
}

/// Rebuild the exact bytes the program binds in a spend signature:
/// `genesis || amount_le || destination || next`.
fn spend_message(genesis: &[u8; 28], amount: u64, destination: &Pubkey, next: &[u8; 28]) -> Vec<u8> {
    let mut m = Vec::with_capacity(28 + 8 + 32 + 28);
    m.extend_from_slice(genesis);
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
