import { useEffect, useId, useRef, useState } from "react";
import type { Trade } from "../../../src/types";
import { fmtNum, fmtPct, fmtSol } from "../format";
import { useWidth } from "./useSize";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Number that counts up/down to its new value instead of jumping. */
export function AnimatedNumber({ value, format, ms = 600 }: { value: number; format: (n: number) => string; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced() || !Number.isFinite(value)) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min((t - start) / ms, 1);
      const e = 1 - Math.pow(1 - k, 3);
      const v = a + (value - a) * e;
      setShown(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

const pathOf = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

export function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const stride = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * stride)]);
  out[out.length - 1] = xs[xs.length - 1];
  return out;
}

/** Tiny trend line for stat tiles. Colour follows direction. */
export function Sparkline({ values, height = 30 }: { values: number[]; height?: number }) {
  const id = useId().replace(/:/g, "");
  const [ref, w] = useWidth<HTMLDivElement>(100);
  const v = downsample(values, 60);
  if (v.length < 2) return <div ref={ref} style={{ height }} />;
  const lo = Math.min(...v), hi = Math.max(...v);
  const span = Math.max(hi - lo, 1e-9);
  const pts = v.map((y, i): [number, number] => [(i / (v.length - 1)) * w, height - 3 - ((y - lo) / span) * (height - 6)]);
  const up = v[v.length - 1] >= v[0];
  const c = up ? "var(--green)" : "var(--red)";
  const d = pathOf(pts);
  return (
    <div ref={ref} className="spark" aria-hidden="true">
      <svg width={w} height={height}>
        <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={c} stopOpacity=".28" /><stop offset="1" stopColor={c} stopOpacity="0" /></linearGradient></defs>
        <path d={`${d}L${w},${height}L0,${height}Z`} fill={`url(#${id})`} />
        <path className="draw" d={d} fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" pathLength={1} />
      </svg>
    </div>
  );
}

/** Ring gauge, animates when the value changes. */
export function Ring({ value, label, sub, color = "var(--accent)", size = 104 }: { value: number; label: string; sub?: string; color?: string; size?: number }) {
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(Math.max(value, 0), 1);
  return (
    <div className="ring" style={{ width: size }}>
      <svg width={size} height={size} role="img" aria-label={`${label} ${(v * 100).toFixed(0)}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="8" />
        <circle className="ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" className="ring-num">{(v * 100).toFixed(0)}%</text>
      </svg>
      <div className="ring-label">{label}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** Profit and loss per exit reason, as diverging bars. */
export function ReasonBars({ byReason }: { byReason: Record<string, { count: number; pnlSol: number }> }) {
  const rows = Object.entries(byReason).sort((a, b) => b[1].pnlSol - a[1].pnlSol);
  if (!rows.length) return <div className="empty">No closed trades yet.</div>;
  const max = Math.max(...rows.map(([, v]) => Math.abs(v.pnlSol)), 1e-9);
  return (
    <div className="rbars">
      {rows.map(([k, v]) => {
        const pct = (Math.abs(v.pnlSol) / max) * 100;
        return (
          <div key={k} className="rbar" title={`${k}: ${v.count} fills, ${v.pnlSol.toFixed(3)} SOL`}>
            <span className="rname">{k.replace(/_/g, " ")}</span>
            <div className="rtrack">
              <div className="rmid" />
              <i className={v.pnlSol >= 0 ? "pos-bar" : "neg-bar"} style={{ width: `${pct / 2}%`, [v.pnlSol >= 0 ? "left" : "right"]: "50%" }} />
            </div>
            <span className={`rval num ${v.pnlSol >= 0 ? "pos" : "neg"}`}>{v.pnlSol >= 0 ? "+" : ""}{v.pnlSol.toFixed(2)}</span>
            <span className="rcount muted">{v.count}×</span>
          </div>
        );
      })}
    </div>
  );
}

/** Result per closed position (fills of one position are summed). */
export function positionResults(trades: Trade[], openIds: Set<string>): number[] {
  const g = new Map<string, { pnl: number; cost: number }>();
  for (const t of trades) {
    if (openIds.has(t.positionId)) continue;
    const cur = g.get(t.positionId) ?? { pnl: 0, cost: t.positionSizeSol };
    cur.pnl += t.pnlSol;
    g.set(t.positionId, cur);
  }
  return [...g.values()].filter((x) => x.cost > 0).map((x) => (x.pnl / x.cost) * 100);
}

/** Histogram of position outcomes (% return). Loss bars red, wins green. */
export function Histogram({ values, bins = 14 }: { values: number[]; bins?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>(400);
  const h = 150;
  if (values.length < 5) return <div ref={ref} className="empty">Needs at least 5 closed positions.</div>;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
  const a = Math.min(lo, -1), b = Math.max(hi, 1);
  const step = (b - a) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) counts[Math.min(Math.max(Math.floor((v - a) / step), 0), bins - 1)] += 1;
  const max = Math.max(...counts);
  const bw = (w - 8) / bins;
  const zeroX = 4 + ((0 - a) / (b - a)) * (w - 8);
  return (
    <div ref={ref}>
      <svg width={w} height={h + 22} role="img" aria-label="Distribution of position results">
        {counts.map((n, i) => {
          const mid = a + (i + 0.5) * step;
          const bh = (n / max) * (h - 8);
          return (
            <rect key={i} className="hbar" x={4 + i * bw + 1} y={h - bh} width={Math.max(bw - 2, 1)} height={bh} rx="2" fill={mid >= 0 ? "var(--green)" : "var(--red)"} fillOpacity={0.85} style={{ animationDelay: `${i * 20}ms` }}>
              <title>{`${(a + i * step).toFixed(0)}% to ${(a + (i + 1) * step).toFixed(0)}%: ${n} positions`}</title>
            </rect>
          );
        })}
        <line x1={zeroX} x2={zeroX} y1="0" y2={h} stroke="var(--faint)" strokeDasharray="3 3" />
        <text x="4" y={h + 15} className="axis">{a.toFixed(0)}%</text>
        <text x={zeroX} y={h + 15} className="axis" textAnchor="middle">0</text>
        <text x={w - 4} y={h + 15} className="axis" textAnchor="end">+{b.toFixed(0)}%</text>
      </svg>
    </div>
  );
}

/** Underwater curve: how far equity sits below its previous peak. */
export function DrawdownChart({ points }: { points: { t: number; equity: number }[] }) {
  const id = useId().replace(/:/g, "");
  const [ref, w] = useWidth<HTMLDivElement>(400);
  const h = 150;
  const [hover, setHover] = useState<number | null>(null);
  const p = downsample(points, 220);
  if (p.length < 3) return <div ref={ref} className="empty">Building history…</div>;
  let peak = p[0].equity;
  const dd = p.map((x) => { peak = Math.max(peak, x.equity); return peak > 0 ? ((x.equity - peak) / peak) * 100 : 0; });
  const worst = Math.min(...dd, -0.5);
  const xs = (i: number) => 4 + (i / (p.length - 1)) * (w - 8);
  const ys = (v: number) => 6 + (v / worst) * (h - 14);
  const d = pathOf(dd.map((v, i) => [xs(i), ys(v)]));
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(Math.max(Math.round(((e.clientX - r.left - 4) / (w - 8)) * (p.length - 1)), 0), p.length - 1));
  };
  return (
    <div ref={ref} className="relative">
      <svg width={w} height={h + 20} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Drawdown">
        <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--red)" stopOpacity="0" /><stop offset="1" stopColor="var(--red)" stopOpacity=".35" /></linearGradient></defs>
        <line x1="4" x2={w - 4} y1={ys(0)} y2={ys(0)} stroke="var(--line)" />
        <path d={`${d}L${xs(p.length - 1)},${ys(0)}L${xs(0)},${ys(0)}Z`} fill={`url(#${id})`} />
        <path className="draw" d={d} fill="none" stroke="var(--red)" strokeWidth="1.6" pathLength={1} />
        <text x="4" y={h + 15} className="axis">0%</text>
        <text x={w - 4} y={h + 15} className="axis" textAnchor="end">worst {worst.toFixed(1)}%</text>
        {hover !== null && <><line x1={xs(hover)} x2={xs(hover)} y1="0" y2={h} stroke="var(--faint)" /><circle cx={xs(hover)} cy={ys(dd[hover])} r="4" fill="var(--red)" /></>}
      </svg>
      {hover !== null && <div className="tip" style={{ left: Math.min(Math.max(xs(hover), 60), w - 60) }}>{dd[hover].toFixed(2)}% below peak</div>}
    </div>
  );
}

export const money = { sol: (n: number) => fmtSol(n, 3), signed: (n: number) => `${n >= 0 ? "+" : ""}${fmtNum(n, 3)}`, pct: fmtPct };
