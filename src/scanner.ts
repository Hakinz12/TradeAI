import type { StrategyConfig } from "./config";
import type { CheckStatus, SafetyCheck, ScanResult, TokenSnapshot } from "./types";

/**
 * Scanner + rug filter. Deterministic hard rejects only: no model, no opinions.
 * Anything that fails here never reaches the predictor.
 *
 * Fail closed: when the data needed to judge a risk is unknown (authorities, holder concentration), the
 * token is rejected rather than assumed safe. Checks whose data free sources simply do not provide
 * (holder count, sell route) are reported as "unknown" without rejecting.
 */
export function scan(token: TokenSnapshot, cfg: StrategyConfig): ScanResult {
  const checks: SafetyCheck[] = [];
  const reasons: string[] = [];

  const add = (id: string, label: string, status: CheckStatus, detail: string, failClosed = true) => {
    checks.push({ id, label, status, detail });
    if (status === "fail" || (status === "unknown" && failClosed)) reasons.push(detail);
  };

  const authority = (id: string, label: string, revoked: boolean | null, word: string) => {
    if (revoked === null) add(id, label, "unknown", `${word} authority unknown`);
    else if (!revoked) add(id, label, "fail", `${word} authority not revoked`);
    else add(id, label, "pass", `${word} authority revoked`);
  };
  authority("mint_authority", "Mint authority revoked", token.mintAuthorityRevoked, "mint");
  authority("freeze_authority", "Freeze authority revoked", token.freezeAuthorityRevoked, "freeze");

  if (token.liquidityUsd < cfg.minLiquidityUsd) {
    add("liquidity", "Liquidity floor", "fail", `liquidity $${Math.round(token.liquidityUsd)} below $${cfg.minLiquidityUsd} floor`);
  } else {
    add("liquidity", "Liquidity floor", "pass", `liquidity $${Math.round(token.liquidityUsd)}`);
  }

  if (token.top10HolderPct === null) {
    add("concentration", "Top-10 holder share", "unknown", "holder concentration unknown");
  } else if (token.top10HolderPct > cfg.maxTop10HolderPct) {
    add("concentration", "Top-10 holder share", "fail", `top-10 holders own ${token.top10HolderPct.toFixed(0)}%`);
  } else {
    add("concentration", "Top-10 holder share", "pass", `top-10 holders own ${token.top10HolderPct.toFixed(0)}%`);
  }

  if (token.holders === null) {
    add("holders", "Holder count", "unknown", "holder count unavailable", false);
  } else if (token.holders < cfg.minHolders) {
    add("holders", "Holder count", "fail", `only ${token.holders} holders`);
  } else {
    add("holders", "Holder count", "pass", `${token.holders} holders`);
  }

  if (token.ageMinutes < 3) add("age", "Token age", "fail", "too new (under 3 min)");
  else if (token.ageMinutes > 120) add("age", "Token age", "fail", "too old for this strategy");
  else add("age", "Token age", "pass", `${Math.round(token.ageMinutes)} min old`);

  if (token.token2022Risky === true) {
    add("token2022", "No risky Token-2022 extension", "fail", "Token-2022 extension risk (transfer fee, hook or delegate)");
  } else if (token.token2022Risky === false) {
    add("token2022", "No risky Token-2022 extension", "pass", "no risky extension");
  } else {
    add("token2022", "No risky Token-2022 extension", "unknown", "extensions not checked", false);
  }

  if (token.sellRouteOk === false) {
    add("sell_route", "Sell route exists", "fail", "no sell route (possible honeypot)");
  } else if (token.sellRouteOk === true) {
    add("sell_route", "Sell route exists", "pass", "sell route found");
  } else {
    add("sell_route", "Sell route exists", "unknown", "sell route not checked", false);
  }

  if (token.intelligence?.status === "ready" && token.intelligence.suspiciousVolumeScore !== null && token.intelligence.suspiciousVolumeScore >= 85 && token.intelligence.confidence !== "low") {
    add("volume_integrity", "Volume integrity", "fail", `suspicious transaction activity score ${token.intelligence.suspiciousVolumeScore}/100`);
  } else if (token.intelligence?.status === "ready") {
    add("volume_integrity", "Volume integrity", "pass", `suspicious transaction activity score ${token.intelligence.suspiciousVolumeScore ?? "unknown"}/100`);
  } else {
    add("volume_integrity", "Volume integrity", "unknown", "transaction sample insufficient; no volume-integrity verdict", false);
  }

  if (token.sellImpactPct === null || token.sellImpactPct === undefined) {
    add("sell_impact", "Sell price impact", "unknown", "sell impact not checked", false);
  } else if (token.sellImpactPct > cfg.maxSellImpactPct) {
    add("sell_impact", "Sell price impact", "fail", `sell impact ${token.sellImpactPct.toFixed(1)}% above ${cfg.maxSellImpactPct}%`);
  } else {
    add("sell_impact", "Sell price impact", "pass", `sell impact ${token.sellImpactPct.toFixed(1)}%`);
  }

  return { pass: reasons.length === 0, reasons, checks };
}
