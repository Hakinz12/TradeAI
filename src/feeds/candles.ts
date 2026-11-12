import type { Candle, Timeframe } from "../types";

export const TF_SECONDS: Record<Timeframe, number> = { "1m": 60, "5m": 300, "15m": 900 };

export interface PricePoint {
  /** Unix seconds */
  time: number;
  price: number;
  volume: number;
}

/**
 * Build OHLC candles from a price series (one point per tick). Used for simulated and recorded data, where only
 * closes are known: wicks are never invented, so high/low are the highest/lowest observed price in the bucket.
 */
export function aggregate(points: PricePoint[], stepSec: number): Candle[] {
  const out: Candle[] = [];
  for (const p of points) {
    const bucket = Math.floor(p.time / stepSec) * stepSec;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, p.price);
      last.low = Math.min(last.low, p.price);
      last.close = p.price;
      last.volume += p.volume;
    } else {
      const open = last ? last.close : p.price;
      out.push({ time: bucket, open, high: Math.max(open, p.price), low: Math.min(open, p.price), close: p.price, volume: p.volume });
    }
  }
  return out;
}
