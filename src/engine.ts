import { analyze } from "./analyst";
import type { EngineSummary, PositionView, PreviewView } from "./api-types";
import type { StrategyConfig } from "./config";
import { extractFeatures } from "./features";
import type { Notifier } from "./notify";
import type { Predictor } from "./predictor";
import { equityOf, checkEntry, checkExit, exitLevels, openValueSol } from "./risk";
import type { ExitDecision } from "./risk";
import { evaluateRegime } from "./regime";
import { scan } from "./scanner";
import type { SignalLogger } from "./signals";
import { dayKey, trim } from "./store";
import type { StrategyStore } from "./store";
import { decideEntry, MIN_ORDER_SOL, poolCapSol, sizeFor } from "./strategy";
import type { Executor, ExitReason, EventKind, LogEvent, Position, State, TokenSnapshot, Trade } from "./types";

const sol = (n: number) => n.toFixed(4);

export interface StepContext {
  tick: number;
  /** Market time in ms */
  t: number;
  /** False when the data feed is unhealthy: open positions are still managed, but nothing new is bought */
  entriesAllowed: boolean;
  feedNote: string | null;
  solUsd: number;
}

export interface EngineDeps {
  id: string;
  name: string;
  cfg: StrategyConfig;
  state: State;
  executor: Executor;
  predictor: Predictor;
  notifier: Notifier;
  signals: SignalLogger;
  store: StrategyStore;
  getToken: (mint: string) => TokenSnapshot | undefined;
  onDayRollover?: (engine: Engine, previousDay: string, equity: { equityStart: number; equityEnd: number }) => void;
  /** Peak equity and max drawdown so far (restored from stored history on start) */
  peakEquity: number;
  maxDrawdownPct: number;
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
}

const MISSING_TICKS_BEFORE_CLOSE = 3;

export class Engine {
  readonly id: string;
  name: string;
  cfg: StrategyConfig;
  readonly state: State;
  readonly counters = { scanned: 0, rejected: 0, scored: 0, entered: 0 };

  private pendingTrades: Trade[] = [];
  private pendingEvents: LogEvent[] = [];
  private seenRejects = new Set<string>();
  private lastRiskLog = new Map<string, number>();
  private missing = new Map<string, number>();
  private orderFailures = 0;
  private dailyLossAlerted = false;
  private peakEquity: number;
  private maxDd: number;
  private lastCtx: StepContext | null = null;

  constructor(private deps: EngineDeps) {
    this.id = deps.id;
    this.name = deps.name;
    this.cfg = deps.cfg;
    this.state = deps.state;
    this.peakEquity = deps.peakEquity;
    this.maxDd = deps.maxDrawdownPct;
  }

  get predictorName(): string {
    return this.deps.predictor.name;
  }

  get maxDrawdownPct(): number {
    return this.maxDd;
  }

  heldMints(): string[] {
    return this.state.positions.map((p) => p.mint);
  }

  setConfig(cfg: StrategyConfig): void {
    this.cfg = cfg;
    this.log("system", "Settings updated", this.lastCtx?.t);
  }

  // Controls ---------------------------------------------------------------------------------

  pause(): void {
    this.state.paused = true;
    this.log("system", "Paused: no new entries. Open positions keep their stops.");
  }

  resume(): void {
    this.state.paused = false;
    this.log("system", "Resumed");
  }

  kill(): void {
    this.state.killed = true;
    this.log("risk", "KILL SWITCH: closing all positions and blocking entries");
    void this.deps.notifier.send("critical", `kill:${this.id}`, `Kill switch pressed on strategy "${this.name}". Closing all positions.`);
  }

  rearm(): void {
    this.state.killed = false;
    this.state.paused = false;
    this.log("system", "Kill switch cleared");
  }

  // Main loop --------------------------------------------------------------------------------

  async step(universe: TokenSnapshot[], ctx: StepContext): Promise<void> {
    const s = this.state;
    this.lastCtx = ctx;
    s.tick = ctx.tick;

    const today = dayKey(ctx.t);
    if (s.dayKey !== today) {
      const previous = s.dayKey;
      const equityStart = s.dayStartEquity;
      s.dayKey = today;
      s.dayStartEquity = equityOf(s);
      this.dailyLossAlerted = false;
      this.log("system", `New day: starting equity ${sol(s.dayStartEquity)} SOL`, ctx.t);
      this.deps.onDayRollover?.(this, previous, { equityStart, equityEnd: s.dayStartEquity });
    }

    const byMint = new Map(universe.map((t) => [t.mint, t]));
    await this.manageOpenPositions(byMint, ctx);

    if (ctx.tick >= s.coldUntilTick) {
      const verdict = evaluateRegime(s, universe, this.cfg);
      if (verdict.cold) {
        s.coldUntilTick = ctx.tick + this.cfg.regimeCooldownTicks;
        s.lastColdTick = ctx.tick;
        const msg = `Regime guard: no new entries for ${this.cfg.regimeCooldownTicks} ticks (${verdict.reason})`;
        this.log("risk", msg, ctx.t);
        void this.deps.notifier.send("warn", `regime:${this.id}`, `${this.name}: ${msg}`);
      }
    }
    const cold = ctx.tick < s.coldUntilTick;

    if (!ctx.entriesAllowed) {
      this.riskLog("feed", `Entries blocked: ${ctx.feedNote ?? "data feed unhealthy"}`, ctx);
    } else if (!s.paused && !s.killed && !cold) {
      await this.lookForEntries(universe, ctx);
    }

    const equity = equityOf(s);
    s.equityCurve.push({ t: ctx.t, equity });
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (this.peakEquity > 0) this.maxDd = Math.max(this.maxDd, ((this.peakEquity - equity) / this.peakEquity) * 100);

    if (!s.killed) {
      const dayLossPct = ((s.dayStartEquity - equity) / s.dayStartEquity) * 100;
      if (dayLossPct >= this.cfg.dailyLossLimitPct && !this.dailyLossAlerted) {
        this.dailyLossAlerted = true;
        const msg = `Daily loss limit reached (-${dayLossPct.toFixed(1)}%): entries blocked until tomorrow`;
        this.log("risk", msg, ctx.t);
        void this.deps.notifier.send("critical", `dayloss:${this.id}`, `${this.name}: ${msg}`);
      }
    }

    trim(s);
    this.flush(ctx, equity);
  }

  private flush(ctx: StepContext, equity: number): void {
    const trades = this.pendingTrades;
    const events = this.pendingEvents;
    this.pendingTrades = [];
    this.pendingEvents = [];
    try {
      this.deps.store.save(this.state, trades, events, ctx.tick, ctx.t, equity);
    } catch (err) {
      console.error(`[engine:${this.id}] failed to save state:`, err);
      // keep what was not saved so the next step retries
      this.pendingTrades = trades.concat(this.pendingTrades);
      this.pendingEvents = events.concat(this.pendingEvents);
    }
  }

  private async manageOpenPositions(byMint: Map<string, TokenSnapshot>, ctx: StepContext): Promise<void> {
    const s = this.state;
    for (const pos of [...s.positions]) {
      const tok = byMint.get(pos.mint) ?? this.deps.getToken(pos.mint);
      if (!tok) {
        // The token dropped out of the data feed. Tolerate a short gap (API hiccups), then close at the last known price.
        const gap = (this.missing.get(pos.id) ?? 0) + 1;
        this.missing.set(pos.id, gap);
        if (gap >= MISSING_TICKS_BEFORE_CLOSE) this.closeFill(pos, pos.lastPrice, 1, "feed_lost", ctx);
        continue;
      }
      this.missing.delete(pos.id);

      pos.lastPrice = tok.price;
      pos.peakPrice = Math.max(pos.peakPrice, tok.price);

      const decision: ExitDecision | null = s.killed ? { reason: "kill_switch", fraction: 1 } : checkExit(pos, tok, ctx.tick, this.cfg);
      if (!decision) continue;

      const res = await this.deps.executor.sell(tok, pos.qty * decision.fraction);
      if (res.ok) {
        this.orderFailures = 0;
        this.closeFill(pos, res.fillPrice, decision.fraction, decision.reason, ctx);
      } else {
        this.orderFailed(`sell:${pos.id}`, `Sell failed for ${pos.symbol}: ${res.error ?? "unknown error"} (will retry)`, ctx);
      }
    }
  }

  private async lookForEntries(universe: TokenSnapshot[], ctx: StepContext): Promise<void> {
    const s = this.state;
    const candidates: { tok: TokenSnapshot; probability: number; factors: string[]; features: ReturnType<typeof extractFeatures> }[] = [];

    for (const tok of universe) {
      if (s.positions.some((p) => p.mint === tok.mint)) continue;

      this.counters.scanned += 1;
      const res = scan(tok, this.cfg);
      if (!res.pass) {
        this.counters.rejected += 1;
        if (!this.seenRejects.has(tok.mint) && tok.ageMinutes >= 3) {
          this.seenRejects.add(tok.mint);
          this.log("scan_reject", `${tok.symbol}: ${res.reasons.join("; ")}`, ctx.t);
        }
        continue;
      }
      const pred = this.deps.predictor.predict(tok);
      this.counters.scored += 1;
      candidates.push({ tok, probability: pred.probability, factors: pred.factors, features: extractFeatures(tok) });
    }

    // Best score first, so limited slots (and the exposure cap) go to the strongest signals.
    candidates.sort((a, b) => b.probability - a.probability);

    for (const c of candidates) {
      const { tok } = c;
      const pred = { probability: c.probability, factors: c.factors };
      const decision = decideEntry(tok, pred, s, this.cfg, ctx.solUsd);
      if (!decision.enter) {
        const kind = decision.reason.startsWith("size") ? "size_too_small" : "below_threshold";
        this.deps.signals.record(ctx, tok, c.features, this.id, c.probability, kind, decision.reason, null);
        continue;
      }

      const risk = checkEntry(s, tok, decision.sizeSol, this.cfg, ctx.tick);
      if (!risk.ok) {
        this.deps.signals.record(ctx, tok, c.features, this.id, c.probability, "vetoed", risk.reason, null);
        this.riskLog(risk.reason, `Entry on ${tok.symbol} vetoed: ${risk.reason}`, ctx);
        continue;
      }

      const res = await this.deps.executor.buy(tok, decision.sizeSol);
      if (!res.ok) {
        this.deps.signals.record(ctx, tok, c.features, this.id, c.probability, "order_failed", res.error ?? "unknown", null);
        this.orderFailed(`buy:${res.error}`, `Buy on ${tok.symbol} rejected: ${res.error ?? "unknown error"}`, ctx);
        continue;
      }
      this.orderFailures = 0;

      const id = `${tok.mint}-${ctx.tick}`;
      const signalId = this.deps.signals.record(ctx, tok, c.features, this.id, c.probability, "entered", decision.reason, id, true);
      this.openPosition(tok, res.fillPrice, res.qty, decision.sizeSol, c.probability, "auto", id, signalId, ctx);
      this.log("entry", `BUY ${tok.symbol} ${sol(decision.sizeSol)} SOL (${decision.reason}; ${c.factors.join(", ") || "no standout factors"})`, ctx.t);
    }
  }

  private openPosition(
    tok: TokenSnapshot,
    fillPrice: number,
    qty: number,
    sizeSol: number,
    score: number,
    source: "auto" | "manual",
    id: string,
    signalId: number | null,
    ctx: StepContext,
  ): void {
    const pos: Position = {
      id,
      mint: tok.mint,
      symbol: tok.symbol,
      theme: tok.theme ?? "other",
      entryPrice: fillPrice,
      qty,
      sizeSol,
      originalSizeSol: sizeSol,
      openedAt: ctx.t,
      openedTick: ctx.tick,
      peakPrice: fillPrice,
      lastPrice: tok.price,
      score,
      tp1Done: false,
      fills: 0,
      source,
      signalId,
    };
    this.state.balanceSol -= sizeSol;
    this.state.positions.push(pos);
    this.counters.entered += 1;
  }

  /** Sell `fraction` of a position's remaining quantity. A full sale removes the position. */
  private closeFill(pos: Position, fillPrice: number, fraction: number, reason: ExitReason, ctx: StepContext): void {
    const s = this.state;
    const full = fraction >= 0.999999;
    const qtySold = full ? pos.qty : pos.qty * fraction;
    const costClosed = full ? pos.sizeSol : pos.sizeSol * fraction;
    const proceeds = qtySold * fillPrice;
    const pnlSol = proceeds - costClosed;
    const pnlPct = (pnlSol / Math.max(costClosed, 1e-12)) * 100;

    pos.fills += 1;
    s.balanceSol += proceeds;

    const trade: Trade = {
      id: `${pos.id}#${pos.fills}`,
      positionId: pos.id,
      mint: pos.mint,
      symbol: pos.symbol,
      theme: pos.theme,
      entryPrice: pos.entryPrice,
      exitPrice: fillPrice,
      sizeSol: costClosed,
      positionSizeSol: pos.originalSizeSol,
      pnlSol,
      pnlPct,
      openedAt: pos.openedAt,
      closedAt: ctx.t,
      closedTick: ctx.tick,
      heldTicks: ctx.tick - pos.openedTick,
      score: pos.score,
      reason,
      partial: !full,
      source: pos.source,
    };
    s.trades.push(trade);
    this.pendingTrades.push(trade);

    if (full) {
      s.positions = s.positions.filter((p) => p.id !== pos.id);
      this.missing.delete(pos.id);
    } else {
      pos.qty -= qtySold;
      pos.sizeSol -= costClosed;
      if (reason === "take_profit_1") pos.tp1Done = true;
    }

    const what = full ? "SELL" : `SELL ${(fraction * 100).toFixed(0)}% of`;
    this.log("exit", `${what} ${pos.symbol} (${reason}) ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% / ${pnlSol >= 0 ? "+" : ""}${sol(pnlSol)} SOL`, ctx.t);
  }

  // Manual trading: goes through the same safety checks and limits --------------------------

  /** What a manual buy of this size would cost and whether the risk manager would allow it. */
  preview(token: TokenSnapshot, sizeSol: number | null): PreviewView {
    const ctx = this.lastCtx;
    const solUsd = ctx?.solUsd ?? 150;
    const pred = this.deps.predictor.predict(token);
    const maxSizeSol = Math.floor(Math.min(this.state.balanceSol * (this.cfg.maxPositionPct / 100), poolCapSol(token, this.cfg, solUsd)) * 1e6) / 1e6;
    const size = sizeSol ?? maxSizeSol;
    const risk = checkEntry(this.state, token, size, this.cfg, ctx?.tick ?? this.state.tick);
    return {
      estimate: this.deps.executor.estimate ? this.deps.executor.estimate(token, size) : null,
      maxSizeSol,
      riskOk: risk.ok && size >= MIN_ORDER_SOL && size <= maxSizeSol + 1e-9,
      riskReason: size > maxSizeSol + 1e-9 ? `above the cap of ${maxSizeSol} SOL` : size < MIN_ORDER_SOL ? "size too small" : risk.reason,
      score: pred.probability,
    };
  }

  async manualBuy(mint: string, requestedSol: number | null): Promise<ActionOutcome> {
    const ctx = this.lastCtx;
    const tok = this.deps.getToken(mint);
    if (!ctx || !tok) return { ok: false, message: "Token is not in the current market data." };
    if (!this.cfg || this.state.positions.some((p) => p.mint === mint)) return { ok: false, message: "Already holding this token." };

    const scanRes = scan(tok, this.cfg);
    if (!scanRes.pass) return { ok: false, message: `Blocked by the safety checks: ${scanRes.reasons.join("; ")}` };

    const pv = this.preview(tok, requestedSol);
    const size = Math.min(requestedSol ?? pv.maxSizeSol, pv.maxSizeSol);
    if (size < MIN_ORDER_SOL) return { ok: false, message: "Size too small for this pool or balance." };
    const risk = checkEntry(this.state, tok, size, this.cfg, ctx.tick);
    if (!risk.ok) return { ok: false, message: `Blocked by the risk manager: ${risk.reason}` };

    const res = await this.deps.executor.buy(tok, size);
    if (!res.ok) return { ok: false, message: `Order failed: ${res.error ?? "unknown error"}` };

    const id = `${tok.mint}-m${ctx.tick}`;
    const signalId = this.deps.signals.record(ctx, tok, extractFeatures(tok), this.id, pv.score, "entered", "manual", id, true);
    this.openPosition(tok, res.fillPrice, res.qty, size, pv.score, "manual", id, signalId, ctx);
    this.log("entry", `MANUAL BUY ${tok.symbol} ${sol(size)} SOL`, ctx.t);
    const note = requestedSol !== null && requestedSol > size ? ` (reduced from ${sol(requestedSol)} to the cap)` : "";
    return { ok: true, message: `Bought ${tok.symbol} for ${sol(size)} SOL${note}.` };
  }

  async manualClose(positionId: string): Promise<ActionOutcome> {
    const ctx = this.lastCtx;
    const pos = this.state.positions.find((p) => p.id === positionId);
    if (!ctx || !pos) return { ok: false, message: "Position not found." };
    const tok = this.deps.getToken(pos.mint);
    if (!tok) return { ok: false, message: "Token is not in the current market data." };
    const res = await this.deps.executor.sell(tok, pos.qty);
    if (!res.ok) return { ok: false, message: `Order failed: ${res.error ?? "unknown error"}` };
    this.closeFill(pos, res.fillPrice, 1, "manual", ctx);
    return { ok: true, message: `Closed ${pos.symbol}.` };
  }

  // Helpers ----------------------------------------------------------------------------------

  log(kind: EventKind, msg: string, t?: number): void {
    const ev: LogEvent = { t: t ?? this.lastCtx?.t ?? Date.now(), kind, msg };
    this.state.events.push(ev);
    this.pendingEvents.push(ev);
  }

  /** Avoid flooding the log with the same veto every tick. */
  private riskLog(key: string, msg: string, ctx: StepContext): void {
    const last = this.lastRiskLog.get(key) ?? -Infinity;
    if (ctx.tick - last >= 30) {
      this.lastRiskLog.set(key, ctx.tick);
      this.log("risk", msg, ctx.t);
    }
  }

  private orderFailed(key: string, msg: string, ctx: StepContext): void {
    this.riskLog(key, msg, ctx);
    this.orderFailures += 1;
    if (this.orderFailures === 5) {
      void this.deps.notifier.send("warn", `orders:${this.id}`, `${this.name}: ${this.orderFailures} order failures in a row. Latest: ${msg}`);
    }
  }

  // Read model for the API -------------------------------------------------------------------

  positionViews(): PositionView[] {
    const tick = this.state.tick;
    return this.state.positions.map((p) => ({
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      theme: p.theme,
      sizeSol: p.sizeSol,
      originalSizeSol: p.originalSizeSol,
      entryPrice: p.entryPrice,
      lastPrice: p.lastPrice,
      pnlPct: (p.lastPrice / p.entryPrice - 1) * 100,
      valueSol: p.qty * p.lastPrice,
      heldTicks: tick - p.openedTick,
      openedAt: p.openedAt,
      score: p.score,
      tp1Done: p.tp1Done,
      source: p.source,
      levels: exitLevels(p, this.cfg),
    }));
  }

  summary(): EngineSummary {
    const s = this.state;
    const equity = equityOf(s);
    return {
      strategyId: this.id,
      strategyName: this.name,
      tick: s.tick,
      t: this.lastCtx?.t ?? Date.now(),
      paused: s.paused,
      killed: s.killed,
      balanceSol: s.balanceSol,
      equitySol: equity,
      startBalanceSol: s.startBalanceSol,
      pnlSol: equity - s.startBalanceSol,
      pnlPct: ((equity - s.startBalanceSol) / s.startBalanceSol) * 100,
      exposurePct: (openValueSol(s) / Math.max(equity, 1e-9)) * 100,
      positions: this.positionViews(),
      trades: s.trades.slice(-60).reverse(),
      events: s.events.slice(-150).reverse(),
      equityCurve: s.equityCurve.slice(-300),
      analysis: analyze(s, this.maxDd),
      counters: this.counters,
      config: this.cfg,
      regime: { cold: s.tick < s.coldUntilTick, ticksLeft: Math.max(0, s.coldUntilTick - s.tick) },
    };
  }
}
