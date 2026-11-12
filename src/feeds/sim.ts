import { mulberry32 } from "../rng";
import type { CandleResult, Feed, FeedHealth, Timeframe, TokenSnapshot } from "../types";
import { aggregate, TF_SECONDS } from "./candles";
import type { PricePoint } from "./candles";

/**
 * SimulatedFeed: a fake memecoin market so the whole pipeline (scan -> predict -> trade -> exit -> dashboard)
 * can run with zero API keys. Each tick is one simulated minute of market time.
 *
 * IMPORTANT: results from this feed say nothing about real-market performance. It exists to test the plumbing
 * and the risk rules. The live feed implements the same `Feed` interface.
 */

interface SimToken {
  snap: TokenSnapshot;
  quality: number; // hidden "true" strength, 0..1
  isRug: boolean;
  rugTick: number;
  rugged: boolean;
  baseLiq: number;
  startPrice: number;
  history: PricePoint[];
}

export interface SimOptions {
  seed?: number;
  /** Distinguishes mints across restarts so old trades never collide with new tokens */
  runId?: number;
  /** Market time (ms) of tick 0 */
  epochMs?: number;
  /** Tick to resume from (the market itself restarts fresh, only the clock continues) */
  startTick?: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const SYL = ["pepe", "doge", "wif", "moon", "bonk", "chad", "frog", "cat", "inu", "ape", "pump", "gem", "rocket", "baby", "elon", "sol"];
const MAX_HISTORY = 400;
const MAX_RETIRED = 300;

export class SimulatedFeed implements Feed {
  readonly kind = "sim" as const;
  private tokens = new Map<string, SimToken>();
  private retired = new Map<string, PricePoint[]>();
  private counter = 0;
  private rand: () => number;
  private tickNo: number;
  private epochMs: number;
  private runId: string;

  constructor(opts: SimOptions = {}) {
    this.rand = mulberry32(opts.seed ?? Date.now() % 2147483647);
    this.tickNo = opts.startTick ?? 0;
    this.epochMs = opts.epochMs ?? Math.floor(Date.now() / 60000) * 60000;
    this.runId = (opts.runId ?? 1).toString(36).toUpperCase();
  }

  now(): number {
    return this.epochMs + this.tickNo * 60000;
  }

  health(): FeedHealth {
    return { ok: true, detail: "simulated market", lastOkAt: this.now(), failures: 0 };
  }

  private gauss(): number {
    const u = Math.max(this.rand(), 1e-9);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private spawn(): void {
    const r = this.rand;
    this.counter += 1;
    const isRug = r() < 0.25;
    let quality = Math.pow(r(), 1.6);
    if (isRug) quality *= 0.5;
    const symbol = (SYL[Math.floor(r() * SYL.length)] + SYL[Math.floor(r() * SYL.length)]).toUpperCase();
    const mint = `SIM${this.runId}-${this.counter.toString().padStart(5, "0")}`;
    const startPrice = 0.00005 + r() * 0.0002;
    const baseLiq = 9000 + quality * 70000 * (0.5 + r());
    const looksRisky = isRug && r() < 0.7;
    const snap: TokenSnapshot = {
      mint,
      symbol,
      price: startPrice,
      liquidityUsd: baseLiq,
      volume5mUsd: baseLiq * 0.2,
      buyRatio: 0.5,
      holders: 30 + Math.floor(r() * 40),
      top10HolderPct: looksRisky ? 55 + r() * 30 : 18 + r() * 27,
      mintAuthorityRevoked: isRug ? r() < 0.35 : r() < 0.92,
      freezeAuthorityRevoked: isRug ? r() < 0.4 : r() < 0.94,
      ageMinutes: 0,
      smartWalletBuys: 0,
      socialVelocity: 0.3,
      priceChange5mPct: 0,
      pairAddress: mint,
      token2022Risky: false,
      sellRouteOk: isRug && r() < 0.15 ? false : true,
      sellImpactPct: 1 + r() * 4,
    };
    this.tokens.set(mint, {
      snap,
      quality,
      isRug,
      rugTick: isRug ? 8 + Math.floor(r() * 100) : -1,
      rugged: false,
      baseLiq,
      startPrice,
      history: [],
    });
  }

  private update(t: SimToken): void {
    const s = t.snap;
    const r = this.rand;
    const before = s.price;
    s.ageMinutes += 1;

    if (t.isRug && !t.rugged && s.ageMinutes >= t.rugTick) {
      t.rugged = true;
      s.price *= 0.04;
    }

    if (t.rugged) {
      s.price *= Math.exp(0.02 * this.gauss());
      s.liquidityUsd = 200 + r() * 600;
      s.volume5mUsd = r() * 300;
      s.buyRatio = 0.15 + r() * 0.1;
      s.smartWalletBuys = 0;
      s.socialVelocity = clamp((s.socialVelocity ?? 0) - 0.05, 0, 1);
    } else {
      const mu = (t.quality - 0.45) * 0.014;
      const ret = mu + 0.04 * this.gauss();
      s.price *= Math.exp(ret);

      const priceRel = s.price / t.startPrice;
      s.liquidityUsd = clamp(t.baseLiq * Math.sqrt(priceRel), 2000, 400000);
      s.volume5mUsd = s.liquidityUsd * (0.08 + 0.5 * r()) * (0.4 + t.quality);
      s.buyRatio = clamp(0.38 + 0.32 * t.quality + 0.06 * this.gauss() + (ret > 0 ? 0.03 : -0.03), 0.05, 0.95);
      s.holders = (s.holders ?? 0) + Math.floor(r() * t.quality * 12 + r() * 3);
      s.smartWalletBuys = Math.round(t.quality * 3 * r() * 1.5);
      s.socialVelocity = clamp(0.2 + 0.6 * t.quality + 0.15 * this.gauss(), 0, 1);
    }

    s.priceChange5mPct = (s.price / before - 1) * 100;
    t.history.push({ time: Math.floor(this.now() / 1000), price: s.price, volume: s.volume5mUsd / 5 });
    if (t.history.length > MAX_HISTORY) t.history.shift();
  }

  async tick(): Promise<TokenSnapshot[]> {
    this.tickNo += 1;
    const r = this.rand;
    if (r() < 0.6) this.spawn();
    if (r() < 0.15) this.spawn();

    for (const [mint, t] of this.tokens) {
      this.update(t);
      if (t.snap.ageMinutes > 300) {
        this.retired.set(mint, t.history);
        if (this.retired.size > MAX_RETIRED) this.retired.delete(this.retired.keys().next().value as string);
        this.tokens.delete(mint);
      }
    }
    return [...this.tokens.values()].map((t) => ({ ...t.snap }));
  }

  get(mint: string): TokenSnapshot | undefined {
    const t = this.tokens.get(mint);
    return t ? { ...t.snap } : undefined;
  }

  async candles(mint: string, tf: Timeframe): Promise<CandleResult> {
    const history = this.tokens.get(mint)?.history ?? this.retired.get(mint);
    if (!history || history.length === 0) return { source: "simulated", candles: [], note: "No history for this token." };
    return { source: "simulated", candles: aggregate(history, TF_SECONDS[tf]) };
  }
}
