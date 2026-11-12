import fs from "node:fs";
import { extractFeatures, FEATURE_NAMES } from "./features";
import type { Features } from "./features";
import type { FeedKindName, Prediction, TokenSnapshot } from "./types";

export interface Predictor {
  readonly name: string;
  predict(token: TokenSnapshot): Prediction;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * HeuristicPredictor: a hand-weighted logistic score. It is the baseline any trained model must beat
 * out-of-sample before it is allowed to replace it (see python/train.py).
 */
export class HeuristicPredictor implements Predictor {
  readonly name = "heuristic";

  predict(t: TokenSnapshot): Prediction {
    const f = extractFeatures(t);
    const parts: [string, number][] = [
      ["buy pressure", (f.buy_ratio - 0.5) * 7],
      ["smart wallets", f.smart_wallets * 0.45],
      ["social velocity", (f.social_velocity - 0.45) * 2.4],
      ["volume turnover", f.volume_turnover * 0.8],
      ["holder base", f.log_holders * 0.5 - 1.0],
      ["holder concentration", -Math.max(f.top10_pct - 30, 0) / 25],
    ];
    const z = -0.9 + parts.reduce((sum, [, v]) => sum + v, 0);
    return applyVolumeIntelligence({ probability: sigmoid(z), factors: topFactors(parts) }, t);
  }
}


function applyVolumeIntelligence(prediction: Prediction, t: TokenSnapshot): Prediction {
  const intel = t.intelligence;
  if (!intel || intel.status !== "ready" || intel.suspiciousVolumeScore === null) return prediction;
  const confidenceWeight = intel.confidence === "high" ? 1 : intel.confidence === "medium" ? 0.7 : 0.4;
  const penalty = Math.max(0, intel.suspiciousVolumeScore - 15) / 100 * 0.65 * confidenceWeight;
  if (penalty <= 0.01) return prediction;
  const p = Math.min(0.999, Math.max(0.001, prediction.probability));
  const logit = Math.log(p / (1 - p)) - penalty;
  return { probability: sigmoid(logit), factors: [...prediction.factors, `suspicious volume -${penalty.toFixed(2)}`].slice(0, 4) };
}

function topFactors(parts: [string, number][]): string[] {
  return parts
    .filter(([, v]) => Math.abs(v) > 0.15)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([name, v]) => `${name} ${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
}

// ---------------------------------------------------------------------------------------------
// Trained model (exported by python/train.py as model.json)
// ---------------------------------------------------------------------------------------------

export interface ModelFile {
  schema: 1;
  feature_names: string[];
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
  /** The feed the model was trained on. A model trained on simulated data must never trade live data. */
  source: FeedKindName;
  trained_at: string;
  n_train: number;
  label: { up_pct: number; down_pct: number; horizon_ticks: number };
  metrics: Record<string, unknown>;
  samples: { features: Record<string, number>; prob: number }[];
}

export class ModelPredictor implements Predictor {
  readonly name: string;

  constructor(readonly model: ModelFile) {
    this.name = `model(${model.source}, n=${model.n_train})`;
  }

  predict(t: TokenSnapshot): Prediction {
    return applyVolumeIntelligence(this.predictFeatures(extractFeatures(t)), t);
  }

  predictFeatures(f: Features): Prediction {
    const m = this.model;
    const contrib = m.feature_names.map((name, i) => {
      const x = f[name as keyof Features];
      return [name.replaceAll("_", " "), (m.coef[i] * (x - m.mean[i])) / m.scale[i]] as [string, number];
    });
    const z = m.intercept + contrib.reduce((s, [, v]) => s + v, 0);
    return { probability: sigmoid(z), factors: topFactors(contrib) };
  }
}

/** Parse and validate a model file. Throws with a clear message instead of trading on a bad model. */
export function parseModel(raw: string, feedKind: FeedKindName): ModelPredictor {
  const m = JSON.parse(raw) as ModelFile;
  if (m.schema !== 1) throw new Error("unsupported model schema");

  const names = [...m.feature_names].sort().join(",");
  const expected = [...FEATURE_NAMES].sort().join(",");
  if (names !== expected) throw new Error(`model features do not match the engine (${names} vs ${expected})`);

  const n = m.feature_names.length;
  const finite = (xs: number[]) => Array.isArray(xs) && xs.length === n && xs.every((x) => Number.isFinite(x));
  if (!finite(m.mean) || !finite(m.coef) || !finite(m.scale) || m.scale.some((s) => s <= 0) || !Number.isFinite(m.intercept)) {
    throw new Error("model has invalid numbers");
  }
  if (m.source !== feedKind) {
    throw new Error(`model was trained on '${m.source}' data but the feed is '${feedKind}': retrain on the same kind of data`);
  }
  return new ModelPredictor(m);
}

export function loadModel(path: string, feedKind: FeedKindName): ModelPredictor {
  return parseModel(fs.readFileSync(path, "utf8"), feedKind);
}
