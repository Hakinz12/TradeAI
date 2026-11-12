import type { TokenSnapshot } from "./types";

/**
 * The model input. This list is the contract between the TypeScript engine and the Python training
 * pipeline: the signal log stores exactly these names, and a trained model.json must list the same ones.
 */
export const FEATURE_NAMES = [
  "buy_ratio",
  "smart_wallets",
  "social_velocity",
  "volume_turnover",
  "log_holders",
  "top10_pct",
  "log_liquidity",
  "age_minutes",
  "price_change_5m",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number>;

/**
 * Unknown values (a data source that does not provide them) become neutral numbers, so a missing signal
 * contributes nothing instead of pushing the score in either direction.
 */
export function extractFeatures(t: TokenSnapshot): Features {
  const turnover = Math.min(t.volume5mUsd / Math.max(t.liquidityUsd, 1), 1);
  return {
    buy_ratio: t.buyRatio ?? 0.5,
    smart_wallets: Math.min(t.smartWalletBuys ?? 0, 4),
    social_velocity: t.socialVelocity ?? 0.45,
    volume_turnover: turnover,
    log_holders: Math.log10(Math.max(t.holders ?? 100, 1)),
    top10_pct: t.top10HolderPct ?? 30,
    log_liquidity: Math.log10(Math.max(t.liquidityUsd, 1)),
    age_minutes: t.ageMinutes,
    price_change_5m: t.priceChange5mPct ?? 0,
  };
}
