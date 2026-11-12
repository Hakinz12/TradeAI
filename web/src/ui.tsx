import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Sparkline } from "./components/charts";

export const Card = ({ title, right, children, className = "" }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>
    {title && (
      <h2>
        {title}
        {right && <span className="right">{right}</span>}
      </h2>
    )}
    {children}
  </section>
);

export function Stat({ label, value, sub, tone, spark }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; spark?: number[] }) {
  // brief highlight when the displayed value changes, so live updates are noticeable
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const prev = useRef(text);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (text && prev.current !== text) { setFlash((n) => n + 1); }
    prev.current = text;
  }, [text]);
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div key={flash} className={`value ${tone ?? ""} ${flash ? "flash" : ""}`}>{value}</div>
      {sub !== undefined && <div className="sub num">{sub}</div>}
      {spark && spark.length > 2 && <Sparkline values={spark} />}
    </div>
  );
}

export const Badge = ({ tone = "", children }: { tone?: string; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

type ToastKind = "good" | "bad" | "";
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: ToastKind } | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((msg: string, kind: ToastKind = "") => {
    setT({ msg, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast ${t.kind}`} role="status">
          {t.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export const Banner = ({ tone, children }: { tone: "warn" | "bad" | "info"; children: ReactNode }) => <div className={`banner ${tone}`}>{children}</div>;

/** Run an async action with a busy flag; errors become toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (ok) toast(typeof ok === "function" ? ok(r) : ok, "good");
        return r;
      } catch (e) {
        toast((e as Error).message, "bad");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}
