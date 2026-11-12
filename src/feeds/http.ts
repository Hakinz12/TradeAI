/**
 * Small HTTP helper for outbound API calls: timeouts, bounded retries with backoff, a minimum interval per host
 * (so free-tier rate limits are respected) and a generic User-Agent. It never sends personal details.
 */
export type FetchFn = typeof fetch;

export interface HttpOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  retries?: number;
  /** host -> minimum ms between requests */
  minIntervalMs?: Record<string, number>;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

const MAX_BODY_BYTES = 2_000_000;

export class HttpClient {
  private last = new Map<string, number>();
  private chain = new Map<string, Promise<void>>();
  private fetchFn: FetchFn;
  private timeoutMs: number;
  private retries: number;
  private ua: string;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: HttpOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.retries = opts.retries ?? 2;
    this.ua = opts.userAgent ?? "alpha-fun-research/0.1";
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Serialise requests per host and keep the configured gap between them. */
  private async gate(host: string): Promise<void> {
    const gap = this.opts.minIntervalMs?.[host] ?? 0;
    if (!gap) return;
    const prev = this.chain.get(host) ?? Promise.resolve();
    const next = prev.then(async () => {
      const wait = (this.last.get(host) ?? 0) + gap - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last.set(host, Date.now());
    });
    this.chain.set(host, next.catch(() => undefined));
    await next;
  }

  async json<T = unknown>(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    const host = new URL(url).host;
    let lastErr: Error = new Error("request failed");
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.gate(host);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(url, {
          method: init.method ?? "GET",
          headers: { accept: "application/json", "user-agent": this.ua, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: ctrl.signal,
          redirect: "error",
        });
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get("retry-after"));
          lastErr = new HttpError(`${host} answered ${res.status}`, res.status);
          if (attempt < this.retries) await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : 500 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new HttpError(`${host} answered ${res.status}`, res.status);
        const text = await res.text();
        if (text.length > MAX_BODY_BYTES) throw new HttpError(`${host} response too large`, res.status);
        return JSON.parse(text) as T;
      } catch (err) {
        if (err instanceof HttpError && err.status !== null && err.status < 500 && err.status !== 429) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        if ((err as Error).name === "AbortError") lastErr = new HttpError(`${host} timed out`, null);
        if (attempt < this.retries) await this.sleep(500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }
}
