# quantum-vault

A quantum-resistant vault for Solana, built from scratch as a learning project.

Solana accounts are secured by Ed25519 — an elliptic-curve scheme that a
sufficiently capable quantum computer breaks with Shor's algorithm. This project
builds a vault whose withdrawals are instead authorized by a **hash-based
signature** (Winternitz OTS), which has no curve for Shor to attack and only
needs cheap hashing to verify on-chain.

## Status

| Phase | What | State |
|-------|------|-------|
| 1 | `wots` — Winternitz one-time signature core library | ✅ done, tested |
| 2 | `quantum-vault` — Solana program (PDA vault + key rotation) | ✅ done, builds to BPF |
| 3 | `harness` — end-to-end LiteSVM tests | ✅ done, passing |

**Proven working:** the end-to-end test opens a vault, spends from it with a
Winternitz signature, and confirms the vault rotates to the next one-time key —
running the real compiled BPF program. On-chain WOTS verification + transfer
costs **~530k compute units** (over the 200k default, so a `ComputeBudget`
instruction is required; well under the 1.4M max).

```bash
cargo test -p harness -- --nocapture   # see the compute-unit readout
```

## Phase 1: the WOTS core (`crates/wots`)

Pure-Rust Winternitz One-Time Signatures over Keccak-256 truncated to 224 bits,
sized to fit a Solana transaction (840-byte signature, 28-byte public key).
The 224-bit choice is deliberate: a 256-bit scheme's 1088-byte signature would
overflow Solana's 1232-byte transaction limit once wrapped in an instruction.

```bash
cargo test -p wots                 # run the test suite
cargo run -p wots --example demo   # see the full lifecycle
```

### Key facts

- **Quantum-resistant:** security rests only on hash preimage resistance. Grover
  (the best quantum attack) merely halves it, so Keccak-256 keeps ~128-bit
  post-quantum security.
- **One-time use:** a keypair may sign exactly one message. Signing twice leaks
  the key. The Phase-2 vault handles this by committing the *next* public key on
  every spend and closing the old vault (the "vault pattern").
- **Compressed public key:** the 34 hash-chain tops are hashed together into a
  single 32-byte on-chain commitment.
- **Checksum:** prevents the classic forgery where an attacker only raises
  message digits — doing so forces a checksum digit down, which needs a hash
  inversion.

## Background

See the research notes that motivated the design choices (Falcon vs. WOTS,
why the PDA layer, the protocol roadmap) — hash-based WOTS is the only family
that runs cheaply on Solana *today* without waiting on unshipped protocol
proposals (SIMD-0461 Falcon precompile, SIMD-0296 larger transactions).

> ⚠️ Educational. Unaudited. Do not guard real funds with this.
