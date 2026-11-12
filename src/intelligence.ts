/**
 * Lightweight transaction intelligence for the hackathon MVP.
 * The input is normalized from Helius Enhanced Transactions; scores are heuristics,
 * not proof of bot activity or common ownership.
 */
export interface EnhancedSwapTransaction {
  signature?: string;
  timestamp?: number;
  feePayer?: string;
  type?: string;
  tokenTransfers?: { mint?: string; fromUserAccount?: string; toUserAccount?: string; tokenAmount?: number }[];
  nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[];
}

export interface WalletCluster {
  wallets: string[];
  reason: "synchronized_activity" | "shared_funder";
  confidence: number;
}

export interface TokenIntelligence {
  status: "ready" | "insufficient_data" | "unavailable";
  transactions: number;
  uniqueWallets: number;
  organicVolumeScore: number | null;
  suspiciousVolumeScore: number | null;
  confidence: "low" | "medium" | "high";
  topWalletVolumePct: number | null;
  repeatedSizePct: number | null;
  synchronizedWalletPct: number | null;
  roundTripWalletPct: number | null;
  sharedFunderWallets: number;
  clusters: WalletCluster[];
  flags: string[];
  updatedAt: number;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const shortWallet = (s: string) => s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s;

export function analyzeTransactions(rows: EnhancedSwapTransaction[], mint: string, updatedAt = Date.now()): TokenIntelligence {
  const txs = rows.filter((tx) => Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.some((t) => t.mint === mint && Number(t.tokenAmount) > 0))
    .map((tx) => {
      const tokenTransfers = tx.tokenTransfers!.filter((t) => t.mint === mint);
      const transfer = tokenTransfers.reduce((sum, t) => sum + Math.max(Number(t.tokenAmount) || 0, 0), 0);
      const wallet = tx.feePayer ?? "";
      const side = tokenTransfers.some((t) => t.toUserAccount === wallet) ? "buy" : tokenTransfers.some((t) => t.fromUserAccount === wallet) ? "sell" : "unknown";
      return { tx, wallet, amount: transfer, time: Number(tx.timestamp) || 0, side };
    }).filter((x) => x.wallet && x.amount > 0);
  const wallets = [...new Set(txs.map((x) => x.wallet))];
  if (txs.length < 8 || wallets.length < 4) return {
    status: "insufficient_data", transactions: txs.length, uniqueWallets: wallets.length,
    organicVolumeScore: null, suspiciousVolumeScore: null, confidence: "low", topWalletVolumePct: null,
    repeatedSizePct: null, synchronizedWalletPct: null, roundTripWalletPct: null, sharedFunderWallets: 0, clusters: [],
    flags: ["Collecting more pool transactions"], updatedAt,
  };

  const byWallet = new Map<string, number>();
  for (const x of txs) byWallet.set(x.wallet, (byWallet.get(x.wallet) ?? 0) + x.amount);
  const total = [...byWallet.values()].reduce((a, b) => a + b, 0);
  const topWalletVolumePct = total > 0 ? Math.max(...byWallet.values()) / total * 100 : 0;
  const rounded = txs.map((x) => Number(x.amount.toPrecision(2)));
  const sizeCounts = new Map<number, number>();
  for (const x of rounded) sizeCounts.set(x, (sizeCounts.get(x) ?? 0) + 1);
  const repeatedSizePct = Math.max(...sizeCounts.values()) / txs.length * 100;

  const bySecond = new Map<number, Set<string>>();
  for (const x of txs) {
    if (!x.time) continue;
    const bucket = Math.floor(x.time / 3);
    const set = bySecond.get(bucket) ?? new Set<string>();
    set.add(x.wallet); bySecond.set(bucket, set);
  }
  const coordinated = new Set<string>();
  const clusters: WalletCluster[] = [];
  for (const group of bySecond.values()) {
    if (group.size >= 3) {
      const members = [...group];
      members.forEach((w) => coordinated.add(w));
      clusters.push({ wallets: members.map(shortWallet), reason: "synchronized_activity", confidence: Math.min(0.95, 0.55 + group.size * 0.05) });
    }
  }
  const synchronizedWalletPct = coordinated.size / Math.max(wallets.length, 1) * 100;
  const roundTripWallets = new Set<string>();
  const walletTrades = new Map<string, typeof txs>();
  for (const x of txs) {
    const list = walletTrades.get(x.wallet) ?? [];
    list.push(x); walletTrades.set(x.wallet, list);
  }
  for (const [wallet, list] of walletTrades) {
    const sorted = list.filter((x) => x.time && x.side !== "unknown").sort((a, b) => a.time - b.time);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].side !== sorted[i - 1].side && sorted[i].time - sorted[i - 1].time <= 120) {
        roundTripWallets.add(wallet); break;
      }
    }
  }
  const roundTripWalletPct = roundTripWallets.size / Math.max(wallets.length, 1) * 100;
  const flags: string[] = [];
  if (topWalletVolumePct > 35) flags.push("One wallet contributes a large share of observed swap volume");
  if (repeatedSizePct > 35) flags.push("Repeatedly similar swap sizes detected");
  if (synchronizedWalletPct > 35) flags.push("Several wallets traded within the same short time windows");
  if (roundTripWalletPct > 25) flags.push("Rapid buy/sell round trips detected across wallets");

  // Weighted heuristic. It is a risk indicator, not a claim that wallets are bots.
  const suspiciousVolumeScore = clamp(topWalletVolumePct * 0.3 + repeatedSizePct * 0.2 + synchronizedWalletPct * 0.3 + roundTripWalletPct * 0.2);
  const organicVolumeScore = 100 - suspiciousVolumeScore;
  const confidence = txs.length >= 60 && wallets.length >= 20 ? "high" : txs.length >= 20 && wallets.length >= 8 ? "medium" : "low";
  return {
    status: "ready", transactions: txs.length, uniqueWallets: wallets.length,
    organicVolumeScore, suspiciousVolumeScore, confidence, topWalletVolumePct,
    repeatedSizePct, synchronizedWalletPct, roundTripWalletPct, sharedFunderWallets: 0, clusters: clusters.slice(0, 8),
    flags: flags.length ? flags : ["No strong coordination pattern detected in the sampled transactions"], updatedAt,
  };
}

/** Detects wallets funded by the same source from their recent enhanced transaction histories. */
export function findSharedFunders(histories: Map<string, EnhancedSwapTransaction[]>): WalletCluster[] {
  const funders = new Map<string, Set<string>>();
  for (const [wallet, txs] of histories) {
    for (const tx of txs) {
      for (const transfer of tx.nativeTransfers ?? []) {
        if (transfer.toUserAccount === wallet && transfer.fromUserAccount && transfer.fromUserAccount !== wallet) {
          const set = funders.get(transfer.fromUserAccount) ?? new Set<string>();
          set.add(wallet); funders.set(transfer.fromUserAccount, set);
        }
      }
    }
  }
  return [...funders.entries()].filter(([, wallets]) => wallets.size >= 2).map(([, wallets]) => ({
    wallets: [...wallets].map(shortWallet), reason: "shared_funder" as const, confidence: Math.min(0.9, 0.55 + wallets.size * 0.08),
  }));
}
