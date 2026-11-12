import { useMemo, useState } from "react";
import type { TokensView } from "../../../src/api-types";
import { usePoll } from "../api";
import { useApp } from "../context";
import { fmtAge, fmtPct, fmtPrice, fmtUsd } from "../format";
import { go } from "../route";
import { Badge, Card } from "../ui";

type SortKey = "score" | "liquidityUsd" | "volume5mUsd" | "ageMinutes";

export function Tokens() {
  const { q } = useApp();
  const { data, error } = usePoll<TokensView>(`/api/tokens${q()}`, 4000);
  const [sort, setSort] = useState<SortKey>("score");
  const [theme, setTheme] = useState<string | null>(null);

  const rows = useMemo(() => {
    const t = (data?.tokens ?? []).filter((r) => !theme || r.theme === theme);
    return [...t].sort((a, b) => (sort === "ageMinutes" ? a[sort] - b[sort] : b[sort] - a[sort])).slice(0, 80);
  }, [data, sort, theme]);

  const th = (k: SortKey, label: string) => (
    <th className="sort r" onClick={() => setSort(k)}>{label}{sort === k ? " ↓" : ""}</th>
  );
  const maxVol = Math.max(...(data?.themes ?? []).map((t) => t.volume5mUsd), 1);

  return (
    <div className="stack">
      <Card title="Narrative heat" right="what the market is chasing right now">
        {data?.themes.length ? (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            {data.themes.map((t) => (
              <button key={t.theme} className={`chip ${theme === t.theme ? "on" : ""}`} style={{ textAlign: "left", borderRadius: 10, padding: 10 }} onClick={() => setTheme(theme === t.theme ? null : t.theme)}>
                <div><b>{t.theme}</b> <span className="muted">· {t.tokens} tokens</span></div>
                <div className="bar" style={{ margin: "6px 0" }}><i style={{ width: `${(t.volume5mUsd / maxVol) * 100}%` }} /></div>
                <div className="sub">{fmtUsd(t.volume5mUsd)}/5m · buys {(t.avgBuyRatio * 100).toFixed(0)}% · top {t.topSymbol}</div>
              </button>
            ))}
          </div>
        ) : <div className="empty">Waiting for market data…</div>}
      </Card>

      <Card title={`Tokens (${rows.length}${data ? ` of ${data.total}` : ""})`} right={
        <span className="row">
          {theme && <button className="sm" onClick={() => setTheme(null)}>clear {theme} ✕</button>}
        </span>
      }>
        {error && <div className="warn">{error}</div>}
        <div className="scroll">
          <table>
            <thead><tr><th>Token</th><th>Theme</th><th className="r">Price (SOL)</th>{th("liquidityUsd", "Liquidity")}{th("volume5mUsd", "Vol 5m")}<th className="r">Buys</th>{th("ageMinutes", "Age")}<th className="r">Organic vol</th>{th("score", "Score")}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.mint} className="click" onClick={() => go(`/token/${r.mint}`)}>
                  <td>{r.symbol} {r.held && <Badge tone="paper">held</Badge>}</td>
                  <td className="muted">{r.theme}</td>
                  <td className="r">{fmtPrice(r.price)}</td>
                  <td className="r">{fmtUsd(r.liquidityUsd)}</td>
                  <td className="r">{fmtUsd(r.volume5mUsd)}</td>
                  <td className="r">{r.buyRatio === null ? "–" : fmtPct(r.buyRatio * 100, 0).replace("+", "")}</td>
                  <td className="r">{fmtAge(r.ageMinutes)}</td>
                  <td className="r">{r.intelligence?.organicVolumeScore == null ? "–" : <span className={r.intelligence.organicVolumeScore >= 65 ? "pos" : "warn"}>{r.intelligence.organicVolumeScore}</span>}</td>
                  <td className="r">{(r.score * 100).toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">No tokens match.</div>}
        </div>
      </Card>
    </div>
  );
}
