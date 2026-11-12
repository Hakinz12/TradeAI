import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const describe = (status: number, body: unknown): string => {
  const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "";
  if (msg) return msg;
  if (status === 429) return "Too many requests. Try again later.";
  return `Request failed (${status}).`;
};

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Could not reach the bot.", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    // Action endpoints answer 4xx with a useful {ok:false,message|error}
    const m = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : describe(res.status, body);
    throw new ApiError(m, res.status);
  }
  return body as T;
}

/** Download an API export. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path);
  if (!res.ok) throw new ApiError(describe(res.status, null), res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface Poll<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Poll an endpoint. Pauses while the tab is hidden and ignores stale responses. */
export function usePoll<T>(path: string | null, ms: number): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const seq = useRef(0);

  useEffect(() => {
    if (!path) return;
    let stopped = false;
    const ctrl = new AbortController();
    const run = async () => {
      if (document.hidden) return;
      const mine = ++seq.current;
      try {
        const d = await api<T>(path, { signal: ctrl.signal });
        if (!stopped && mine === seq.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (!stopped && (e as Error).name !== "AbortError") setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    setLoading(true);
    void run();
    const id = setInterval(run, ms);
    return () => {
      stopped = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [path, ms, nonce]);

  return { data, error, loading, reload };
}
