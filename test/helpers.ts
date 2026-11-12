import { defaultStrategyConfig } from "../src/config";
import type { Position, TokenSnapshot } from "../src/types";
import { newState } from "../src/store";

export const cfg = defaultStrategyConfig({} as NodeJS.ProcessEnv);

export const token = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  mint: "SIMX-00001", symbol: "TEST", price: 0.001, liquidityUsd: 80000, volume5mUsd: 20000, buyRatio: 0.7,
  holders: 900, top10HolderPct: 20, mintAuthorityRevoked: true, freezeAuthorityRevoked: true, ageMinutes: 120,
  smartWalletBuys: 2, socialVelocity: 0.5, theme: "dog", ...over,
});

export const position = (over: Partial<Position> = {}): Position => ({
  id: "P-1", mint: "SIMX-00001", symbol: "TEST", theme: "dog", entryPrice: 0.001, qty: 100, sizeSol: 0.1,
  originalSizeSol: 0.1, openedAt: 0, openedTick: 0, peakPrice: 0.001, lastPrice: 0.001, score: 0.7, tp1Done: false,
  fills: 0, source: "auto", signalId: null, ...over,
});

export const freshState = () => newState(10, 1_700_000_000_000);
