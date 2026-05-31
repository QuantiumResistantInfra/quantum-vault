// On-chain program interface: PDAs, instruction encoding, and the messages the
// WOTS signature binds. Mirrors the native Rust program byte-for-byte.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// The program id is the same on every cluster (same program keypair), so this
// does not change for mainnet.
export const PROGRAM_ID = new PublicKey(
  "34CJhzSBAptiSadvHZK4A1PhpcfdsbguyRXqnUQPpCiD",
);

export type Cluster = "devnet" | "mainnet-beta";

// ──────────────────────────────────────────────────────────────────────────
//  MAINNET CUTOVER: flip this one constant to "mainnet-beta" and set a real RPC
//  (VITE_RPC_URL). Everything else — buttons, explorer links, RPC — follows.
// ──────────────────────────────────────────────────────────────────────────
export const NETWORK: Cluster = "devnet";
export const IS_DEVNET = NETWORK === "devnet";

const PUBLIC_RPC: Record<Cluster, string> = {
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

/** Read an optional custom RPC from Vite env (undefined under Node). */
function envRpcUrl(): string | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_RPC_URL;
  } catch {
    return undefined;
  }
}

/** App RPC. On mainnet set VITE_RPC_URL to a paid endpoint — the public
 *  mainnet RPC is heavily rate-limited. */
export const RPC_URL: string = envRpcUrl() || PUBLIC_RPC[NETWORK];

/** Devnet test scripts (verify-*.ts) always target devnet regardless of NETWORK. */
export const DEVNET_RPC = PUBLIC_RPC.devnet;

/** Explorer link honoring the active cluster. */
export function explorerUrl(address: string): string {
  const suffix = NETWORK === "mainnet-beta" ? "" : `?cluster=${NETWORK}`;
  return `https://explorer.solana.com/address/${address}${suffix}`;
}

const VAULT_SEED = new TextEncoder().encode("vault");
const SIGBUF_SEED = new TextEncoder().encode("sigbuf");

const DOMAIN_SPEND_SOL = 0x01;
const DOMAIN_SPEND_TOKEN = 0x02;

export function vaultPda(genesis: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, genesis], PROGRAM_ID)[0];
}

export function sigbufPda(genesis: Uint8Array, payer: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([SIGBUF_SEED, genesis, payer.toBytes()], PROGRAM_ID)[0];
}

// --- little-endian encoders --------------------------------------------------

function u16le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}
function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// --- instruction data (Borsh enum: 1-byte variant index + fields) ------------

function ixData(variant: number, ...fields: Uint8Array[]): Buffer {
  return Buffer.from(concat([Uint8Array.of(variant), ...fields]));
}

export function openVaultIx(
  payer: PublicKey,
  genesis: Uint8Array,
  pubSeed: Uint8Array,
  deposit: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vaultPda(genesis), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData(0, genesis, pubSeed, u64le(deposit)),
  });
}

export function initSigBufferIx(payer: PublicKey, genesis: Uint8Array): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: sigbufPda(genesis, payer), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData(1, genesis),
  });
}

export function writeSigBufferIx(
  payer: PublicKey,
  genesis: Uint8Array,
  offset: number,
  chunk: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: sigbufPda(genesis, payer), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    // Vec<u8> is borsh-encoded as u32 length prefix + bytes.
    data: ixData(2, u16le(offset), u32le(chunk.length), chunk),
  });
}

export function spendSolIx(
  vault: PublicKey,
  genesis: Uint8Array,
  amount: bigint,
  next: Uint8Array,
  destination: PublicKey,
  payer: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sigbufPda(genesis, payer), isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true }, // rent refund
    ],
    data: ixData(3, genesis, u64le(amount), next),
  });
}

export function spendTokenIx(
  vault: PublicKey,
  genesis: Uint8Array,
  amount: bigint,
  next: Uint8Array,
  mint: PublicKey,
  vaultToken: PublicKey,
  destinationToken: PublicKey,
  payer: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sigbufPda(genesis, payer), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: destinationToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: false, isWritable: true }, // rent refund
    ],
    data: ixData(4, genesis, u64le(amount), next),
  });
}

// --- signed messages (must match the program exactly) ------------------------

export function spendSolMessage(
  genesis: Uint8Array,
  amount: bigint,
  destination: PublicKey,
  next: Uint8Array,
): Uint8Array {
  return concat([
    Uint8Array.of(DOMAIN_SPEND_SOL),
    genesis,
    u64le(amount),
    destination.toBytes(),
    next,
  ]);
}

export function spendTokenMessage(
  genesis: Uint8Array,
  mint: PublicKey,
  amount: bigint,
  destination: PublicKey,
  next: Uint8Array,
): Uint8Array {
  return concat([
    Uint8Array.of(DOMAIN_SPEND_TOKEN),
    genesis,
    mint.toBytes(),
    u64le(amount),
    destination.toBytes(),
    next,
  ]);
}
