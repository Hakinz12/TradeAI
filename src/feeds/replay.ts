import type { Db } from "../db";
import type { CandleResult, Feed, FeedHealth, Timeframe, TokenSnapshot } from "../types";
import { TF_SECONDS, aggregate } from "./candles";
import type { PricePoint } from "./candles";

/**
 * Replays market snapshots recorded earlier (by any feed) tick by tick, so strategies can be compared on the
 * exact same data. Once the recording ends, tick() keeps returning the last universe with `finished` set.
 */
export class ReplayFeed implements Feed {
  readonly kind = "replay" as const;
  private ticks: { tick: number; t: number }[];
  private pos = -1;
  private current = new Map<string, TokenSnapshot>();
  private history = new Map<string, PricePoint[]>();
  private nowMs = 0;

  constructor(private source: Db, opts: { fromTick?: number; maxTicks?: number } = {}) {
    const all = source.snapshotTicks().filter((x) => x.tick >= (opts.fromTick ?? 0));
    this.ticks = opts.maxTicks ? all.slice(0, opts.maxTicks) : all;
    this.nowMs = this.ticks[0]?.t ?? 0;
  }

  get total(): number {
    return this.ticks.length;
  }

  get finished(): boolean {
    return this.pos >= this.ticks.length - 1;
  }

  async tick(): Promise<TokenSnapshot[]> {
    if (this.finished) return [...this.current.values()];
    this.pos += 1;
    const row = this.ticks[this.pos];
    this.nowMs = row.t;
    const universe = this.source.snapshotsAt(row.tick);
    this.current = new Map(universe.map((u) => [u.mint, u]));
    for (const u of universe) {
      const h = this.history.get(u.mint) ?? [];
      h.push({ time: Math.floor(row.t / 1000), price: u.price, volume: u.volume5mUsd / 5 });
      if (h.length > 2000) h.shift();
      this.history.set(u.mint, h);
    }
    return universe;
  }

  now(): number {
    return this.nowMs;
  }

  get(mint: string): TokenSnapshot | undefined {
    return this.current.get(mint);
  }

  async candles(mint: string, tf: Timeframe): Promise<CandleResult> {
    const pts = this.history.get(mint) ?? [];
    return { source: "replay", candles: aggregate(pts, TF_SECONDS[tf]) };
  }

  health(): FeedHealth {
    return { ok: true, detail: `replay ${Math.max(this.pos + 1, 0)}/${this.ticks.length}`, lastOkAt: this.nowMs, failures: 0 };
  }
}
