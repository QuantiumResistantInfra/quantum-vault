// Proves the TypeScript SDK works against the real deployed devnet program:
// open a vault, deposit, withdraw (sign in TS, verify on-chain), check rotation.
//
// Run: npm run verify-devnet   (uses the default Solana CLI wallet as fee payer)

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEVNET_RPC } from "./program";
import { VaultWallet, openVault, depositSol, withdrawSol, readCurrentPubkey } from "./vault";

function loadCliWallet(): Keypair {
  const path = join(homedir(), ".config", "solana", "id.json");
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

async function main() {
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const feePayer = loadCliWallet();
  console.log("fee payer:", feePayer.publicKey.toBase58());

  const wallet = VaultWallet.random();
  console.log("vault:    ", wallet.address.toBase58());
  // NOTE: never log wallet.mnemonic — it is the vault's authority.

  console.log("\nopening vault (+0.02 SOL)...");
  await openVault(conn, feePayer, wallet, BigInt(LAMPORTS_PER_SOL / 50));

  console.log("depositing 0.01 SOL...");
  await depositSol(conn, feePayer, wallet.address, BigInt(LAMPORTS_PER_SOL / 100));

  const destination = Keypair.generate().publicKey;
  const amount = BigInt(LAMPORTS_PER_SOL / 200); // 0.005 SOL
  console.log("\nwithdrawing 0.005 SOL to", destination.toBase58());
  await withdrawSol(conn, feePayer, wallet, amount, destination, (p) =>
    console.log("  -", p.step + (p.signature ? ` (${p.signature.slice(0, 16)}...)` : "")),
  );

  const destBalance = await conn.getBalance(destination, "confirmed");
  const current = await readCurrentPubkey(conn, wallet);
  const rotated = current && wallet.findIndex(current) === 1;

  console.log("\n--- results ---");
  console.log("destination balance:", destBalance, "lamports (expected", Number(amount), ")");
  console.log("vault rotated to key #1:", rotated);
  if (destBalance !== Number(amount) || !rotated) {
    throw new Error("verification FAILED");
  }
  console.log("\n✅ TypeScript SDK verified against live devnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
