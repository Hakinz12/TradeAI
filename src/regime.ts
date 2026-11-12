import type { StrategyConfig } from "./config";
import type { State, TokenSnapshot } from "./types";

export interface RegimeVerdict {
  cold: boolean;
  reason: string | null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Market regime guard: most losses cluster when the whole market turns. Pause new entries when either
 *  - most of the recent exits were stop-losses or rugs, or
 *  - buying pressure across the whole universe is weak.
 * Only trades closed after the last cooldown count, so the same losses cannot re-trigger it forever.
 */
export function evaluateRegime(state: State, universe: TokenSnapshot[], cfg: StrategyConfig): RegimeVerdict {
  if (!cfg.regimeEnabled) return { cold: false, reason: null };

  const decided = state.trades
    .filter((t) => t.closedTick > state.lastColdTick && t.source === "auto" && t.reason !== "kill_switch" && t.reason !== "feed_lost" && t.reason !== "manual")
    .slice(-cfg.regimeWindow);
  if (decided.length >= cfg.regimeMinTrades) {
    const losses = decided.filter((t) => t.reason === "stop_loss" || t.reason === "rug_exit").length;
    if (losses / decided.length >= cfg.regimeMaxLossRate) {
      return { cold: true, reason: `${losses} of the last ${decided.length} exits were stop-losses or rugs` };
    }
  }

  const live = universe.filter((t) => t.ageMinutes >= 3 && t.ageMinutes <= 120 && t.buyRatio !== null);
  if (live.length >= 8) {
    const m = median(live.map((t) => t.buyRatio as number));
    if (m < cfg.regimeMinMedianBuy) return { cold: true, reason: `weak market breadth (median buy ratio ${m.toFixed(2)})` };
  }
  return { cold: false, reason: null };
}
