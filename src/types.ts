import type { TokenIntelligence } from "./intelligence";
export interface TokenSnapshot {
  mint: string;
  symbol: string;
  name?: string;
  /** Price in SOL */
  price: number;
  liquidityUsd: number;
  volume5mUsd: number;
  /** buys / (buys + sells) over the last few minutes, 0..1. null = unknown */
  buyRatio: number | null;
  /** null = unavailable from the data source (free sources do not provide it) */
  holders: number | null;
  /** % of supply held by the top 10 non-pool wallets. null = could not be determined */
  top10HolderPct: number | null;
  /** null = unknown. The scanner fails closed on unknown authorities. */
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  ageMinutes: number;
  /** Number of tracked smart wallets that bought recently. null = no data source */
  smartWalletBuys: number | null;
  /** 0..1, positive social chatter vs. baseline. null = no data source */
  socialVelocity: number | null;
  priceChange5mPct?: number | null;
  /** Pool address, used to fetch charts */
  pairAddress?: string;
  /** Token-2022 mint with a risky extension (transfer fee/hook, permanent delegate...). null = unknown */
  token2022Risky?: boolean | null;
  /** Result of a sell-route quote. null = not checked */
  sellRouteOk?: boolean | null;
  sellImpactPct?: number | null;
  /** Transaction-derived behavioural signals. Missing when no indexed transaction provider is configured. */
  intelligence?: TokenIntelligence;
  /** Narrative theme, assigned by the lab */
  theme?: string;
}

export type CheckStatus = "pass" | "fail" | "unknown";

export interface SafetyCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ScanResult {
  pass: boolean;
  /** Reasons the token was rejected (failed checks, plus unknown checks that fail closed) */
  reasons: string[];
  checks: SafetyCheck[];
}

export interface Prediction {
  /** Estimated probability the trade hits its up-target before its down-target, 0..1 */
  probability: number;
  /** Top contributing factors, for the decision log */
  factors: string[];
}

export type ExitReason =
  | "stop_loss"
  | "trailing_stop"
  | "take_profit"
  | "take_profit_1"
  | "time_stop"
  | "rug_exit"
  | "kill_switch"
  | "manual"
  | "feed_lost";

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  theme: string;
  entryPrice: number;
  /** Remaining quantity */
  qty: number;
  /** Remaining cost basis in SOL */
  sizeSol: number;
  originalSizeSol: number;
  openedAt: number;
  openedTick: number;
  peakPrice: number;
  lastPrice: number;
  score: number;
  tp1Done: boolean;
  fills: number;
  source: "auto" | "manual";
  signalId: number | null;
}

export interface Trade {
  /** `${positionId}#${n}`: one row per fill, so scaling out produces several rows per position */
  id: string;
  positionId: string;
  mint: string;
  symbol: string;
  theme: string;
  entryPrice: number;
  exitPrice: number;
  /** Cost basis of the part that was sold */
  sizeSol: number;
  /** Full cost of the position this fill belongs to */
  positionSizeSol: number;
  pnlSol: number;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  closedTick: number;
  heldTicks: number;
  score: number;
  reason: ExitReason;
  partial: boolean;
  source: "auto" | "manual";
}

export type EventKind = "scan_reject" | "signal" | "entry" | "exit" | "risk" | "system";

export interface LogEvent {
  t: number;
  kind: EventKind;
  msg: string;
}

export interface State {
  balanceSol: number;
  startBalanceSol: number;
  positions: Position[];
  trades: Trade[];
  events: LogEvent[];
  equityCurve: { t: number; equity: number }[];
  paused: boolean;
  killed: boolean;
  dayKey: string;
  dayStartEquity: number;
  tick: number;
  /** Regime guard: no new entries while tick < coldUntilTick */
  coldUntilTick: number;
  lastColdTick: number;
}

export interface OrderResult {
  ok: boolean;
  fillPrice: number;
  qty: number;
  error?: string;
}

export interface TradeEstimate {
  buySlippagePct: number;
  sellSlippagePct: number;
  roundTripCostPct: number;
  poolSharePct: number;
}

export interface Executor {
  buy(token: TokenSnapshot, sizeSol: number): Promise<OrderResult>;
  sell(token: TokenSnapshot, qty: number): Promise<OrderResult>;
  estimate?(token: TokenSnapshot, sizeSol: number): TradeEstimate;
}

export interface Candle {
  /** Unix seconds */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "1m" | "5m" | "15m";

export interface CandleResult {
  source: string;
  candles: Candle[];
  note?: string;
}

export interface FeedHealth {
  ok: boolean;
  detail: string;
  lastOkAt: number | null;
  failures: number;
}

export type FeedKindName = "sim" | "live" | "replay";

export interface Feed {
  readonly kind: FeedKindName;
  /** Advance one step and return the current tradable universe */
  tick(): Promise<TokenSnapshot[]>;
  /** Market time in ms (simulated clock for sim/replay, wall clock for live) */
  now(): number;
  /** Latest snapshot for a mint, or undefined if it has dropped out of the universe */
  get(mint: string): TokenSnapshot | undefined;
  /** Mints that are held in open positions: a live feed must keep tracking them even when they stop looking interesting */
  pin?(mints: string[]): void;
  candles(mint: string, tf: Timeframe): Promise<CandleResult>;
  health(): FeedHealth;
  /** Tokens that must stay in the universe (open positions), even if they would otherwise age out */
  pin?(mints: string[]): void;
}
