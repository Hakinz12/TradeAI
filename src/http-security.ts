import type { NextFunction, Request, RequestHandler, Response } from "express";

export const isLoopback = (host: string) => host === "127.0.0.1" || host === "::1" || host === "localhost";

/** Tiny fixed-window counter keyed by client IP. In memory only: fine for one process. */
export class WindowCounter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private timer: NodeJS.Timeout;

  constructor(private windowMs: number) {
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref();
  }

  add(key: string): number {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/**
 * lightweight-charts 5.2.1 injects one fixed <style> element at runtime. Rather than allowing every inline style, the
 * policy allows exactly that stylesheet by hash. If you upgrade lightweight-charts, the browser console shows the new
 * hash in a CSP violation message: replace it here.
 */
export const CHART_STYLE_HASH = "sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY=";

export const CSP = `default-src 'self'; script-src 'self'; style-src 'self' '${CHART_STYLE_HASH}'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

export function securityHeaders(loopbackOnly: boolean): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!loopbackOnly) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

export interface ApiRateLimiter {
  handler: RequestHandler;
  stop: () => void;
}

/** Rate limit API traffic per IP and prevent API responses from being cached. */
export function createApiRateLimiter(maxReqPerMin = 300): ApiRateLimiter {
  const requests = new WindowCounter(60_000);

  const handler = (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    const ip = req.ip ?? "unknown";

    if (requests.add(ip) > maxReqPerMin) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "too many requests" });
      return;
    }
    next();
  };

  return { handler, stop: () => requests.stop() };
}
