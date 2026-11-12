import type { StrategyConfig } from "./config";
import type { Prediction, State, TokenSnapshot } from "./types";

export interface EntryDecision {
  enter: boolean;
  sizeSol: number;
  reason: string;
}

export const MIN_ORDER_SOL = 0.01;

/** Largest position the pool can absorb: a share of its liquidity, converted to SOL. */
export function poolCapSol(token: TokenSnapshot, cfg: StrategyConfig, solUsd: number): number {
  return ((cfg.maxPoolSharePct / 100) * token.liquidityUsd) / solUsd;
}

/** Size from confidence: 50%..100% of the max position, then capped by pool liquidity. */
export function sizeFor(token: TokenSnapshot, probability: number, state: State, cfg: StrategyConfig, solUsd: number): number {
  const conf = (probability - cfg.minScore) / Math.max(1 - cfg.minScore, 1e-9);
  const scale = 0.5 + 0.5 * Math.min(Math.max(conf, 0), 1);
  const maxSize = state.balanceSol * (cfg.maxPositionPct / 100);
  const size = Math.min(maxSize * scale, poolCapSol(token, cfg, solUsd));
  return Math.floor(size * 1e6) / 1e6;
}

/**
 * Strategy: turn a prediction into a yes/no and a size.
 * Rules decide. The LLM (when added) should only feed scores like narrative strength into the predictor,
 * never place orders directly.
 */
export function decideEntry(token: TokenSnapshot, pred: Prediction, state: State, cfg: StrategyConfig, solUsd: number): EntryDecision {
  if (state.positions.some((p) => p.mint === token.mint)) {
    return { enter: false, sizeSol: 0, reason: "already holding" };
  }
  if (pred.probability < cfg.minScore) {
    return { enter: false, sizeSol: 0, reason: `score ${pred.probability.toFixed(2)} below ${cfg.minScore}` };
  }
  const sizeSol = sizeFor(token, pred.probability, state, cfg, solUsd);
  if (sizeSol < MIN_ORDER_SOL) return { enter: false, sizeSol: 0, reason: "size too small for this pool" };
  return { enter: true, sizeSol, reason: `score ${pred.probability.toFixed(2)}` };
}
