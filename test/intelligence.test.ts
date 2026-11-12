import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTransactions, findSharedFunders } from "../src/intelligence";

const mint = "TokenMint111111111111111111111111111111111";
test("volume intelligence scores concentration, repeated sizes and synchronized activity", () => {
  const txs = Array.from({ length: 24 }, (_, i) => ({
    feePayer: i < 12 ? "walletA111111111111111111111111111111111" : `wallet${i}111111111111111111111111111111`,
    timestamp: 1_700_000_000 + Math.floor(i / 3) * 2,
    tokenTransfers: [{ mint, tokenAmount: i % 2 ? 100 : 100.01 }],
  }));
  const result = analyzeTransactions(txs, mint, 1_700_000_100);
  assert.equal(result.status, "ready");
  assert.ok((result.suspiciousVolumeScore ?? 0) > 20);
  assert.ok(result.flags.length > 0);
});

test("insufficient samples are not misrepresented as clean organic volume", () => {
  const result = analyzeTransactions([{ feePayer: "wallet", tokenTransfers: [{ mint, tokenAmount: 1 }] }], mint);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.organicVolumeScore, null);
});

test("shared funder relationships are detected from incoming native transfers", () => {
  const histories = new Map([
    ["walletA", [{ nativeTransfers: [{ fromUserAccount: "funder", toUserAccount: "walletA", amount: 1 }] }]],
    ["walletB", [{ nativeTransfers: [{ fromUserAccount: "funder", toUserAccount: "walletB", amount: 1 }] }]],
  ]);
  const clusters = findSharedFunders(histories);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].reason, "shared_funder");
});

test("high-confidence suspicious volume lowers the prediction probability", async () => {
  const { HeuristicPredictor } = await import("../src/predictor");
  const predictor = new HeuristicPredictor();
  const base = {
    mint, symbol: "TEST", price: 1, liquidityUsd: 50000, volume5mUsd: 5000, buyRatio: 0.7,
    holders: 500, top10HolderPct: 20, mintAuthorityRevoked: true, freezeAuthorityRevoked: true,
    ageMinutes: 20, smartWalletBuys: 2, socialVelocity: 0.6,
  };
  const clean = predictor.predict(base);
  const suspicious = predictor.predict({ ...base, intelligence: {
    status: "ready", transactions: 100, uniqueWallets: 25, organicVolumeScore: 10,
    suspiciousVolumeScore: 90, confidence: "high", topWalletVolumePct: 60,
    repeatedSizePct: 70, synchronizedWalletPct: 80, roundTripWalletPct: 50,
    sharedFunderWallets: 8, clusters: [], flags: ["coordinated activity"], updatedAt: Date.now(),
  } });
  assert.ok(suspicious.probability < clean.probability);
});
