// Proves the SPL-token flow against the live devnet program: open a vault, mint
// a test token, deposit, withdraw (WOTS-signed), check balances + rotation.
//
// Run: npx tsx src/sdk/verify-token.ts

import { Connection, Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEVNET_RPC } from "./program";
import { VaultWallet, openVault, readCurrentPubkey } from "./vault";
import { createTestMint, depositToken, withdrawToken, tokenBalance, toBase, fromBase } from "./tokens";

function loadCliWallet(): Keypair {
  const secret = JSON.parse(readFileSync(join(homedir(), ".config", "solana", "id.json"), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const conn = new Connection(DEVNET_RPC, "confirmed");
  const feePayer = loadCliWallet();
  const wallet = VaultWallet.random();
  console.log("vault:", wallet.address.toBase58());

  console.log("opening vault…");
  await openVault(conn, feePayer, wallet, 0n);

  console.log("creating test mint + minting 1000 tokens…");
  const mint = await createTestMint(conn, feePayer, 1000);
  console.log("mint:", mint.toBase58());

  console.log("depositing 600 tokens to vault…");
  await depositToken(conn, feePayer, mint, wallet.address, toBase(600));
  console.log("vault token balance:", fromBase(await tokenBalance(conn, wallet.address, mint, true)));

  const dest = Keypair.generate().publicKey;
  console.log("\nwithdrawing 250 tokens to", dest.toBase58());
  await withdrawToken(conn, feePayer, wallet, mint, toBase(250), dest, (p) => console.log("  -", p.step));

  const destBal = await tokenBalance(conn, dest, mint);
  const vaultBal = await tokenBalance(conn, wallet.address, mint, true);
  const current = await readCurrentPubkey(conn, wallet);
  const rotated = current && wallet.findIndex(current) === 1;

  console.log("\n--- results ---");
  console.log("destination tokens:", fromBase(destBal), "(expected 250)");
  console.log("vault tokens:", fromBase(vaultBal), "(expected 350)");
  console.log("key rotated to #1:", rotated);
  if (destBal !== toBase(250) || vaultBal !== toBase(350) || !rotated) {
    throw new Error("verification FAILED");
  }
  console.log("\n✅ SPL-token flow verified against live devnet");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
