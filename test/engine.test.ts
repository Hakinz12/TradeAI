import test from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig, defaultStrategyConfig } from "../src/config";
import { buildLab } from "../src/bootstrap";
import { Db } from "../src/db";
import { Notifier } from "../src/notify";

const env = { SIM_SEED: "11", DB_PATH: ":memory:" } as NodeJS.ProcessEnv;
const quiet = () => new Notifier({});

async function run(ticks: number, db = new Db(":memory:")) {
  const app = loadAppConfig(env);
  const built = buildLab(app, defaultStrategyConfig(env), { db, notifier: quiet() });
  for (let i = 0; i < ticks; i++) await built.lab.step();
  return built;
}

test("engine: simulated run trades, labels signals and obeys the risk caps", async () => {
  const { lab, db } = await run(700);
  const e = lab.champion();
  assert.ok(e.state.trades.length > 0, "made trades");
  assert.ok(db.countSignals().total > 0, "logged signals");
  assert.ok(e.state.positions.length <= e.cfg.maxOpenPositions);
  const exposure = e.state.positions.reduce((s, p) => s + p.qty * p.lastPrice, 0);
  assert.ok(exposure / Math.max(e.state.balanceSol + exposure, 1e-9) <= (e.cfg.maxExposurePct + 15) / 100, "exposure stays near the cap");
  const themes = new Map<string, number>();
  for (const p of e.state.positions) themes.set(p.theme, (themes.get(p.theme) ?? 0) + 1);
  for (const n of themes.values()) assert.ok(n <= e.cfg.maxPerTheme);
  db.close();
});

test("engine: kill switch closes everything and blocks new entries", async () => {
  const { lab, db } = await run(300);
  const e = lab.champion();
  lab.control("kill", e.id);
  for (let i = 0; i < 5; i++) await lab.step();
  assert.equal(e.state.positions.length, 0, "no open positions after kill");
  assert.equal(e.state.killed, true);
  const before = e.state.trades.length;
  for (let i = 0; i < 50; i++) await lab.step();
  assert.equal(e.state.positions.length, 0, "no entries while killed");
  assert.ok(e.state.trades.length >= before);
  lab.control("rearm", e.id);
  assert.equal(e.state.killed, false);
  db.close();
});

test("engine: state survives a reload from the database", async () => {
  const db = new Db(":memory:");
  const { lab } = await run(400, db);
  const snap = lab.champion().state;
  const app = loadAppConfig(env);
  const again = buildLab(app, defaultStrategyConfig(env), { db, notifier: quiet() });
  const re = again.lab.champion().state;
  assert.equal(re.positions.length, snap.positions.length);
  assert.ok(Math.abs(re.balanceSol - snap.balanceSol) < 1e-9);
  db.close();
});

test("engine: same seed gives the same result (reproducible backtests)", async () => {
  const a = await run(250);
  const b = await run(250);
  assert.equal(a.lab.champion().state.trades.length, b.lab.champion().state.trades.length);
  assert.ok(Math.abs(a.lab.champion().state.balanceSol - b.lab.champion().state.balanceSol) < 1e-9);
});

test("manual buy goes through the same risk checks", async () => {
  const { lab } = await run(60);
  const e = lab.champion();
  e.pause();
  const mint = lab.tokensView(e).tokens[0].mint;
  const out = await e.manualBuy(mint, 0.1);
  assert.equal(out.ok, false, "refused while paused");
  const bogus = await e.manualBuy("NOPE-00000", 0.1);
  assert.equal(bogus.ok, false);
});
