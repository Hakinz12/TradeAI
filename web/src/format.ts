export const LOCALE = (() => {
  try {
    new Intl.DateTimeFormat(navigator.language);
    return navigator.language;
  } catch {
    return "en-US"; // some environments report an invalid tag
  }
})();
export const fmtSol = (n: number, d = 3) => `${n.toFixed(d)} SOL`;
export const fmtNum = (n: number, d = 2) => n.toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtPct = (n: number, d = 1) => `${n > 0 ? "+" : ""}${n.toFixed(d)}%`;
export const cls = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
export const fmtUsd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`);
export const fmtPrice = (p: number) => (p === 0 ? "0" : p >= 0.01 ? p.toFixed(4) : p.toPrecision(3));
export const fmtTime = (t: number) => new Date(t).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const fmtDateTime = (t: number) => new Date(t).toLocaleString(LOCALE, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const short = (a: string, n = 4) => (a.length > 2 * n + 3 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);
export const fmtAge = (min: number) => (min < 60 ? `${Math.round(min)}m` : min < 1440 ? `${(min / 60).toFixed(1)}h` : `${(min / 1440).toFixed(1)}d`);
export const labelOf = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).replace("Pct", "%").replace("Sol", "SOL").replace("Usd", "USD");
