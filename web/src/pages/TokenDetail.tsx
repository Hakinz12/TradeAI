import { useEffect, useMemo, useState } from "react";
import type { CandlesView, PreviewView, TokenDetail as Detail } from "../../../src/api-types";
import type { Timeframe } from "../../../src/types";
import { api, usePoll } from "../api";
import type { ChartMarker } from "../components/PriceChart";
import { PriceChart } from "../components/PriceChart";
import { TradesTable } from "../components/Tables";
import { useApp } from "../context";
import { cls, fmtAge, fmtPct, fmtPrice, fmtSol, fmtUsd, short } from "../format";
import { Badge, Card, useAction } from "../ui";

const TFS: Timeframe[] = ["1m", "5m", "15m"];

function Ticket({ mint, symbol, disabled }: { mint: string; symbol: string; disabled: boolean }) {
  const { strategyId, reload } = useApp();
  const [size, setSize] = useState("");
  const [pv, setPv] = useState<PreviewView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAction();

  useEffect(() => {
    const n = size === "" ? null : Number(size);
    if (n !== null && (!Number.isFinite(n) || n <= 0)) return;
    const id = setTimeout(() => {
      api<PreviewView>(`/api/preview?mint=${mint}&strategy=${strategyId}${n === null ? "" : `&size=${n}`}`)
        .then((d) => { setPv(d); setErr(null); })
        .catch((e: Error) => setErr(e.message));
    }, 300);
    return () => clearTimeout(id);
  }, [mint, size, strategyId]);

  const buy = () => {
    const n = size === "" ? null : Number(size);
    if (!confirm(`Paper-buy ${symbol}${n ? ` with ${n} SOL` : " at the suggested size"}? It goes through the same risk checks as automatic trades.`)) return;
    void run(() => api<{ message: string }>("/api/manual/buy", { method: "POST", body: { mint, sizeSol: n, strategy: strategyId } }), (r) => r.message).then(reload);
  };

  const e = pv?.estimate;
  return (
    <Card title="Manual ticket" right="paper">
      <div className="field">
        <label htmlFor="size">Size (SOL), leave empty for the suggested size</label>
        <input id="size" inputMode="decimal" placeholder={pv ? `max ${pv.maxSizeSol.toFixed(3)}` : "auto"} value={size} onChange={(ev) => setSize(ev.target.value)} />
      </div>
      {err && <div className="neg" style={{ marginTop: 8 }}>{err}</div>}
      {pv && (
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Model score</dt><dd>{(pv.score * 100).toFixed(0)}</dd>
          {e && <><dt>Buy slippage</dt><dd>{e.buySlippagePct.toFixed(1)}%</dd><dt>Sell slippage</dt><dd>{e.sellSlippagePct.toFixed(1)}%</dd>
            <dt>Round trip cost</dt><dd className={e.roundTripCostPct > 8 ? "warn" : ""}>{e.roundTripCostPct.toFixed(1)}%</dd><dt>Share of pool</dt><dd>{e.poolSharePct.toFixed(2)}%</dd></>}
          <dt>Risk manager</dt><dd className={pv.riskOk ? "pos" : "neg"}>{pv.riskOk ? "allowed" : pv.riskReason}</dd>
        </dl>
      )}
      <div style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || disabled || !pv || !pv.riskOk} onClick={buy}>Buy (paper)</button>
      </div>
    </Card>
  );
}

export function TokenDetail({ mint }: { mint: string }) {
  const { q, strategyId } = useApp();
  const [tf, setTf] = useState<Timeframe>("1m");
  const [replay, setReplay] = useState<number | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState("");
  const { busy: aiBusy, run: runAi } = useAction();
  const detail = usePoll<Detail>(`/api/token/${mint}${q()}`, 4000);
  const candles = usePoll<CandlesView>(`/api/candles/${mint}?tf=${tf}`, 6000);
  const d = detail.data;

  useEffect(() => setReplay(null), [mint, tf, strategyId]);

  const all = candles.data?.candles ?? [];
  const shown = replay === null ? all : all.slice(0, replay);

  const markers = useMemo<ChartMarker[]>(() => {
    if (!d) return [];
    const out: ChartMarker[] = [];
    const seen = new Set<string>();
    for (const p of d.positions) {
      out.push({ time: p.openedAt / 1000, kind: "entry", text: "buy" });
      seen.add(p.id);
    }
    for (const t of d.trades) {
      if (!seen.has(t.positionId)) {
        out.push({ time: t.openedAt / 1000, kind: "entry", text: "buy" });
        seen.add(t.positionId);
      }
      out.push({ time: t.closedAt / 1000, kind: "exit", text: `${t.reason.replace("_", " ")} ${fmtPct(t.pnlPct, 0)}`, good: t.pnlSol >= 0 });
    }
    return out;
  }, [d]);

  const held = d?.positions[0] ?? null;
  const lastCandleTime = shown[shown.length - 1]?.time;

  if (detail.error && !d) return <Card><div className="neg">{detail.error}</div><p><a href="#/tokens">← back to tokens</a></p></Card>;
  if (!d) return <div className="empty">Loading…</div>;
  const t = d.token;

  return (
    <div className="stack">
      <div className="row">
        <a href="#/tokens">←</a>
        <h1 style={{ margin: 0, fontSize: 20 }}>{t.symbol}</h1>
        <span className="mono muted" title={t.mint}>{short(t.mint, 6)}</span>
        <Badge>{t.theme ?? "other"}</Badge>
        {held && <Badge tone="paper">held {fmtPct(held.pnlPct)}</Badge>}
        <span className="mono" style={{ marginLeft: "auto" }}>{fmtPrice(t.price)} SOL</span>
      </div>

      <div className="grid wide-left">
        <Card title="Chart" right={
          <span className="row">
            <span className="seg">{TFS.map((x) => <button key={x} className={tf === x ? "on" : ""} onClick={() => setTf(x)}>{x}</button>)}</span>
          </span>
        }>
          <div className="chart-box">
            <PriceChart candles={shown} markers={markers} levels={held && replay === null ? held.levels : null} stepSec={candles.data?.stepSec ?? 60} />
            {!shown.length && <div className="chart-note">{candles.data?.note ?? (candles.loading ? "Loading chart…" : "No candles yet for this token.")}</div>}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="sub">Replay</span>
            <input type="range" style={{ flex: 1 }} min={Math.min(10, all.length)} max={all.length} value={replay ?? all.length} disabled={all.length < 12}
              onChange={(e) => setReplay(Number(e.target.value) >= all.length ? null : Number(e.target.value))} aria-label="Replay position" />
            <span className="sub mono">{replay === null ? "live" : `${replay}/${all.length}`}</span>
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            Source: {candles.data?.source ?? "…"}{candles.data?.note ? ` · ${candles.data.note}` : ""}{lastCandleTime === undefined ? "" : ""}. Arrows mark this strategy's entries and exits; dashed lines are the live stop and targets.
          </div>
        </Card>

        <div className="stack">
          <Card title="Prediction">
            <div className="value">{(d.prediction.probability * 100).toFixed(0)}<span className="sub"> / 100</span></div>
            <div className="sub">estimated chance this trade reaches its profit target before its stop</div>
            <div className="tags" style={{ marginTop: 8 }}>{d.prediction.factors.map((f) => <span key={f} className="badge">{f}</span>)}</div>
          </Card>
        </div>
      </div>

      <div className="grid two">
        <Ticket mint={mint} symbol={t.symbol} disabled={false} />
        <Card title="Market">
          <dl className="kv">
            <dt>Liquidity</dt><dd>{fmtUsd(t.liquidityUsd)}</dd><dt>Volume 5m</dt><dd>{fmtUsd(t.volume5mUsd)}</dd>
            <dt>Buy ratio</dt><dd>{t.buyRatio === null ? "unknown" : `${(t.buyRatio * 100).toFixed(0)}%`}</dd>
            <dt>Age</dt><dd>{fmtAge(t.ageMinutes)}</dd><dt>Holders</dt><dd>{t.holders ?? "n/a"}</dd><dt>Smart wallets</dt><dd>{t.smartWalletBuys ?? "n/a"}</dd>
            <dt>5m change</dt><dd className={cls(t.priceChange5mPct ?? 0)}>{t.priceChange5mPct == null ? "n/a" : fmtPct(t.priceChange5mPct)}</dd>
          </dl>
        </Card>
      </div>

      <Card title="Gemini token analyst" right={<Badge>advisory only</Badge>}>
        <p className="sub">Gemini reviews the current token snapshot and available on-chain intelligence. Missing fields remain unknown; this analysis does not approve or execute trades.</p>
        <button className="primary" disabled={aiBusy} onClick={() => runAi(async () => {
          const context = { mint: t.mint, symbol: t.symbol, priceSol: t.price, liquidityUsd: t.liquidityUsd, volume5mUsd: t.volume5mUsd, buyRatio: t.buyRatio, ageMinutes: t.ageMinutes, holders: t.holders, smartWalletBuys: t.smartWalletBuys, priceChange5mPct: t.priceChange5mPct, prediction: d.prediction, intelligence: t.intelligence, strategyViews: d.takes, observedAt: new Date().toISOString() };
          const result = await api<{ analysis: string }>("/api/ai/analyze", { method: "POST", body: { question: `Assess ${t.symbol} (${t.mint}) as a potential Solana trade. Explain the strongest positive and negative signals, manipulation/liquidity concerns, data gaps, and what should be independently verified. Do not issue a buy/sell command.`, context: JSON.stringify(context) } });
          setAiAnalysis(result.analysis);
        }, "Gemini analysis complete.")}>Analyse this token with Gemini</button>
        {aiAnalysis && <div className="analysis-output" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{aiAnalysis}</div>}
      </Card>

      <div className="grid two">
        <Card title="Volume intelligence" right={t.intelligence ? <Badge tone={t.intelligence.confidence === "high" ? "ok" : "warn"}>{t.intelligence.confidence} confidence</Badge> : <Badge>pending</Badge>}>
          {!t.intelligence || t.intelligence.status === "insufficient_data" ? (
            <div className="sub">{t.intelligence?.flags[0] ?? "Configure HELIUS_API_KEY to analyse indexed pool transactions."}</div>
          ) : t.intelligence.status === "unavailable" ? (
            <div className="sub">{t.intelligence.flags[0]}</div>
          ) : (
            <>
              <div className="grid two">
                <div><div className="label">Organic volume</div><div className="value pos">{t.intelligence.organicVolumeScore}/100</div></div>
                <div><div className="label">Suspicious activity</div><div className="value warn">{t.intelligence.suspiciousVolumeScore}/100</div></div>
              </div>
              <div className="kv" style={{ marginTop: 12 }}>
                <dt>Observed swaps</dt><dd>{t.intelligence.transactions}</dd>
                <dt>Unique wallets</dt><dd>{t.intelligence.uniqueWallets}</dd>
                <dt>Top wallet volume</dt><dd>{t.intelligence.topWalletVolumePct?.toFixed(1)}%</dd>
                <dt>Repeated sizes</dt><dd>{t.intelligence.repeatedSizePct?.toFixed(1)}%</dd>
                <dt>Synchronized wallets</dt><dd>{t.intelligence.synchronizedWalletPct?.toFixed(1)}%</dd>
                <dt>Round-trip wallets</dt><dd>{t.intelligence.roundTripWalletPct?.toFixed(1)}%</dd>
                <dt>Shared-funder wallets</dt><dd>{t.intelligence.sharedFunderWallets}</dd>
              </div>
              <div className="sub" style={{ marginTop: 10 }}>{t.intelligence.flags.join(" · ")}</div>
              <div className="sub" style={{ marginTop: 5 }}>Heuristic indicators from sampled indexed transactions; not proof of bot activity or common ownership.</div>
            </>
          )}
        </Card>
        <Card title="Wallet relationship clusters">
          {t.intelligence?.clusters.length ? t.intelligence.clusters.map((c, i) => (
            <div key={i} className="cluster-row"><span>{c.reason === "shared_funder" ? "Shared funding source" : "Synchronized trading"}</span><Badge>{Math.round(c.confidence * 100)}%</Badge><div className="sub mono">{c.wallets.join(" · ")}</div></div>
          )) : <div className="sub">No wallet clusters established from the current transaction sample.</div>}
        </Card>
      </div>

      <div className="grid two">
        <Card title="What each strategy thinks">
          <div className="scroll"><table><thead><tr><th>Strategy</th><th className="r">Score</th><th>Verdict</th></tr></thead><tbody>
            {d.takes.map((k) => (
              <tr key={k.strategyId}><td>{k.strategyName}</td><td className="r">{(k.score * 100).toFixed(0)}</td><td>{k.wouldEnter ? <Badge tone="ok">would buy</Badge> : <span className="muted">{k.reason}</span>}</td></tr>
            ))}
          </tbody></table></div>
        </Card>
        <Card title="Your trades in this token"><TradesTable trades={d.trades} limit={10} showDate /></Card>
      </div>
      {held && <div className="sub">Open: {fmtSol(held.valueSol)} · stop {fmtPrice(held.levels.stop)} · target {fmtPrice(held.levels.tp1 ?? held.levels.takeProfit)}</div>}
    </div>
  );
}
