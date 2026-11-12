import type { ActionResult, CandlesView, LabStrategy, LabView, PreviewView, ReportEntry, Summary, TokenDetail, TokenRow, TokensView } from "./api-types";
import { applyStrategyPatch, STRATEGY_BOUNDS } from "./config";
import type { AppConfig, StrategyConfig } from "./config";
import type { Db, StrategyRow } from "./db";
import { Engine } from "./engine";
import type { StepContext } from "./engine";
import { TF_SECONDS, aggregate } from "./feeds/candles";
import { extractFeatures } from "./features";
import { themeHeat, themeOf } from "./narrative";
import type { Notifier } from "./notify";
import { PaperExecutor } from "./executor";
import type { Predictor } from "./predictor";
import { buildDailyReport } from "./reports";
import { hashString, mulberry32 } from "./rng";
import { scan } from "./scanner";
import type { SignalLogger } from "./signals";
import { StrategyStore } from "./store";
import { decideEntry } from "./strategy";
import type { Feed, Timeframe, TokenSnapshot } from "./types";

export interface LabDeps {
  db: Db;
  app: AppConfig;
  feed: Feed;
  predictor: Predictor;
  notifier: Notifier;
  signals: SignalLogger;
  baseCfg: StrategyConfig;
}

export const MAX_STRATEGIES = 6;

/** Starting lineup: the champion uses your .env settings, the challengers vary risk and selectivity. */
const SEED_STRATEGIES: { id: string; name: string; patch: Partial<StrategyConfig>; champion: boolean }[] = [
  { id: "champion", name: "Champion", patch: {}, champion: true },
  {
    id: "cautious",
    name: "Cautious",
    patch: { minScore: 0.7, maxPositionPct: 3, stopLossPct: 15, maxOpenPositions: 3, maxPerTheme: 1 },
    champion: false,
  },
  {
    id: "aggressive",
    name: "Aggressive",
    patch: { minScore: 0.56, maxPositionPct: 7.5, trailingStopPct: 20, maxOpenPositions: 7, maxPerTheme: 3 },
    champion: false,
  },
];

/** Merge stored settings over the defaults (so newly added settings get a value) and fall back if invalid. */
function resolveConfig(base: StrategyConfig, raw: string): StrategyConfig {
  try {
    const merged = applyStrategyPatch(base, JSON.parse(raw), true);
    return merged.ok ? merged.cfg : base;
  } catch {
    return base;
  }
}

export class Lab {
  readonly engines = new Map<string, Engine>();
  tick: number;
  private universe: TokenSnapshot[] = [];
  private byMint = new Map<string, TokenSnapshot>();
  private feedWasOk = true;
  private championId = "champion";

  constructor(readonly d: LabDeps) {
    this.tick = Number(d.db.getMeta("lab_tick") ?? 0);
    this.init();
  }

  private init(): void {
    const { db, baseCfg } = this.d;
    if (db.listStrategies().length === 0) {
      for (const s of SEED_STRATEGIES) {
        const res = applyStrategyPatch(baseCfg, s.patch);
        db.upsertStrategy({
          id: s.id,
          name: s.name,
          config: JSON.stringify(res.ok ? res.cfg : baseCfg),
          champion: s.champion,
          archived: false,
          createdAt: Date.now(),
        });
      }
    }
    const rows = db.listStrategies();
    for (const row of rows) this.createEngine(row);
    this.championId = rows.find((r) => r.champion)?.id ?? rows[0].id;
  }

  private createEngine(row: StrategyRow): Engine {
    const { db, app, feed, predictor, notifier, signals, baseCfg } = this.d;
    const cfg = resolveConfig(baseCfg, row.config);
    const store = new StrategyStore(db, row.id);
    const state = store.load(cfg.startBalanceSol, feed.now());
    const stats = db.equityStats(row.id);
    const executor = new PaperExecutor({
      solUsd: app.solUsd,
      latencyPenaltyPct: app.pessimism.latencyPenaltyPct,
      slippageMultiplier: app.pessimism.slippageMultiplier,
      feePct: app.pessimism.feePct,
      sellFailProb: app.pessimism.sellFailProb,
      lowLiqUsd: app.pessimism.lowLiqUsd,
      rand: mulberry32(hashString(row.id) ^ (app.simSeed ?? 0)),
    });
    const engine = new Engine({
      id: row.id,
      name: row.name,
      cfg,
      state,
      executor,
      predictor,
      notifier,
      signals,
      store,
      getToken: (mint) => this.getToken(mint),
      onDayRollover: (e, day, equity) => this.onDayRollover(e, day, equity),
      peakEquity: stats.peak,
      maxDrawdownPct: stats.maxDrawdownPct,
    });
    this.engines.set(row.id, engine);
    return engine;
  }

  // Loop -------------------------------------------------------------------------------------

  getToken(mint: string): TokenSnapshot | undefined {
    return this.byMint.get(mint) ?? this.d.feed.get(mint);
  }

  async step(): Promise<void> {
    const { feed, db, app, signals } = this.d;
    feed.pin?.([...this.engines.values()].flatMap((e) => e.heldMints()));

    const universe = await feed.tick();
    this.tick += 1;
    const t = feed.now();
    for (const tok of universe) tok.theme = themeOf(tok.symbol, tok.name);
    this.universe = universe;
    this.byMint = new Map(universe.map((x) => [x.mint, x]));

    const health = feed.health();
    if (health.ok !== this.feedWasOk) {
      this.feedWasOk = health.ok;
      void this.d.notifier.send(
        health.ok ? "info" : "warn",
        "feed-health",
        health.ok ? "Data feed recovered. Entries are allowed again." : `Data feed unhealthy: ${health.detail}. New entries are blocked.`,
      );
    }

    const ctx: StepContext = { tick: this.tick, t, entriesAllowed: health.ok, feedNote: health.ok ? null : health.detail, solUsd: app.solUsd };
    signals.resolve(this.byMint, this.tick);
    for (const engine of this.engines.values()) await engine.step(universe, ctx);

    if (app.recordSnapshots && this.tick % app.recordEveryTicks === 0 && universe.length) db.insertSnapshots(this.tick, t, universe);
    db.setMeta("lab_tick", String(this.tick));
    if (this.tick % 1000 === 0) {
      db.prune({ keepEventsPerStrategy: 5000, keepEquityPerStrategy: 50000, keepSnapshotTicks: 6000, currentTick: this.tick });
    }
  }

  private onDayRollover(engine: Engine, day: string, equity: { equityStart: number; equityEnd: number }): void {
    const report = buildDailyReport({
      strategyId: engine.id,
      strategyName: engine.name,
      day,
      state: engine.state,
      equityStart: equity.equityStart,
      equityEnd: equity.equityEnd,
      maxDrawdownPct: engine.maxDrawdownPct,
    });
    this.d.db.saveReport(day, engine.id, Date.now(), report);
    if (engine.id === this.championId) {
      const sign = report.pnlSol >= 0 ? "+" : "";
      void this.d.notifier.send(
        "info",
        `report:${day}`,
        `Daily report ${day} (${engine.name}): ${report.positionsClosed} positions closed, ${report.wins} wins, ${sign}${report.pnlSol.toFixed(4)} SOL.`,
      );
    }
  }

  // Lookups ----------------------------------------------------------------------------------

  champion(): Engine {
    return this.engines.get(this.championId) ?? [...this.engines.values()][0];
  }

  engine(id?: string): Engine | undefined {
    return id ? this.engines.get(id) : this.champion();
  }

  isChampion(id: string): boolean {
    return id === this.championId;
  }

  feedStatus() {
    const h = this.d.feed.health();
    return { kind: this.d.feed.kind, ok: h.ok, detail: h.detail };
  }

  summary(engine: Engine): Summary {
    return {
      ...engine.summary(),
      champion: this.isChampion(engine.id),
      paper: this.d.app.paperMode,
      feed: this.feedStatus(),
      predictor: this.d.predictor.name,
    };
  }

  labView(): LabView {
    const strategies: LabStrategy[] = [...this.engines.values()].map((e) => {
      const s = e.summary();
      return {
        id: e.id,
        name: e.name,
        champion: this.isChampion(e.id),
        paused: s.paused,
        killed: s.killed,
        equitySol: s.equitySol,
        pnlPct: s.pnlPct,
        positionsClosed: s.analysis.trades,
        winRate: s.analysis.winRate,
        expectancyPct: s.analysis.expectancyPct,
        profitFactor: s.analysis.profitFactor,
        maxDrawdownPct: s.analysis.maxDrawdownPct,
        open: s.positions.length,
        config: s.config,
        curve: s.equityCurve.slice(-200),
      };
    });
    return { strategies, feed: this.feedStatus(), paper: this.d.app.paperMode, predictor: this.d.predictor.name, signals: this.d.db.countSignals() };
  }

  tokensView(engine: Engine): TokensView {
    const held = new Set(engine.heldMints());
    const rows: TokenRow[] = this.universe.map((t) => {
      return {
        mint: t.mint,
        symbol: t.symbol,
        theme: t.theme ?? "other",
        price: t.price,
        liquidityUsd: t.liquidityUsd,
        volume5mUsd: t.volume5mUsd,
        buyRatio: t.buyRatio,
        ageMinutes: t.ageMinutes,
        intelligence: t.intelligence,
        score: this.d.predictor.predict(t).probability,
        held: held.has(t.mint),
      };
    });
    rows.sort((a, b) => b.score - a.score);
    return { tokens: rows.slice(0, 150), themes: themeHeat(this.universe), total: rows.length };
  }

  tokenDetail(mint: string, engine: Engine): TokenDetail | null {
    const tok = this.getToken(mint);
    // A closed trade can outlive the token's presence in the market data: still show its history.
    const trades = this.d.db.tradesForMint(engine.id, mint);
    if (!tok && trades.length === 0) return null;
    const snapshot: TokenSnapshot = tok ?? this.snapshotFromTrades(mint, trades[trades.length - 1].symbol);

    const pred = this.d.predictor.predict(snapshot);
    const takes = [...this.engines.values()].map((e) => {
      const s = scan(snapshot, e.cfg);
      const decision = s.pass ? decideEntry(snapshot, pred, e.state, e.cfg, this.d.app.solUsd) : { enter: false, sizeSol: 0, reason: s.reasons[0] ?? "failed safety checks" };
      return { strategyId: e.id, strategyName: e.name, score: pred.probability, wouldEnter: decision.enter, reason: decision.reason };
    });
    return {
      token: snapshot,
      prediction: pred,
      estimate: tok ? engine.preview(tok, null).estimate : null,
      positions: engine.positionViews().filter((p) => p.mint === mint),
      trades,
      takes,
      sim: this.d.feed.kind === "sim",
    };
  }

  private snapshotFromTrades(mint: string, symbol: string): TokenSnapshot {
    return {
      mint, symbol, price: 0, liquidityUsd: 0, volume5mUsd: 0, buyRatio: null, holders: null, top10HolderPct: null,
      mintAuthorityRevoked: null, freezeAuthorityRevoked: null, ageMinutes: 0, smartWalletBuys: null, socialVelocity: null,
    };
  }

  preview(mint: string, sizeSol: number | null, engine: Engine): PreviewView | null {
    const tok = this.getToken(mint);
    return tok ? engine.preview(tok, sizeSol) : null;
  }

  async candles(mint: string, tf: Timeframe): Promise<CandlesView> {
    const stepSec = TF_SECONDS[tf];
    try {
      const res = await this.d.feed.candles(mint, tf);
      if (res.candles.length > 0) return { source: res.source, note: res.note ?? null, candles: res.candles, stepSec };
      // Fall back to our own recorded prices.
      const hist = this.d.db.priceHistory(mint, 2000);
      if (hist.length > 1) {
        const candles = aggregate(hist.map((h) => ({ time: Math.floor(h.t / 1000), price: h.price, volume: h.vol / 5 })), stepSec);
        return { source: "recorded", note: res.note ?? "From the bot's own recorded prices.", candles, stepSec };
      }
      return { source: res.source, note: res.note ?? "No chart data yet.", candles: [], stepSec };
    } catch (err) {
      return { source: "none", note: `Chart data unavailable: ${(err as Error).message}`, candles: [], stepSec };
    }
  }

  reports(engineId: string, limit = 30): ReportEntry[] {
    return this.d.db.listReports(engineId, limit) as ReportEntry[];
  }

  generateReport(engine: Engine, t: number): ReportEntry {
    const s = engine.state;
    const day = s.dayKey;
    const equity = engine.summary().equitySol;
    const data = buildDailyReport({
      strategyId: engine.id,
      strategyName: engine.name,
      day,
      state: s,
      equityStart: s.dayStartEquity,
      equityEnd: equity,
      maxDrawdownPct: engine.maxDrawdownPct,
    });
    this.d.db.saveReport(day, engine.id, t, data);
    return { day, createdAt: t, data };
  }

  // Strategy management ----------------------------------------------------------------------

  addStrategy(name: string, baseId: string, patch: unknown): ActionResult & { id?: string } {
    if (this.engines.size >= MAX_STRATEGIES) return { ok: false, message: `At most ${MAX_STRATEGIES} strategies can run at once.` };
    const cleanName = name.trim().slice(0, 40);
    if (!cleanName) return { ok: false, message: "Give the strategy a name." };
    const base = this.engines.get(baseId);
    if (!base) return { ok: false, message: "Base strategy not found." };
    const res = applyStrategyPatch(base.cfg, patch ?? {});
    if (!res.ok) return { ok: false, message: res.error };

    let id = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "strategy";
    while (this.engines.has(id) || id === "all") id = `${id.slice(0, 20)}-${Math.floor(Math.random() * 1000)}`;

    const row: StrategyRow = { id, name: cleanName, config: JSON.stringify(res.cfg), champion: false, archived: false, createdAt: Date.now() };
    this.d.db.upsertStrategy(row);
    this.createEngine(row);
    return { ok: true, message: `Added strategy "${cleanName}".`, id };
  }

  updateConfig(id: string, patch: unknown): ActionResult {
    const engine = this.engines.get(id);
    if (!engine) return { ok: false, message: "Strategy not found." };
    const res = applyStrategyPatch(engine.cfg, patch);
    if (!res.ok) return { ok: false, message: res.error };
    engine.setConfig(res.cfg);
    this.d.db.upsertStrategy({ id, name: engine.name, config: JSON.stringify(res.cfg), champion: this.isChampion(id), archived: false, createdAt: Date.now() });
    return { ok: true, message: "Settings saved." };
  }

  promote(id: string): ActionResult {
    const engine = this.engines.get(id);
    if (!engine) return { ok: false, message: "Strategy not found." };
    this.championId = id;
    this.d.db.setChampion(id);
    engine.log("system", "Promoted to champion");
    return { ok: true, message: `${engine.name} is now the champion.` };
  }

  archive(id: string): ActionResult {
    if (id === this.championId) return { ok: false, message: "The champion cannot be archived. Promote another strategy first." };
    const engine = this.engines.get(id);
    if (!engine) return { ok: false, message: "Strategy not found." };
    this.d.db.upsertStrategy({ id, name: engine.name, config: JSON.stringify(engine.cfg), champion: false, archived: true, createdAt: Date.now() });
    this.engines.delete(id);
    return { ok: true, message: `Archived ${engine.name}.` };
  }

  control(action: "pause" | "resume" | "kill" | "rearm", target: string): ActionResult {
    const list = target === "all" ? [...this.engines.values()] : [this.engines.get(target)].filter((e): e is Engine => !!e);
    if (list.length === 0) return { ok: false, message: "Strategy not found." };
    for (const e of list) e[action]();
    return { ok: true, message: `${action} applied to ${list.length === 1 ? list[0].name : `${list.length} strategies`}.` };
  }

  bounds() {
    return STRATEGY_BOUNDS;
  }

  featuresOf(mint: string) {
    const t = this.getToken(mint);
    return t ? extractFeatures(t) : null;
  }
}
