import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { DEVNET_RPC, PROGRAM_ID } from "./sdk/program";
import { VaultWallet, openVault, depositSol, withdrawSol, readCurrentPubkey } from "./sdk/vault";
import {
  createTestMint,
  depositToken,
  withdrawToken,
  tokenBalance,
  toBase,
  fromBase,
} from "./sdk/tokens";

const FEEPAYER_KEY = "qv_feepayer";
const MNEMONIC_KEY = "qv_mnemonic";
const MINT_KEY = "qv_mint";

function loadFeePayer(): Keypair {
  const saved = localStorage.getItem(FEEPAYER_KEY);
  if (saved) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
    } catch {
      /* regenerate */
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(FEEPAYER_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: { toBytes(): Uint8Array };
  connect(): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}
const getPhantom = (): PhantomProvider | undefined =>
  (window as unknown as { solana?: PhantomProvider }).solana;

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function App() {
  const conn = useMemo(() => new Connection(DEVNET_RPC, "confirmed"), []);
  const feePayer = useMemo(loadFeePayer, []);

  const [feeBalance, setFeeBalance] = useState(0);
  const [phantom, setPhantom] = useState<PublicKey | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(() => localStorage.getItem(MNEMONIC_KEY));
  const wallet = useMemo(() => (mnemonic ? VaultWallet.fromMnemonic(mnemonic) : null), [mnemonic]);
  const [mint, setMint] = useState<PublicKey | null>(() => {
    const m = localStorage.getItem(MINT_KEY);
    return m ? new PublicKey(m) : null;
  });

  const [vaultBalance, setVaultBalance] = useState<number | null>(null);
  const [keyIndex, setKeyIndex] = useState<number | null>(null);
  const [feeTokens, setFeeTokens] = useState(0n);
  const [vaultTokens, setVaultTokens] = useState(0n);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [showPhrase, setShowPhrase] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [importText, setImportText] = useState("");
  const [depositAmt, setDepositAmt] = useState("0.05");
  const [withdrawAmt, setWithdrawAmt] = useState("0.01");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [tDeposit, setTDeposit] = useState("100");
  const [tWithdraw, setTWithdraw] = useState("25");
  const [tWithdrawTo, setTWithdrawTo] = useState("");

  const say = useCallback(
    (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40)),
    [],
  );

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
    if (mint) {
      setFeeTokens(await tokenBalance(conn, feePayer.publicKey, mint));
      setVaultTokens(await tokenBalance(conn, wallet.address, mint, true));
    }
  }, [conn, feePayer, wallet, mint]);

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

  const connectPhantom = () =>
    run("connect", async () => {
      const p = getPhantom();
      if (!p?.isPhantom) throw new Error("Phantom not found — install the extension");
      const res = await p.connect();
      setPhantom(new PublicKey(res.publicKey.toBytes()));
      say("✅ Phantom connected");
    });

  const fundFromPhantom = () =>
    run("fund", async () => {
      const p = getPhantom();
      if (!p || !phantom) throw new Error("connect Phantom first");
      say("Funding burner 0.2 SOL from Phantom…");
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: phantom,
          toPubkey: feePayer.publicKey,
          lamports: LAMPORTS_PER_SOL / 5,
        }),
      );
      tx.feePayer = phantom;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      const signed = await p.signTransaction(tx); // sent via our devnet connection
      const sig = await conn.sendRawTransaction(signed.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      say("✅ Burner funded from Phantom");
    });

  const createVault = () => {
    const w = VaultWallet.random();
    localStorage.setItem(MNEMONIC_KEY, w.mnemonic);
    setMnemonic(w.mnemonic);
    setShowPhrase(true);
    setRevealed(false);
    setWithdrawTo(feePayer.publicKey.toBase58());
    setTWithdrawTo(feePayer.publicKey.toBase58());
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
      say(`Depositing ${depositAmt} SOL…`);
      await depositSol(conn, feePayer, wallet!.address, BigInt(Math.round(parseFloat(depositAmt) * LAMPORTS_PER_SOL)));
      say("✅ Deposit confirmed");
    });

  const doWithdraw = () =>
    run("withdraw", async () => {
      await withdrawSol(
        conn,
        feePayer,
        wallet!,
        BigInt(Math.round(parseFloat(withdrawAmt) * LAMPORTS_PER_SOL)),
        new PublicKey(withdrawTo.trim()),
        (p) => say(`  ${p.step}`),
      );
      say("✅ SOL withdrawal complete — key rotated");
    });

  const makeMint = () =>
    run("mint", async () => {
      say("Creating test token + minting 1000 to fee payer…");
      const m = await createTestMint(conn, feePayer, 1000);
      localStorage.setItem(MINT_KEY, m.toBase58());
      setMint(m);
      say(`✅ Test token ${short(m.toBase58())} created`);
    });

  const doDepositToken = () =>
    run("deposit token", async () => {
      say(`Depositing ${tDeposit} tokens…`);
      await depositToken(conn, feePayer, mint!, wallet!.address, toBase(parseFloat(tDeposit)));
      say("✅ Token deposit confirmed");
    });

  const doWithdrawToken = () =>
    run("withdraw token", async () => {
      await withdrawToken(
        conn,
        feePayer,
        wallet!,
        mint!,
        toBase(parseFloat(tWithdraw)),
        new PublicKey(tWithdrawTo.trim()),
        (p) => say(`  ${p.step}`),
      );
      say("✅ Token withdrawal complete — key rotated");
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
        <p className="muted">A throwaway keypair that just relays transactions. Not the vault authority.</p>
        <div className="row">
          <code>{feePayer.publicKey.toBase58()}</code>
          <span className="bal">{sol(feeBalance)} SOL</span>
        </div>
        <div className="import">
          <button onClick={airdrop} disabled={busy}>
            Airdrop 1 SOL
          </button>
          {phantom ? (
            <button onClick={fundFromPhantom} disabled={busy}>
              Fund burner 0.2 ◎ from Phantom
            </button>
          ) : (
            <button onClick={connectPhantom} disabled={busy}>
              Connect Phantom
            </button>
          )}
        </div>
        {phantom && <p className="muted">Phantom: {short(phantom.toBase58())}</p>}
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
                <label>Deposit SOL (from fee payer)</label>
                <div className="import">
                  <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
                  <button onClick={doDeposit} disabled={busy}>
                    Deposit SOL
                  </button>
                </div>
              </div>
              <div className="action">
                <label>Withdraw SOL (signed by your one-time key)</label>
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

              <div className="tokens">
                <h3>SPL tokens</h3>
                {!mint ? (
                  <button onClick={makeMint} disabled={busy}>
                    Create test token (mint 1000 to fee payer)
                  </button>
                ) : (
                  <>
                    <div className="row">
                      <code>{mint.toBase58()}</code>
                      <span className="bal">{fromBase(vaultTokens)} in vault</span>
                    </div>
                    <p className="muted">Fee payer holds {fromBase(feeTokens)} tokens.</p>
                    <div className="action">
                      <label>Deposit tokens (from fee payer)</label>
                      <div className="import">
                        <input value={tDeposit} onChange={(e) => setTDeposit(e.target.value)} />
                        <button onClick={doDepositToken} disabled={busy}>
                          Deposit tokens
                        </button>
                      </div>
                    </div>
                    <div className="action">
                      <label>Withdraw tokens (to a wallet; its token account is auto-created)</label>
                      <input
                        className="dest"
                        placeholder="destination wallet address"
                        value={tWithdrawTo}
                        onChange={(e) => setTWithdrawTo(e.target.value)}
                      />
                      <div className="import">
                        <input value={tWithdraw} onChange={(e) => setTWithdraw(e.target.value)} />
                        <button
                          className="primary"
                          onClick={doWithdrawToken}
                          disabled={busy || !tWithdrawTo.trim()}
                        >
                          Withdraw tokens
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>Activity</h2>
        <div className="log">
          {log.length === 0 ? (
            <span className="muted">No activity yet.</span>
          ) : (
            log.map((l, i) => <div key={i}>{l}</div>)
          )}
        </div>
      </section>
    </div>
  );
}
