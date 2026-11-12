import { HttpClient } from "./feeds/http";

/** Minimal JSON-RPC client for a Solana RPC endpoint. The URL may contain an API key: it is never logged. */
export class RpcClient {
  constructor(private url: string, private http: HttpClient = new HttpClient({ timeoutMs: 10000 })) {
    if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
      throw new Error("RPC URL must be https (or http on localhost for tests)");
    }
  }

  get enabled(): boolean {
    return Boolean(this.url);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.http.json<{ result?: T; error?: { message?: string; code?: number } }>(this.url, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
    });
    if (res.error) throw new Error(`RPC ${method}: ${res.error.message ?? "error"}`);
    if (res.result === undefined) throw new Error(`RPC ${method}: empty result`);
    return res.result;
  }
}
