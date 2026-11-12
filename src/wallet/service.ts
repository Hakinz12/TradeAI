import crypto from "node:crypto";
import {
  address, appendTransactionMessageInstruction, createTransactionMessage, getBase64EncodedWireTransaction, getPublicKeyFromAddress, isAddress,
  lamports, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners, verifySignature,
} from "@solana/kit";
import type { SignatureBytes } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import type { Challenge, WalletView, WithdrawIntent, WithdrawResult } from "../api-types";
import type { Db } from "../db";
import type { RpcClient } from "../rpc";
import { keystoreAddress, unlockSigner } from "./keystore";

const LAMPORTS = 1_000_000_000;
const FEE_LAMPORTS = 5_000;
/** No application reserve: only the transaction fee must remain payable by the burner. */
const RESERVE_LAMPORTS = 0;
const INTENT_TTL_MS = 2 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export interface WalletConfig {
  keystorePath: string;
  ownerWallet: string;
  paperMode: boolean;
}

interface Intent extends WithdrawIntent {
  lamports: bigint;
  used: boolean;
}

const explorer = (kind: "address" | "tx", v: string) => `https://solscan.io/${kind === "address" ? "account" : "tx"}/${v}`;

/**
 * Burner wallet operations. Funds can only ever leave to OWNER_WALLET, and a withdrawal needs an owner-wallet
 * signature over the exact amount and destination plus the keystore passphrase. Each intent is single-use and
 * expires after two minutes. There are no app-level daily or per-withdrawal caps or minimum; only the network
 * transaction fee must remain payable.
 */
export class WalletService {
  private intents = new Map<string, Intent>();
  private challenges = new Map<string, { message: string; expiresAt: number }>();
  private fails: number[] = [];
  private cache: { at: number; view: WalletView } | null = null;
  readonly burner: string | null;

  constructor(private cfg: WalletConfig, private rpc: RpcClientLike | null, private db: Db, private now: () => number = Date.now) {
    this.burner = keystoreAddress(cfg.keystorePath);
    if (cfg.ownerWallet && !isAddress(cfg.ownerWallet)) throw new Error("OWNER_WALLET is not a valid Solana address");
    if (cfg.ownerWallet && this.burner && cfg.ownerWallet === this.burner) throw new Error("OWNER_WALLET must be a different wallet from the burner");
  }

  // ---- status -----------------------------------------------------------------------------

  private log(): { t: number; amountSol: number; signature: string; status: string }[] {
    try {
      return JSON.parse(this.db.getMeta("withdraw_log") ?? "[]");
    } catch {
      return [];
    }
  }

  private blockedReason(): string | null {
    if (!this.burner) return "No burner wallet yet. Create one with `npm run wallet -- create`.";
    if (!this.cfg.ownerWallet) return "Set OWNER_WALLET in .env to the wallet you control. Withdrawals only ever go there.";
    if (!this.rpc) return "Set HELIUS_API_KEY (or HELIUS_RPC_URL) so the server can reach Solana.";
    return null;
  }

  async view(force = false): Promise<WalletView> {
    if (!force && this.cache && this.now() - this.cache.at < 10_000) return this.cache.view;
    const view: WalletView = {
      configured: Boolean(this.burner), address: this.burner, rpcConfigured: Boolean(this.rpc), paperMode: this.cfg.paperMode,
      balanceSol: null, tokens: [], recent: [], error: null, explorerUrl: this.burner ? explorer("address", this.burner) : null, updatedAt: null,
      ownerWallet: this.cfg.ownerWallet || null, withdrawEnabled: this.blockedReason() === null, withdrawBlockedReason: this.blockedReason(),
      withdrawals: this.log().slice(-10).reverse(),
    };
    if (this.burner && this.rpc) {
      try {
        const bal = await this.rpc.call<{ value: number }>("getBalance", [this.burner, { commitment: "confirmed" }]);
        view.balanceSol = bal.value / LAMPORTS;
        view.updatedAt = this.now();
        const [sigs, toks] = await Promise.allSettled([
          this.rpc.call<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]>("getSignaturesForAddress", [this.burner, { limit: 8 }]),
          this.rpc.call<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number; decimals: number } } } } } }[] }>(
            "getTokenAccountsByOwner", [this.burner, { programId: TOKEN_PROGRAM }, { encoding: "jsonParsed" }]),
        ]);
        if (sigs.status === "fulfilled") view.recent = sigs.value.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, failed: s.err !== null }));
        if (toks.status === "fulfilled") {
          view.tokens = toks.value.value
            .map((a) => a.account.data.parsed.info)
            .filter((i) => i.tokenAmount.uiAmount > 0)
            .map((i) => ({ mint: i.mint, amount: i.tokenAmount.uiAmount, decimals: i.tokenAmount.decimals }))
            .slice(0, 20);
        }
      } catch (err) {
        view.error = `Could not read the wallet from Solana: ${(err as Error).message}`;
      }
    }
    this.cache = { at: this.now(), view };
    return view;
  }

  // ---- ownership proof (connect wallet) ---------------------------------------------------

  challenge(addr: string): Challenge {
    if (!isAddress(addr)) throw new Error("invalid wallet address");
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    const message = `Alpha.fun ownership proof\nwallet: ${addr}\nnonce: ${crypto.randomBytes(16).toString("hex")}\nexpires: ${new Date(expiresAt).toISOString()}`;
    this.challenges.set(addr, { message, expiresAt });
    if (this.challenges.size > 20) this.challenges.delete(this.challenges.keys().next().value as string);
    return { message, expiresAt };
  }

  async verifyChallenge(addr: string, signatureB64: string): Promise<{ verified: boolean; isOwner: boolean }> {
    const ch = this.challenges.get(addr);
    this.challenges.delete(addr); // single use
    if (!ch || ch.expiresAt < this.now()) return { verified: false, isOwner: false };
    const ok = await this.checkSignature(addr, ch.message, signatureB64);
    return { verified: ok, isOwner: ok && addr === this.cfg.ownerWallet };
  }

  private async checkSignature(addr: string, message: string, signatureB64: string): Promise<boolean> {
    try {
      const sig = Buffer.from(signatureB64, "base64");
      if (sig.length !== 64) return false;
      const key = await getPublicKeyFromAddress(address(addr));
      return await verifySignature(key, new Uint8Array(sig) as SignatureBytes, new TextEncoder().encode(message));
    } catch {
      return false;
    }
  }

  // ---- withdrawals ------------------------------------------------------------------------

  private lockedOut(): boolean {
    const cutoff = this.now() - FAIL_WINDOW_MS;
    this.fails = this.fails.filter((t) => t > cutoff);
    return this.fails.length >= MAX_FAILS;
  }

  async prepareWithdraw(amountSol: number): Promise<WithdrawIntent> {
    const reason = this.blockedReason();
    if (reason) throw new Error(reason);
    if (this.lockedOut()) throw new Error("Withdrawals are locked for a while after repeated failed attempts.");
    if (!Number.isFinite(amountSol) || amountSol <= 0) throw new Error("Withdrawal amount must be greater than zero.");
    const amount = BigInt(Math.round(amountSol * LAMPORTS));
    if (amount < 1n) throw new Error("Withdrawal amount is below one lamport.");
    await this.assertBalance(amount);

    const id = crypto.randomBytes(12).toString("hex");
    const expiresAt = this.now() + INTENT_TTL_MS;
    const to = this.cfg.ownerWallet;
    const message = `Alpha.fun withdrawal\namount: ${amountSol.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} SOL\nto: ${to}\nfrom: ${this.burner}\nid: ${id}\nexpires: ${new Date(expiresAt).toISOString()}`;
    this.intents.set(id, { id, message, amountSol, to, expiresAt, lamports: amount, used: false });
    for (const [k, v] of this.intents) if (v.expiresAt < this.now() || this.intents.size > 20) this.intents.delete(k);
    return { id, message, amountSol, to, expiresAt };
  }

  private async assertBalance(amount: bigint): Promise<void> {
    const bal = await (this.rpc as RpcClientLike).call<{ value: number }>("getBalance", [this.burner, { commitment: "confirmed" }]);
    if (BigInt(bal.value) - amount - BigInt(FEE_LAMPORTS) < BigInt(RESERVE_LAMPORTS)) {
      const max = Math.max((bal.value - FEE_LAMPORTS - RESERVE_LAMPORTS) / LAMPORTS, 0);
      throw new Error(`Not enough balance. At most ${max.toFixed(9)} SOL can be withdrawn after the transaction fee.`);
    }
  }

  async executeWithdraw(id: string, signatureB64: string, passphrase: string): Promise<WithdrawResult> {
    const reason = this.blockedReason();
    if (reason) return { ok: false, error: reason };
    if (this.lockedOut()) return { ok: false, error: "Withdrawals are locked for a while after repeated failed attempts." };
    const intent = this.intents.get(id);
    if (!intent || intent.used) return { ok: false, error: "Unknown or already used withdrawal request. Start again." };
    intent.used = true; // single use, even if the rest fails
    if (intent.expiresAt < this.now()) return { ok: false, error: "The withdrawal request expired. Start again." };

    if (!(await this.checkSignature(intent.to, intent.message, signatureB64))) {
      this.fails.push(this.now());
      return { ok: false, error: "The signature does not match the owner wallet for this exact withdrawal." };
    }

    let signer;
    try {
      signer = await unlockSigner(this.cfg.keystorePath, passphrase);
    } catch (err) {
      this.fails.push(this.now());
      return { ok: false, error: (err as Error).message };
    }
    if (signer.address !== this.burner) return { ok: false, error: "keystore address mismatch" };

    const rpc = this.rpc as RpcClientLike;
    try {
      await this.assertBalance(intent.lamports);
      const bh = await rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const msg = pipe(
        createTransactionMessage({ version: "legacy" }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.value.blockhash as never, lastValidBlockHeight: BigInt(bh.value.lastValidBlockHeight) }, m),
        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: signer, destination: address(intent.to), amount: lamports(intent.lamports) }), m),
      );
      const signed = await signTransactionMessageWithSigners(msg);
      const wire = getBase64EncodedWireTransaction(signed);

      const sim = await rpc.call<{ value: { err: unknown; logs?: string[] | null } }>("simulateTransaction", [wire, { encoding: "base64", sigVerify: true, commitment: "confirmed" }]);
      if (sim.value.err) return { ok: false, error: `Simulation failed, nothing was sent: ${JSON.stringify(sim.value.err)}` };

      const signature = await rpc.call<string>("sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);
      let status: "confirmed" | "sent" = "sent";
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 0 : 1500));
        try {
          const st = await rpc.call<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature]]);
          const s = st.value[0];
          if (s?.err) return { ok: false, signature, error: `The transaction failed on chain: ${JSON.stringify(s.err)}` };
          if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
            status = "confirmed";
            break;
          }
        } catch {
          /* keep polling */
        }
      }
      this.db.setMeta("withdraw_log", JSON.stringify([...this.log(), { t: this.now(), amountSol: intent.amountSol, signature, status }].slice(-50)));
      this.cache = null;
      console.log(`[wallet] withdrawal of ${intent.amountSol} SOL sent: ${signature}`);
      return { ok: true, signature, status, explorerUrl: explorer("tx", signature) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

export type RpcClientLike = Pick<RpcClient, "call">;
