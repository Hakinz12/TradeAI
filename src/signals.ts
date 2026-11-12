import type { Db } from "./db";
import type { Features } from "./features";
import type { FeedKindName, TokenSnapshot } from "./types";

export interface LabelSpec {
  upPct: number;
  downPct: number;
  horizonTicks: number;
}

export type DecisionKind = "entered" | "below_threshold" | "vetoed" | "order_failed" | "size_too_small";

interface Pending {
  mint: string;
  entryPrice: number;
  openedTick: number;
  lastPrice: number;
}

const SAMPLE_EVERY_TICKS = 5;
const MAX_SAMPLES_PER_MINT = 12;

/**
 * Decision logging with outcome labels.
 *
 * Every scored token is sampled (first sighting, then every few ticks) with its features, so the training set
 * is not limited to the trades we happened to take. That avoids selection bias: a model trained only on
 * entered trades learns the old strategy's habits, not what actually works.
 *
 * Each sampled signal is labelled by what the price did next, independent of any strategy:
 *   up first (+upPct before -downPct) -> label 1, down first or timeout -> label 0.
 */
export class SignalLogger {
  private sampled = new Map<string, { count: number; lastTick: number }>();
  private tickCache = new Map<string, number | null>();
  private cacheTick = -1;
  private pending = new Map<number, Pending>();

  constructor(
    private db: Db,
    private spec: LabelSpec,
    private source: FeedKindName,
  ) {}

  /**
   * Record one strategy's decision about a token. Returns the signal id when the token was sampled this tick
   * (always sampled when `force` is set, e.g. for entries), otherwise null.
   */
  record(
    ctx: { tick: number; t: number },
    token: TokenSnapshot,
    features: Features,
    strategyId: string,
    score: number,
    decision: DecisionKind,
    reason: string,
    positionId: string | null,
    force = false,
  ): number | null {
    if (ctx.tick !== this.cacheTick) {
      this.cacheTick = ctx.tick;
      this.tickCache.clear();
    }

    let id = this.tickCache.get(token.mint);
    if (id === undefined || (id === null && force)) {
      const st = this.sampled.get(token.mint);
      const due = !st || (st.count < MAX_SAMPLES_PER_MINT && ctx.tick - st.lastTick >= SAMPLE_EVERY_TICKS);
      if (due || force) {
        id = this.db.insertSignal({
          tick: ctx.tick,
          t: ctx.t,
          mint: token.mint,
          symbol: token.symbol,
          price: token.price,
          features: JSON.stringify(features),
          source: this.source,
        });
        this.sampled.set(token.mint, { count: (st?.count ?? 0) + 1, lastTick: ctx.tick });
        this.pending.set(id, { mint: token.mint, entryPrice: token.price, openedTick: ctx.tick, lastPrice: token.price });
      } else {
        id = null;
      }
      this.tickCache.set(token.mint, id);
    }

    if (id !== null) this.db.insertDecision(id, strategyId, score, decision, reason, positionId);
    return id;
  }

  /** Resolve pending labels using this tick's prices. Call once per tick. */
  resolve(universe: Map<string, TokenSnapshot>, tick: number): void {
    if (this.pending.size === 0) return;
    const done: { id: number; label: number; pct: number; kind: string }[] = [];

    for (const [id, p] of this.pending) {
      const tok = universe.get(p.mint);
      if (tok) p.lastPrice = tok.price;
      const pct = (p.lastPrice / p.entryPrice - 1) * 100;

      if (tok && pct <= -this.spec.downPct) done.push({ id, label: 0, pct: -this.spec.downPct, kind: "down" });
      else if (tok && pct >= this.spec.upPct) done.push({ id, label: 1, pct: this.spec.upPct, kind: "up" });
      else if (!tok || tick - p.openedTick >= this.spec.horizonTicks) done.push({ id, label: 0, pct, kind: "timeout" });
    }

    if (done.length === 0) return;
    this.db.tx(() => {
      for (const d of done) {
        this.db.setLabel(d.id, d.label, d.pct, tick, d.kind);
        this.pending.delete(d.id);
      }
    });
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
