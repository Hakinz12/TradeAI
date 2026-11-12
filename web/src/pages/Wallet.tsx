import { useEffect, useRef, useState } from "react";
import type { Challenge, WalletView, WithdrawIntent, WithdrawResult } from "../../../src/api-types";
import { api, usePoll } from "../api";
import { useApp } from "../context";
import { fmtDateTime, fmtSol, short } from "../format";
import { connectWallet, detectWallets, signText } from "../wallets";
import type { WalletOption } from "../wallets";
import { Badge, Banner, Card, Modal, useAction, useToast } from "../ui";

const copy = (text: string, toast: (m: string) => void) => {
  navigator.clipboard?.writeText(text).then(() => toast("Copied."), () => toast("Could not copy: select the text manually."));
};

export function Wallet() {
  const { summary } = useApp();
  const toast = useToast();
  const { data: w, reload } = usePoll<WalletView>("/api/wallet", 15_000);
  const { busy, run } = useAction();

  const [options, setOptions] = useState<WalletOption[]>([]);
  const [active, setActive] = useState<WalletOption | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [proof, setProof] = useState<{ verified: boolean; isOwner: boolean } | null>(null);

  const [amount, setAmount] = useState("");
  const [intent, setIntent] = useState<WithdrawIntent | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [depositAmt, setDepositAmt] = useState("");
  const baseline = useRef<number | null>(null);

  useEffect(() => {
    const read = () => setOptions(detectWallets());
    read();
    const t = setTimeout(read, 800); // extensions inject a moment after page load
    return () => clearTimeout(t);
  }, []);

  // announce incoming deposits
  useEffect(() => {
    if (w?.balanceSol == null) return;
    if (baseline.current !== null && w.balanceSol > baseline.current + 0.0005) toast(`Deposit received: +${(w.balanceSol - baseline.current).toFixed(4)} SOL`, "good");
    baseline.current = w.balanceSol;
  }, [w?.balanceSol, toast]);

  const connect = (o: WalletOption) =>
    run(async () => {
      const a = await connectWallet(o);
      setActive(o);
      setAddress(a);
      setProof(null);
    }, "Wallet connected. Now prove you own it.");

  const prove = () =>
    run(async () => {
      if (!active || !address) throw new Error("Connect a wallet first.");
      const ch = await api<Challenge>("/api/wallet/challenge", { method: "POST", body: { address } });
      const sig = await signText(active, ch.message);
      const r = await api<{ verified: boolean; isOwner: boolean }>("/api/wallet/verify", { method: "POST", body: { address, signature: sig } });
      setProof(r);
      if (!r.verified) throw new Error("The signature did not verify.");
    }, "Ownership verified. Signing is free and sends nothing on chain.");

  const disconnect = () => {
    void active?.provider.disconnect?.().catch(() => undefined);
    setActive(null); setAddress(null); setProof(null);
  };

  const prepare = () =>
    run(async () => {
      const i = await api<WithdrawIntent>("/api/wallet/withdraw/prepare", { method: "POST", body: { amountSol: Number(amount) } });
      setIntent(i); setSignature(null); setPass(""); setResult(null);
    });

  const sign = () =>
    run(async () => {
      if (!active || !intent) return;
      setSignature(await signText(active, intent.message));
    });

  const execute = () =>
    run(async () => {
      if (!intent || !signature) return;
      const r = await api<WithdrawResult>("/api/wallet/withdraw/execute", { method: "POST", body: { id: intent.id, signature, passphrase: pass } });
      setResult(r); setPass(""); setIntent(null); setSignature(null); setAmount("");
      reload();
    });

  const closeFlow = () => { setIntent(null); setSignature(null); setPass(""); };

  if (!w) return <div className="empty">Loading…</div>;
  const canWithdraw = w.withdrawEnabled && proof?.isOwner && address === w.ownerWallet;
  const solanaPay = w.address ? `solana:${w.address}?label=${encodeURIComponent("Alpha.fun burner")}${depositAmt && Number(depositAmt) > 0 ? `&amount=${Number(depositAmt)}` : ""}` : "";

  return (
    <div className="stack">
      <Banner tone="info">
        <b>Alpha.fun is in paper mode.</b> It trades with a simulated balance and never spends the real wallet below. The wallet is here to hold funds for when live trading is added; keep only a small amount in it.
      </Banner>

      <div className="grid two">
        <Card title="Paper account (simulation)">
          <div className="value">{summary ? fmtSol(summary.equitySol, 2) : "…"}</div>
          <div className="sub">Not real money. This is what the strategy trades with.</div>
        </Card>
        <Card title="Burner wallet (real, on-chain)" right={w.explorerUrl ? <a href={w.explorerUrl} target="_blank" rel="noreferrer noopener">explorer ↗</a> : undefined}>
          {!w.configured ? (
            <p>No burner wallet yet. In a terminal run <span className="mono">npm run wallet -- create</span>, then restart Alpha.fun.</p>
          ) : (
            <>
              <div className="value">{w.balanceSol === null ? "…" : fmtSol(w.balanceSol, 4)}</div>
              {w.error && <div className="neg sub">{w.error}</div>}
              {!w.rpcConfigured && <div className="warn sub">Add HELIUS_API_KEY to .env to see the balance.</div>}
              <div className="copy" style={{ marginTop: 10 }}>{w.address}</div>
              <div className="row" style={{ marginTop: 8 }}><button className="sm" onClick={() => copy(w.address as string, toast)}>Copy address</button><button className="sm" onClick={reload}>Refresh</button></div>
              {w.tokens.length > 0 && <div className="sub" style={{ marginTop: 8 }}>{w.tokens.length} token account{w.tokens.length > 1 ? "s" : ""} held</div>}
            </>
          )}
        </Card>
      </div>

      <div className="grid two">
        <Card title="Connect your wallet" right={address ? <Badge tone="ok">connected</Badge> : <Badge>not connected</Badge>}>
          {!address ? (
            options.length ? (
              <div className="row">{options.map((o) => <button key={o.id} className="primary" disabled={busy} onClick={() => connect(o)}>Connect {o.name}</button>)}</div>
            ) : <p className="muted" style={{ margin: 0 }}>No Solana wallet extension found in this browser. Install Phantom, Solflare or Backpack, then reload this page.</p>
          ) : (
            <>
              <div className="copy">{address}</div>
              <div className="row" style={{ marginTop: 10 }}>
                {proof?.verified ? <Badge tone="ok">ownership verified</Badge> : <button className="primary" disabled={busy} onClick={prove}>Prove ownership</button>}
                {proof?.verified && (proof.isOwner ? <Badge tone="ok">this is your OWNER_WALLET</Badge> : <Badge tone="warn">not the OWNER_WALLET</Badge>)}
                <button className="sm ghost" onClick={disconnect}>Disconnect</button>
              </div>
              {proof?.verified && !proof.isOwner && !w.ownerWallet && (
                <div className="sub" style={{ marginTop: 10 }}>To allow withdrawals to this wallet, add <span className="mono">OWNER_WALLET={address}</span> to your .env and restart. Withdrawals can only ever go to that one address.</div>
              )}
              {proof?.verified && !proof.isOwner && w.ownerWallet && <div className="sub warn" style={{ marginTop: 10 }}>This is not the wallet set as OWNER_WALLET ({short(w.ownerWallet)}). Connect that one to withdraw.</div>}
            </>
          )}
          <p className="sub">Proving ownership is a free signature. It never sends a transaction or gives Alpha.fun access to your funds.</p>
        </Card>

        <Card title="Deposit">
          {w.address ? (
            <>
              <p style={{ marginTop: 0 }}>Send <b>SOL</b> to the burner address from any wallet or exchange. Only SOL is supported for deposits here.</p>
              <div className="copy">{w.address}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <input inputMode="decimal" placeholder="amount (optional)" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} style={{ width: 150 }} />
                <button onClick={() => copy(w.address as string, toast)}>Copy address</button>
                <a href={solanaPay} className="sm">Open in wallet app</a>
              </div>
              <p className="sub">This page notices when the balance rises and tells you. Double-check the first characters of the address ({short(w.address, 4)}) in your wallet before confirming. Start with a small test amount.</p>
            </>
          ) : <p className="muted" style={{ margin: 0 }}>Create the burner wallet first.</p>}
        </Card>
      </div>

      <Card title="Withdraw to your wallet">
        {w.withdrawBlockedReason && <Banner tone="warn">{w.withdrawBlockedReason}</Banner>}
        {result && (
          <Banner tone={result.ok ? "info" : "bad"}>
            {result.ok ? <>Withdrawal {result.status === "confirmed" ? "confirmed" : "sent"}. {result.explorerUrl && <a href={result.explorerUrl} target="_blank" rel="noreferrer noopener">View transaction ↗</a>}</> : <>Not sent: {result.error}</>}
          </Banner>
        )}
        <p className="sub" style={{ marginTop: 0 }}>
          Funds can only go to your OWNER_WALLET{w.ownerWallet ? ` (${short(w.ownerWallet)})` : ""}. Every withdrawal needs a signature from that wallet over the exact amount and your keystore passphrase.
          No application-level withdrawal cap or minimum. The amount is limited only by the available balance and the Solana transaction fee.
        </p>
        <div className="row">
          <input inputMode="decimal" placeholder="amount in SOL" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 160 }} aria-label="Withdraw amount in SOL" />
          <button className="primary" disabled={busy || !canWithdraw || !(Number(amount) > 0)} onClick={prepare}>Withdraw…</button>
          {!canWithdraw && w.withdrawEnabled && <span className="sub warn">Connect and verify your OWNER_WALLET above first.</span>}
        </div>
        {w.withdrawals.length > 0 && (
          <div className="scroll" style={{ marginTop: 12 }}><table><thead><tr><th>When</th><th className="r">Amount</th><th>Status</th><th>Tx</th></tr></thead><tbody>
            {w.withdrawals.map((x) => <tr key={x.signature}><td>{fmtDateTime(x.t)}</td><td className="r">{x.amountSol} SOL</td><td>{x.status}</td><td><a href={`https://solscan.io/tx/${x.signature}`} target="_blank" rel="noreferrer noopener">{short(x.signature, 5)}</a></td></tr>)}
          </tbody></table></div>
        )}
      </Card>

      {w.recent.length > 0 && (
        <Card title="Recent wallet activity">
          <div className="scroll"><table><thead><tr><th>When</th><th>Transaction</th><th>Status</th></tr></thead><tbody>
            {w.recent.map((r) => <tr key={r.signature}><td>{r.blockTime ? fmtDateTime(r.blockTime * 1000) : "–"}</td><td><a href={`https://solscan.io/tx/${r.signature}`} target="_blank" rel="noreferrer noopener" className="mono">{short(r.signature, 6)}</a></td><td>{r.failed ? <Badge tone="bad">failed</Badge> : <Badge tone="ok">ok</Badge>}</td></tr>)}
          </tbody></table></div>
        </Card>
      )}

      {intent && (
        <Modal title="Confirm withdrawal" onClose={closeFlow}>
          <p style={{ marginTop: 0 }}>You are about to send <b>{intent.amountSol} SOL</b> from the burner wallet to:</p>
          <div className="copy">{intent.to}</div>
          <p className="sub">Check this is your own wallet. This request expires in 2 minutes and works once.</p>
          <ol style={{ paddingLeft: 18 }}>
            <li style={{ marginBottom: 10 }}>
              <b>Sign the request with {active?.name ?? "your wallet"}</b>{" "}
              {signature ? <Badge tone="ok">signed</Badge> : <button className="primary sm" disabled={busy} onClick={sign}>Sign</button>}
              <div className="sub">Your wallet shows this text. Confirm it shows the same amount and address. It is a message, not a transaction.</div>
              <pre className="copy" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{intent.message}</pre>
            </li>
            <li>
              <b>Enter your keystore passphrase</b>
              <div className="field" style={{ marginTop: 6 }}><input type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Keystore passphrase" /></div>
            </li>
          </ol>
          <div className="row"><button className="primary" disabled={busy || !signature || !pass} onClick={execute}>Send {intent.amountSol} SOL</button><button onClick={closeFlow}>Cancel</button></div>
        </Modal>
      )}
    </div>
  );
}
