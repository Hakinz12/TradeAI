import type { Request, Response } from "express";
import { isAddress } from "@solana/kit";
import type { ApiContext } from "../server";
import { WindowCounter, isLoopback } from "../http-security";
import type { Notifier } from "../notify";
import type { WalletService } from "./service";

const WINDOW = 15 * 60_000;

export function registerWalletRoutes(ctx: ApiContext, wallet: WalletService): void {
  const { app, cfg } = ctx;
  const prepares = new WindowCounter(WINDOW);
  const executes = new WindowCounter(WINDOW);
  const bad = (res: Response, msg: string) => res.status(400).json({ error: msg });

  // Passphrases travel in the request body: off-loopback that is only acceptable over HTTPS.
  const secureEnough = (req: Request, res: Response): boolean => {
    if (isLoopback(cfg.host) || req.secure) return true;
    res.status(403).json({ error: "Withdrawals need HTTPS when the dashboard is reachable from other machines." });
    return false;
  };

  app.get("/api/wallet", async (_req, res) => {
    res.json(await wallet.view());
  });

  app.post("/api/wallet/challenge", (req, res) => {
    const addr = (req.body as { address?: unknown } | undefined)?.address;
    if (typeof addr !== "string" || !isAddress(addr)) return bad(res, "invalid wallet address");
    res.json(wallet.challenge(addr));
  });

  app.post("/api/wallet/verify", async (req, res) => {
    const b = (req.body ?? {}) as { address?: unknown; signature?: unknown };
    if (typeof b.address !== "string" || !isAddress(b.address) || typeof b.signature !== "string" || b.signature.length > 200) return bad(res, "invalid request");
    res.json(await wallet.verifyChallenge(b.address, b.signature));
  });

  app.post("/api/wallet/withdraw/prepare", async (req, res) => {
    if (!secureEnough(req, res)) return;
    if (prepares.add(req.ip ?? "?") > 20) return res.status(429).json({ error: "too many requests" });
    const amount = Number((req.body as { amountSol?: unknown } | undefined)?.amountSol);
    try {
      res.json(await wallet.prepareWithdraw(amount));
    } catch (err) {
      res.status(422).json({ error: (err as Error).message });
    }
  });

  app.post("/api/wallet/withdraw/execute", async (req, res) => {
    if (!secureEnough(req, res)) return;
    if (executes.add(req.ip ?? "?") > 5) return res.status(429).json({ error: "too many withdrawal attempts, try again later" });
    const b = (req.body ?? {}) as { id?: unknown; signature?: unknown; passphrase?: unknown };
    if (typeof b.id !== "string" || !/^[a-f0-9]{24}$/.test(b.id) || typeof b.signature !== "string" || b.signature.length > 200 || typeof b.passphrase !== "string" || b.passphrase.length < 1 || b.passphrase.length > 256) {
      return bad(res, "invalid request");
    }
    console.log(`[server] withdrawal execute attempt from ${req.ip}`); // never log the passphrase or signature
    const out = await wallet.executeWithdraw(b.id, b.signature, b.passphrase);
    res.status(out.ok ? 200 : 422).json(out);
  });
}

/** Alerts when the burner balance drops without a withdrawal you made through the dashboard. */
export function startWalletWatch(wallet: WalletService, notifier: Notifier, dropPct: number, everyMs = 60_000): NodeJS.Timeout {
  let last: number | null = null;
  let lastWithdrawAt = 0;
  const timer = setInterval(async () => {
    if (!wallet.burner) return;
    try {
      const v = await wallet.view(true);
      if (v.balanceSol === null) return;
      const w = v.withdrawals[0];
      if (w) lastWithdrawAt = Math.max(lastWithdrawAt, w.t);
      if (last !== null && last > 0.01 && v.balanceSol < last * (1 - dropPct / 100) && Date.now() - lastWithdrawAt > 5 * 60_000) {
        void notifier.send("critical", "wallet-drop", `Burner wallet balance fell from ${last.toFixed(4)} to ${v.balanceSol.toFixed(4)} SOL and no withdrawal was made through Alpha.fun. Check ${v.explorerUrl}`);
      }
      last = v.balanceSol;
    } catch {
      /* the next poll will try again */
    }
  }, everyMs);
  timer.unref();
  return timer;
}
