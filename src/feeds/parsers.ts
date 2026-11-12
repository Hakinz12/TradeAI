import { isAddress, isOffCurveAddress } from "@solana/kit";
import type { Candle, TokenSnapshot } from "../types";

/** Defensive parsers: external data is untrusted, so every field is type-checked and nothing is assumed. */

export const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const cleanText = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[^\p{L}\p{N} ._$-]/gu, "").slice(0, max) : "");

export const isMint = (s: unknown): s is string => typeof s === "string" && s.length >= 32 && s.length <= 44 && isAddress(s);

/** Token addresses on Solana from DexScreener's profiles/boosts lists. */
export function parseDiscovery(json: unknown): string[] {
  const list = Array.isArray(json) ? json : [];
  const out: string[] = [];
  for (const raw of list) {
    const o = obj(raw);
    if (o.chainId === "solana" && isMint(o.tokenAddress)) out.push(o.tokenAddress);
  }
  return out;
}

export interface DexPair {
  mint: string;
  pairAddress: string;
  symbol: string;
  name: string;
  priceSol: number;
  liquidityUsd: number;
  volume5mUsd: number;
  buyRatio: number | null;
  priceChange5mPct: number | null;
  ageMinutes: number;
  priceUsd: number | null;
}

/**
 * Pick the best (deepest) usable pair per token from DexScreener's /tokens/v1 answer.
 * Price is expressed in SOL: directly when quoted in SOL, otherwise converted from USD.
 */
export function parsePairs(json: unknown, solUsd: number, nowMs: number): Map<string, DexPair> {
  const best = new Map<string, DexPair>();
  const list = Array.isArray(json) ? json : [];
  for (const raw of list) {
    const p = obj(raw);
    if (p.chainId !== "solana") continue;
    const base = obj(p.baseToken);
    const quote = obj(p.quoteToken);
    if (!isMint(base.address) || typeof p.pairAddress !== "string" || !isAddress(p.pairAddress)) continue;
    const liq = num(obj(p.liquidity).usd);
    const priceUsd = num(p.priceUsd);
    const priceNative = num(p.priceNative);
    if (liq === null || liq <= 0) continue;
    let priceSol: number | null = null;
    if (quote.address === WSOL && priceNative !== null && priceNative > 0) priceSol = priceNative;
    else if (priceUsd !== null && priceUsd > 0 && solUsd > 0) priceSol = priceUsd / solUsd;
    if (priceSol === null) continue;

    const m5 = obj(obj(p.txns).m5);
    const buys = num(m5.buys) ?? 0;
    const sells = num(m5.sells) ?? 0;
    const created = num(p.pairCreatedAt);
    const entry: DexPair = {
      mint: base.address,
      pairAddress: p.pairAddress,
      symbol: cleanText(base.symbol, 16) || "?",
      name: cleanText(base.name, 40),
      priceSol,
      liquidityUsd: liq,
      volume5mUsd: Math.max(num(obj(p.volume).m5) ?? 0, 0),
      buyRatio: buys + sells >= 5 ? buys / (buys + sells) : null,
      priceChange5mPct: num(obj(p.priceChange).m5),
      ageMinutes: created !== null && created > 0 ? Math.max((nowMs - created) / 60000, 0) : 0,
      priceUsd,
    };
    const cur = best.get(entry.mint);
    if (!cur || entry.liquidityUsd > cur.liquidityUsd) best.set(entry.mint, entry);
  }
  return best;
}

/** GeckoTerminal OHLCV: ohlcv_list rows are [ts, o, h, l, c, v], newest first. Returned oldest first. */
export function parseOhlcv(json: unknown, solUsd = 0, quoteIsUsd = false): Candle[] {
  const list = obj(obj(obj(json).data).attributes).ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Candle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(num);
    if (t === null || o === null || h === null || l === null || c === null) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || h < l) continue;
    const k = quoteIsUsd && solUsd > 0 ? 1 / solUsd : 1;
    out.push({ time: t, open: o * k, high: h * k, low: l * k, close: c * k, volume: v ?? 0 });
  }
  out.sort((a, b) => a.time - b.time);
  // drop duplicate timestamps
  return out.filter((c, i) => i === 0 || c.time !== out[i - 1].time);
}

export interface MintInfo {
  decimals: number | null;
  supply: number | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  token2022: boolean;
  token2022Risky: boolean | null;
  riskyExtensions: string[];
}

const RISKY_EXTENSIONS = new Set(["transferFeeConfig", "transferHook", "permanentDelegate", "defaultAccountState", "pausableConfig", "nonTransferable", "confidentialTransferMint"]);

/** getAccountInfo (jsonParsed) of a mint account. null authority in the parsed data means revoked. */
export function parseMintInfo(result: unknown): MintInfo | null {
  const value = obj(obj(result).value);
  if (!Object.keys(value).length) return null;
  const parsed = obj(obj(value.data).parsed);
  if (parsed.type !== "mint") return null;
  const info = obj(parsed.info);
  const owner = value.owner;
  const token2022 = owner === TOKEN_2022;
  const exts = Array.isArray(info.extensions) ? info.extensions : [];
  const risky: string[] = [];
  for (const e of exts) {
    const name = obj(e).extension;
    if (typeof name !== "string" || !RISKY_EXTENSIONS.has(name)) continue;
    if (name === "transferFeeConfig") {
      const st = obj(obj(e).state);
      const nf = obj(st.newerTransferFee);
      const of = obj(st.olderTransferFee);
      const bp = Math.max(num(nf.transferFeeBasisPoints) ?? 0, num(of.transferFeeBasisPoints) ?? 0);
      if (bp <= 0) continue; // fee configured at 0: harmless unless changed, the authority check covers that
    }
    risky.push(name);
  }
  const authorityState = (k: string): boolean | null => (k in info ? info[k] === null : null);
  return {
    decimals: num(info.decimals),
    supply: num(info.supply),
    mintAuthorityRevoked: authorityState("mintAuthority"),
    freezeAuthorityRevoked: authorityState("freezeAuthority"),
    token2022,
    token2022Risky: token2022 ? risky.length > 0 : false,
    riskyExtensions: risky,
  };
}

/** Largest token accounts: [{address, amount (raw string)}] */
export function parseLargest(result: unknown): { address: string; amount: number }[] {
  const list = obj(result).value;
  if (!Array.isArray(list)) return [];
  const out: { address: string; amount: number }[] = [];
  for (const r of list) {
    const o = obj(r);
    const amount = num(o.amount);
    if (typeof o.address === "string" && isAddress(o.address) && amount !== null && amount >= 0) out.push({ address: o.address, amount });
  }
  return out;
}

/** Owner wallet of each token account from getMultipleAccounts (jsonParsed). null = unknown. */
export function parseTokenAccountOwners(result: unknown): (string | null)[] {
  const list = obj(result).value;
  if (!Array.isArray(list)) return [];
  return list.map((v) => {
    const owner = obj(obj(obj(obj(v).data).parsed).info).owner;
    return typeof owner === "string" && isAddress(owner) ? owner : null;
  });
}

/**
 * Share of supply held by the biggest real holders. Token accounts owned by program-derived addresses
 * (pools, vaults, bonding curves: off-curve owners) are excluded, because they are not people who can dump.
 * Returns null whenever the answer cannot be trusted, so the scanner fails closed.
 */
export function top10Share(largest: { address: string; amount: number }[], owners: (string | null)[], ownerAccounts: unknown[], supply: number | null): number | null {
  if (!supply || supply <= 0 || largest.length === 0 || owners.length !== largest.length) return null;
  const holders: number[] = [];
  const byOwner = new Map<string, number>();
  largest.forEach((l, i) => {
    const owner = owners[i];
    if (!owner) return;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + l.amount);
  });
  if (byOwner.size === 0) return null;
  // classify unique owners: PDA (off-curve) or program-owned account = not a real holder
  const ownerList = [...byOwner.keys()];
  if (ownerAccounts.length !== ownerList.length) return null;
  ownerList.forEach((o, i) => {
    const acc = obj(ownerAccounts[i]);
    const exists = Object.keys(acc).length > 0;
    const programOwned = exists && acc.owner !== SYSTEM_PROGRAM;
    let off = false;
    try {
      off = isOffCurveAddress(o as never);
    } catch {
      return; // cannot classify: leave it out entirely and let the caller see an incomplete picture
    }
    if (off || programOwned) return;
    holders.push(byOwner.get(o) as number);
  });
  holders.sort((a, b) => b - a);
  const top = holders.slice(0, 10).reduce((a, b) => a + b, 0);
  return Math.min((top / supply) * 100, 100);
}

export function toSnapshot(pair: DexPair): TokenSnapshot {
  return {
    mint: pair.mint,
    symbol: pair.symbol,
    name: pair.name,
    price: pair.priceSol,
    liquidityUsd: pair.liquidityUsd,
    volume5mUsd: pair.volume5mUsd,
    buyRatio: pair.buyRatio,
    holders: null,
    top10HolderPct: null,
    mintAuthorityRevoked: null,
    freezeAuthorityRevoked: null,
    ageMinutes: pair.ageMinutes,
    smartWalletBuys: null,
    socialVelocity: null,
    priceChange5mPct: pair.priceChange5mPct,
    pairAddress: pair.pairAddress,
    token2022Risky: null,
    sellRouteOk: null,
    sellImpactPct: null,
  };
}
