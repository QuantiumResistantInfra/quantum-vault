# quantum-vault

Post-quantum secure vaults for Solana.

Solana accounts are secured by Ed25519 — an elliptic-curve scheme that a
sufficiently capable quantum computer breaks with Shor's algorithm. quantum-vault
authorizes every withdrawal with a **hash-based Winternitz one-time signature**
instead: there is no elliptic curve for Shor to attack, and verification is cheap
enough to run on-chain with Keccak hashing.

A single vault identity guards both **SOL and arbitrary SPL tokens** (USDC, etc.)
under the same quantum-resistant key.

## Status

| Component | What | State |
|-----------|------|-------|
| `wots` | Winternitz one-time signature core library | ✅ done, tested |
| `quantum-vault` | Solana program (PDA vault, SOL + SPL tokens, key rotation) | ✅ done, builds to BPF |
| `harness` | end-to-end LiteSVM tests (SOL + token + forgery) | ✅ done, passing |

**Proven working:** the end-to-end tests open a vault, spend SOL *and* SPL
tokens from it with Winternitz signatures, and confirm the vault rotates to the
next one-time key — running the real compiled BPF program. On-chain cost is
**~505–565k compute units** per spend (over the 200k default, so a
`ComputeBudget` instruction is required; well under the 1.4M max).

```bash
cargo test -p harness -- --nocapture   # see the compute-unit readout
```

## The WOTS core (`crates/wots`)

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
  (the best quantum attack) merely square-roots it, so 224-bit Keccak keeps
  ~112-bit post-quantum security.
- **One-time use:** a keypair may sign exactly one message. Signing twice leaks
  the key. The vault handles this by committing the *next* public key on every
  spend and rotating to it (the "vault pattern").
- **Compressed public key:** the 30 hash-chain tops are hashed together into a
  single 28-byte on-chain commitment.
- **Checksum:** prevents the classic forgery where an attacker only raises
  message digits — doing so forces a checksum digit down, which needs a hash
  inversion.

## How the vault works

Funds live in a PDA whose address is bound to an immutable genesis WOTS public
key, so the deposit address never changes. A withdrawal presents a Winternitz
signature over the spend (domain-tagged, binding amount, destination, and the
next key); the program verifies it against the vault's current key, moves the
funds, and rotates `current_pubkey` to `next_pubkey` — retiring the spent
one-time key forever. Authorization is purely cryptographic: any relayer can
submit the transaction and pay the fee; only a valid WOTS signature moves funds.

The same vault PDA owns its SPL associated token accounts and signs token
transfers via `invoke_signed`, so one quantum-resistant key guards SOL and any
number of token mints.

### Instructions

- `open_vault(genesis_pubkey, deposit)` — create + fund a vault
- `spend(genesis_pubkey, amount, next_pubkey, signature)` — withdraw SOL, rotate
- `deposit_token(genesis_pubkey, amount)` — deposit SPL tokens (permissionless)
- `spend_token(genesis_pubkey, amount, next_pubkey, signature)` — withdraw SPL tokens, rotate

## Background

Hash-based WOTS is the only post-quantum signature family that runs cheaply on
Solana today, without waiting on unshipped protocol proposals (SIMD-0461 Falcon
precompile, SIMD-0296 larger transactions). See the design notes for the full
rationale (Falcon vs. WOTS, why the PDA layer, the protocol roadmap).

## Roadmap

- ✅ SPL-token vaults
- Native/Pinocchio port to lower the per-spend compute cost
- TypeScript client + devnet deployment
- Security audit
