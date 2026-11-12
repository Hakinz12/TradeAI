import { useCallback, useEffect, useMemo, useState } from "react";
import type { LabView, Summary } from "../../src/api-types";
import { api, usePoll } from "./api";
import { AppContext } from "./context";
import { Lab } from "./pages/Lab";
import { Manager } from "./pages/Manager";
import { Overview } from "./pages/Overview";
import { Reports } from "./pages/Reports";
import { Trade } from "./pages/Trade";
import { Settings } from "./pages/Settings";
import { TokenDetail } from "./pages/TokenDetail";
import { Tokens } from "./pages/Tokens";
import { Trades } from "./pages/Trades";
import { Wallet } from "./pages/Wallet";
import { useRoute } from "./route";
import { Badge, Card, ToastHost, useAction } from "./ui";

const svg = (children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICONS: Record<string, React.ReactNode> = {
  "/": svg(<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />),
  "/tokens": svg(<><circle cx="12" cy="12" r="8" /><path d="M12 8v8M9 10.5h4.5a1.5 1.5 0 0 1 0 3H9" /></>),
  "/lab": svg(<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />),
  "/trades": svg(<path d="M4 7h13l-3-3M20 17H7l3 3" />),
  "/trade": svg(<><path d="M4 18 9 12l4 3 7-9"/><path d="M15 6h5v5"/></>),
  "/wallet": svg(<><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18M16 15h2" /></>),
  "/settings": svg(<><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>),
  "/reports": svg(<><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h7" /></>),
  "/manager": svg(<><path d="M5 5h14v10H8l-3 3z" /><path d="M9 9h6M9 12h4" /></>),
};

const NAV: { path: string; label: string; short: string }[] = [
  { path: "/", label: "Overview", short: "Home" },
  { path: "/tokens", label: "Explore", short: "Explore" },
  { path: "/trade", label: "Trade", short: "Trade" },
  { path: "/lab", label: "Strategy lab", short: "Lab" },
  { path: "/trades", label: "Trades", short: "Trades" },
  { path: "/wallet", label: "Wallet", short: "Wallet" },
  { path: "/settings", label: "Settings", short: "Setup" },
  { path: "/reports", label: "Reports", short: "Reports" },
  { path: "/manager", label: "Manager AI", short: "AI" },
];

function Shell() {
  const route = useRoute();
  const [strategyId, setStrategyIdState] = useState(() => {
    try { return sessionStorage.getItem("alpha-fun.strategy") ?? ""; } catch { return ""; }
  });
  const setStrategyId = useCallback((id: string) => {
    setStrategyIdState(id);
    try { sessionStorage.setItem("alpha-fun.strategy", id); } catch { /* ignore */ }
  }, []);
  const q = useCallback((extra = "") => `${strategyId ? `?strategy=${encodeURIComponent(strategyId)}` : ""}${extra}`, [strategyId]);

  const sum = usePoll<Summary>(`/api/summary${q()}`, 3000);
  const lab = usePoll<LabView>("/api/lab", 6000);
  const { busy, run } = useAction();
  const s = sum.data;

  // if the selected strategy was archived, fall back to the champion
  useEffect(() => {
    if (strategyId && sum.error === "unknown strategy") setStrategyId("");
  }, [strategyId, sum.error, setStrategyId]);

  const reload = useCallback(() => { sum.reload(); lab.reload(); }, [sum, lab]);
  const ctx = useMemo(() => ({ strategyId: s?.strategyId ?? strategyId, setStrategyId, summary: s, lab: lab.data, reload, q }), [s, strategyId, setStrategyId, lab.data, reload, q]);

  const control = (action: "pause" | "resume" | "kill" | "rearm", target?: string) => {
    if (action === "kill" && !confirm(target === "all" ? "KILL ALL strategies? Every open position is closed immediately and trading stops until you re-arm." : "Kill this strategy? All its open positions are closed immediately and trading stops until you re-arm.")) return;
    void run(() => api("/api/control/" + action, { method: "POST", body: { strategy: target ?? s?.strategyId } }), `${action} done`).then(reload);
  };

  const page = (() => {
    const [a, b] = route.parts;
    if (!a) return <Overview />;
    if (a === "tokens") return <Tokens />;
    if (a === "trade") return <Trade />;
    if (a === "token" && b) return <TokenDetail mint={b} />;
    if (a === "lab") return <Lab />;
    if (a === "trades") return <Trades />;
    if (a === "wallet") return <Wallet />;
    if (a === "settings") return <Settings />;
    if (a === "reports") return <Reports />;
    if (a === "manager") return <Manager />;
    return <Card><p>Page not found. <a href="#/">Go to the overview</a>.</p></Card>;
  })();

  const section = route.parts[0] === "token" ? "/tokens" : "/" + (route.parts[0] ?? "");

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <aside className="side">
          <div className="brand"><i /><span className="brand-alpha">alpha<span>.fun</span></span></div>
          <nav className="nav">{NAV.map((n) => <a key={n.path} href={`#${n.path}`} className={section === n.path ? "on" : ""}>{ICONS[n.path]}{n.label}</a>)}</nav>
          <div style={{ marginTop: "auto" }} className="sub">
            {s && <>Tick {s.tick}<br />Model: {s.predictor}</>}
          </div>
        </aside>
        <main className="main">
          <div className="topbar">
            <h1>{NAV.find((n) => n.path === section)?.label ?? "Alpha.fun"}</h1>
            {s && (
              <>
                <Badge tone={s.paper ? "paper" : "bad"}>{s.paper ? "PAPER" : "LIVE"}</Badge>
                <Badge tone={s.feed.ok ? "ok" : "bad"}><span className="dot" />{s.feed.kind} feed</Badge>
                <Badge tone={s.killed ? "bad" : s.paused ? "warn" : "ok"}>{s.killed ? "killed" : s.paused ? "paused" : "running"}</Badge>
                {lab.data && lab.data.strategies.length > 1 && (
                  <select value={s.strategyId} onChange={(e) => setStrategyId(e.target.value)} aria-label="Strategy">
                    {lab.data.strategies.map((x) => <option key={x.id} value={x.id}>{x.name}{x.champion ? " ★" : ""}</option>)}
                  </select>
                )}
                {s.paused ? <button disabled={busy || s.killed} onClick={() => control("resume")}>Resume</button> : <button disabled={busy || s.killed} onClick={() => control("pause")}>Pause</button>}
                {s.killed ? <button disabled={busy} onClick={() => control("rearm")}>Re-arm</button> : <button className="danger" disabled={busy} onClick={() => control("kill")}>Kill</button>}
                <button className="danger sm" disabled={busy} onClick={() => control("kill", "all")} title="Close everything on every strategy">Kill all</button>
              </>
            )}
          </div>
          {sum.error && !s && <Card><div className="neg">{sum.error}</div></Card>}
          {page}
        </main>
      </div>
      <nav className="tabbar" aria-label="Pages">{NAV.map((n) => <a key={n.path} href={`#${n.path}`} className={section === n.path ? "on" : ""}>{n.short}</a>)}</nav>
    </AppContext.Provider>
  );
}

export default function App() {
  return <ToastHost><Shell /></ToastHost>;
}
