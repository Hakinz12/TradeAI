import { parseLargest, parseMintInfo, parseTokenAccountOwners, top10Share } from "./parsers";
import type { MintInfo } from "./parsers";
import type { HttpClient } from "./http";
import type { RpcClient } from "../rpc";

export interface Safety {
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  token2022Risky: boolean | null;
  top10HolderPct: number | null;
  decimals: number | null;
  checkedAt: number;
}

/** On-chain authority and holder-concentration checks through the RPC. Any failure leaves fields null (scanner fails closed). */
export async function checkMintSafety(rpc: RpcClient, mint: string, now: number): Promise<Safety> {
  const empty: Safety = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null, token2022Risky: null, top10HolderPct: null, decimals: null, checkedAt: now };
  let info: MintInfo | null = null;
  try {
    info = parseMintInfo(await rpc.call("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]));
  } catch {
    return empty;
  }
  if (!info) return empty;
  const out: Safety = {
    ...empty,
    mintAuthorityRevoked: info.mintAuthorityRevoked,
    freezeAuthorityRevoked: info.freezeAuthorityRevoked,
    token2022Risky: info.token2022Risky,
    decimals: info.decimals,
  };
  try {
    const largest = parseLargest(await rpc.call("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]));
    if (largest.length) {
      const accounts = await rpc.call("getMultipleAccounts", [largest.map((l) => l.address), { encoding: "jsonParsed" }]);
      const owners = parseTokenAccountOwners(accounts);
      const uniqueOwners = [...new Set(owners.filter((o): o is string => Boolean(o)))];
      const ownerAccounts = uniqueOwners.length ? ((await rpc.call<{ value: unknown[] }>("getMultipleAccounts", [uniqueOwners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value ?? []) : [];
      out.top10HolderPct = top10Share(largest, owners, ownerAccounts, info.supply);
    }
  } catch {
    /* leave top10HolderPct null */
  }
  return out;
}

export interface SellCheck {
  ok: boolean;
  impactPct: number | null;
  checkedAt: number;
}

/** Optional: can this token be sold back to SOL through Jupiter, and at what price impact? Needs a Jupiter API key. */
export async function checkSellRoute(http: HttpClient, quoteUrl: string, apiKey: string, mint: string, decimals: number, priceSol: number, sizeSol: number, now: number): Promise<SellCheck | null> {
  if (!apiKey || priceSol <= 0) return null;
  const raw = Math.floor((sizeSol / priceSol) * 10 ** decimals);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const url = `${quoteUrl}?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${raw}&slippageBps=300`;
  try {
    const q = await http.json<{ routePlan?: unknown[]; priceImpactPct?: string; outAmount?: string }>(url, { headers: { "x-api-key": apiKey } });
    const hasRoute = Array.isArray(q.routePlan) && q.routePlan.length > 0 && Number(q.outAmount) > 0;
    const impact = Number(q.priceImpactPct);
    return { ok: hasRoute, impactPct: Number.isFinite(impact) ? Math.abs(impact) * 100 : null, checkedAt: now };
  } catch (err) {
    // 400/404 "no route" means the token cannot be sold: that is a real finding. Other errors are unknown.
    const status = (err as { status?: number | null }).status;
    if (status === 400 || status === 404) return { ok: false, impactPct: null, checkedAt: now };
    return null;
  }
}
