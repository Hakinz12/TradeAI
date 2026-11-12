import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from "@solana/kit";
import type { KeyPairSigner } from "@solana/kit";

/**
 * Encrypted burner-wallet file. The 32-byte ed25519 seed is encrypted with AES-256-GCM using a key derived from
 * your passphrase with scrypt. The public address is stored in the clear (so the dashboard can show it without
 * the passphrase) and bound to the ciphertext as authenticated data, so the file cannot be silently swapped.
 */
export interface KeystoreFile {
  v: 1;
  address: string;
  kdf: { name: "scrypt"; n: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string; ct: string };
}

const SCRYPT = { n: 2 ** 15, r: 8, p: 1 };
export const MIN_PASSPHRASE = 12;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function deriveKey(passphrase: string, salt: Buffer, n = SCRYPT.n, r = SCRYPT.r, p = SCRYPT.p): Buffer {
  return crypto.scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: n, r, p, maxmem: 256 * n * r });
}

export function keystoreExists(file: string): boolean {
  return fs.existsSync(file);
}

export async function createKeystore(file: string, passphrase: string): Promise<{ address: string }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  if (fs.existsSync(file)) throw new Error("a keystore already exists at this path; refusing to overwrite it");
  const seed = crypto.randomBytes(32);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  cipher.setAAD(Buffer.from(signer.address));
  const ct = Buffer.concat([cipher.update(seed), cipher.final()]);
  const data: KeystoreFile = {
    v: 1,
    address: signer.address,
    kdf: { name: "scrypt", ...SCRYPT, salt: b64(salt) },
    cipher: { name: "aes-256-gcm", iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  seed.fill(0);
  return { address: signer.address };
}

export function readKeystore(file: string): KeystoreFile | null {
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8")) as KeystoreFile;
    if (k.v !== 1 || typeof k.address !== "string" || k.kdf?.name !== "scrypt" || k.cipher?.name !== "aes-256-gcm") return null;
    return k;
  } catch {
    return null;
  }
}

/** Public address without any passphrase. */
export function keystoreAddress(file: string): string | null {
  return readKeystore(file)?.address ?? null;
}

async function decryptSeed(file: string, passphrase: string): Promise<{ seed: Buffer; ks: KeystoreFile }> {
  const ks = readKeystore(file);
  if (!ks) throw new Error("keystore missing or unreadable");
  // refuse downgraded parameters from a tampered file
  if (ks.kdf.n < 2 ** 14 || ks.kdf.n > 2 ** 20 || ks.kdf.r < 8 || ks.kdf.r > 16 || ks.kdf.p < 1 || ks.kdf.p > 4) throw new Error("keystore parameters rejected");
  const key = deriveKey(passphrase, unb64(ks.kdf.salt), ks.kdf.n, ks.kdf.r, ks.kdf.p);
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, unb64(ks.cipher.iv));
    d.setAAD(Buffer.from(ks.address));
    d.setAuthTag(unb64(ks.cipher.tag));
    const seed = Buffer.concat([d.update(unb64(ks.cipher.ct)), d.final()]);
    if (seed.length !== 32) throw new Error("bad length");
    return { seed, ks };
  } catch {
    throw new Error("wrong passphrase or damaged keystore");
  }
}

/** Decrypt and return a signer. The seed buffer is wiped before returning. Verifies the address matches the file. */
export async function unlockSigner(file: string, passphrase: string): Promise<KeyPairSigner> {
  const { seed, ks } = await decryptSeed(file, passphrase);
  try {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
    if (signer.address !== ks.address) throw new Error("keystore address mismatch");
    return signer;
  } finally {
    seed.fill(0);
  }
}

/** Standard 64-byte secret key (seed + public key) in base58, importable into Phantom/Solflare. Only for the export command. */
export async function exportSecretKey(file: string, passphrase: string): Promise<string> {
  const { seed, ks } = await decryptSeed(file, passphrase);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", (await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed), true)).keyPair.publicKey));
  const out = getBase58Decoder().decode(Buffer.concat([seed, pub]));
  seed.fill(0);
  if (!ks.address) throw new Error("bad keystore");
  return out;
}
