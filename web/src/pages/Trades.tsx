import { download } from "../api";
import { TradesTable } from "../components/Tables";
import { useApp } from "../context";
import { Card, useAction } from "../ui";

export function Trades() {
  const { summary: s, strategyId } = useApp();
  const { busy, run } = useAction();
  if (!s) return <div className="empty">Loading…</div>;
  return (
    <Card title={`Trade history · ${s.strategyName}`} right={
      <span className="row">
        <button className="sm" disabled={busy} onClick={() => void run(() => download(`/api/export/trades.csv?strategy=${strategyId}`, `trades-${strategyId}.csv`))}>Download trades CSV</button>
        <button className="sm" disabled={busy} onClick={() => void run(() => download("/api/export/signals.csv", "signals.csv"))}>Download signals CSV</button>
      </span>
    }>
      <TradesTable trades={s.trades} limit={300} showDate />
      <p className="sub">Each row is one sell. A position scaled out in two steps shows two rows. Showing the most recent fills; the CSV has the full history.</p>
    </Card>
  );
}
