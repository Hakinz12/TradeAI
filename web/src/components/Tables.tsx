import type { LogEvent, Trade } from "../../../src/types";
import type { PositionView } from "../../../src/api-types";
import { api } from "../api";
import { useApp } from "../context";
import { cls, fmtAge, fmtDateTime, fmtPct, fmtPrice, fmtSol, fmtTime, short } from "../format";
import { useAction } from "../ui";
import { go } from "../route";

export function PositionsTable({ positions }: { positions: PositionView[] }) {
  const { strategyId, reload } = useApp();
  const { busy, run } = useAction();
  if (!positions.length) return <div className="empty">No open positions.</div>;
  const close = (p: PositionView) => {
    if (!confirm(`Sell the whole ${p.symbol} position now at the current price?`)) return;
    void run(() => api<{ message: string }>("/api/manual/close", { method: "POST", body: { positionId: p.id, strategy: strategyId } }), (r) => r.message).then(reload);
  };
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Token</th><th className="r">Size</th><th className="r">P/L</th><th className="r">Entry</th><th className="r">Now</th><th className="r">Stop</th><th className="r">Target</th><th className="r">Held</th><th /></tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} className="click" onClick={() => go(`/token/${p.mint}`)}>
              <td>
                {p.symbol} <span className="muted">{p.theme}</span> {p.source === "manual" && <span className="badge">manual</span>} {p.tp1Done && <span className="badge ok">TP1 hit</span>}
              </td>
              <td className="r">{fmtSol(p.valueSol)}</td>
              <td className={`r ${cls(p.pnlPct)}`}>{fmtPct(p.pnlPct)}</td>
              <td className="r">{fmtPrice(p.entryPrice)}</td>
              <td className="r">{fmtPrice(p.lastPrice)}</td>
              <td className="r neg">{fmtPrice(p.levels.stop)}</td>
              <td className="r pos">{fmtPrice(p.levels.tp1 ?? p.levels.takeProfit)}</td>
              <td className="r">{fmtAge(p.heldTicks)}</td>
              <td className="r" onClick={(e) => e.stopPropagation()}>
                <button className="sm danger" disabled={busy} onClick={() => close(p)}>Close</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const REASON: Record<string, string> = {
  stop_loss: "Stop loss", trailing_stop: "Trailing stop", take_profit: "Take profit", take_profit_1: "Partial profit", time_stop: "Time stop",
  rug_exit: "Rug exit", kill_switch: "Kill switch", manual: "Manual", feed_lost: "Data lost",
};

export function TradesTable({ trades, limit = 30, showDate = false }: { trades: Trade[]; limit?: number; showDate?: boolean }) {
  if (!trades.length) return <div className="empty">No closed trades yet.</div>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Closed</th><th>Token</th><th>Reason</th><th className="r">Cost</th><th className="r">P/L SOL</th><th className="r">P/L %</th><th className="r">Held</th></tr>
        </thead>
        <tbody>
          {trades.slice(0, limit).map((t) => (
            <tr key={t.id} className="click" onClick={() => go(`/token/${t.mint}`)}>
              <td className="num">{showDate ? fmtDateTime(t.closedAt) : fmtTime(t.closedAt)}</td>
              <td>{t.symbol} {t.partial && <span className="badge">partial</span>}</td>
              <td>{REASON[t.reason] ?? t.reason}</td>
              <td className="r">{t.sizeSol.toFixed(3)}</td>
              <td className={`r ${cls(t.pnlSol)}`}>{t.pnlSol >= 0 ? "+" : ""}{t.pnlSol.toFixed(4)}</td>
              <td className={`r ${cls(t.pnlPct)}`}>{fmtPct(t.pnlPct)}</td>
              <td className="r">{fmtAge(t.heldTicks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EventLog({ events, hideRejects = true }: { events: LogEvent[]; hideRejects?: boolean }) {
  const rows = (hideRejects ? events.filter((e) => e.kind !== "scan_reject") : events).slice(0, 60);
  if (!rows.length) return <div className="empty">Nothing yet.</div>;
  return (
    <div className="log">
      {rows.map((e, i) => (
        <div key={`${e.t}-${i}`}>
          <time>{fmtTime(e.t)}</time>
          <span className={`k-${e.kind}`}>{e.msg}</span>
        </div>
      ))}
    </div>
  );
}

export { short };
