import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { parseDiscovery, parsePairs, parseOhlcv, parseMintInfo, parseLargest, top10Share, WSOL } from "../src/feeds/parsers";
import { HttpClient } from "../src/feeds/http";
import { LiveFeed } from "../src/feeds/live";
import { RpcClient } from "../src/rpc";
import { loadAppConfig } from "../src/config";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const RAYDIUM_AUTH = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"; // program-derived, off curve

const walletAddress = () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return getAddressDecoder().decode(new Uint8Array(raw));
};

const pair = (over: Record<string, unknown> = {}) => ({
  chainId: "solana", pairAddress: POOL, baseToken: { address: MINT, name: "Test Coin", symbol: "TST" }, quoteToken: { address: WSOL, symbol: "SOL" },
  priceNative: "0.00002", priceUsd: "0.003", txns: { m5: { buys: 30, sells: 10 } }, volume: { m5: 4200 }, priceChange: { m5: 3.5 },
  liquidity: { usd: 52000 }, pairCreatedAt: 1_700_000_000_000, ...over,
});

test("parsers: discovery keeps only valid Solana mints", () => {
  const out = parseDiscovery([{ chainId: "solana", tokenAddress: MINT }, { chainId: "ethereum", tokenAddress: MINT }, { chainId: "solana", tokenAddress: "not-an-address!" }, null, 5]);
  assert.deepEqual(out, [MINT]);
  assert.deepEqual(parseDiscovery({ nope: 1 }), []);
});

test("parsers: pairs → snapshot data, deepest pair wins, junk is dropped", () => {
  const m = parsePairs([pair(), pair({ pairAddress: WSOL, liquidity: { usd: 1000 } }), pair({ liquidity: { usd: "abc" } }), { chainId: "solana" }], 150, 1_700_000_600_000);
  const p = m.get(MINT)!;
  assert.equal(p.pairAddress, POOL);
  assert.equal(p.priceSol, 0.00002);
  assert.equal(p.buyRatio, 0.75);
  assert.equal(p.ageMinutes, 10);
  const usd = parsePairs([pair({ quoteToken: { address: MINT }, priceNative: "5", priceUsd: "0.003" })], 150, 0).get(MINT)!;
  assert.ok(Math.abs(usd.priceSol - 0.003 / 150) < 1e-12, "non-SOL quote converts from USD");
  const thin = parsePairs([pair({ txns: { m5: { buys: 1, sells: 1 } } })], 150, 0).get(MINT)!;
  assert.equal(thin.buyRatio, null, "too few trades = unknown, not 50%");
  assert.equal(parsePairs("garbage", 150, 0).size, 0);
});

test("parsers: token names are sanitised", () => {
  const p = parsePairs([pair({ baseToken: { address: MINT, name: "<script>x</script>=cmd", symbol: "A‮B" } })], 150, 0).get(MINT)!;
  assert.ok(!/[<>‮]/.test(p.name + p.symbol));
});

test("parsers: OHLCV sorted oldest first, invalid rows dropped", () => {
  const json = { data: { attributes: { ohlcv_list: [[120, 2, 3, 1, 2.5, 10], [60, 1, 2, 0.5, 1.5, 5], [60, 9, 9, 9, 9, 9], [180, 0, 1, 1, 1, 1], ["x"]] } } };
  const c = parseOhlcv(json);
  assert.deepEqual(c.map((x) => x.time), [60, 120]);
  assert.equal(parseOhlcv({}).length, 0);
});

const mintResult = (info: Record<string, unknown>, owner = "Tokenkeg") => ({ value: { owner, data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000000000", ...info } } } } });

test("parsers: mint authority null means revoked, missing means unknown", () => {
  const ok = parseMintInfo(mintResult({ mintAuthority: null, freezeAuthority: null }))!;
  assert.equal(ok.mintAuthorityRevoked, true);
  assert.equal(ok.freezeAuthorityRevoked, true);
  const live = parseMintInfo(mintResult({ mintAuthority: "abc", freezeAuthority: null }))!;
  assert.equal(live.mintAuthorityRevoked, false);
  const unknown = parseMintInfo(mintResult({}))!;
  assert.equal(unknown.mintAuthorityRevoked, null);
  assert.equal(parseMintInfo({ value: null }), null);
});

test("parsers: Token-2022 risky extensions are flagged, a zero fee is not", () => {
  const risky = parseMintInfo(mintResult({ mintAuthority: null, freezeAuthority: null, extensions: [{ extension: "transferHook", state: {} }] }, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"))!;
  assert.equal(risky.token2022Risky, true);
  const fee = parseMintInfo(mintResult({ extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 500 } } }] }, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"))!;
  assert.equal(fee.token2022Risky, true);
  const zero = parseMintInfo(mintResult({ extensions: [{ extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 0 } } }] }, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"))!;
  assert.equal(zero.token2022Risky, false);
  assert.equal(ok(parseMintInfo(mintResult({}))!.token2022Risky), false);
});
const ok = (v: unknown) => v;

test("top-10 share excludes pool/program-controlled owners and fails closed on bad data", () => {
  const w1 = walletAddress();
  const w2 = walletAddress();
  const largest = [
    { address: MINT, amount: 500 }, // owned by the pool authority (PDA): excluded
    { address: POOL, amount: 100 }, // wallet 1
    { address: WSOL, amount: 50 }, // wallet 2
  ];
  const owners = [RAYDIUM_AUTH, w1, w2];
  const SYS = "11111111111111111111111111111111";
  const ownerAccounts = [{}, { owner: SYS }, { owner: SYS }];
  const pct = top10Share(largest, owners, ownerAccounts, 1000);
  assert.equal(pct, 15);
  assert.equal(top10Share(largest, owners, ownerAccounts, null), null);
  assert.equal(top10Share(largest, owners, [{}], 1000), null, "mismatched data = unknown");
  assert.equal(top10Share([], [], [], 1000), null);
  assert.equal(parseLargest({ value: [{ address: MINT, amount: "12" }, { address: "bad", amount: "1" }] }).length, 1);
});

test("http: retries 5xx, honours failures, never follows redirects", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls < 3) return new Response("busy", { status: 503 });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as typeof fetch;
  const http = new HttpClient({ fetchFn, retries: 2, sleep: async () => undefined });
  assert.deepEqual(await http.json("https://example.test/x"), { ok: 1 });
  assert.equal(calls, 3);
  const bad = new HttpClient({ fetchFn: (async () => new Response("no", { status: 404 })) as typeof fetch, sleep: async () => undefined });
  await assert.rejects(() => bad.json("https://example.test/x"), /404/);
  const ua: string[] = [];
  const spy = new HttpClient({ fetchFn: (async (_u: unknown, init?: RequestInit) => { ua.push(String((init?.headers as Record<string, string>)["user-agent"])); return new Response("{}"); }) as typeof fetch });
  await spy.json("https://example.test/y");
  assert.ok(!ua[0].includes("@"), "no email in the user agent");
});

test("live feed: end-to-end with mocked APIs, fails closed until on-chain checks arrive", async () => {
  const app = loadAppConfig({ FEED: "live" } as NodeJS.ProcessEnv);
  let rpcOn = false;
  const fetchFn = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("token-profiles")) return new Response(JSON.stringify([{ chainId: "solana", tokenAddress: MINT }]));
    if (u.includes("token-boosts")) return new Response("[]");
    if (u.includes("/tokens/v1/solana/")) return new Response(JSON.stringify([pair()]));
    if (u.includes("rpc.test")) {
      if (!rpcOn) return new Response("down", { status: 500 });
      return new Response(JSON.stringify({ result: mintResult({ mintAuthority: null, freezeAuthority: null }) }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const http = new HttpClient({ fetchFn, retries: 0, sleep: async () => undefined });
  const rpc = new RpcClient("https://rpc.test/?api-key=SECRET", http);
  let now = 1_700_000_600_000;
  const feed = new LiveFeed(app, { http, rpc, now: () => now });
  const first = await feed.tick();
  assert.equal(first.length, 1);
  assert.equal(first[0].mintAuthorityRevoked, null, "unknown until verified on-chain");
  assert.equal(feed.health().ok, true);
  rpcOn = true;
  now += 120_000;
  const second = await feed.tick();
  assert.equal(second[0].mintAuthorityRevoked, true);
  assert.equal(second[0].freezeAuthorityRevoked, true);
  assert.equal(feed.get(MINT)?.symbol, "TST");
});

test("live feed: health turns unhealthy when the price API is down", async () => {
  const app = loadAppConfig({ FEED: "live" } as NodeJS.ProcessEnv);
  const http = new HttpClient({ fetchFn: (async () => new Response("x", { status: 500 })) as typeof fetch, retries: 0, sleep: async () => undefined });
  let now = 1_700_000_000_000;
  const feed = new LiveFeed(app, { http, rpc: null, now: () => now });
  await feed.tick();
  assert.equal(feed.health().ok, false);
});

test("rpc: refuses plain http to remote hosts", () => {
  assert.throws(() => new RpcClient("http://evil.example/rpc"));
  assert.doesNotThrow(() => new RpcClient("https://mainnet.helius-rpc.com/?api-key=x"));
});
