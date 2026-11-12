import type { StrategyConfig } from "./config";
import type { ExitReason, Position, State, TokenSnapshot } from "./types";

export interface EntryCheck {
  ok: boolean;
  reason: string;
}

export interface ExitDecision {
  reason: ExitReason;
  /** Fraction of the remaining position to sell, 0..1 */
  fraction: number;
}

/** Value of open positions at their last price. */
export function openValueSol(state: State): number {
  return state.positions.reduce((sum, p) => sum + p.qty * p.lastPrice, 0);
}

/** Total account value: free balance + open positions marked to last price. */
export function equityOf(state: State): number {
  return state.balanceSol + openValueSol(state);
}

/**
 * Risk manager. It has veto power over every entry and decides every exit.
 * Nothing the strategy or predictor says can override these rules.
 */
export function checkEntry(state: State, token: TokenSnapshot, sizeSol: number, cfg: StrategyConfig, tick: number): EntryCheck {
  if (state.killed) return { ok: false, reason: "kill switch active" };
  if (state.paused) return { ok: false, reason: "paused" };
  if (tick < state.coldUntilTick) return { ok: false, reason: "market regime guard is cooling off" };
  if (state.positions.length >= cfg.maxOpenPositions) return { ok: false, reason: "max open positions reached" };
  if (sizeSol <= 0 || sizeSol > state.balanceSol) return { ok: false, reason: "insufficient balance" };

  const theme = token.theme ?? "other";
  const sameTheme = state.positions.filter((p) => p.theme === theme).length;
  if (sameTheme >= cfg.maxPerTheme) return { ok: false, reason: `theme cap reached (${sameTheme}/${cfg.maxPerTheme} in '${theme}')` };

  const equity = equityOf(state);
  const exposurePct = ((openValueSol(state) + sizeSol) / Math.max(equity, 1e-9)) * 100;
  if (exposurePct > cfg.maxExposurePct) return { ok: false, reason: `exposure cap (${exposurePct.toFixed(0)}% > ${cfg.maxExposurePct}%)` };

  const dayLossPct = ((state.dayStartEquity - equity) / state.dayStartEquity) * 100;
  if (dayLossPct >= cfg.dailyLossLimitPct) return { ok: false, reason: `daily loss limit hit (-${dayLossPct.toFixed(1)}%)` };
  return { ok: true, reason: "ok" };
}

/** Returns what to sell now (and why), or null to keep holding. */
export function checkExit(pos: Position, token: TokenSnapshot, tick: number, cfg: StrategyConfig): ExitDecision | null {
  const price = token.price;

  if (token.liquidityUsd < 2000) return { reason: "rug_exit", fraction: 1 };

  const pnlPct = (price / pos.entryPrice - 1) * 100;
  if (pnlPct <= -cfg.stopLossPct) return { reason: "stop_loss", fraction: 1 };

  if (price >= pos.entryPrice * cfg.takeProfitMult) return { reason: "take_profit", fraction: 1 };

  // Scale out: sell part at the first target, let the rest run under the trailing stop.
  const scaling = cfg.tp1Fraction > 0 && cfg.tp1Mult < cfg.takeProfitMult;
  if (scaling && !pos.tp1Done && price >= pos.entryPrice * cfg.tp1Mult) {
    return { reason: "take_profit_1", fraction: cfg.tp1Fraction };
  }

  // Trailing stop only arms once the trade has been meaningfully in profit.
  const wasInProfit = pos.peakPrice >= pos.entryPrice * 1.1;
  if (wasInProfit && price <= pos.peakPrice * (1 - cfg.trailingStopPct / 100)) return { reason: "trailing_stop", fraction: 1 };

  if (tick - pos.openedTick >= cfg.maxHoldMinutes) return { reason: "time_stop", fraction: 1 };
  return null;
}

/** Price levels for a position, drawn on the token chart. */
export function exitLevels(pos: Position, cfg: StrategyConfig) {
  const scaling = cfg.tp1Fraction > 0 && cfg.tp1Mult < cfg.takeProfitMult;
  const trailArmed = pos.peakPrice >= pos.entryPrice * 1.1;
  return {
    entry: pos.entryPrice,
    stop: pos.entryPrice * (1 - cfg.stopLossPct / 100),
    tp1: scaling && !pos.tp1Done ? pos.entryPrice * cfg.tp1Mult : null,
    takeProfit: pos.entryPrice * cfg.takeProfitMult,
    trail: trailArmed ? pos.peakPrice * (1 - cfg.trailingStopPct / 100) : null,
  };
}
