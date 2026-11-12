import type { Executor, OrderResult, TokenSnapshot, TradeEstimate } from "./types";

export interface PaperOptions {
  solUsd: number;
  /** Adverse price move between decision and fill, applied to every order (percent) */
  latencyPenaltyPct: number;
  /** Multiplies the modelled slippage */
  slippageMultiplier: number;
  /** Combined swap + priority fee per side (percent) */
  feePct: number;
  /** Probability that a sell fails on a thin pool; the engine retries next tick */
  sellFailProb: number;
  lowLiqUsd: number;
  rand: () => number;
}

export const defaultPaperOptions = (rand: () => number = Math.random): PaperOptions => ({
  solUsd: 150,
  latencyPenaltyPct: 1.0,
  slippageMultiplier: 1.5,
  feePct: 0.5,
  sellFailProb: 0.25,
  lowLiqUsd: 6000,
  rand,
});

/**
 * PaperExecutor: simulates fills on purpose pessimistically, because real memecoin fills are worse than a
 * clean simulation. Slippage grows with order size relative to pool liquidity, every order pays a latency
 * penalty and fee, and sells on thin pools can fail. On a rugged pool slippage clamps near 95%.
 */
export class PaperExecutor implements Executor {
  constructor(private opts: PaperOptions) {}

  private slippage(valueSol: number, liquidityUsd: number): number {
    const base = 0.01 + ((valueSol * this.opts.solUsd) / Math.max(liquidityUsd, 1)) * 1.5;
    return base * this.opts.slippageMultiplier;
  }

  estimate(token: TokenSnapshot, sizeSol: number): TradeEstimate {
    const buy = this.slippage(sizeSol, token.liquidityUsd);
    const sell = Math.min(this.slippage(sizeSol, token.liquidityUsd), 0.95);
    const overhead = 2 * (this.opts.feePct + this.opts.latencyPenaltyPct) / 100;
    return {
      buySlippagePct: buy * 100,
      sellSlippagePct: sell * 100,
      roundTripCostPct: (buy + sell + overhead) * 100,
      poolSharePct: ((sizeSol * this.opts.solUsd) / Math.max(token.liquidityUsd, 1)) * 100,
    };
  }

  async buy(token: TokenSnapshot, sizeSol: number): Promise<OrderResult> {
    const slip = this.slippage(sizeSol, token.liquidityUsd);
    if (slip > 0.25) return { ok: false, fillPrice: 0, qty: 0, error: `slippage too high (${(slip * 100).toFixed(0)}%)` };
    const fillPrice = token.price * (1 + slip + (this.opts.feePct + this.opts.latencyPenaltyPct) / 100);
    return { ok: true, fillPrice, qty: sizeSol / fillPrice };
  }

  async sell(token: TokenSnapshot, qty: number): Promise<OrderResult> {
    if (token.liquidityUsd < this.opts.lowLiqUsd && this.opts.rand() < this.opts.sellFailProb) {
      return { ok: false, fillPrice: 0, qty: 0, error: "sell failed: pool too thin, transaction dropped" };
    }
    const slip = Math.min(this.slippage(qty * token.price, token.liquidityUsd), 0.95);
    const raw = token.price * (1 - slip - (this.opts.feePct + this.opts.latencyPenaltyPct) / 100);
    return { ok: true, fillPrice: Math.max(raw, token.price * 0.01), qty };
  }
}

/**
 * LiveExecutor: intentionally not implemented yet.
 * Planned: Jupiter quote + swap, signed with a dedicated burner wallet, sent as a Jito bundle,
 * with a simulated sell before every buy and an allowlist of programs it may touch.
 */
export class LiveExecutor implements Executor {
  async buy(): Promise<OrderResult> {
    throw new Error("LiveExecutor is not implemented. Run in paper mode.");
  }
  async sell(): Promise<OrderResult> {
    throw new Error("LiveExecutor is not implemented. Run in paper mode.");
  }
}
