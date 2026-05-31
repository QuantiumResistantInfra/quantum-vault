import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DEVNET_RPC, PROGRAM_ID } from "./sdk/program";
import {
  VaultWallet,
  openVault,
  depositSol,
  withdrawSol,
  readCurrentPubkey,
} from "./sdk/vault";

const FEEPAYER_KEY = "qv_feepayer";
const MNEMONIC_KEY = "qv_mnemonic";

function loadFeePayer(): Keypair {
  const saved = localStorage.getItem(FEEPAYER_KEY);
  if (saved) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
    } catch {
      /* regenerate below */
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(FEEPAYER_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function App() {
  const conn = useMemo(() => new Connection(DEVNET_RPC, "confirmed"), []);
  const feePayer = useMemo(loadFeePayer, []);

  const [feeBalance, setFeeBalance] = useState(0);
  const [mnemonic, setMnemonic] = useState<string | null>(() => localStorage.getItem(MNEMONIC_KEY));
  const wallet = useMemo(() => (mnemonic ? VaultWallet.fromMnemonic(mnemonic) : null), [mnemonic]);

  const [vaultBalance, setVaultBalance] = useState<number | null>(null);
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [showPhrase, setShowPhrase] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [importText, setImportText] = useState("");
  const [depositAmt, setDepositAmt] = useState("0.05");
  const [withdrawAmt, setWithdrawAmt] = useState("0.01");
  const [withdrawTo, setWithdrawTo] = useState("");

  const say = useCallback((m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40)), []);

  const refresh = useCallback(async () => {
    setFeeBalance(await conn.getBalance(feePayer.publicKey, "confirmed"));
    if (!wallet) {
      setVaultBalance(null);
      setKeyIndex(null);
      return;
    }
    const info = await conn.getAccountInfo(wallet.address, "confirmed");
    setVaultBalance(info ? info.lamports : null);
    const current = await readCurrentPubkey(conn, wallet);
    setKeyIndex(current ? wallet.findIndex(current) : null);
  }, [conn, feePayer, wallet]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      say(`❌ ${label}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const airdrop = () =>
    run("airdrop", async () => {
      say("Requesting 1 SOL airdrop…");
      const sig = await conn.requestAirdrop(feePayer.publicKey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      say("✅ Airdropped 1 SOL");
    });

  const createVault = () => {
    const w = VaultWallet.random();
    localStorage.setItem(MNEMONIC_KEY, w.mnemonic);
    setMnemonic(w.mnemonic);
    setShowPhrase(true);
    setRevealed(false);
    setWithdrawTo(feePayer.publicKey.toBase58());
    say(`Created vault ${short(w.address.toBase58())} — save your recovery phrase!`);
  };

  const importVault = () =>
    run("import", async () => {
      const w = VaultWallet.fromMnemonic(importText.trim());
      localStorage.setItem(MNEMONIC_KEY, w.mnemonic);
      setMnemonic(w.mnemonic);
      setImportText("");
      say(`Imported vault ${short(w.address.toBase58())}`);
    });

  const forget = () => {
    localStorage.removeItem(MNEMONIC_KEY);
    setMnemonic(null);
    setShowPhrase(false);
    say("Forgot vault (still on-chain; re-import the phrase to access)");
  };

  const doOpen = () =>
    run("open", async () => {
      say("Opening vault on-chain…");
      await openVault(conn, feePayer, wallet!, 0n);
      say("✅ Vault opened");
    });

  const doDeposit = () =>
    run("deposit", async () => {
      const lamports = BigInt(Math.round(parseFloat(depositAmt) * LAMPORTS_PER_SOL));
      say(`Depositing ${depositAmt} SOL…`);
      await depositSol(conn, feePayer, wallet!.address, lamports);
      say("✅ Deposit confirmed");
    });

  const doWithdraw = () =>
    run("withdraw", async () => {
      const lamports = BigInt(Math.round(parseFloat(withdrawAmt) * LAMPORTS_PER_SOL));
      const dest = new PublicKey(withdrawTo.trim());
      await withdrawSol(conn, feePayer, wallet!, lamports, dest, (p) => say(`  ${p.step}`));
      say("✅ Withdrawal complete — key rotated");
    });

  return (
    <div className="wrap">
      <header>
        <h1>
          quantum-vault <span className="badge">devnet</span>
        </h1>
        <p className="sub">
          Post-quantum Solana vault — withdrawals authorized by a hash-based Winternitz one-time
          signature, not Ed25519. No elliptic curve for Shor's algorithm to break.
        </p>
        <a
          className="prog"
          href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`}
          target="_blank"
        >
          program {short(PROGRAM_ID.toBase58())} ↗
        </a>
      </header>

      <section className="card">
        <h2>Fee payer (burner)</h2>
        <p className="muted">A throwaway keypair that just pays network fees. Not the vault authority.</p>
        <div className="row">
          <code>{feePayer.publicKey.toBase58()}</code>
          <span className="bal">{sol(feeBalance)} SOL</span>
        </div>
        <button onClick={airdrop} disabled={busy}>
          Airdrop 1 SOL
        </button>
      </section>

      {!wallet ? (
        <section className="card">
          <h2>Your vault</h2>
          <p className="muted">
            The recovery phrase below <b>is</b> the vault's quantum-resistant authority. Whoever holds
            it controls the funds. Save it.
          </p>
          <button className="primary" onClick={createVault} disabled={busy}>
            Create new vault
          </button>
          <div className="import">
            <input
              placeholder="…or paste a 24-word recovery phrase"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <button onClick={importVault} disabled={busy || !importText.trim()}>
              Import
            </button>
          </div>
        </section>
      ) : (
        <section className="card">
          <div className="vhead">
            <h2>Your vault</h2>
            <button className="link" onClick={forget}>
              forget
            </button>
          </div>

          {showPhrase && (
            <div className="phrase">
              <b>⚠️ Recovery phrase — write this down. It is the vault's authority.</b>
              <div
                className="phrase-box"
                onClick={() => setRevealed((r) => !r)}
                title={revealed ? "click to hide" : "click to reveal"}
              >
                <code className={`mnemonic${revealed ? "" : " blurred"}`}>{wallet.mnemonic}</code>
                {!revealed && <span className="reveal-hint">🔒 click to reveal</span>}
              </div>
              <div className="phrase-actions">
                <button className="link" onClick={() => setRevealed((r) => !r)}>
                  {revealed ? "hide phrase" : "reveal"}
                </button>
                <button
                  className="link"
                  onClick={() => {
                    navigator.clipboard?.writeText(wallet.mnemonic);
                    say("Recovery phrase copied to clipboard");
                  }}
                >
                  copy
                </button>
                <button
                  className="link"
                  onClick={() => {
                    setShowPhrase(false);
                    setRevealed(false);
                  }}
                >
                  done
                </button>
              </div>
            </div>
          )}

          <div className="row">
            <code>{wallet.address.toBase58()}</code>
            <span className="bal">{vaultBalance === null ? "—" : `${sol(vaultBalance)} SOL`}</span>
          </div>
          <p className="muted">
            {vaultBalance === null
              ? "Not opened yet."
              : `Open · one-time key #${keyIndex ?? "?"} (rotates every withdrawal)`}
          </p>

          {vaultBalance === null ? (
            <button className="primary" onClick={doOpen} disabled={busy}>
              Open vault on-chain
            </button>
          ) : (
            <>
              <div className="action">
                <label>Deposit (from fee payer)</label>
                <div className="import">
                  <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
                  <button onClick={doDeposit} disabled={busy}>
                    Deposit SOL
                  </button>
                </div>
              </div>
              <div className="action">
                <label>Withdraw (signed by your one-time key)</label>
                <input
                  className="dest"
                  placeholder="destination address"
                  value={withdrawTo}
                  onChange={(e) => setWithdrawTo(e.target.value)}
                />
                <div className="import">
                  <input value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} />
                  <button className="primary" onClick={doWithdraw} disabled={busy || !withdrawTo.trim()}>
                    Withdraw SOL
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>Activity</h2>
        <div className="log">
          {log.length === 0 ? <span className="muted">No activity yet.</span> : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </section>
    </div>
  );
}
