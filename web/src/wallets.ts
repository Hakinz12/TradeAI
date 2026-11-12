/** Browser wallet providers (Phantom, Solflare, Backpack) through their injected objects. Nothing leaves the browser except what you sign. */
interface Injected {
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  signMessage(msg: Uint8Array, display?: string): Promise<Uint8Array | { signature: Uint8Array }>;
  signTransaction?<T>(transaction: T): Promise<T>;
  signAllTransactions?<T>(transactions: T[]): Promise<T[]>;
  signAndSendTransaction?<T>(transaction: T, options?: unknown): Promise<{ signature: string }>;
}

export interface WalletOption {
  id: "phantom" | "solflare" | "backpack";
  name: string;
  provider: Injected;
}

export function detectWallets(): WalletOption[] {
  const w = window as unknown as { phantom?: { solana?: Injected & { isPhantom?: boolean } }; solflare?: Injected & { isSolflare?: boolean }; backpack?: Injected };
  const out: WalletOption[] = [];
  if (w.phantom?.solana?.isPhantom) out.push({ id: "phantom", name: "Phantom", provider: w.phantom.solana });
  if (w.solflare?.isSolflare) out.push({ id: "solflare", name: "Solflare", provider: w.solflare });
  if (w.backpack) out.push({ id: "backpack", name: "Backpack", provider: w.backpack });
  return out;
}

export async function connectWallet(opt: WalletOption): Promise<string> {
  const res = await opt.provider.connect();
  const pk = (res && "publicKey" in res ? res.publicKey : undefined) ?? opt.provider.publicKey;
  if (!pk) throw new Error("The wallet did not return an address.");
  return pk.toString();
}

export async function signText(opt: WalletOption, text: string): Promise<string> {
  const out = await opt.provider.signMessage(new TextEncoder().encode(text), "utf8");
  const sig = out instanceof Uint8Array ? out : out.signature;
  let bin = "";
  sig.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
