import { analyze, positionOutcomes } from "./analyst";
import type { DailyReport } from "./api-types";
import { dayKey } from "./store";
import type { State, Trade } from "./types";

export interface ReportInput {
  strategyId: string;
  strategyName: string;
  day: string;
  state: State;
  equityStart: number;
  equityEnd: number;
  maxDrawdownPct: number;
}

/** Daily summary for one strategy: results, best and worst trade, exit mix, and what the analyst learned. */
export function buildDailyReport(input: ReportInput): DailyReport {
  const { state, day } = input;
  const fills: Trade[] = state.trades.filter((t) => dayKey(t.closedAt) === day);
  const outcomes = positionOutcomes(fills, new Set(state.positions.map((p) => p.id)));

  const byReason: DailyReport["byReason"] = {};
  for (const t of fills) {
    const b = (byReason[t.reason] ??= { count: 0, pnlSol: 0 });
    b.count += 1;
    b.pnlSol += t.pnlSol;
  }

  const wins = outcomes.filter((o) => o.pnlSol > 0).length;
  const pick = (cmp: (a: Trade, b: Trade) => boolean): DailyReport["best"] => {
    if (!fills.length) return null;
    const t = fills.reduce((a, b) => (cmp(b, a) ? b : a));
    return { symbol: t.symbol, pnlPct: t.pnlPct, pnlSol: t.pnlSol };
  };

  const coldEvents = state.events.filter((e) => dayKey(e.t) === day && e.msg.startsWith("Regime guard")).length;

  const notes: string[] = [];
  const pnlSol = fills.reduce((s, t) => s + t.pnlSol, 0);
  notes.push(`${outcomes.length} positions closed, ${wins} winners, net ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL.`);
  if (coldEvents) notes.push(`The regime guard paused entries ${coldEvents} time${coldEvents === 1 ? "" : "s"}.`);
  if (fills.length === 0) notes.push("No trades closed today.");
  notes.push(...analyze(state, input.maxDrawdownPct).suggestions);

  return {
    day,
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    fills: fills.length,
    positionsClosed: outcomes.length,
    wins,
    losses: outcomes.length - wins,
    pnlSol,
    equityStart: input.equityStart,
    equityEnd: input.equityEnd,
    best: pick((a, b) => a.pnlPct > b.pnlPct),
    worst: pick((a, b) => a.pnlPct < b.pnlPct),
    byReason,
    coldEvents,
    notes,
  };
}
