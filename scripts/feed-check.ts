/**
 * Smoke test for the live data sources. Run it on your own machine (it needs internet):
 *
 *   npm run feed:check
 *
 * It does not trade. It fetches real data, runs the on-chain checks on a few tokens and tells you what works.
 */
import { loadAppConfig, redactUrl } from "../src/config";
import { LiveFeed } from "../src/feeds/live";
import { scan } from "../src/scanner";
import { defaultStrategyConfig } from "../src/config";

const app = loadAppConfig({ ...process.env, FEED: "live" });
const cfg = defaultStrategyConfig(process.env);
console.log("RPC:", app.rpcUrl ? redactUrl(app.rpcUrl) : "(none: set HELIUS_API_KEY for safety checks; without it every token is rejected)");
console.log("Jupiter sell check:", app.jupiterApiKey ? "enabled" : "disabled (no JUPITER_API_KEY)");

const feed = new LiveFeed(app);
let universe = await feed.tick();
console.log(`\n1) Discovery + prices: ${universe.length} tokens`, feed.health());
if (!universe.length) {
  console.log("   Nothing came back. Check your internet connection / firewall and try again.");
  process.exit(1);
}
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  universe = await feed.tick();
}
const checked = universe.filter((t) => t.mintAuthorityRevoked !== null);
console.log(`2) On-chain checks completed for ${checked.length}/${universe.length} tokens`);
if (app.rpcUrl && checked.length === 0) console.log("   RPC checks returned nothing: is the key valid and the plan active?");

let pass = 0;
for (const t of universe.slice(0, 8)) {
  const r = scan(t, cfg);
  if (r.pass) pass++;
  console.log(`   ${t.symbol.padEnd(10)} liq $${Math.round(t.liquidityUsd).toString().padEnd(8)} top10=${t.top10HolderPct === null ? "?" : t.top10HolderPct.toFixed(0) + "%"} mintRevoked=${t.mintAuthorityRevoked} freezeRevoked=${t.freezeAuthorityRevoked} → ${r.pass ? "PASS" : "reject: " + r.reasons[0]}`);
}
console.log(`   ${pass} of the first ${Math.min(8, universe.length)} pass the scanner`);

const sample = universe.find((t) => t.pairAddress);
if (sample) {
  const c = await feed.candles(sample.mint, "5m");
  console.log(`3) Candles for ${sample.symbol}: ${c.candles.length} (source ${c.source}${c.note ? ", " + c.note : ""})`);
}
console.log("\nDone. If steps 1-3 look right, run `FEED=live npm start`.");
