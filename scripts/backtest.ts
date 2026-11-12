/**
 * Backtest / strategy comparison. Runs every strategy in the lab over the same market and prints a table.
 *
 *   npm run backtest -- --source sim --ticks 3000 --seeds 5
 *   npm run backtest -- --source db --db data/tradeai.db
 *
 * Simulated data only shows that the engine behaves; it says nothing about live profitability.
 */
import { Db } from "../src/db";
import { loadAppConfig, defaultStrategyConfig } from "../src/config";
import { buildLab } from "../src/bootstrap";
import { ReplayFeed } from "../src/feeds/replay";
import { SimulatedFeed } from "../src/feeds/sim";
import { Notifier } from "../src/notify";

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) out[a[i].slice(2)] = a[i + 1]?.startsWith("--") || a[i + 1] === undefined ? "true" : a[++i];
  return out;
}

const opt = args();
const source = opt.source ?? "sim";
const ticks = Math.min(Math.max(Number(opt.ticks ?? 2000), 10), 200000);
const seeds = Math.min(Math.max(Number(opt.seeds ?? 1), 1), 50);
const firstSeed = Number(opt.seed ?? 1);

interface Row { seed: string; id: string; closed: number; win: number; pnlPct: number; pf: number | null; dd: number }
const rows: Row[] = [];
const origLog = console.log;

async function one(label: string, makeFeed: () => ReplayFeed | SimulatedFeed, n: number) {
  const env = { DB_PATH: ":memory:", PREDICTOR: "heuristic", RECORD_SNAPSHOTS: "false" } as NodeJS.ProcessEnv;
  const app = loadAppConfig(env);
  const feed = makeFeed();
  const { lab, db } = buildLab(app, defaultStrategyConfig(env), { db: new Db(":memory:"), feed, notifier: new Notifier({}) });
  console.log = () => undefined; // silence per-tick alert chatter while running
  try {
    for (let i = 0; i < n; i++) {
      if (feed instanceof ReplayFeed && feed.finished) break;
      await lab.step();
    }
  } finally {
    console.log = origLog;
  }
  for (const s of lab.labView().strategies) {
    rows.push({ seed: label, id: s.id, closed: s.positionsClosed, win: s.winRate, pnlPct: s.pnlPct, pf: s.profitFactor, dd: s.maxDrawdownPct });
  }
  db.close();
}

if (source === "db") {
  const path = opt.db ?? "data/tradeai.db";
  const src = new Db(path);
  const probe = new ReplayFeed(src);
  if (probe.total < 50) {
    console.error(`Only ${probe.total} recorded ticks in ${path}. Let the app run longer (RECORD_SNAPSHOTS=true) before backtesting on recorded data.`);
    process.exit(1);
  }
  await one("recorded", () => new ReplayFeed(src), probe.total);
  src.close();
} else {
  for (let k = 0; k < seeds; k++) {
    const seed = firstSeed + k;
    await one(`seed ${seed}`, () => new SimulatedFeed({ seed, runId: 1, epochMs: Date.UTC(2026, 0, 1), startTick: 0 }), ticks);
  }
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`\n${pad("run", 10)}${pad("strategy", 12)}${pad("closed", 8)}${pad("win%", 8)}${pad("pnl%", 10)}${pad("PF", 7)}maxDD%`);
for (const r of rows) {
  console.log(`${pad(r.seed, 10)}${pad(r.id, 12)}${pad(r.closed, 8)}${pad((r.win * 100).toFixed(0), 8)}${pad(r.pnlPct.toFixed(1), 10)}${pad(r.pf === null ? "-" : r.pf.toFixed(2), 7)}${r.dd.toFixed(1)}`);
}
if (seeds > 1 && source !== "db") {
  console.log("\nAverage across seeds:");
  for (const id of new Set(rows.map((r) => r.id))) {
    const rs = rows.filter((r) => r.id === id);
    const avg = (f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(`${pad(id, 12)}pnl ${avg((r) => r.pnlPct).toFixed(1)}%   worst drawdown ${Math.max(...rs.map((r) => r.dd)).toFixed(1)}%   losing seeds ${rs.filter((r) => r.pnlPct < 0).length}/${rs.length}`);
  }
}
console.log("\nSimulated results show the engine works. They are NOT evidence of live profit.");
