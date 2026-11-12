import type { Db } from "./db";
import type { LogEvent, State, Trade } from "./types";

export const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);

const MAX_TRADES_IN_MEMORY = 5000;
const MAX_EVENTS_IN_MEMORY = 300;
const MAX_CURVE_IN_MEMORY = 600;

export function newState(startBalanceSol: number, t: number): State {
  return {
    balanceSol: startBalanceSol,
    startBalanceSol,
    positions: [],
    trades: [],
    events: [],
    equityCurve: [],
    paused: false,
    killed: false,
    dayKey: dayKey(t),
    dayStartEquity: startBalanceSol,
    tick: 0,
    coldUntilTick: 0,
    lastColdTick: -1,
  };
}

/** Persists one strategy's state in SQLite. The engine keeps working in memory; this writes through. */
export class StrategyStore {
  private lastPositionsJson = "";

  constructor(private db: Db, readonly id: string) {}

  load(startBalanceSol: number, t: number): State {
    const row = this.db.loadState(this.id);
    if (!row) return newState(startBalanceSol, t);
    const positions = this.db.loadPositions(this.id);
    this.lastPositionsJson = JSON.stringify(positions);
    return {
      ...row,
      positions,
      trades: this.db.recentTrades(this.id, MAX_TRADES_IN_MEMORY),
      events: this.db.recentEvents(this.id, MAX_EVENTS_IN_MEMORY),
      equityCurve: this.db.recentEquity(this.id, MAX_CURVE_IN_MEMORY),
    };
  }

  save(state: State, newTrades: Trade[], newEvents: LogEvent[], tick: number, t: number, equity: number): void {
    this.db.tx(() => {
      this.db.saveState(this.id, {
        balanceSol: state.balanceSol,
        startBalanceSol: state.startBalanceSol,
        paused: state.paused,
        killed: state.killed,
        dayKey: state.dayKey,
        dayStartEquity: state.dayStartEquity,
        tick: state.tick,
        coldUntilTick: state.coldUntilTick,
        lastColdTick: state.lastColdTick,
      });
      const posJson = JSON.stringify(state.positions);
      if (posJson !== this.lastPositionsJson) {
        this.db.replacePositions(this.id, state.positions);
        this.lastPositionsJson = posJson;
      }
      if (newTrades.length) this.db.insertTrades(this.id, newTrades);
      if (newEvents.length) this.db.insertEvents(this.id, newEvents);
      this.db.insertEquity(this.id, t, tick, equity);
    });
  }
}

/** Keep the in-memory arrays bounded. */
export function trim(state: State): void {
  if (state.trades.length > MAX_TRADES_IN_MEMORY) state.trades.splice(0, state.trades.length - MAX_TRADES_IN_MEMORY);
  if (state.events.length > MAX_EVENTS_IN_MEMORY) state.events.splice(0, state.events.length - MAX_EVENTS_IN_MEMORY);
  if (state.equityCurve.length > MAX_CURVE_IN_MEMORY) state.equityCurve.splice(0, state.equityCurve.length - MAX_CURVE_IN_MEMORY);
}
