import { useId, useMemo, useState } from "react";
import { fmtDateTime, fmtNum, fmtTime } from "../format";
import { downsample } from "./charts";
import { useWidth } from "./useSize";

export interface Line {
  id: string;
  name: string;
  color: string;
  points: { t: number; equity: number }[];
}

const RANGES: { key: string; label: string; n: number }[] = [
  { key: "60", label: "Last 60", n: 60 },
  { key: "240", label: "Last 240", n: 240 },
  { key: "all", label: "All", n: Infinity },
];

/**
 * Interactive equity chart: hover crosshair with a tooltip, range tabs, legend toggles for comparing strategies,
 * a gradient area for a single line, and a draw-in animation. Plain SVG, no chart library.
 */
export function EquityChart({ lines, baseline, height = 250 }: { lines: Line[]; baseline?: number; height?: number }) {
  const uid = useId().replace(/:/g, "");
  const [ref, w] = useWidth<HTMLDivElement>(640);
  const [range, setRange] = useState("all");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  const n = RANGES.find((r) => r.key === range)?.n ?? Infinity;
  const shown = useMemo(
    () => lines.filter((l) => !hidden.has(l.id)).map((l) => ({ ...l, points: downsample(l.points.slice(-Math.min(n, l.points.length)), 260) })),
    [lines, hidden, n],
  );
  const all = shown.flatMap((l) => l.points);
  if (lines.every((l) => l.points.length < 2)) return <div className="empty">Building equity curve…</div>;

  const padL = 52, padR = 10, padT = 10, padB = 24;
  const H = height;
  const iw = Math.max(w - padL - padR, 10);
  const ih = H - padT - padB;
  const ts = all.map((p) => p.t);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const vals = all.map((p) => p.equity).concat(baseline !== undefined ? [baseline] : []);
  let v0 = Math.min(...vals), v1 = Math.max(...vals);
  const padV = Math.max((v1 - v0) * 0.08, 1e-6);
  v0 -= padV; v1 += padV;
  const px = (t: number) => padL + ((t - t0) / Math.max(t1 - t0, 1)) * iw;
  const py = (v: number) => padT + (1 - (v - v0) / Math.max(v1 - v0, 1e-9)) * ih;
  const ticks = [0, 1, 2, 3].map((i) => v0 + ((v1 - v0) * i) / 3);
  const xt = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3);
  const single = shown.length === 1;
  const lead = shown[0];
  const up = lead ? lead.points[lead.points.length - 1].equity >= lead.points[0].equity : true;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - r.left - padL) / iw) * (t1 - t0);
    let best = 0, bd = Infinity;
    const ref0 = lead?.points ?? [];
    ref0.forEach((p, i) => { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = i; } });
    setHover(ref0.length ? best : null);
  };
  const hp = hover !== null && lead ? lead.points[Math.min(hover, lead.points.length - 1)] : null;
  const at = (l: (typeof shown)[number], t: number) => l.points.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), l.points[0]);
  const many = Math.abs(t1 - t0) > 36 * 3600_000;

  return (
    <div>
      <div className="chart-head">
        <div className="legend">
          {lines.length > 1 && lines.map((l) => (
            <button key={l.id} className={`chip ${hidden.has(l.id) ? "" : "on"}`} style={hidden.has(l.id) ? undefined : { borderColor: l.color, color: l.color }} onClick={() => setHidden((s) => { const x = new Set(s); if (x.has(l.id)) x.delete(l.id); else x.add(l.id); return x; })} aria-pressed={!hidden.has(l.id)}>
              <i style={{ background: l.color }} />{l.name}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Range">
          {RANGES.map((r) => <button key={r.key} className={range === r.key ? "on" : ""} onClick={() => setRange(r.key)}>{r.label}</button>)}
        </div>
      </div>
      <div ref={ref} className="relative">
        <svg width={w} height={H} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Equity curve" className="eqsvg">
          <defs>
            {shown.map((l) => (
              <linearGradient key={l.id} id={`${uid}${l.id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={single ? (up ? "var(--green)" : "var(--red)") : l.color} stopOpacity={single ? 0.3 : 0.12} />
                <stop offset="1" stopColor={single ? (up ? "var(--green)" : "var(--red)") : l.color} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={w - padR} y1={py(v)} y2={py(v)} stroke="var(--line)" strokeDasharray={i === 0 ? undefined : "2 5"} />
              <text x={padL - 8} y={py(v)} textAnchor="end" dominantBaseline="central" className="axis">{fmtNum(v, v1 - v0 < 1 ? 3 : 2)}</text>
            </g>
          ))}
          {xt.map((t, i) => <text key={i} x={px(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"} className="axis">{many ? fmtDateTime(t) : fmtTime(t)}</text>)}
          {baseline !== undefined && <><line x1={padL} x2={w - padR} y1={py(baseline)} y2={py(baseline)} stroke="var(--amber)" strokeOpacity=".5" strokeDasharray="5 4" /><text x={w - padR} y={py(baseline) - 5} textAnchor="end" className="axis" fill="var(--amber)">start</text></>}
          {shown.map((l) => {
            const pts = l.points.map((p): [number, number] => [px(p.t), py(p.equity)]);
            const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
            const col = single ? (up ? "var(--green)" : "var(--red)") : l.color;
            const last = pts[pts.length - 1];
            return (
              <g key={l.id}>
                {single && <path d={`${d}L${last[0]},${padT + ih}L${pts[0][0]},${padT + ih}Z`} fill={`url(#${uid}${l.id})`} />}
                <path className="draw eqline" d={d} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" pathLength={1} />
                <circle cx={last[0]} cy={last[1]} r="3.5" fill={col} /><circle className="pulse" cx={last[0]} cy={last[1]} r="3.5" fill="none" stroke={col} />
              </g>
            );
          })}
          {hp && <line x1={px(hp.t)} x2={px(hp.t)} y1={padT} y2={padT + ih} stroke="var(--faint)" />}
          {hp && shown.map((l) => { const q = at(l, hp.t); return <circle key={l.id} cx={px(q.t)} cy={py(q.equity)} r="4.5" fill="var(--bg)" stroke={single ? (up ? "var(--green)" : "var(--red)") : l.color} strokeWidth="2" />; })}
        </svg>
        {hp && (
          <div className="tip" style={{ left: Math.min(Math.max(px(hp.t), 90), w - 90), top: 8 }}>
            <div className="muted">{many ? fmtDateTime(hp.t) : fmtTime(hp.t)}</div>
            {shown.map((l) => <div key={l.id} className="num"><i className="sw" style={{ background: l.color }} />{shown.length > 1 && `${l.name} `}{fmtNum(at(l, hp.t).equity, 3)} SOL</div>)}
          </div>
        )}
      </div>
    </div>
  );
}
