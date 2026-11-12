import { useState } from "react";
import { api } from "../api";
import { EquityChart } from "../components/EquityChart";
import { useApp } from "../context";
import { cls, fmtPct, fmtSol } from "../format";
import { Badge, Card, Modal, useAction } from "../ui";

const COLORS = ["var(--accent)", "var(--blue)", "var(--amber)", "#c084fc", "#fb7185", "#a3e635"];

export function Lab() {
  const { lab, reload, setStrategyId, strategyId } = useApp();
  const { busy, run } = useAction();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState("champion");
  const [stop, setStop] = useState("");
  const [minScore, setMinScore] = useState("");
  const [pos, setPos] = useState("");
  if (!lab) return <div className="empty">Loading…</div>;

  const act = (path: string, body: unknown, ok: string) => run(() => api(path, { method: "POST", body }), ok).then(reload);

  const create = async () => {
    const patch: Record<string, number> = {};
    if (stop) patch.stopLossPct = Number(stop);
    if (minScore) patch.minScore = Number(minScore) / 100;
    if (pos) patch.maxPositionPct = Number(pos);
    const r = await run(() => api("/api/strategies", { method: "POST", body: { name, baseId: base, patch } }), "Strategy created. It trades alongside the others with its own paper account.");
    if (r) { setCreating(false); setName(""); reload(); }
  };

  return (
    <div className="stack">
      <Card title="Same market, different rules" right={<button className="sm primary" onClick={() => setCreating(true)} disabled={lab.strategies.length >= 6}>New strategy</button>}>
        <p className="sub" style={{ marginTop: 0 }}>Every strategy trades the same live data with its own paper account, so you can see which rules actually work before trusting one. Promote the best to champion.</p>
        <EquityChart lines={lab.strategies.map((s, i) => ({ id: s.id, name: s.name, color: COLORS[i % COLORS.length], points: s.curve }))} />
      </Card>

      <Card title="Comparison">
        <div className="scroll"><table>
          <thead><tr><th>Strategy</th><th className="r">Equity</th><th className="r">P/L</th><th className="r">Closed</th><th className="r">Win rate</th><th className="r">Expectancy</th><th className="r">PF</th><th className="r">Max DD</th><th className="r">Open</th><th /></tr></thead>
          <tbody>
            {lab.strategies.map((s) => (
              <tr key={s.id}>
                <td>{s.name} {s.champion && <Badge tone="paper">champion</Badge>} {s.killed && <Badge tone="bad">killed</Badge>} {s.paused && <Badge tone="warn">paused</Badge>}</td>
                <td className="r">{fmtSol(s.equitySol, 2)}</td>
                <td className={`r ${cls(s.pnlPct)}`}>{fmtPct(s.pnlPct)}</td>
                <td className="r">{s.positionsClosed}</td>
                <td className="r">{(s.winRate * 100).toFixed(0)}%</td>
                <td className={`r ${cls(s.expectancyPct)}`}>{fmtPct(s.expectancyPct)}</td>
                <td className="r">{s.profitFactor === null ? "–" : s.profitFactor.toFixed(2)}</td>
                <td className="r">{s.maxDrawdownPct.toFixed(1)}%</td>
                <td className="r">{s.open}</td>
                <td className="r"><span className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                  <button className="sm" onClick={() => setStrategyId(s.id)} disabled={strategyId === s.id}>{strategyId === s.id ? "viewing" : "view"}</button>
                  {!s.champion && <button className="sm" disabled={busy} onClick={() => confirm(`Make ${s.name} the champion? The champion is the strategy the dashboard shows by default and the one future live trading would use.`) && void act(`/api/strategies/${s.id}/promote`, {}, `${s.name} is now champion.`)}>promote</button>}
                  {!s.champion && <button className="sm danger" disabled={busy} onClick={() => confirm(`Archive ${s.name}? It stops trading; its history is kept.`) && void act(`/api/strategies/${s.id}/archive`, {}, "Archived.")}>archive</button>}
                </span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="sub">Small samples lie: a strategy needs dozens of closed positions before its numbers mean anything.</p>
      </Card>

      {creating && (
        <Modal title="New strategy" onClose={() => setCreating(false)}>
          <div className="stack">
            <div className="field"><label htmlFor="n">Name</label><input id="n" value={name} maxLength={30} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label htmlFor="b">Start from</label><select id="b" value={base} onChange={(e) => setBase(e.target.value)}>{lab.strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div className="row">
              <div className="field"><label htmlFor="s">Stop loss %</label><input id="s" inputMode="decimal" placeholder="keep" value={stop} onChange={(e) => setStop(e.target.value)} /></div>
              <div className="field"><label htmlFor="m">Min score (0-100)</label><input id="m" inputMode="decimal" placeholder="keep" value={minScore} onChange={(e) => setMinScore(e.target.value)} /></div>
              <div className="field"><label htmlFor="p">Position size %</label><input id="p" inputMode="decimal" placeholder="keep" value={pos} onChange={(e) => setPos(e.target.value)} /></div>
            </div>
            <p className="sub">All other settings are copied. Fine-tune everything on the Settings page afterwards.</p>
            <div className="row"><button className="primary" disabled={busy || !name.trim()} onClick={create}>Create</button><button onClick={() => setCreating(false)}>Cancel</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
