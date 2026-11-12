import { useMemo } from "react";
import { useApp } from "../context";
import { AnimatedNumber, DrawdownChart, Histogram, positionResults, ReasonBars, Ring } from "../components/charts";
import { EquityChart } from "../components/EquityChart";
import { EventLog, PositionsTable, TradesTable } from "../components/Tables";
import { cls, fmtNum, fmtPct } from "../format";
import { Banner, Card, Stat } from "../ui";

export function Overview() {
  const { summary: s } = useApp();
  const results = useMemo(() => (s ? positionResults(s.trades, new Set(s.positions.map((p) => p.id))) : []), [s]);
  if (!s) return <div className="empty">Loading…</div>;
  const a = s.analysis;
  const curve = s.equityCurve.map((p) => p.equity);
  const wins = results.filter((r) => r > 0).length;
  return (
    <>
      {s.regime.cold && <Banner tone="warn">Market regime guard is on: no new entries for about {s.regime.ticksLeft} more minutes (the market looks weak). Open positions keep their stops.</Banner>}
      {s.killed && <Banner tone="bad">Kill switch is active. All positions were closed and nothing new will open until you re-arm.</Banner>}
      {!s.feed.ok && <Banner tone="bad">Data feed problem: {s.feed.detail}. New entries are blocked until it recovers.</Banner>}
      {s.feed.kind === "sim" && <Banner tone="info">Simulated market. Results here test that the engine works; they say nothing about real profit.</Banner>}

      <div className="hero">
        <Card className="hero-main">
          <div className="hero-top">
            <div>
              <div className="label">Equity · {s.strategyName}</div>
              <div className="hero-value num"><AnimatedNumber value={s.equitySol} format={(n) => fmtNum(n, 3)} /><span className="unit">SOL</span></div>
              <div className={`pill ${cls(s.pnlSol)}`}>
                {s.pnlSol >= 0 ? "▲" : "▼"} <AnimatedNumber value={Math.abs(s.pnlSol)} format={(n) => n.toFixed(3)} /> SOL · {fmtPct(s.pnlPct)} since start
              </div>
            </div>
          </div>
          <EquityChart lines={[{ id: "e", name: s.strategyName, color: "var(--accent)", points: s.equityCurve }]} baseline={s.startBalanceSol} height={260} />
        </Card>
        <Card className="hero-side" title="Health">
          <div className="rings">
            <Ring value={a.winRate} label="Win rate" sub={`${wins}/${results.length || a.trades} positions`} color="var(--green)" />
            <Ring value={s.exposurePct / 100} label="Deployed" sub={`${s.positions.length}/${s.config.maxOpenPositions} open`} color="var(--blue)" />
          </div>
          <dl className="kv mini">
            <dt>Profit factor</dt><dd>{a.profitFactor === null ? "–" : a.profitFactor.toFixed(2)}</dd>
            <dt>Expectancy</dt><dd className={cls(a.expectancyPct)}>{fmtPct(a.expectancyPct)}</dd>
            <dt>Max drawdown</dt><dd className="neg">-{a.maxDrawdownPct.toFixed(1)}%</dd>
            <dt>Free balance</dt><dd>{fmtNum(s.balanceSol, 3)}</dd>
          </dl>
        </Card>
      </div>

      <div className="grid stats">
        <Stat label="Total P/L" value={`${s.pnlSol >= 0 ? "+" : ""}${s.pnlSol.toFixed(3)} SOL`} sub={fmtPct(s.pnlPct)} tone={cls(s.pnlSol)} spark={curve} />
        <Stat label="Closed positions" value={a.trades} sub={`${wins} wins · ${results.length - wins} losses`} />
        <Stat label="Avg win" value={fmtPct(a.avgWinPct)} sub="per winning position" tone="pos" />
        <Stat label="Avg loss" value={fmtPct(a.avgLossPct)} sub="per losing position" tone="neg" />
      </div>

      <div className="grid three insights">
        <Card title="P/L by exit reason"><ReasonBars byReason={a.byReason} /></Card>
        <Card title="Outcome distribution"><Histogram values={results} /></Card>
        <Card title="Drawdown"><DrawdownChart points={s.equityCurve} /></Card>
      </div>

      {(a.sampleWarning || a.suggestions.length > 0) && (
        <Card title="Analyst" className="analyst">
          {a.sampleWarning && <p className="warn" style={{ margin: "0 0 6px" }}>{a.sampleWarning}</p>}
          <ul className="plain">{a.suggestions.map((t) => <li key={t}>{t}</li>)}</ul>
        </Card>
      )}

      <div className="stack">
        <Card title={`Open positions (${s.positions.length}/${s.config.maxOpenPositions})`} right={<span className="sub num">scanned {s.counters.scanned} · rejected {s.counters.rejected} · entered {s.counters.entered} since restart</span>}>
          <PositionsTable positions={s.positions} />
        </Card>
        <div className="grid two">
          <Card title="Recent trades"><TradesTable trades={s.trades} limit={12} /></Card>
          <Card title="Decision log"><EventLog events={s.events} /></Card>
        </div>
      </div>
    </>
  );
}
