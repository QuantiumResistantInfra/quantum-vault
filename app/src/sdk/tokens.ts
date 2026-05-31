// SPL-token support: create a test mint, deposit, and withdraw tokens from the
// vault. Withdrawals reuse the same WOTS + signature-buffer flow as SOL.

import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  VaultWallet,
  WithdrawProgress,
  readCurrentPubkey,
  sendTx,
  uploadSignature,
} from "./vault";
import { spendTokenIx, spendTokenMessage } from "./program";
import { SIGNATURE_BYTES } from "./wots";

export const DECIMALS = 6;

export const toBase = (ui: number): bigint => BigInt(Math.round(ui * 10 ** DECIMALS));
export const fromBase = (base: bigint): number => Number(base) / 10 ** DECIMALS;

/** Create a fresh test mint and mint `uiAmount` tokens to the fee payer. */
export async function createTestMint(
  conn: Connection,
  feePayer: Keypair,
  uiAmount = 1000,
): Promise<PublicKey> {
  const mint = await createMint(conn, feePayer, feePayer.publicKey, null, DECIMALS);
  const ata = await getOrCreateAssociatedTokenAccount(conn, feePayer, mint, feePayer.publicKey);
  await mintTo(conn, feePayer, mint, ata.address, feePayer, toBase(uiAmount));
  return mint;
}

/** Token balance for `owner`'s associated token account (0 if it doesn't exist). */
export async function tokenBalance(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey,
  allowOwnerOffCurve = false,
): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve);
    return (await getAccount(conn, ata, "confirmed")).amount;
  } catch {
    return 0n;
  }
}

/** Deposit tokens into the vault's token account (a plain SPL transfer). */
export async function depositToken(
  conn: Connection,
  feePayer: Keypair,
  mint: PublicKey,
  vault: PublicKey,
  amount: bigint,
): Promise<string> {
  const source = await getOrCreateAssociatedTokenAccount(conn, feePayer, mint, feePayer.publicKey);
  const vaultAta = await getOrCreateAssociatedTokenAccount(conn, feePayer, mint, vault, true);
  return sendTx(conn, feePayer, [
    createTransferInstruction(source.address, vaultAta.address, feePayer.publicKey, amount),
  ]);
}

/** Full token withdrawal: sign, buffer the signature, spend, rotate the key. */
export async function withdrawToken(
  conn: Connection,
  feePayer: Keypair,
  wallet: VaultWallet,
  mint: PublicKey,
  amount: bigint,
  destinationWallet: PublicKey,
  onProgress?: (p: WithdrawProgress) => void,
): Promise<void> {
  const current = await readCurrentPubkey(conn, wallet);
  if (!current) throw new Error("vault not opened yet");
  const k = wallet.findIndex(current);
  const next = wallet.pubkeyAt(k + 1);

  const vaultAta = getAssociatedTokenAddressSync(mint, wallet.address, true);
  const destAta = getAssociatedTokenAddressSync(mint, destinationWallet, false);

  // The signature binds the destination *token account* (ATA), not the wallet.
  const message = spendTokenMessage(wallet.genesis, mint, amount, destAta, next);
  const sig = wallet.signAt(k, message);
  if (sig.length !== SIGNATURE_BYTES) throw new Error("bad signature length");

  await uploadSignature(conn, feePayer, wallet.genesis, sig, onProgress);

  // Create the destination token account in the spend tx if it doesn't exist.
  const prep: TransactionInstruction[] = [];
  try {
    await getAccount(conn, destAta, "confirmed");
  } catch {
    prep.push(createAssociatedTokenAccountInstruction(feePayer.publicKey, destAta, destinationWallet, mint));
  }

  onProgress?.({ step: "Spending tokens + rotating key" });
  const s = await sendTx(conn, feePayer, [
    ...prep,
    spendTokenIx(wallet.address, wallet.genesis, amount, next, mint, vaultAta, destAta, feePayer.publicKey),
  ]);
  onProgress?.({ step: "Done", signature: s });
}
