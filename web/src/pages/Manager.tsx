import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import { Badge, Card } from "../ui";

type Message = { role: "user" | "model"; text: string };
type ChatResponse = { answer: string; model: string; advisoryOnly: true; contextUpdatedAt: string };
const STORAGE_KEY = "alpha-fun.manager-chat.v1";
const STARTER: Message = { role: "model", text: "I'm Manager AI, your Alpha.fun assistant. Ask me about the platform, Solana, market intelligence, your portfolio, positions, trading decisions, risk controls, strategies, or setup. I can explain and advise, but I cannot execute trades or move funds." };
const SUGGESTIONS = ["What is Alpha.fun doing right now?", "Explain my current portfolio", "How does the Risk Manager work?", "Explain a Solana token's liquidity"];

export function Manager() {
  const { strategyId, summary } = useApp();
  const [messages, setMessages] = useState<Message[]>(() => {
    try { const saved = localStorage.getItem(STORAGE_KEY); const parsed = saved ? JSON.parse(saved) as Message[] : null; return Array.isArray(parsed) && parsed.length ? parsed.slice(-30) : [STARTER]; }
    catch { return [STARTER]; }
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-30))); } catch { /* storage may be unavailable */ } }, [messages]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const next = [...messages, { role: "user" as const, text: question }].slice(-16);
    while (next.length && next[0].role !== "user") next.shift();
    setMessages((old) => [...old, { role: "user" as const, text: question }].slice(-30));
    setDraft(""); setBusy(true); setError(null);
    try {
      const response = await api<ChatResponse>("/api/manager/chat", { method: "POST", body: { messages: next, strategy: strategyId } });
      setMessages((old) => [...old, { role: "model" as const, text: response.answer }].slice(-30));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void send(draft); }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }

  return <div className="manager-page">
    <div className="manager-heading">
      <div><div className="manager-kicker">ALPHA.FUN INTELLIGENCE</div><h2>Manager AI</h2><p>Your conversational command center for research, platform guidance, and trading intelligence.</p></div>
      <Badge tone="ok"><span className="dot" />Assistant ready</Badge>
    </div>
    <div className="manager-layout">
      <Card>
        <div className="manager-chat-head"><div className="manager-avatar">α</div><div><strong>Manager AI</strong><div className="sub">Connected to selected strategy context</div></div><span className="manager-live">● Available</span></div>
        <div className="manager-messages" aria-live="polite">
          {messages.map((m, i) => <div className={`manager-message ${m.role === "user" ? "from-user" : "from-ai"}`} key={`${i}-${m.role}`}><div className="manager-message-label">{m.role === "user" ? "YOU" : "MANAGER AI"}</div><div className="manager-bubble">{m.text}</div></div>)}
          {busy && <div className="manager-message from-ai"><div className="manager-message-label">MANAGER AI</div><div className="manager-bubble manager-typing">Thinking…</div></div>}
          <div ref={endRef} />
        </div>
        {error && <div className="banner warn" role="alert">{error}</div>}
        <form className="manager-composer" onSubmit={submit}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder="Ask Manager AI anything…" rows={2} maxLength={2000} disabled={busy} aria-label="Message Manager AI"/><div className="manager-compose-bottom"><span className="sub">Enter to send · Shift + Enter for a new line</span><button className="primary" type="submit" disabled={busy || !draft.trim()}>Send ↗</button></div></form>
      </Card>
      <div className="manager-side">
        <Card><h3>Ask Manager AI</h3><div className="manager-suggestions">{SUGGESTIONS.map((s) => <button key={s} className="ghost" onClick={() => void send(s)} disabled={busy}>{s} <span>↗</span></button>)}</div></Card>
        <Card><h3>Platform context</h3><div className="manager-context-row"><span>Strategy</span><strong>{summary?.strategyName ?? strategyId ?? "Champion"}</strong></div><div className="manager-context-row"><span>Mode</span><strong>{summary?.paper ? "Paper trading" : "Configured mode"}</strong></div><div className="manager-context-row"><span>Market feed</span><strong>{summary?.feed.kind ?? "Checking…"}</strong></div><div className="manager-context-row"><span>Open positions</span><strong>{summary?.positions.length ?? "—"}</strong></div><p className="sub">Answers about your account use a read-only snapshot from the selected strategy.</p></Card>
        <Card><h3>Safety boundaries</h3><p className="sub">Manager AI can explain and recommend. It cannot sign transactions, move funds, place orders, or override the independent Risk Manager. Wallet approval remains required for every real transaction.</p><Badge tone="warn">Advisory only</Badge></Card>
        <button className="ghost manager-clear" onClick={() => { setMessages([STARTER]); setError(null); }}>Clear conversation</button>
      </div>
    </div>
  </div>;
}
