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
| 2 | `quantum-vault` — Solana program (PDA vault + key rotation) | ⏳ next |
| 3 | Client + integration tests on a local validator | ⏳ planned |

## Phase 1: the WOTS core (`crates/wots`)

Pure-Rust Winternitz One-Time Signatures over Keccak-256, sized to fit a Solana
transaction (1088-byte signature, 32-byte public key).

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
