import test from "node:test";
import assert from "node:assert/strict";
import { applyStrategyPatch, STRATEGY_BOUNDS } from "../src/config";
import { checkEntry, checkExit, equityOf } from "../src/risk";
import { scan } from "../src/scanner";
import { PaperExecutor, defaultPaperOptions } from "../src/executor";
import { csvCell, toCsv } from "../src/csv";
import { Db } from "../src/db";
import { cfg, freshState, position, token } from "./helpers";

test("config: patch within bounds applies, out of bounds and unknown keys are rejected", () => {
  const ok = applyStrategyPatch(cfg, { stopLossPct: 15 });
  assert.equal(ok.ok, true);
  assert.equal(applyStrategyPatch(cfg, { stopLossPct: 99999 }).ok, false);
  assert.equal(applyStrategyPatch(cfg, { evil: 1 }).ok, false);
  assert.equal(applyStrategyPatch(cfg, { stopLossPct: "15" }).ok, false);
  assert.equal(applyStrategyPatch(cfg, { startBalanceSol: 5 }).ok, false, "start balance is not editable");
  assert.ok(STRATEGY_BOUNDS.stopLossPct[1] <= 100);
});

test("risk: entry vetoes", () => {
  const s = freshState();
  assert.equal(checkEntry(s, token(), 0.5, cfg, 1).ok, true);
  assert.equal(checkEntry({ ...s, killed: true }, token(), 0.5, cfg, 1).ok, false);
  assert.equal(checkEntry({ ...s, paused: true }, token(), 0.5, cfg, 1).ok, false);
  assert.equal(checkEntry({ ...s, coldUntilTick: 50 }, token(), 0.5, cfg, 10).ok, false);
  assert.equal(checkEntry(s, token(), 999, cfg, 1).ok, false, "more than balance");
  assert.equal(checkEntry(s, token(), 9, cfg, 1).ok, false, "exposure cap");
  const withTheme = { ...s, positions: [position({ id: "a" }), position({ id: "b" })] };
  assert.equal(checkEntry(withTheme, token(), 0.1, cfg, 1).ok, false, "theme cap");
  const lost = { ...s, dayStartEquity: 10, balanceSol: 8 };
  assert.equal(checkEntry(lost, token(), 0.1, cfg, 1).ok, false, "daily loss limit");
});

test("risk: exits fire in the right order", () => {
  const p = position();
  assert.equal(checkExit(p, token({ price: 0.001 }), 5, cfg), null);
  const stop = checkExit(p, token({ price: 0.001 * (1 - cfg.stopLossPct / 100) * 0.99 }), 5, cfg);
  assert.equal(stop?.reason, "stop_loss");
  assert.equal(stop?.fraction, 1);
  const rug = checkExit(p, token({ liquidityUsd: 500 }), 5, cfg);
  assert.equal(rug?.reason, "rug_exit");
  const tp1 = checkExit(p, token({ price: 0.001 * cfg.tp1Mult * 1.01 }), 5, cfg);
  assert.equal(tp1?.reason, "take_profit_1");
  assert.ok(tp1!.fraction > 0 && tp1!.fraction < 1);
  const timed = checkExit(p, token(), cfg.maxHoldMinutes + 1, cfg);
  assert.equal(timed?.reason, "time_stop");
  // trailing stop arms only after a peak above +10%, then fires on the pullback
  const peaked = position({ peakPrice: 0.0014 });
  const trail = checkExit(peaked, token({ price: 0.0014 * (1 - cfg.trailingStopPct / 100) * 0.99 }), 5, cfg);
  assert.equal(trail?.reason, "trailing_stop");
});

test("scanner: fails closed on unknown authorities and rejects bad tokens", () => {
  assert.equal(scan(token(), cfg).pass, true);
  assert.equal(scan(token({ mintAuthorityRevoked: null }), cfg).pass, false);
  assert.equal(scan(token({ freezeAuthorityRevoked: false }), cfg).pass, false);
  assert.equal(scan(token({ top10HolderPct: null }), cfg).pass, false);
  assert.equal(scan(token({ top10HolderPct: 90 }), cfg).pass, false);
  assert.equal(scan(token({ liquidityUsd: 100 }), cfg).pass, false);
  assert.equal(scan(token({ sellRouteOk: false }), cfg).pass, false);
  assert.equal(scan(token({ holders: null }), cfg).pass, true, "unavailable holders do not reject");
});

test("executor: pessimistic fills always cost you", async () => {
  const ex = new PaperExecutor(defaultPaperOptions(() => 0.99));
  const t = token();
  const b = await ex.buy(t, 0.5);
  assert.ok(b.ok && b.fillPrice > t.price, "buy fills above the quote");
  const s = await ex.sell(t, b.qty);
  assert.ok(s.ok && s.fillPrice < t.price, "sell fills below the quote");
  const huge = await ex.buy(token({ liquidityUsd: 3000 }), 5);
  assert.equal(huge.ok, false, "refuses absurd slippage");
  const failing = new PaperExecutor(defaultPaperOptions(() => 0));
  const thin = await failing.sell(token({ liquidityUsd: 2000 }), 10);
  assert.equal(thin.ok, false, "sells can fail on thin pools");
  const est = ex.estimate(t, 1);
  assert.ok(est.roundTripCostPct > 0);
});

test("csv: neutralises spreadsheet formula injection", () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.ok(csvCell("+1").startsWith("'"));
  assert.ok(csvCell("@SUM(A1)").startsWith("'"));
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell(-3.5), "-3.5", "negative numbers stay numeric");
  assert.equal(toCsv(["a", "b"], [[1, "x"]]).trim(), "a,b\n1,x");
});

test("db: two strategies may use the same position and trade ids", () => {
  const db = new Db(":memory:");
  const p = position();
  db.replacePositions("one", [p]);
  db.replacePositions("two", [p]);
  assert.equal(db.loadPositions("one").length, 1);
  assert.equal(db.loadPositions("two").length, 1);
  const trade = { id: "P-1#1", positionId: "P-1", mint: "M", symbol: "S", theme: "dog", entryPrice: 1, exitPrice: 2, sizeSol: 1, positionSizeSol: 1, pnlSol: 1, pnlPct: 100, openedAt: 0, closedAt: 5, closedTick: 5, heldTicks: 5, score: 0.5, reason: "take_profit" as const, partial: false, source: "auto" as const };
  db.insertTrades("one", [trade]);
  db.insertTrades("two", [{ ...trade, pnlSol: -1 }]);
  assert.equal(db.recentTrades("one", 10)[0].pnlSol, 1);
  assert.equal(db.recentTrades("two", 10)[0].pnlSol, -1);
  db.close();
});

test("risk: equity marks open positions to last price", () => {
  const s = { ...freshState(), balanceSol: 5, positions: [position({ qty: 100, lastPrice: 0.01 })] };
  assert.equal(equityOf(s), 6);
});
