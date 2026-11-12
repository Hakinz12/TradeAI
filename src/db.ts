import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { LogEvent, Position, TokenSnapshot, Trade } from "./types";

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  champion INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE strategy_state (
  strategy_id TEXT PRIMARY KEY,
  balance_sol REAL NOT NULL,
  start_balance_sol REAL NOT NULL,
  paused INTEGER NOT NULL,
  killed INTEGER NOT NULL,
  day_key TEXT NOT NULL,
  day_start_equity REAL NOT NULL,
  tick INTEGER NOT NULL,
  cold_until_tick INTEGER NOT NULL,
  last_cold_tick INTEGER NOT NULL
);

CREATE TABLE positions (id TEXT NOT NULL, strategy_id TEXT NOT NULL, mint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (strategy_id, id));
CREATE INDEX positions_strategy ON positions(strategy_id);

CREATE TABLE trades (
  id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  closed_tick INTEGER NOT NULL,
  pnl_sol REAL NOT NULL,
  pnl_pct REAL NOT NULL,
  reason TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (strategy_id, id)
);
CREATE INDEX trades_strategy ON trades(strategy_id, closed_at);
CREATE INDEX trades_mint ON trades(strategy_id, mint);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  t INTEGER NOT NULL,
  kind TEXT NOT NULL,
  msg TEXT NOT NULL
);
CREATE INDEX events_strategy ON events(strategy_id, id);

CREATE TABLE equity (strategy_id TEXT NOT NULL, t INTEGER NOT NULL, tick INTEGER NOT NULL, equity REAL NOT NULL);
CREATE INDEX equity_strategy ON equity(strategy_id, tick);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  t INTEGER NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  features TEXT NOT NULL,
  source TEXT NOT NULL,
  label INTEGER,
  label_pct REAL,
  label_tick INTEGER,
  label_kind TEXT
);
CREATE INDEX signals_mint ON signals(mint, tick);
CREATE INDEX signals_label ON signals(label);

CREATE TABLE decisions (
  signal_id INTEGER NOT NULL,
  strategy_id TEXT NOT NULL,
  score REAL NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  position_id TEXT
);
CREATE INDEX decisions_signal ON decisions(signal_id);
CREATE INDEX decisions_position ON decisions(position_id);

CREATE TABLE snapshots (tick INTEGER NOT NULL, t INTEGER NOT NULL, mint TEXT NOT NULL, price REAL NOT NULL, vol REAL NOT NULL, data TEXT NOT NULL);
CREATE INDEX snapshots_tick ON snapshots(tick);
CREATE INDEX snapshots_mint ON snapshots(mint, tick);

CREATE TABLE reports (day TEXT NOT NULL, strategy_id TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (day, strategy_id));
`;

export interface StrategyRow {
  id: string;
  name: string;
  config: string;
  champion: boolean;
  archived: boolean;
  createdAt: number;
}

export interface StateRow {
  balanceSol: number;
  startBalanceSol: number;
  paused: boolean;
  killed: boolean;
  dayKey: string;
  dayStartEquity: number;
  tick: number;
  coldUntilTick: number;
  lastColdTick: number;
}

export interface SignalRow {
  tick: number;
  t: number;
  mint: string;
  symbol: string;
  price: number;
  features: string;
  source: string;
}

export interface ExportedSignal {
  id: number;
  tick: number;
  t: number;
  mint: string;
  symbol: string;
  source: string;
  features: Record<string, number>;
  label: number | null;
  labelPct: number | null;
  labelKind: string | null;
}

export class Db {
  readonly raw: Database.Database;
  private cache = new Map<string, Database.Statement>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.raw = new Database(file);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    const v = this.raw.pragma("user_version", { simple: true }) as number;
    if (v >= SCHEMA_VERSION) return;
    this.raw.exec(DDL);
    this.raw.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.raw.close();
  }

  private stmt(sql: string): Database.Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  tx<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  // meta -------------------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    return (this.stmt("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // strategies -------------------------------------------------------------------------------

  listStrategies(): StrategyRow[] {
    const rows = this.stmt("SELECT * FROM strategies WHERE archived = 0 ORDER BY created_at, id").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      config: r.config as string,
      champion: r.champion === 1,
      archived: r.archived === 1,
      createdAt: r.created_at as number,
    }));
  }

  upsertStrategy(row: StrategyRow): void {
    this.stmt(
      `INSERT INTO strategies (id, name, config, champion, archived, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, champion = excluded.champion, archived = excluded.archived`,
    ).run(row.id, row.name, row.config, row.champion ? 1 : 0, row.archived ? 1 : 0, row.createdAt);
  }

  setChampion(id: string): void {
    this.tx(() => {
      this.stmt("UPDATE strategies SET champion = 0").run();
      this.stmt("UPDATE strategies SET champion = 1 WHERE id = ?").run(id);
    });
  }

  // strategy state ---------------------------------------------------------------------------

  loadState(id: string): StateRow | undefined {
    const r = this.stmt("SELECT * FROM strategy_state WHERE strategy_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      balanceSol: r.balance_sol as number,
      startBalanceSol: r.start_balance_sol as number,
      paused: r.paused === 1,
      killed: r.killed === 1,
      dayKey: r.day_key as string,
      dayStartEquity: r.day_start_equity as number,
      tick: r.tick as number,
      coldUntilTick: r.cold_until_tick as number,
      lastColdTick: r.last_cold_tick as number,
    };
  }

  saveState(id: string, s: StateRow): void {
    this.stmt(
      `INSERT INTO strategy_state (strategy_id, balance_sol, start_balance_sol, paused, killed, day_key, day_start_equity, tick, cold_until_tick, last_cold_tick)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(strategy_id) DO UPDATE SET balance_sol = excluded.balance_sol, start_balance_sol = excluded.start_balance_sol,
         paused = excluded.paused, killed = excluded.killed, day_key = excluded.day_key, day_start_equity = excluded.day_start_equity,
         tick = excluded.tick, cold_until_tick = excluded.cold_until_tick, last_cold_tick = excluded.last_cold_tick`,
    ).run(id, s.balanceSol, s.startBalanceSol, s.paused ? 1 : 0, s.killed ? 1 : 0, s.dayKey, s.dayStartEquity, s.tick, s.coldUntilTick, s.lastColdTick);
  }

  // positions --------------------------------------------------------------------------------

  loadPositions(id: string): Position[] {
    const rows = this.stmt("SELECT data FROM positions WHERE strategy_id = ?").all(id) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Position);
  }

  replacePositions(id: string, positions: Position[]): void {
    this.tx(() => {
      this.stmt("DELETE FROM positions WHERE strategy_id = ?").run(id);
      const ins = this.stmt("INSERT INTO positions (id, strategy_id, mint, data) VALUES (?, ?, ?, ?)");
      for (const p of positions) ins.run(p.id, id, p.mint, JSON.stringify(p));
    });
  }

  // trades -----------------------------------------------------------------------------------

  insertTrades(id: string, trades: Trade[]): void {
    const ins = this.stmt(
      `INSERT OR REPLACE INTO trades (id, strategy_id, position_id, mint, symbol, closed_at, closed_tick, pnl_sol, pnl_pct, reason, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of trades) ins.run(t.id, id, t.positionId, t.mint, t.symbol, t.closedAt, t.closedTick, t.pnlSol, t.pnlPct, t.reason, JSON.stringify(t));
  }

  recentTrades(id: string, limit: number): Trade[] {
    const rows = this.stmt("SELECT data FROM trades WHERE strategy_id = ? ORDER BY rowid DESC LIMIT ?").all(id, limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Trade).reverse();
  }

  tradesForMint(id: string, mint: string): Trade[] {
    const rows = this.stmt("SELECT data FROM trades WHERE strategy_id = ? AND mint = ? ORDER BY rowid").all(id, mint) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Trade);
  }

  // events -----------------------------------------------------------------------------------

  insertEvents(id: string, events: LogEvent[]): void {
    const ins = this.stmt("INSERT INTO events (strategy_id, t, kind, msg) VALUES (?, ?, ?, ?)");
    for (const e of events) ins.run(id, e.t, e.kind, e.msg);
  }

  recentEvents(id: string, limit: number): LogEvent[] {
    const rows = this.stmt("SELECT t, kind, msg FROM events WHERE strategy_id = ? ORDER BY id DESC LIMIT ?").all(id, limit) as LogEvent[];
    return rows.reverse();
  }

  // equity -----------------------------------------------------------------------------------

  insertEquity(id: string, t: number, tick: number, equity: number): void {
    this.stmt("INSERT INTO equity (strategy_id, t, tick, equity) VALUES (?, ?, ?, ?)").run(id, t, tick, equity);
  }

  recentEquity(id: string, limit: number): { t: number; equity: number }[] {
    const rows = this.stmt("SELECT t, equity FROM equity WHERE strategy_id = ? ORDER BY tick DESC LIMIT ?").all(id, limit) as { t: number; equity: number }[];
    return rows.reverse();
  }

  /** Peak equity and max drawdown over the stored history, to restore the engine's running figures. */
  equityStats(id: string): { peak: number; maxDrawdownPct: number } {
    let peak = 0;
    let maxDd = 0;
    for (const row of this.stmt("SELECT equity FROM equity WHERE strategy_id = ? ORDER BY tick").iterate(id) as Iterable<{ equity: number }>) {
      if (row.equity > peak) peak = row.equity;
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - row.equity) / peak) * 100);
    }
    return { peak, maxDrawdownPct: maxDd };
  }

  // signals ----------------------------------------------------------------------------------

  insertSignal(s: SignalRow): number {
    const r = this.stmt("INSERT INTO signals (tick, t, mint, symbol, price, features, source) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      s.tick, s.t, s.mint, s.symbol, s.price, s.features, s.source,
    );
    return Number(r.lastInsertRowid);
  }

  insertDecision(signalId: number, strategyId: string, score: number, decision: string, reason: string, positionId: string | null): void {
    this.stmt("INSERT INTO decisions (signal_id, strategy_id, score, decision, reason, position_id) VALUES (?, ?, ?, ?, ?, ?)").run(
      signalId, strategyId, score, decision, reason, positionId,
    );
  }

  setLabel(signalId: number, label: number, pct: number, tick: number, kind: string): void {
    this.stmt("UPDATE signals SET label = ?, label_pct = ?, label_tick = ?, label_kind = ? WHERE id = ?").run(label, pct, tick, kind, signalId);
  }

  /** Labelled signals in time order, for the Python training pipeline. */
  exportSignals(onlyLabelled: boolean): ExportedSignal[] {
    const sql = `SELECT id, tick, t, mint, symbol, source, features, label, label_pct, label_kind FROM signals ${
      onlyLabelled ? "WHERE label IS NOT NULL" : ""
    } ORDER BY tick, id`;
    const rows = this.stmt(sql).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      tick: r.tick as number,
      t: r.t as number,
      mint: r.mint as string,
      symbol: r.symbol as string,
      source: r.source as string,
      features: JSON.parse(r.features as string) as Record<string, number>,
      label: r.label as number | null,
      labelPct: r.label_pct as number | null,
      labelKind: r.label_kind as string | null,
    }));
  }

  countSignals(): { total: number; labelled: number } {
    const r = this.stmt("SELECT COUNT(*) AS total, SUM(CASE WHEN label IS NOT NULL THEN 1 ELSE 0 END) AS labelled FROM signals").get() as {
      total: number;
      labelled: number | null;
    };
    return { total: r.total, labelled: r.labelled ?? 0 };
  }

  // snapshots (recording for charts and replay) ----------------------------------------------

  insertSnapshots(tick: number, t: number, tokens: TokenSnapshot[]): void {
    const ins = this.stmt("INSERT INTO snapshots (tick, t, mint, price, vol, data) VALUES (?, ?, ?, ?, ?, ?)");
    this.tx(() => {
      for (const tok of tokens) ins.run(tick, t, tok.mint, tok.price, tok.volume5mUsd, JSON.stringify(tok));
    });
  }

  snapshotTicks(): { tick: number; t: number }[] {
    return this.stmt("SELECT DISTINCT tick, t FROM snapshots ORDER BY tick").all() as { tick: number; t: number }[];
  }

  snapshotsAt(tick: number): TokenSnapshot[] {
    const rows = this.stmt("SELECT data FROM snapshots WHERE tick = ?").all(tick) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as TokenSnapshot);
  }

  priceHistory(mint: string, limit: number): { tick: number; t: number; price: number; vol: number }[] {
    const rows = this.stmt("SELECT tick, t, price, vol FROM snapshots WHERE mint = ? ORDER BY tick DESC LIMIT ?").all(mint, limit) as {
      tick: number;
      t: number;
      price: number;
      vol: number;
    }[];
    return rows.reverse();
  }

  // reports ----------------------------------------------------------------------------------

  saveReport(day: string, strategyId: string, createdAt: number, data: unknown): void {
    this.stmt(
      `INSERT INTO reports (day, strategy_id, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, strategy_id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`,
    ).run(day, strategyId, createdAt, JSON.stringify(data));
  }

  listReports(strategyId: string, limit: number): { day: string; createdAt: number; data: unknown }[] {
    const rows = this.stmt("SELECT day, created_at, data FROM reports WHERE strategy_id = ? ORDER BY day DESC LIMIT ?").all(strategyId, limit) as {
      day: string;
      created_at: number;
      data: string;
    }[];
    return rows.map((r) => ({ day: r.day, createdAt: r.created_at, data: JSON.parse(r.data) }));
  }

  // housekeeping -----------------------------------------------------------------------------

  /** Keep the database from growing without bound. Signals and trades are never pruned: they are the training data. */
  prune(opts: { keepEventsPerStrategy: number; keepEquityPerStrategy: number; keepSnapshotTicks: number; currentTick: number }): void {
    this.tx(() => {
      for (const s of this.listStrategies()) {
        this.stmt("DELETE FROM events WHERE strategy_id = ? AND id NOT IN (SELECT id FROM events WHERE strategy_id = ? ORDER BY id DESC LIMIT ?)").run(
          s.id, s.id, opts.keepEventsPerStrategy,
        );
        this.stmt("DELETE FROM equity WHERE strategy_id = ? AND tick < (SELECT COALESCE(MIN(tick), 0) FROM (SELECT tick FROM equity WHERE strategy_id = ? ORDER BY tick DESC LIMIT ?))").run(
          s.id, s.id, opts.keepEquityPerStrategy,
        );
      }
      this.stmt("DELETE FROM snapshots WHERE tick < ?").run(opts.currentTick - opts.keepSnapshotTicks);
    });
  }
}
