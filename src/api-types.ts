import type { Analysis } from "./analyst";
import type { StrategyConfig } from "./config";
import type { ThemeHeat } from "./narrative";
import type { Candle, CheckStatus, FeedKindName, LogEvent, TokenSnapshot, Trade, TradeEstimate } from "./types";

/**
 * Shapes of the API responses. Single source of truth: the engine/server return them and the React dashboard
 * imports them (type-only), so a change here is a compile error on both sides instead of a runtime surprise.
 */

export interface ExitLevels {
  entry: number;
  stop: number;
  tp1: number | null;
  takeProfit: number;
  trail: number | null;
}

export interface PositionView {
  id: string;
  mint: string;
  symbol: string;
  theme: string;
  sizeSol: number;
  originalSizeSol: number;
  entryPrice: number;
  lastPrice: number;
  pnlPct: number;
  valueSol: number;
  heldTicks: number;
  openedAt: number;
  score: number;
  tp1Done: boolean;
  source: "auto" | "manual";
  levels: ExitLevels;
}

export interface RegimeView {
  cold: boolean;
  ticksLeft: number;
}

export interface EngineSummary {
  strategyId: string;
  strategyName: string;
  tick: number;
  /** Market time (ms). Simulated clock in sim mode. */
  t: number;
  paused: boolean;
  killed: boolean;
  balanceSol: number;
  equitySol: number;
  startBalanceSol: number;
  pnlSol: number;
  pnlPct: number;
  exposurePct: number;
  positions: PositionView[];
  trades: Trade[];
  events: LogEvent[];
  equityCurve: { t: number; equity: number }[];
  analysis: Analysis;
  counters: { scanned: number; rejected: number; scored: number; entered: number };
  config: StrategyConfig;
  regime: RegimeView;
}

export interface FeedStatus {
  kind: FeedKindName;
  ok: boolean;
  detail: string;
}

export type Summary = EngineSummary & {
  champion: boolean;
  paper: boolean;
  feed: FeedStatus;
  predictor: string;
};

export interface LabStrategy {
  id: string;
  name: string;
  champion: boolean;
  paused: boolean;
  killed: boolean;
  equitySol: number;
  pnlPct: number;
  positionsClosed: number;
  winRate: number;
  expectancyPct: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  open: number;
  config: StrategyConfig;
  curve: { t: number; equity: number }[];
}

export interface LabView {
  strategies: LabStrategy[];
  feed: FeedStatus;
  paper: boolean;
  predictor: string;
  signals: { total: number; labelled: number };
}

export interface TokenRow {
  mint: string;
  symbol: string;
  theme: string;
  price: number;
  liquidityUsd: number;
  volume5mUsd: number;
  buyRatio: number | null;
  ageMinutes: number;
  intelligence?: TokenSnapshot["intelligence"];
  score: number;
  held: boolean;
}

export interface TokensView {
  tokens: TokenRow[];
  themes: ThemeHeat[];
  total: number;
}

export interface StrategyTake {
  strategyId: string;
  strategyName: string;
  score: number;
  wouldEnter: boolean;
  reason: string;
}

export interface TokenDetail {
  token: TokenSnapshot;
  prediction: { probability: number; factors: string[] };
  estimate: TradeEstimate | null;
  positions: PositionView[];
  trades: Trade[];
  takes: StrategyTake[];
  sim: boolean;
}

export interface CandlesView {
  source: string;
  note: string | null;
  candles: Candle[];
  /** Candle width in seconds, so the chart can snap markers to candles */
  stepSec: number;
}

export interface PreviewView {
  estimate: TradeEstimate | null;
  maxSizeSol: number;
  riskOk: boolean;
  riskReason: string;
  score: number;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface WalletView {
  configured: boolean;
  address: string | null;
  rpcConfigured: boolean;
  paperMode: boolean;
  balanceSol: number | null;
  tokens: { mint: string; amount: number; decimals: number }[];
  recent: { signature: string; slot: number; blockTime: number | null; failed: boolean }[];
  error: string | null;
  explorerUrl: string | null;
  updatedAt: number | null;
  ownerWallet: string | null;
  withdrawEnabled: boolean;
  /** Why withdrawals are unavailable, when they are */
  withdrawBlockedReason: string | null;
  withdrawals: { t: number; amountSol: number; signature: string; status: string }[];
}

export interface WithdrawIntent {
  id: string;
  message: string;
  amountSol: number;
  to: string;
  expiresAt: number;
}

export interface WithdrawResult {
  ok: boolean;
  signature?: string;
  status?: "confirmed" | "sent";
  explorerUrl?: string;
  error?: string;
}

export interface Challenge {
  message: string;
  expiresAt: number;
}

export interface DailyReport {
  day: string;
  strategyId: string;
  strategyName: string;
  fills: number;
  positionsClosed: number;
  wins: number;
  losses: number;
  pnlSol: number;
  equityStart: number;
  equityEnd: number;
  best: { symbol: string; pnlPct: number; pnlSol: number } | null;
  worst: { symbol: string; pnlPct: number; pnlSol: number } | null;
  byReason: Record<string, { count: number; pnlSol: number }>;
  coldEvents: number;
  notes: string[];
}

export interface ReportEntry {
  day: string;
  createdAt: number;
  data: DailyReport;
}

export type { CheckStatus };
