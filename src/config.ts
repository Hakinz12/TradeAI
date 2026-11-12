import "dotenv/config";

type Env = Record<string, string | undefined>;

const num = (env: Env, key: string, fallback: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const str = (env: Env, key: string, fallback = ""): string => (env[key] ?? fallback).trim();
const bool = (env: Env, key: string, fallback: boolean): boolean => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true";
};

// ---------------------------------------------------------------------------------------------
// Per-strategy settings (risk, entry rules, exits). Every strategy in the lab has its own copy.
// ---------------------------------------------------------------------------------------------

export interface StrategyConfig {
  startBalanceSol: number;

  // Sizing and portfolio limits
  maxPositionPct: number; // max % of free balance in one trade
  maxOpenPositions: number;
  maxExposurePct: number; // max % of equity deployed across all open positions
  maxPerTheme: number; // max open positions in one narrative theme (correlated bets)
  maxPoolSharePct: number; // a position may not exceed this % of the pool's liquidity

  // Exits
  stopLossPct: number;
  trailingStopPct: number;
  tp1Mult: number; // first take-profit level (multiple of entry)
  tp1Fraction: number; // fraction sold at tp1Mult (0 disables scaling out)
  takeProfitMult: number; // final take-profit on the remainder
  maxHoldMinutes: number;
  dailyLossLimitPct: number;

  // Entry rules
  minScore: number;
  minLiquidityUsd: number;
  maxTop10HolderPct: number;
  minHolders: number;
  maxSellImpactPct: number;

  // Market regime guard
  regimeEnabled: number; // 1 = on, 0 = off
  regimeWindow: number;
  regimeMinTrades: number;
  regimeMaxLossRate: number;
  regimeMinMedianBuy: number;
  regimeCooldownTicks: number;
}

export type StrategyKey = keyof StrategyConfig;

/** Hard limits on every setting, so a typo (or a hostile request) cannot switch the safety rules off. */
export const STRATEGY_BOUNDS: Record<StrategyKey, [number, number]> = {
  startBalanceSol: [0.1, 100000],
  maxPositionPct: [0.1, 25],
  maxOpenPositions: [1, 20],
  maxExposurePct: [1, 100],
  maxPerTheme: [1, 10],
  maxPoolSharePct: [0.1, 10],
  stopLossPct: [1, 60],
  trailingStopPct: [1, 60],
  tp1Mult: [1.1, 20],
  tp1Fraction: [0, 0.9],
  takeProfitMult: [1.2, 100],
  maxHoldMinutes: [5, 1440],
  dailyLossLimitPct: [1, 50],
  minScore: [0.3, 0.99],
  minLiquidityUsd: [1000, 5_000_000],
  maxTop10HolderPct: [5, 100],
  minHolders: [0, 100000],
  maxSellImpactPct: [0.5, 50],
  regimeEnabled: [0, 1],
  regimeWindow: [3, 50],
  regimeMinTrades: [2, 50],
  regimeMaxLossRate: [0.3, 1],
  regimeMinMedianBuy: [0.2, 0.6],
  regimeCooldownTicks: [1, 1440],
};

/** Settings that make sense to edit after a strategy exists (the starting balance does not). */
export const EDITABLE_KEYS = (Object.keys(STRATEGY_BOUNDS) as StrategyKey[]).filter((k) => k !== "startBalanceSol");

export function defaultStrategyConfig(env: Env = process.env): StrategyConfig {
  return {
    startBalanceSol: num(env, "START_BALANCE_SOL", 10),
    maxPositionPct: num(env, "MAX_POSITION_PCT", 5),
    maxOpenPositions: num(env, "MAX_OPEN_POSITIONS", 5),
    maxExposurePct: num(env, "MAX_EXPOSURE_PCT", 35),
    maxPerTheme: num(env, "MAX_PER_THEME", 2),
    maxPoolSharePct: num(env, "MAX_POOL_SHARE_PCT", 1.5),
    stopLossPct: num(env, "STOP_LOSS_PCT", 20),
    trailingStopPct: num(env, "TRAILING_STOP_PCT", 15),
    tp1Mult: num(env, "TP1_MULT", 2),
    tp1Fraction: num(env, "TP1_FRACTION", 0.5),
    takeProfitMult: num(env, "TAKE_PROFIT_MULT", 5),
    maxHoldMinutes: num(env, "MAX_HOLD_MINUTES", 90),
    dailyLossLimitPct: num(env, "DAILY_LOSS_LIMIT_PCT", 10),
    minScore: num(env, "MIN_SCORE", 0.62),
    minLiquidityUsd: num(env, "MIN_LIQUIDITY_USD", 15000),
    maxTop10HolderPct: num(env, "MAX_TOP10_HOLDER_PCT", 45),
    minHolders: num(env, "MIN_HOLDERS", 40),
    maxSellImpactPct: num(env, "MAX_SELL_IMPACT_PCT", 8),
    regimeEnabled: num(env, "REGIME_ENABLED", 1),
    regimeWindow: num(env, "REGIME_WINDOW", 10),
    regimeMinTrades: num(env, "REGIME_MIN_TRADES", 6),
    regimeMaxLossRate: num(env, "REGIME_MAX_LOSS_RATE", 0.7),
    regimeMinMedianBuy: num(env, "REGIME_MIN_MEDIAN_BUY", 0.42),
    regimeCooldownTicks: num(env, "REGIME_COOLDOWN_TICKS", 30),
  };
}

export type PatchResult = { ok: true; cfg: StrategyConfig } | { ok: false; error: string };

/** Validate a partial update against the bounds and cross-field rules. Returns the merged config. */
export function applyStrategyPatch(base: StrategyConfig, patch: unknown, allowStartBalance = false): PatchResult {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return { ok: false, error: "patch must be an object" };
  const next: StrategyConfig = { ...base };
  const allowed = allowStartBalance ? (Object.keys(STRATEGY_BOUNDS) as StrategyKey[]) : EDITABLE_KEYS;

  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(allowed as string[]).includes(key)) return { ok: false, error: `unknown or locked setting: ${key}` };
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `${key} must be a number` };
    const [lo, hi] = STRATEGY_BOUNDS[key as StrategyKey];
    if (value < lo || value > hi) return { ok: false, error: `${key} must be between ${lo} and ${hi}` };
    next[key as StrategyKey] = value;
  }

  if (next.tp1Fraction > 0 && next.tp1Mult >= next.takeProfitMult) {
    return { ok: false, error: "tp1Mult must be below takeProfitMult (or set tp1Fraction to 0)" };
  }
  if (next.regimeMinTrades > next.regimeWindow) return { ok: false, error: "regimeMinTrades cannot exceed regimeWindow" };
  if (next.regimeEnabled !== 0 && next.regimeEnabled !== 1) return { ok: false, error: "regimeEnabled must be 0 or 1" };
  return { ok: true, cfg: next };
}

// ---------------------------------------------------------------------------------------------
// App-level settings (process, data sources, keys, alerts). Not editable from the dashboard.
// ---------------------------------------------------------------------------------------------

export type FeedKind = "sim" | "live" | "replay";

export interface AppConfig {
  paperMode: boolean;
  port: number;
  host: string;
  trustProxy: boolean;

  tickMs: number; // loop speed for the simulated feed
  pollMs: number; // loop speed for the live feed (must respect API rate limits)
  dbPath: string;

  feed: FeedKind;
  simSeed: number | undefined;
  recordSnapshots: boolean;
  recordEveryTicks: number;
  solUsd: number;

  rpcUrl: string; // may contain the Helius key: never log it
  heliusApiKey: string;
  jupiterApiKey: string;
  jupiterQuoteUrl: string;
  geminiApiKey: string;
  geminiModel: string;
  devnetRpcUrl: string;

  alerts: { discordWebhook: string; telegramToken: string; telegramChatId: string };

  pessimism: {
    latencyPenaltyPct: number;
    slippageMultiplier: number;
    feePct: number;
    sellFailProb: number;
    lowLiqUsd: number;
  };

  predictor: "heuristic" | "model";
  modelPath: string;
  keystorePath: string;
  walletAlertDropPct: number;
  /** The only address withdrawals can ever go to. Empty = withdrawals disabled. */
  ownerWallet: string;

  label: { upPct: number; downPct: number; horizonTicks: number };
}

export function loadAppConfig(env: Env = process.env): AppConfig {
  const heliusKey = str(env, "HELIUS_API_KEY");
  const rpcUrl = str(env, "HELIUS_RPC_URL") || (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : "");
  const feedRaw = str(env, "FEED", "sim");
  const feed: FeedKind = feedRaw === "live" || feedRaw === "replay" ? feedRaw : "sim";
  const seedRaw = str(env, "SIM_SEED");

  return {
    paperMode: bool(env, "PAPER_MODE", true),
    port: num(env, "PORT", 3000),
    host: str(env, "HOST", "127.0.0.1"),
    trustProxy: bool(env, "TRUST_PROXY", false),

    tickMs: num(env, "TICK_MS", 2000),
    pollMs: Math.max(num(env, "POLL_MS", 20000), 5000),
    dbPath: str(env, "DB_PATH", "data/tradeai.db"),

    feed,
    simSeed: seedRaw !== "" && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : undefined,
    recordSnapshots: bool(env, "RECORD_SNAPSHOTS", feed === "live"),
    recordEveryTicks: Math.max(1, Math.floor(num(env, "RECORD_EVERY_TICKS", 1))),
    solUsd: num(env, "SOL_USD", 150),

    rpcUrl,
    heliusApiKey: heliusKey,
    jupiterApiKey: str(env, "JUPITER_API_KEY"),
    jupiterQuoteUrl: str(env, "JUPITER_QUOTE_URL", "https://api.jup.ag/swap/v1/quote"),
    geminiApiKey: str(env, "GEMINI_API_KEY"),
    geminiModel: str(env, "GEMINI_MODEL", "gemini-2.5-flash"),
    devnetRpcUrl: str(env, "HELIUS_DEVNET_RPC_URL", "https://api.devnet.solana.com"),

    alerts: {
      discordWebhook: str(env, "ALERT_DISCORD_WEBHOOK"),
      telegramToken: str(env, "ALERT_TELEGRAM_TOKEN"),
      telegramChatId: str(env, "ALERT_TELEGRAM_CHAT_ID"),
    },

    pessimism: {
      latencyPenaltyPct: num(env, "PESSIMISM_LATENCY_PCT", 1.0),
      slippageMultiplier: num(env, "PESSIMISM_SLIPPAGE_MULT", 1.5),
      feePct: num(env, "PESSIMISM_FEE_PCT", 0.5),
      sellFailProb: Math.min(Math.max(num(env, "PESSIMISM_SELL_FAIL_PROB", 0.25), 0), 0.9),
      lowLiqUsd: num(env, "PESSIMISM_LOW_LIQ_USD", 6000),
    },

    predictor: str(env, "PREDICTOR", "heuristic") === "model" ? "model" : "heuristic",
    modelPath: str(env, "MODEL_PATH", "data/model.json"),
    keystorePath: str(env, "KEYSTORE_PATH", "data/burner.keystore.json"),
    walletAlertDropPct: num(env, "WALLET_ALERT_DROP_PCT", 5),
    ownerWallet: str(env, "OWNER_WALLET"),

    label: {
      upPct: num(env, "LABEL_UP_PCT", 40),
      downPct: num(env, "LABEL_DOWN_PCT", 20),
      horizonTicks: Math.max(5, Math.floor(num(env, "LABEL_HORIZON_TICKS", 90))),
    },
  };
}

export const redactUrl = (url: string): string => url.replace(/(api-key=)[^&]+/gi, "$1***");

export const appConfig = loadAppConfig();
export const baseStrategyConfig = defaultStrategyConfig();
