// Vault wallet: manages the sequence of one-time WOTS keys from one recovery
// phrase, and the high-level open / deposit / withdraw flows.
//
// Because each WOTS key signs only once, a vault is really a *chain* of keys:
// seed_k = keccak(master || k). The genesis (vault address) is key 0; after k
// spends the on-chain `current_pubkey` is key k. To spend we read that pubkey,
// find which index it is, sign with that key, and commit key k+1.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import { generateMnemonic, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { publicKey, secretKeyFromSeed, sign, SIGNATURE_BYTES } from "./wots";
import {
  initSigBufferIx,
  openVaultIx,
  sigbufPda,
  spendSolIx,
  spendSolMessage,
  vaultPda,
  writeSigBufferIx,
} from "./program";

const MAX_SCAN = 10_000; // how many spends back we can recover by scanning

export class VaultWallet {
  readonly master: Uint8Array;
  readonly genesis: Uint8Array;

  constructor(master: Uint8Array) {
    if (master.length !== 32) throw new Error("master must be 32 bytes");
    this.master = master;
    this.genesis = this.pubkeyAt(0);
  }

  static random(): VaultWallet {
    return VaultWallet.fromMnemonic(generateMnemonic(wordlist, 256));
  }

  static fromMnemonic(mnemonic: string): VaultWallet {
    if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid recovery phrase");
    return new VaultWallet(mnemonicToEntropy(mnemonic, wordlist));
  }

  get mnemonic(): string {
    return entropyToMnemonic(this.master, wordlist);
  }

  get address(): PublicKey {
    return vaultPda(this.genesis);
  }

  /** Deterministic 32-byte seed for one-time key #k. */
  private seedAt(k: number): Uint8Array {
    const buf = new Uint8Array(36);
    buf.set(this.master, 0);
    new DataView(buf.buffer).setUint32(32, k, true);
    return keccak_256(buf); // full 32 bytes
  }

  pubkeyAt(k: number): Uint8Array {
    return publicKey(secretKeyFromSeed(this.seedAt(k)));
  }

  signAt(k: number, message: Uint8Array): Uint8Array {
    return sign(secretKeyFromSeed(this.seedAt(k)), message);
  }

  /** Find which key index the on-chain `current_pubkey` corresponds to. */
  findIndex(currentPubkey: Uint8Array): number {
    for (let k = 0; k < MAX_SCAN; k++) {
      if (eq(this.pubkeyAt(k), currentPubkey)) return k;
    }
    throw new Error("could not match on-chain key — wrong recovery phrase?");
  }
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function send(
  conn: Connection,
  feePayer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, [feePayer], { commitment: "confirmed" });
}

/** Read the vault's current one-time public key (28 bytes), or null if not opened. */
export async function readCurrentPubkey(
  conn: Connection,
  wallet: VaultWallet,
): Promise<Uint8Array | null> {
  const info = await conn.getAccountInfo(wallet.address, "confirmed");
  if (!info) return null;
  return Uint8Array.from(info.data.slice(1, 29));
}

export async function openVault(
  conn: Connection,
  feePayer: Keypair,
  wallet: VaultWallet,
  depositLamports: bigint,
): Promise<string> {
  return send(conn, feePayer, [openVaultIx(feePayer.publicKey, wallet.genesis, depositLamports)]);
}

/** Deposit SOL by a plain transfer to the vault address (no program ix needed). */
export async function depositSol(
  conn: Connection,
  feePayer: Keypair,
  vault: PublicKey,
  lamports: bigint,
): Promise<string> {
  return send(conn, feePayer, [
    SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: vault, lamports }),
  ]);
}

export interface WithdrawProgress {
  step: string;
  signature?: string;
}

/** Full SOL withdrawal: sign, upload signature to a buffer, spend, rotate. */
export async function withdrawSol(
  conn: Connection,
  feePayer: Keypair,
  wallet: VaultWallet,
  amount: bigint,
  destination: PublicKey,
  onProgress?: (p: WithdrawProgress) => void,
): Promise<void> {
  const current = await readCurrentPubkey(conn, wallet);
  if (!current) throw new Error("vault not opened yet");
  const k = wallet.findIndex(current);
  const next = wallet.pubkeyAt(k + 1);

  const message = spendSolMessage(wallet.genesis, amount, destination, next);
  const sig = wallet.signAt(k, message);
  if (sig.length !== SIGNATURE_BYTES) throw new Error("bad signature length");

  onProgress?.({ step: "Creating signature buffer" });
  let s = await send(conn, feePayer, [initSigBufferIx(feePayer.publicKey, wallet.genesis)]);
  onProgress?.({ step: "Signature buffer created", signature: s });

  const CHUNK = 900;
  for (let offset = 0; offset < sig.length; offset += CHUNK) {
    const chunk = sig.slice(offset, Math.min(offset + CHUNK, sig.length));
    onProgress?.({ step: `Uploading signature (${offset}/${sig.length})` });
    s = await send(conn, feePayer, [writeSigBufferIx(wallet.genesis, offset, chunk)]);
  }

  onProgress?.({ step: "Spending + rotating key" });
  s = await send(conn, feePayer, [
    spendSolIx(wallet.address, wallet.genesis, amount, next, destination, feePayer.publicKey),
  ]);
  onProgress?.({ step: "Done", signature: s });
}

export { sigbufPda };
