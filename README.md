# quantum-vault

Post-quantum secure vaults for Solana.

> **Live on devnet:** [`34CJhzSBAptiSadvHZK4A1PhpcfdsbguyRXqnUQPpCiD`](https://explorer.solana.com/address/34CJhzSBAptiSadvHZK4A1PhpcfdsbguyRXqnUQPpCiD?cluster=devnet)

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
| `quantum-vault` | Native Solana program (PDA vault, SOL + SPL, key rotation) | ✅ done, builds to BPF |
| `harness` | end-to-end LiteSVM tests (SOL + token + forgery) | ✅ done, passing |
| `app` | TypeScript SDK + React web UI (devnet) | ✅ done, verified live |

**Proven working:** the end-to-end tests open a vault, spend SOL *and* SPL tokens
from it with Winternitz signatures, and confirm the vault rotates to the next
one-time key — running the real compiled BPF program. A spend costs **~72–75k
compute units**, comfortably under the 200k default (no `ComputeBudget`
instruction needed).

```bash
cargo build-sbf --manifest-path programs/quantum-vault/Cargo.toml   # build BPF
cargo test -p harness -- --nocapture                                # run e2e + see CU
```

## The WOTS core (`crates/wots`)

Pure-Rust Winternitz One-Time Signatures over Keccak-256 truncated to 224 bits,
with Winternitz parameter `W=16`. `W` is the performance knob: on-chain
verification walks each chain up to `W-1` times, so a small `W` means far fewer
Keccak hashes — the dominant on-chain cost. Dropping from base-256 to `W=16` cut
a spend from ~565k to ~72k compute units (~8×). The trade-off is a larger
1652-byte signature that no longer fits one transaction (see the buffer flow
below).

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
- **Compressed public key:** the 59 hash-chain tops are hashed together into a
  single 28-byte on-chain commitment.
- **Checksum:** prevents the classic forgery where an attacker only raises
  message digits — doing so forces a checksum digit down, which needs a hash
  inversion.

## How the vault works

Funds live in a PDA whose address is bound to an immutable genesis WOTS public
key, so the deposit address never changes. The same vault PDA also owns its SPL
token accounts and signs token transfers via `invoke_signed`, so one
quantum-resistant key guards SOL and any number of token mints.

A withdrawal is a short sequence, because the 1652-byte signature exceeds
Solana's 1232-byte transaction limit:

1. `init_sig_buffer` — create a signature-buffer PDA for the spend.
2. `write_sig_buffer` ×N — upload the signature in transaction-sized chunks.
3. `spend_sol` / `spend_token` — verify the buffered signature against the
   vault's current key (over a domain-tagged message binding amount, destination,
   and the next key), move the funds, rotate `current_pubkey` to `next_pubkey`,
   and close the buffer (rent refunded).

Authorization is purely cryptographic: any relayer can submit these transactions
and pay the fees; only a valid WOTS signature moves funds. **Deposits need no
program instruction** — sending SOL or SPL tokens to the vault's address / token
account is an ordinary transfer.

### Instructions

- `OpenVault { genesis_pubkey, deposit }` — create + fund a vault
- `InitSigBuffer { genesis_pubkey }` — open a signature buffer
- `WriteSigBuffer { offset, chunk }` — upload signature bytes
- `SpendSol { genesis_pubkey, amount, next_pubkey }` — withdraw SOL, rotate
- `SpendToken { genesis_pubkey, amount, next_pubkey }` — withdraw SPL tokens, rotate

## Deployment

Deployed and verified on **devnet** at
`34CJhzSBAptiSadvHZK4A1PhpcfdsbguyRXqnUQPpCiD`.

```bash
# build + deploy
cargo build-sbf --manifest-path programs/quantum-vault/Cargo.toml
solana program deploy target/deploy/quantum_vault.so \
  --program-id <program-keypair.json> --url devnet

# live smoke test: open a vault, buffer a signature, spend, verify rotation
cargo run -p harness --example devnet_smoke
```

## Web app (`app/`)

A React UI + TypeScript SDK for using a vault from the browser on devnet. The SDK
ports WOTS **signing** to TypeScript (byte-for-byte compatible with the on-chain
Rust verifier) and builds the full open → buffer → spend → rotate flow for both
**SOL and SPL tokens**. A burner keypair relays the (multi-tx) flow popup-free;
**Phantom** can be connected to fund the burner in one approval. The vault's
authority is a 24-word recovery phrase (a chain of one-time keys derived from it),
shown blurred behind a click-to-reveal. Verified end-to-end against the live
devnet program — SOL and token signatures generated in the browser verify
on-chain, funds move, and the one-time key rotates.

```bash
cd app
npm install
npm run verify-devnet            # prove the SOL flow against the live program
npx tsx src/sdk/verify-token.ts  # prove the SPL-token flow
npm run dev                      # launch the web UI
```

### Switching networks

The app is network-driven by one constant, `NETWORK`, in
[`app/src/sdk/program.ts`](app/src/sdk/program.ts). Set it to `"mainnet-beta"`
and the RPC, the airdrop/test-token buttons, and the explorer links all follow.
For mainnet, set `VITE_RPC_URL` (see `app/.env.example`) to a paid RPC — the
public mainnet endpoint is rate-limited. The program id is the same on every
cluster, so it doesn't change.

## Background

Hash-based WOTS is the only post-quantum signature family that runs cheaply on
Solana today, without waiting on unshipped protocol proposals (SIMD-0461 Falcon
precompile, SIMD-0296 larger transactions). See the design notes for the full
rationale (Falcon vs. WOTS, why the PDA layer, the protocol roadmap).

## Roadmap

- ✅ SPL-token vaults
- ✅ Native program + `W=16` tuning (8× lower compute) with signature buffer
- ✅ Devnet deployment + live smoke test
- ✅ TypeScript SDK + React web UI (WOTS signing in TS), verified on devnet
