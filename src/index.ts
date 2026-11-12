import { appConfig, baseStrategyConfig, redactUrl } from "./config";
import { buildLab } from "./bootstrap";
import { startServer } from "./server";
import { RpcClient } from "./rpc";
import { registerWalletRoutes, startWalletWatch } from "./wallet/routes";
import { WalletService } from "./wallet/service";

if (!appConfig.paperMode) {
  console.error("Live trading is not implemented yet. Set PAPER_MODE=true.");
  process.exit(1);
}
if (appConfig.rpcUrl) console.log(`[config] RPC: ${redactUrl(appConfig.rpcUrl)}`);

const { lab, db, notifier } = buildLab(appConfig, baseStrategyConfig);
console.log(`[engine] ${lab.engines.size} strategies, feed=${lab.d.feed.kind}, predictor=${lab.d.predictor.name}, alerts=${notifier.enabled ? "on" : "off"}`);

// One step at a time: a slow step (e.g. a slow API call) skips the next timer tick instead of piling up.
let busy = false;
const intervalMs = appConfig.feed === "live" ? appConfig.pollMs : appConfig.tickMs;
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  lab
    .step()
    .catch((err) => console.error("[engine] tick error:", (err as Error).message))
    .finally(() => {
      busy = false;
    });
}, intervalMs);

const wallet = new WalletService(appConfig, appConfig.rpcUrl ? new RpcClient(appConfig.rpcUrl) : null, db);
const walletTimer = startWalletWatch(wallet, notifier, appConfig.walletAlertDropPct);
const { server, stop } = startServer({ cfg: appConfig, lab, db, extend: (ctx) => registerWalletRoutes(ctx, wallet) });

const shutdown = () => {
  clearInterval(timer);
  clearInterval(walletTimer);
  stop();
  server.close();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
