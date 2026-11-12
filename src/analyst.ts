import type { State, Trade } from "./types";

export interface Analysis {
  /** Closed positions (a position scaled out in two fills counts once) */
  trades: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  profitFactor: number | null;
  totalPnlSol: number;
  maxDrawdownPct: number;
  byReason: Record<string, { count: number; pnlSol: number }>;
  sampleWarning: string | null;
  suggestions: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** One result per closed position: fills of the same position are summed. Positions still open are excluded. */
export function positionOutcomes(trades: Trade[], openIds: Set<string>): { pnlSol: number; pnlPct: number }[] {
  const groups = new Map<string, { pnlSol: number; cost: number }>();
  for (const t of trades) {
    if (openIds.has(t.positionId)) continue;
    const g = groups.get(t.positionId) ?? { pnlSol: 0, cost: t.positionSizeSol };
    g.pnlSol += t.pnlSol;
    groups.set(t.positionId, g);
  }
  return [...groups.values()].map((g) => ({ pnlSol: g.pnlSol, pnlPct: (g.pnlSol / Math.max(g.cost, 1e-12)) * 100 }));
}

/**
 * Analyst: judges the bot on expectancy, profit factor and drawdown, not win rate.
 * It only suggests changes; a human approves them. (An LLM can later write these suggestions in plain language.)
 */
export function analyze(state: State, maxDrawdownPct: number): Analysis {
  const outcomes = positionOutcomes(state.trades, new Set(state.positions.map((p) => p.id)));
  const wins = outcomes.filter((o) => o.pnlSol > 0);
  const losses = outcomes.filter((o) => o.pnlSol <= 0);
  const grossWin = wins.reduce((s, o) => s + o.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + o.pnlSol, 0));

  const byReason: Analysis["byReason"] = {};
  for (const t of state.trades) {
    const b = (byReason[t.reason] ??= { count: 0, pnlSol: 0 });
    b.count += 1;
    b.pnlSol += t.pnlSol;
  }

  const n = outcomes.length;
  const fills = state.trades.length || 1;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0;
  const share = (reason: string) => (byReason[reason]?.count ?? 0) / fills;

  const suggestions: string[] = [];
  if (n >= 20) {
    if (profitFactor !== null && profitFactor < 1) {
      suggestions.push("Losing in this sample. Raise MIN_SCORE or tighten MAX_TOP10_HOLDER_PCT before risking real funds.");
    }
    if (share("stop_loss") > 0.5) suggestions.push("Over half of exits are stop-losses: entries may be too early, or the stop too tight.");
    if (share("rug_exit") > 0.1) suggestions.push("Rug exits are frequent: tighten the scanner (liquidity floor, holder concentration, authorities).");
    if (share("time_stop") > 0.3) suggestions.push("Many trades go nowhere: shorten MAX_HOLD_MINUTES or require stronger momentum to enter.");
    if (maxDrawdownPct > 20) suggestions.push(`Max drawdown is ${maxDrawdownPct.toFixed(0)}%: reduce MAX_POSITION_PCT or MAX_OPEN_POSITIONS.`);
    if (suggestions.length === 0) suggestions.push("No obvious parameter issues in this sample.");
  }

  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    avgWinPct: mean(wins.map((o) => o.pnlPct)),
    avgLossPct: mean(losses.map((o) => o.pnlPct)),
    expectancyPct: mean(outcomes.map((o) => o.pnlPct)),
    profitFactor,
    totalPnlSol: state.trades.reduce((s, t) => s + t.pnlSol, 0),
    maxDrawdownPct,
    byReason,
    sampleWarning: n < 30 ? `Only ${n} closed trades. Too few to judge the strategy; aim for 100+.` : null,
    suggestions,
  };
}
