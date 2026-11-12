import fs from "node:fs";
import type { AppConfig, StrategyConfig } from "./config";
import { Db } from "./db";
import { LiveFeed } from "./feeds/live";
import { SimulatedFeed } from "./feeds/sim";
import { Lab } from "./lab";
import { Notifier } from "./notify";
import { HeuristicPredictor, loadModel } from "./predictor";
import type { Predictor } from "./predictor";
import { SignalLogger } from "./signals";
import type { Feed } from "./types";

export interface Built {
  lab: Lab;
  db: Db;
  feed: Feed;
  predictor: Predictor;
  notifier: Notifier;
  signals: SignalLogger;
}

export function createPredictor(app: AppConfig, feedKind: Feed["kind"]): Predictor {
  if (app.predictor === "model") {
    try {
      if (fs.existsSync(app.modelPath)) {
        const p = loadModel(app.modelPath, feedKind);
        console.log(`[predictor] using trained model: ${p.name}`);
        return p;
      }
      console.warn(`[predictor] PREDICTOR=model but ${app.modelPath} does not exist: using the heuristic`);
    } catch (err) {
      console.warn(`[predictor] could not use the model (${(err as Error).message}): using the heuristic`);
    }
  }
  return new HeuristicPredictor();
}

export interface BuildOptions {
  db?: Db;
  feed?: Feed;
  notifier?: Notifier;
  predictor?: Predictor;
}

/** Build the whole trading stack from configuration. Used by the server, the backtest CLI and the tests. */
export function buildLab(app: AppConfig, base: StrategyConfig, opts: BuildOptions = {}): Built {
  const db = opts.db ?? new Db(app.dbPath);

  let feed = opts.feed;
  if (!feed) {
    if (app.feed === "replay") throw new Error("the replay feed is used through `npm run backtest`");
    if (app.feed === "live") {
      feed = new LiveFeed(app, { db });
    }
  }
  if (!feed) {
    // The simulated market restarts fresh each run, but its clock and mint names continue, so history never collides.
    const run = Number(db.getMeta("sim_run") ?? 0) + 1;
    db.setMeta("sim_run", String(run));
    let epoch = Number(db.getMeta("sim_epoch") ?? 0);
    if (!epoch) {
      epoch = Math.floor(Date.now() / 60000) * 60000;
      db.setMeta("sim_epoch", String(epoch));
    }
    feed = new SimulatedFeed({ seed: app.simSeed, runId: run, epochMs: epoch, startTick: Number(db.getMeta("lab_tick") ?? 0) });
  }

  const notifier = opts.notifier ?? new Notifier(app.alerts);
  const predictor = opts.predictor ?? createPredictor(app, feed.kind);
  const signals = new SignalLogger(db, app.label, feed.kind);
  const lab = new Lab({ db, app, feed, predictor, notifier, signals, baseCfg: base });
  return { lab, db, feed, predictor, notifier, signals };
}
