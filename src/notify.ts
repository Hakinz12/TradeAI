export type AlertLevel = "info" | "warn" | "critical";

export interface NotifierOptions {
  discordWebhook?: string;
  telegramToken?: string;
  telegramChatId?: string;
  fetchFn?: typeof fetch;
  telegramBase?: string;
  /** Tests only: accept webhook hosts other than discord.com */
  allowAnyHost?: boolean;
  dedupeMs?: number;
  now?: () => number;
}

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

/**
 * Alerts to Discord and/or Telegram. Never throws: a broken webhook must not stop the trading loop.
 * Repeats of the same alert key inside the dedupe window are dropped, so a flapping condition cannot spam you.
 */
export class Notifier {
  readonly enabled: boolean;
  private fetchFn: typeof fetch;
  private last = new Map<string, number>();
  private discordUrl: string | null = null;
  private telegramUrl: string | null = null;
  private chatId: string;
  private dedupeMs: number;
  private now: () => number;

  constructor(opts: NotifierOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.dedupeMs = opts.dedupeMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.chatId = opts.telegramChatId ?? "";

    if (opts.discordWebhook) {
      try {
        const u = new URL(opts.discordWebhook);
        const okHost = opts.allowAnyHost || DISCORD_HOSTS.has(u.hostname);
        if ((u.protocol === "https:" || opts.allowAnyHost) && okHost && u.pathname.startsWith("/api/webhooks/")) {
          this.discordUrl = u.toString();
        } else {
          console.warn("[alerts] ALERT_DISCORD_WEBHOOK ignored: not a discord.com webhook URL");
        }
      } catch {
        console.warn("[alerts] ALERT_DISCORD_WEBHOOK ignored: not a valid URL");
      }
    }

    if (opts.telegramToken && this.chatId) {
      if (/^\d+:[\w-]+$/.test(opts.telegramToken) && /^-?\d+$|^@\w+$/.test(this.chatId)) {
        this.telegramUrl = `${opts.telegramBase ?? "https://api.telegram.org"}/bot${opts.telegramToken}/sendMessage`;
      } else {
        console.warn("[alerts] Telegram settings ignored: token or chat id has an unexpected format");
      }
    }

    this.enabled = this.discordUrl !== null || this.telegramUrl !== null;
  }

  /** Returns true if the alert was sent to at least one channel. */
  async send(level: AlertLevel, key: string, text: string): Promise<boolean> {
    const now = this.now();
    const window = level === "critical" ? Math.min(this.dedupeMs, 10_000) : this.dedupeMs;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < window) return false;
    this.last.set(key, now);

    const line = `[${level.toUpperCase()}] ${text}`.slice(0, 1800);
    console.log(`[alert] ${line}`);
    if (!this.enabled) return false;

    const jobs: Promise<boolean>[] = [];
    if (this.discordUrl) jobs.push(this.post(this.discordUrl, { content: line }));
    if (this.telegramUrl) jobs.push(this.post(this.telegramUrl, { chat_id: this.chatId, text: line }));
    const results = await Promise.all(jobs);
    return results.some(Boolean);
  }

  private async post(url: string, body: unknown): Promise<boolean> {
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) console.warn(`[alerts] webhook returned ${res.status}`);
      return res.ok;
    } catch (err) {
      console.warn(`[alerts] webhook failed: ${(err as Error).name}`);
      return false;
    }
  }
}
