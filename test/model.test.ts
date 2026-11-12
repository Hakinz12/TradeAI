import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseModel } from "../src/predictor";
import type { Features } from "../src/features";

const raw = fs.readFileSync(new URL("./fixtures/model-sim.json", import.meta.url), "utf8");

test("model: TypeScript predictions match the Python trainer on every stored sample", () => {
  const p = parseModel(raw, "sim");
  const m = JSON.parse(raw);
  assert.ok(m.samples.length >= 20);
  for (const s of m.samples) {
    const got = p.predictFeatures(s.features as Features).probability;
    assert.ok(Math.abs(got - s.prob) < 1e-9, `parity: ${got} vs ${s.prob}`);
  }
});

test("model: refuses a sim-trained model on live data and rejects malformed files", () => {
  assert.throws(() => parseModel(raw, "live"), /trained on 'sim'/);
  const m = JSON.parse(raw);
  assert.throws(() => parseModel(JSON.stringify({ ...m, feature_names: m.feature_names.slice(1) }), "sim"), /features do not match/);
  assert.throws(() => parseModel(JSON.stringify({ ...m, scale: m.scale.map(() => 0) }), "sim"), /invalid numbers/);
  assert.throws(() => parseModel(JSON.stringify({ ...m, coef: [...m.coef.slice(1), null] }), "sim"), /invalid numbers/);
  assert.throws(() => parseModel(JSON.stringify({ ...m, schema: 2 }), "sim"), /schema/);
});
