import type { AppConfig } from "../config";
import { TF_SECONDS, aggregate } from "./candles";
import type { Db } from "../db";
import { HttpClient } from "./http";
import { checkMintSafety, checkSellRoute } from "./onchain";
import type { Safety, SellCheck } from "./onchain";
import { isMint, parseDiscovery, parseOhlcv, parsePairs, toSnapshot, WSOL } from "./parsers";
import type { DexPair } from "./parsers";
import type { CandleResult, Feed, FeedHealth, Timeframe, TokenSnapshot } from "../types";
import { RpcClient } from "../rpc";
import { analyzeTransactions, findSharedFunders } from "../intelligence";
import type { EnhancedSwapTransaction, TokenIntelligence } from "../intelligence";

const DEX = "https://api.dexscreener.com";
const GECKO = "https://api.geckoterminal.com/api/v2";
const MAX_CANDIDATES = 150;
const SAFETY_TTL_MS = 15 * 60_000;
const SELL_TTL_MS = 5 * 60_000;
const MAX_SAFETY_PER_TICK = 3;
const DISCOVERY_EVERY_MS = 60_000;
const DROP_AFTER_MS = 20 * 60_000;

export interface LiveOptions {
  db?: Db | null;
  http?: HttpClient;
  rpc?: RpcClient | null;
  now?: () => number;
  dexBase?: string;
  geckoBase?: string;
}

/**
 * Live market feed. DexScreener for discovery and prices, the Solana RPC for authority/holder checks,
 * GeckoTerminal for chart candles, Jupiter (optional, key needed) for a sell-route check.
 * Everything unknown stays null so the scanner fails closed instead of trading blind.
 */
export class LiveFeed implements Feed {
  readonly kind = "live" as const;
  private http: HttpClient;
  private rpc: RpcClient | null;
  private clock: () => number;
  private dex: string;
  private gecko: string;
  private seen = new Map<string, { first: number; lastPair: number }>();
  private pairs = new Map<string, DexPair>();
  private safety = new Map<string, Safety>();
  private sells = new Map<string, SellCheck>();
  private intelligence = new Map<string, TokenIntelligence>();
  private intelligenceAt = new Map<string, number>();
  private current = new Map<string, TokenSnapshot>();
  private pinned = new Set<string>();
  private lastDiscovery = 0;
  private discoveryOk = true;
  private solUsd: number;
  private lastSolRefresh = 0;
  private candleCache = new Map<string, { at: number; result: CandleResult }>();
  private h: FeedHealth = { ok: false, detail: "starting", lastOkAt: null, failures: 0 };

  private db: Db | null;

  constructor(private app: AppConfig, opts: LiveOptions = {}) {
    this.db = opts.db ?? null;
    this.http = opts.http ?? new HttpClient({ minIntervalMs: { "api.dexscreener.com": 250, "api.geckoterminal.com": 12500, "api.jup.ag": 1100, "api.helius.xyz": 250 } });
    this.rpc = opts.rpc !== undefined ? opts.rpc : app.rpcUrl ? new RpcClient(app.rpcUrl) : null;
    this.clock = opts.now ?? Date.now;
    this.dex = opts.dexBase ?? DEX;
    this.gecko = opts.geckoBase ?? GECKO;
    this.solUsd = app.solUsd;
  }

  now(): number {
    return this.clock();
  }
  get(mint: string): TokenSnapshot | undefined {
    return this.current.get(mint);
  }
  pin(mints: string[]): void {
    this.pinned = new Set(mints.filter(isMint));
  }
  health(): FeedHealth {
    return { ...this.h };
  }

  private fail(detail: string) {
    this.h = { ok: false, detail, lastOkAt: this.h.lastOkAt, failures: this.h.failures + 1 };
  }

  private async discover(now: number) {
    if (now - this.lastDiscovery < DISCOVERY_EVERY_MS) return;
    this.lastDiscovery = now;
    const found: string[] = [];
    let okLists = 0;
    for (const path of ["/token-profiles/latest/v1", "/token-boosts/latest/v1"]) {
      try {
        found.push(...parseDiscovery(await this.http.json(`${this.dex}${path}`)));
        okLists += 1;
      } catch {
        /* the other list may still work */
      }
    }
    this.discoveryOk = okLists > 0;
    for (const m of found) if (!this.seen.has(m)) this.seen.set(m, { first: now, lastPair: now });
    if (this.seen.size > MAX_CANDIDATES) {
      const evict = [...this.seen.entries()].filter(([m]) => !this.pinned.has(m)).sort((a, b) => a[1].first - b[1].first);
      for (const [m] of evict.slice(0, this.seen.size - MAX_CANDIDATES)) this.seen.delete(m);
    }
  }

  private async refreshSolPrice(now: number) {
    if (now - this.lastSolRefresh < 5 * 60_000) return;
    this.lastSolRefresh = now;
    try {
      const p = parsePairs(await this.http.json(`${this.dex}/tokens/v1/solana/${WSOL}`), this.solUsd, now);
      const sol = [...p.values()].filter((x) => x.mint === WSOL).sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
      if (sol?.priceUsd && sol.priceUsd > 20 && sol.priceUsd < 2000) this.solUsd = sol.priceUsd;
    } catch {
      /* keep the previous value */
    }
  }

  async tick(): Promise<TokenSnapshot[]> {
    const now = this.now();
    try {
      await this.discover(now);
      await this.refreshSolPrice(now);
      const mints = [...new Set([...this.seen.keys(), ...this.pinned])];
      let okBatches = 0;
      let batches = 0;
      for (let i = 0; i < mints.length; i += 30) {
        const batch = mints.slice(i, i + 30);
        batches += 1;
        try {
          const got = parsePairs(await this.http.json(`${this.dex}/tokens/v1/solana/${batch.join(",")}`), this.solUsd, now);
          okBatches += 1;
          for (const [m, p] of got) {
            this.pairs.set(m, p);
            const s = this.seen.get(m);
            if (s) s.lastPair = now;
          }
        } catch {
          /* counted below */
        }
      }
      if ((batches > 0 && okBatches === 0) || (!this.discoveryOk && this.seen.size === 0)) {
        this.fail("price source unreachable");
        return [...this.current.values()];
      }
      for (const [m, s] of this.seen) if (!this.pinned.has(m) && now - s.lastPair > DROP_AFTER_MS) {
        this.seen.delete(m);
        this.pairs.delete(m);
      }

      await this.enrich(now);

      const next = new Map<string, TokenSnapshot>();
      for (const [m, p] of this.pairs) {
        if (!this.seen.has(m) && !this.pinned.has(m)) continue;
        if (p.liquidityUsd < 1000 && !this.pinned.has(m)) continue;
        const snap = toSnapshot(p);
        const sf = this.safety.get(m);
        if (sf) {
          snap.mintAuthorityRevoked = sf.mintAuthorityRevoked;
          snap.freezeAuthorityRevoked = sf.freezeAuthorityRevoked;
          snap.token2022Risky = sf.token2022Risky;
          snap.top10HolderPct = sf.top10HolderPct;
        }
        const intel = this.intelligence.get(m);
        if (intel) snap.intelligence = intel;
        const sl = this.sells.get(m);
        if (sl) {
          snap.sellRouteOk = sl.ok;
          snap.sellImpactPct = sl.impactPct;
        }
        next.set(m, snap);
      }
      this.current = next;
      this.h = { ok: true, detail: `${next.size} tokens, ${this.rpc ? "on-chain checks on" : "no RPC: tokens stay untradable"}`, lastOkAt: now, failures: 0 };
      return [...next.values()];
    } catch (err) {
      this.fail((err as Error).message);
      return [...this.current.values()];
    }
  }

  /** Spend RPC/Jupiter budget only on tokens that already look tradable, newest checks first, a few per tick. */
  private async enrich(now: number) {
    await this.refreshIntelligence(now);
    if (!this.rpc) return;
    const candidates = [...this.pairs.values()]
      .filter((p) => (this.seen.has(p.mint) || this.pinned.has(p.mint)) && p.liquidityUsd >= 5000 && p.volume5mUsd >= 500)
      .filter((p) => {
        const sf = this.safety.get(p.mint);
        if (!sf) return true;
        const failed = sf.mintAuthorityRevoked === null; // lookup failed: retry within a minute
        return now - sf.checkedAt > (failed ? 60_000 : SAFETY_TTL_MS);
      })
      .sort((a, b) => (this.safety.get(a.mint)?.checkedAt ?? 0) - (this.safety.get(b.mint)?.checkedAt ?? 0) || b.liquidityUsd - a.liquidityUsd);
    for (const p of candidates.slice(0, MAX_SAFETY_PER_TICK)) {
      this.safety.set(p.mint, await checkMintSafety(this.rpc, p.mint, now));
    }
    if (!this.app.jupiterApiKey) return;
    let used = 0;
    for (const p of this.pairs.values()) {
      if (used >= 2) break;
      const sf = this.safety.get(p.mint);
      if (!sf?.decimals || sf.mintAuthorityRevoked !== true) continue;
      if (now - (this.sells.get(p.mint)?.checkedAt ?? 0) < SELL_TTL_MS) continue;
      const r = await checkSellRoute(this.http, this.app.jupiterQuoteUrl, this.app.jupiterApiKey, p.mint, sf.decimals, p.priceSol, 0.3, now);
      used += 1;
      if (r) this.sells.set(p.mint, r);
    }
  }

  /** Indexed pool swaps are sampled periodically; the dashboard clearly labels heuristic confidence. */
  private async refreshIntelligence(now: number) {
    if (!this.app.heliusApiKey) return;
    const candidates = [...this.pairs.values()]
      .filter((p) => (this.seen.has(p.mint) || this.pinned.has(p.mint)) && p.liquidityUsd >= 1500)
      .filter((p) => now - (this.intelligenceAt.get(p.mint) ?? 0) >= 60_000)
      .sort((a, b) => b.volume5mUsd - a.volume5mUsd).slice(0, 2);
    for (const p of candidates) {
      this.intelligenceAt.set(p.mint, now);
      try {
        const url = `https://api.helius.xyz/v0/addresses/${p.pairAddress}/transactions?api-key=${encodeURIComponent(this.app.heliusApiKey)}&limit=100`;
        const txs = await this.http.json<EnhancedSwapTransaction[]>(url);
        const intel = analyzeTransactions(Array.isArray(txs) ? txs : [], p.mint, now);
        if (intel.status === "ready") {
          const traders = [...new Set((txs ?? []).map((tx) => tx.feePayer).filter((x): x is string => Boolean(x)))].slice(0, 5);
          const histories = new Map<string, EnhancedSwapTransaction[]>();
          // A small bounded sample of trader histories provides evidence of common initial funders.
          for (const wallet of traders) {
            try {
              const historyUrl = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${encodeURIComponent(this.app.heliusApiKey)}&limit=30`;
              histories.set(wallet, await this.http.json<EnhancedSwapTransaction[]>(historyUrl));
            } catch { /* partial history is still useful */ }
          }
          const funderClusters = findSharedFunders(histories);
          intel.clusters = [...funderClusters, ...intel.clusters].slice(0, 8);
          intel.sharedFunderWallets = new Set(funderClusters.flatMap((c) => c.wallets)).size;
          if (funderClusters.length) {
            intel.flags.push("Multiple traders in the sample received SOL from a shared funding source");
            intel.suspiciousVolumeScore = Math.min(100, (intel.suspiciousVolumeScore ?? 0) + 12);
            intel.organicVolumeScore = 100 - intel.suspiciousVolumeScore;
          }
        }
        this.intelligence.set(p.mint, intel);
      } catch {
        this.intelligence.set(p.mint, {
          status: "unavailable", transactions: 0, uniqueWallets: 0, organicVolumeScore: null,
          suspiciousVolumeScore: null, confidence: "low", topWalletVolumePct: null,
          repeatedSizePct: null, synchronizedWalletPct: null, roundTripWalletPct: null, sharedFunderWallets: 0,
          clusters: [], flags: ["Indexed transaction history is temporarily unavailable"], updatedAt: now,
        });
      }
    }
  }

  async candles(mint: string, tf: Timeframe): Promise<CandleResult> {
    const p = this.pairs.get(mint);
    if (!p) return { source: "none", candles: [], note: "token not tracked" };
    const key = `${mint}:${tf}`;
    const hit = this.candleCache.get(key);
    if (hit && this.now() - hit.at < 60_000) return hit.result;
    const [timeframe, aggregateN] = tf === "1m" ? ["minute", 1] : tf === "5m" ? ["minute", 5] : ["minute", 15];
    try {
      const url = `${this.gecko}/networks/solana/pools/${p.pairAddress}/ohlcv/${timeframe}?aggregate=${aggregateN}&limit=300&currency=usd`;
      const candles = parseOhlcv(await this.http.json(url), this.solUsd, true);
      if (candles.length) {
        const result = { source: "geckoterminal", candles, note: "prices converted from USD to SOL at the current SOL price" };
        this.candleCache.set(key, { at: this.now(), result });
        return result;
      }
    } catch {
      /* fall through to the recorded history */
    }
    const rec = this.db?.priceHistory(mint, 1500).reverse() ?? [];
    const pts = rec.map((r) => ({ time: Math.floor(r.t / 1000), price: r.price, volume: r.vol }));
    return { source: "recorded", candles: aggregate(pts, TF_SECONDS[tf]), note: "chart service unavailable: built from prices recorded by this app" };
  }
}
