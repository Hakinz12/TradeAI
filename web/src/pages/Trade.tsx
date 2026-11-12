import { useEffect, useState } from "react";
import { api } from "../api";
import { detectWallets, connectWallet } from "../wallets";
import type { WalletOption } from "../wallets";
import { Badge, Banner, Card, useAction } from "../ui";

type Network = "paper" | "devnet" | "mainnet";
type Pair = { label: string; pool: string; mintA: string; mintB: string; tokenA: string; tokenB: string };
type SwapConfig = { devnetReady: boolean; devnetProvider: string; devnetPairs: Pair[]; mainnetReady: boolean; geminiReady: boolean; heliusReady: boolean; message: string };
type Quote = { quote: Record<string, unknown> & { inAmount: string; outAmount: string; priceImpactPct?: string; routePlan?: unknown[] }; source: string; fetchedAt: string; requiresWalletApproval: boolean };

export function Trade() {
  const [network, setNetwork] = useState<Network>(() => (localStorage.getItem("alpha-fun.network") as Network) || "paper");
  const [mode, setMode] = useState<"manual" | "approval">("manual");
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [active, setActive] = useState<WalletOption | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [config, setConfig] = useState<SwapConfig | null>(null);
  const [pair, setPair] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [slippage, setSlippage] = useState("100");
  const [inputDecimals, setInputDecimals] = useState("9");
  const [analysisContext, setAnalysisContext] = useState("");
  const [inputMint, setInputMint] = useState("So11111111111111111111111111111111111111112");
  const [outputMint, setOutputMint] = useState("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [analysisQuestion, setAnalysisQuestion] = useState("Assess the key risks and what evidence is missing before considering a trade.");
  const [analysis, setAnalysis] = useState("");
  const [notice, setNotice] = useState("Connect a wallet to prepare a trade.");
  const { busy, run } = useAction();

  useEffect(() => {
    const refresh = () => setWallets(detectWallets());
    refresh();
    const timer = window.setTimeout(refresh, 700);
    api<SwapConfig>("/api/swap/config").then((c) => { setConfig(c); if (c.devnetPairs[0]) setPair(c.devnetPairs[0].pool); }).catch((e: Error) => setNotice(e.message));
    return () => window.clearTimeout(timer);
  }, []);

  const chooseNetwork = (n: Network) => { setNetwork(n); localStorage.setItem("alpha-fun.network", n); };
  const connect = (w: WalletOption) => run(async () => {
    const a = await connectWallet(w); setActive(w); setAddress(a); setNotice(`${w.name} connected: ${a}`);
  }, "Wallet connected.");
  const disconnect = () => { void active?.provider.disconnect?.().catch(() => undefined); setActive(null); setAddress(null); setNotice("Wallet disconnected."); };

  const selectedPair = config?.devnetPairs.find((p) => p.pool === pair);
  const getQuote = () => run(async () => {
    if (network !== "mainnet") throw new Error("Jupiter quote preparation is Mainnet-only.");
    if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a valid positive amount.");
    if (!active || !address) throw new Error("Connect a wallet first.");
    const decimals = Number(inputDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Token decimals must be between 0 and 18.");
    const [whole, fraction = ""] = amount.split(".");
    if (fraction.length > decimals) throw new Error(`Amount has more than ${decimals} decimal places.`);
    const rawAmount = (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
    const result = await api<Quote>("/api/swap/mainnet/quote", { method: "POST", body: { inputMint, outputMint, amount: rawAmount, slippageBps: Number(slippage) } });
    setQuote(result); setNotice("Fresh Jupiter quote received. Review it before preparing a wallet transaction.");
  }, "Jupiter quote received.");
  const buildSwap = () => run(async () => {
    if (!quote || !address) throw new Error("Get a fresh quote and connect your wallet first.");
    const built = await api<{ swapTransaction: string; warning: string }>("/api/swap/mainnet/build", { method: "POST", body: { quoteResponse: quote.quote, userPublicKey: address } });
    setNotice(`${built.warning} Transaction payload prepared (${built.swapTransaction.length.toLocaleString()} characters). Wallet signing/submission is not enabled in this build.`);
  }, "Unsigned transaction prepared.");
  const askGemini = () => run(async () => {
    const result = await api<{ analysis: string; model: string }>("/api/ai/analyze", { method: "POST", body: { question: analysisQuestion, context: `Selected network: ${network}. Wallet connected: ${Boolean(address)}. User-provided context: ${analysisContext}. This application currently exposes paper execution and quote/transaction preparation only. Do not infer a token's live market metrics from this context.` } });
    setAnalysis(result.analysis);
  }, "Gemini analysis complete.");

  return <div className="stack">
    <Card title="Trading environment" right={<Badge tone={network === "mainnet" ? "warn" : "ok"}>{network.toUpperCase()}</Badge>}>
      <div className="seg" role="group" aria-label="Trading environment">
        {(["paper", "devnet", "mainnet"] as Network[]).map((n) => <button key={n} className={network === n ? "on" : ""} onClick={() => chooseNetwork(n)}>{n === "paper" ? "Paper" : n === "devnet" ? "Devnet" : "Mainnet"}</button>)}
      </div>
      <p className="sub" style={{ marginBottom: 0 }}>{network === "paper" ? "Simulated fills only. No wallet transaction is sent." : network === "devnet" ? "Test SOL only. Devnet transactions are real on-chain transactions but have no monetary value." : "Mainnet uses real SOL and tokens. Check every address, quote, fee and slippage value before signing."}</p>
    </Card>

    <div className="grid two">
      <Card title="Wallet connection" right={address ? <Badge tone="ok">connected</Badge> : <Badge>not connected</Badge>}>
        {address ? <><div className="copy">{address}</div><div className="row" style={{ marginTop: 10 }}><span className="sub">{active?.name}</span><button className="sm" onClick={disconnect}>Disconnect</button></div></> : <div className="row">{wallets.map((w) => <button key={w.id} onClick={() => connect(w)} disabled={busy}>{w.name}</button>)}{!wallets.length && <p className="sub">Install Phantom, Solflare or Backpack to connect.</p>}</div>}
        <p className="sub">Wallet connection only reveals your public address. Alpha.fun never asks for seed phrases or private keys.</p>
      </Card>
      <Card title="Execution mode">
        <div className="seg"><button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>Manual</button><button disabled title="AI proposal queue is not connected in this build">AI approval · planned</button></div>
        <p className="sub">{mode === "manual" ? "Manual trading is the target workflow. In this build, wallet connection is available but order signing is not enabled yet." : "AI proposal generation and the approval queue are planned. This build does not execute AI-generated trades."}</p>
      </Card>
    </div>

    {network === "devnet" && <Card title="Devnet Swap Lab" right={<Badge tone={config?.devnetReady ? "ok" : "warn"}>{config?.devnetReady ? "pool configured" : "setup required"}</Badge>}>
      <Banner tone="info">Devnet swaps use the Orca Whirlpools AMM deployment. A real pool with funded liquidity is required; mainnet pairs cannot be reused on Devnet.</Banner>
      {config?.devnetPairs.length ? <>
        <div className="field"><label htmlFor="devnet-pair">Configured token pair</label><select id="devnet-pair" value={pair} onChange={(e) => setPair(e.target.value)}>{config.devnetPairs.map((p) => <option key={p.pool} value={p.pool}>{p.label}</option>)}</select></div>
        {selectedPair && <dl className="kv" style={{ marginTop: 12 }}><dt>Pool</dt><dd className="mono">{selectedPair.pool}</dd><dt>Token A</dt><dd>{selectedPair.tokenA} · {selectedPair.mintA}</dd><dt>Token B</dt><dd>{selectedPair.tokenB} · {selectedPair.mintB}</dd></dl>}
      </> : <div className="empty">No Devnet pool is configured yet. Set DEVNET_ORCA_POOLS in .env after creating or verifying a funded Orca Devnet Whirlpool. See DEVNET.md.</div>}
      <div className="row" style={{ marginTop: 12 }}><a href="https://faucet.solana.com/" target="_blank" rel="noreferrer">Get test SOL ↗</a><a href="https://explorer.solana.com/?cluster=devnet" target="_blank" rel="noreferrer">Devnet Explorer ↗</a><a href="https://www.orca.so/" target="_blank" rel="noreferrer">Orca ↗</a></div>
    </Card>}

    {network === "mainnet" && <Banner tone="warn">Mainnet execution is locked until the production swap adapter, quote validation and transaction simulation have been configured. Do not treat the current paper executor as live trading.</Banner>}
    {network === "devnet" && !config?.devnetReady && <Banner tone="warn">No live Devnet swap route is configured. This page will not fabricate quotes or submit a dummy transaction.</Banner>}
    {network === "paper" && <Banner tone="info">Paper mode is available now through Explore → token details. Its fills are simulated and intentionally pessimistic.</Banner>}

    <Card title="Manual swap ticket" right={<Badge tone={config?.mainnetReady ? "ok" : "warn"}>{config?.mainnetReady ? "Jupiter connected" : "API setup needed"}</Badge>}>
      <Banner tone="warn">Mainnet is real money. Quotes and unsigned transactions can be prepared, but wallet signing and submission are not enabled yet. Do not treat a prepared payload as an executed swap.</Banner>
      <div className="grid two">
        <div className="field"><label htmlFor="swap-input-mint">Input token mint</label><input id="swap-input-mint" value={inputMint} onChange={(e) => { setInputMint(e.target.value.trim()); setQuote(null); }} /></div>
        <div className="field"><label htmlFor="swap-output-mint">Output token mint</label><input id="swap-output-mint" value={outputMint} onChange={(e) => { setOutputMint(e.target.value.trim()); setQuote(null); }} /></div>
        <div className="field"><label htmlFor="swap-amount">Input amount (SOL or token units)</label><input id="swap-amount" value={amount} onChange={(e) => { setAmount(e.target.value); setQuote(null); }} inputMode="decimal" /></div>
        <div className="field"><label htmlFor="swap-decimals">Input token decimals</label><input id="swap-decimals" value={inputDecimals} onChange={(e) => { setInputDecimals(e.target.value); setQuote(null); }} inputMode="numeric" /></div>
        <div className="field"><label htmlFor="swap-slippage">Max slippage (basis points)</label><input id="swap-slippage" value={slippage} onChange={(e) => { setSlippage(e.target.value); setQuote(null); }} inputMode="numeric" /></div>
      </div>
      <div className="row" style={{ marginTop: 12 }}><button className="primary" disabled={busy || network !== "mainnet" || !config?.mainnetReady || !address} onClick={getQuote}>Get Jupiter quote</button><button disabled={busy || !quote || !address} onClick={buildSwap}>Prepare unsigned transaction</button><Badge tone="warn">Wallet execution pending</Badge></div>
      {quote && <div className="copy" style={{ marginTop: 12 }}>Input: {quote.quote.inAmount} smallest units · Output: {quote.quote.outAmount} smallest units · Price impact: {String(quote.quote.priceImpactPct ?? "not provided")}% · Routes: {quote.quote.routePlan?.length ?? "unknown"} · Quote: {new Date(quote.fetchedAt).toLocaleTimeString()}</div>}
      <p className="sub">Enter the correct decimals for the input mint (wrapped SOL uses 9; USDC uses 6). The quote is only as accurate as the mint and decimals you provide. Never sign a transaction you have not independently reviewed.</p>
      <p className="sub">{notice}</p>
    </Card>

    <Card title="Gemini analyst" right={<Badge tone={config?.geminiReady ? "ok" : "warn"}>{config?.geminiReady ? "Gemini connected" : "API key needed"}</Badge>}>
      <p className="sub">Ask Gemini to assess risks, explain indicators or identify missing evidence. Its output is advisory and cannot place or approve trades.</p>
      <div className="field"><label htmlFor="gemini-question">Analysis request</label><textarea id="gemini-question" rows={3} value={analysisQuestion} onChange={(e) => setAnalysisQuestion(e.target.value)} /></div>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="gemini-context">Optional market / token context (paste verified data)</label><textarea id="gemini-context" rows={4} value={analysisContext} onChange={(e) => setAnalysisContext(e.target.value)} placeholder="Token mint, liquidity, volume, holder concentration, recent transactions, source and timestamp..." /></div>
      <div className="row" style={{ marginTop: 10 }}><button className="primary" disabled={busy || !config?.geminiReady || analysisQuestion.trim().length < 3} onClick={askGemini}>Analyse with Gemini</button></div>
      {analysis && <div className="analysis-output" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{analysis}</div>}
    </Card>
  </div>;
}
