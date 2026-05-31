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
import { bytesToHex } from "@noble/hashes/utils";
import { generateMnemonic, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { publicKey, publicSeed, secretKeyFromSeed, sign, SIGNATURE_BYTES } from "./wots";
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

// --- one-time-key guard (F5) ------------------------------------------------
// A WOTS key MUST sign exactly one message; signing a second, different message
// with the same key leaks it. This refuses to do so. Re-signing the *same*
// message (e.g. re-submitting a stuck withdrawal) is allowed. Backed by
// localStorage in the browser (so it holds across tabs) and an in-memory map in
// Node. NOTE: this does not protect against two fully independent processes that
// share neither — never drive one vault from two uncoordinated signers.
const memGuard = new Map<string, string>();

function guardRead(slot: string): string | null {
  if (typeof localStorage !== "undefined") return localStorage.getItem(slot);
  return memGuard.get(slot) ?? null;
}
function guardWrite(slot: string, value: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(slot, value);
  else memGuard.set(slot, value);
}

/** Throw unless key `index` is being signed over the same message as before. */
export function assertSignOnce(vaultAddress: string, index: number, message: Uint8Array): void {
  const slot = `qv_signed_${vaultAddress}_${index}`;
  const messageHash = bytesToHex(keccak_256(message));
  const prev = guardRead(slot);
  if (prev !== null && prev !== messageHash) {
    throw new Error(
      `Refusing to sign one-time key #${index} a second time over a different ` +
        `spend — that would leak the key. Let the pending withdrawal confirm ` +
        `first, or re-submit the identical one.`,
    );
  }
  guardWrite(slot, messageHash);
}

export class VaultWallet {
  readonly master: Uint8Array;
  readonly pubSeed: Uint8Array;
  readonly genesis: Uint8Array;

  constructor(master: Uint8Array) {
    if (master.length !== 32) throw new Error("master must be 32 bytes");
    this.master = master;
    this.pubSeed = publicSeed(master);
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
    return publicKey(secretKeyFromSeed(this.seedAt(k)), this.pubSeed);
  }

  signAt(k: number, message: Uint8Array): Uint8Array {
    return sign(secretKeyFromSeed(this.seedAt(k)), message, this.pubSeed);
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

export async function sendTx(
  conn: Connection,
  feePayer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, [feePayer], { commitment: "confirmed" });
}

export interface WithdrawProgress {
  step: string;
  signature?: string;
}

/** Create the signature buffer and upload a 1652-byte signature in chunks. */
export async function uploadSignature(
  conn: Connection,
  feePayer: Keypair,
  genesis: Uint8Array,
  sig: Uint8Array,
  onProgress?: (p: WithdrawProgress) => void,
): Promise<void> {
  onProgress?.({ step: "Creating signature buffer" });
  await sendTx(conn, feePayer, [initSigBufferIx(feePayer.publicKey, genesis)]);
  const CHUNK = 900;
  for (let offset = 0; offset < sig.length; offset += CHUNK) {
    const chunk = sig.slice(offset, Math.min(offset + CHUNK, sig.length));
    onProgress?.({ step: `Uploading signature (${offset}/${sig.length})` });
    await sendTx(conn, feePayer, [writeSigBufferIx(feePayer.publicKey, genesis, offset, chunk)]);
  }
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
  return sendTx(conn, feePayer, [
    openVaultIx(feePayer.publicKey, wallet.genesis, wallet.pubSeed, depositLamports),
  ]);
}

/** Deposit SOL by a plain transfer to the vault address (no program ix needed). */
export async function depositSol(
  conn: Connection,
  feePayer: Keypair,
  vault: PublicKey,
  lamports: bigint,
): Promise<string> {
  return sendTx(conn, feePayer, [
    SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: vault, lamports }),
  ]);
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
  assertSignOnce(wallet.address.toBase58(), k, message);
  const sig = wallet.signAt(k, message);
  if (sig.length !== SIGNATURE_BYTES) throw new Error("bad signature length");

  await uploadSignature(conn, feePayer, wallet.genesis, sig, onProgress);

  onProgress?.({ step: "Spending + rotating key" });
  const s = await sendTx(conn, feePayer, [
    spendSolIx(wallet.address, wallet.genesis, amount, next, destination, feePayer.publicKey),
  ]);
  onProgress?.({ step: "Done", signature: s });
}

export { sigbufPda };
