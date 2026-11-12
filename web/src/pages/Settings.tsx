import { useEffect, useMemo, useState } from "react";
import type { StrategyConfig } from "../../../src/config";
import { api, usePoll } from "../api";
import { useApp } from "../context";
import { labelOf } from "../format";
import { Banner, Card, Modal, useAction } from "../ui";

interface SettingsView {
  editable: (keyof StrategyConfig)[];
  bounds: Record<string, [number, number]>;
  strategies: { id: string; name: string; champion: boolean; config: StrategyConfig }[];
}

const GROUPS: { title: string; keys: (keyof StrategyConfig)[]; hint: string }[] = [
  { title: "Entry filters", hint: "What must be true before a token can be bought.", keys: ["minScore", "minLiquidityUsd", "maxTop10HolderPct", "minHolders", "maxSellImpactPct"] },
  { title: "Position sizing", hint: "How much goes in and how much can be deployed.", keys: ["maxPositionPct", "maxOpenPositions", "maxExposurePct", "maxPerTheme", "maxPoolSharePct"] },
  { title: "Exits", hint: "Stops and targets. The stop loss is the automatic opt-out when a trade goes wrong.", keys: ["stopLossPct", "trailingStopPct", "tp1Mult", "tp1Fraction", "takeProfitMult", "maxHoldMinutes"] },
  { title: "Portfolio protection", hint: "Circuit breakers that stop the bot trading when conditions are bad.", keys: ["dailyLossLimitPct", "regimeEnabled", "regimeWindow", "regimeMinTrades", "regimeMaxLossRate", "regimeMinMedianBuy", "regimeCooldownTicks"] },
];
const PCT_AS_FRACTION = new Set<keyof StrategyConfig>(["minScore", "tp1Fraction", "regimeMaxLossRate", "regimeMinMedianBuy"]);
const show = (k: keyof StrategyConfig, v: number | boolean) => (typeof v === "boolean" ? v : PCT_AS_FRACTION.has(k) ? +(v * 100).toFixed(2) : v);
const parse = (k: keyof StrategyConfig, raw: string) => (PCT_AS_FRACTION.has(k) ? Number(raw) / 100 : Number(raw));

export function Settings() {
  const { strategyId, reload } = useApp();
  const { data, reload: reloadSettings } = usePoll<SettingsView>("/api/settings", 60_000);
  const { busy, run } = useAction();
  const strat = data?.strategies.find((s) => s.id === strategyId) ?? data?.strategies[0];
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setDraft({}), [strat?.id]);

  const changes = useMemo(() => {
    if (!strat) return [];
    const out: { key: keyof StrategyConfig; from: number | boolean; to: number | boolean }[] = [];
    for (const [k, raw] of Object.entries(draft)) {
      const key = k as keyof StrategyConfig;
      const cur = strat.config[key] as number | boolean;
      const next = typeof cur === "boolean" ? Boolean(raw) : parse(key, String(raw));
      if (next !== cur && !(typeof next === "number" && !Number.isFinite(next))) out.push({ key, from: cur, to: next });
    }
    return out;
  }, [draft, strat]);

  if (!data || !strat) return <div className="empty">Loading…</div>;

  const save = async () => {
    const patch = Object.fromEntries(changes.map((c) => [c.key, c.to]));
    const r = await run(() => api(`/api/settings/${strat.id}`, { method: "PUT", body: { patch } }), "Saved. Applies to new decisions immediately; open positions keep their existing stops.");
    if (r) { setConfirming(false); setDraft({}); reloadSettings(); reload(); }
  };

  return (
    <div className="stack">
      <Banner tone="info">Editing <b>{strat.name}</b>{strat.champion ? " (champion)" : ""}. Every value is range-checked by the server; you cannot save a setting outside its safe bounds.</Banner>
      <div className="grid two">
        {GROUPS.map((g) => (
          <Card key={g.title} title={g.title}>
            <p className="sub" style={{ marginTop: 0 }}>{g.hint}</p>
            <div className="stack">
              {g.keys.map((k) => {
                const cur = strat.config[k] as number | boolean;
                const [lo, hi] = data.bounds[k] ?? [0, 0];
                const label = labelOf(k) + (PCT_AS_FRACTION.has(k) ? " %" : "");
                if (typeof cur === "boolean") {
                  return <label key={k} className="row"><input type="checkbox" checked={Boolean(k in draft ? draft[k] : cur)} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} /> {label}</label>;
                }
                const lim = PCT_AS_FRACTION.has(k) ? [lo * 100, hi * 100] : [lo, hi];
                return (
                  <div key={k} className="field">
                    <label htmlFor={k}>{label} <span className="muted">({lim[0]}–{lim[1]})</span></label>
                    <input id={k} inputMode="decimal" value={String(k in draft ? draft[k] : show(k, cur))} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>
      <div className="row">
        <button className="primary" disabled={!changes.length || busy} onClick={() => setConfirming(true)}>Review {changes.length || ""} change{changes.length === 1 ? "" : "s"}</button>
        <button disabled={!changes.length} onClick={() => setDraft({})}>Discard</button>
      </div>
      {confirming && (
        <Modal title="Confirm changes" onClose={() => setConfirming(false)}>
          <table><tbody>{changes.map((c) => <tr key={c.key}><td>{labelOf(c.key)}</td><td className="r muted">{String(show(c.key, c.from))}</td><td className="r">→</td><td className="r"><b>{String(show(c.key, c.to))}</b></td></tr>)}</tbody></table>
          <div className="row" style={{ marginTop: 14 }}><button className="primary" disabled={busy} onClick={save}>Save changes</button><button onClick={() => setConfirming(false)}>Cancel</button></div>
        </Modal>
      )}
    </div>
  );
}
