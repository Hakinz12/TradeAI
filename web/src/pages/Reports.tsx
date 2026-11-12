import type { ReportEntry } from "../../../src/api-types";
import { api, usePoll } from "../api";
import { useApp } from "../context";
import { cls, fmtSol } from "../format";
import { Card, useAction } from "../ui";

export function Reports() {
  const { strategyId, q } = useApp();
  const { data, reload } = usePoll<ReportEntry[]>(`/api/reports${q()}`, 30_000);
  const { busy, run } = useAction();
  return (
    <Card title="Daily reports" right={<button className="sm primary" disabled={busy} onClick={() => void run(() => api("/api/reports/generate", { method: "POST", body: { strategy: strategyId } }), "Report updated.").then(reload)}>Generate today's report</button>}>
      <p className="sub" style={{ marginTop: 0 }}>A report is written automatically at each day rollover and sent to your alert channels if you set them up.</p>
      {!data?.length ? <div className="empty">No reports yet.</div> : data.map((r) => {
        const d = r.data;
        return (
          <div key={`${r.day}-${d.strategyId}`} className="card" style={{ marginBottom: 10, background: "var(--panel2)" }}>
            <div className="row"><b>{r.day}</b><span className="muted">{d.strategyName}</span><span className={`mono ${cls(d.pnlSol)}`} style={{ marginLeft: "auto" }}>{d.pnlSol >= 0 ? "+" : ""}{d.pnlSol.toFixed(3)} SOL</span></div>
            <div className="sub">{d.positionsClosed} positions · {d.wins} wins / {d.losses} losses · equity {fmtSol(d.equityStart, 2)} → {fmtSol(d.equityEnd, 2)}{d.coldEvents ? ` · regime guard fired ${d.coldEvents}×` : ""}</div>
            {d.best && <div className="sub">Best {d.best.symbol} {d.best.pnlPct.toFixed(0)}% · worst {d.worst?.symbol} {d.worst?.pnlPct.toFixed(0)}%</div>}
            {d.notes.length > 0 && <ul className="plain">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          </div>
        );
      })}
    </Card>
  );
}
