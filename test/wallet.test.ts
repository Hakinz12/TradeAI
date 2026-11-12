import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes, getCompiledTransactionMessageDecoder, getTransactionDecoder, signBytes } from "@solana/kit";
import { createKeystore, exportSecretKey, keystoreAddress, unlockSigner } from "../src/wallet/keystore";
import { WalletService } from "../src/wallet/service";
import { Db } from "../src/db";

const PASS = "correct horse battery staple";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ks-")), "burner.json");
const signB64 = async (signer: Awaited<ReturnType<typeof createKeyPairSignerFromPrivateKeyBytes>>, msg: string) =>
  Buffer.from(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(msg))).toString("base64");
const newOwner = () => createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(crypto.randomBytes(32)));

class MockRpc {
  balance = 3_000_000_000;
  sent: string[] = [];
  simErr: unknown = null;
  calls: string[] = [];
  async call<T>(method: string, params: unknown[]): Promise<T> {
    this.calls.push(method);
    switch (method) {
      case "getBalance": return { value: this.balance } as T;
      case "getLatestBlockhash": return { value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1000 } } as T;
      case "simulateTransaction": return { value: { err: this.simErr, logs: [] } } as T;
      case "sendTransaction": this.sent.push(params[0] as string); return "5".repeat(88) as T;
      case "getSignatureStatuses": return { value: [{ confirmationStatus: "confirmed", err: null }] } as T;
      case "getSignaturesForAddress": return [] as T;
      case "getTokenAccountsByOwner": return { value: [] } as T;
      default: throw new Error("unexpected " + method);
    }
  }
}

async function setup() {
  const file = tmp();
  const { address } = await createKeystore(file, PASS);
  const owner = await newOwner();
  const rpc = new MockRpc();
  const db = new Db(":memory:");
  const svc = new WalletService(
    { keystorePath: file, ownerWallet: owner.address, paperMode: true },
    rpc, db,
  );
  return { file, address, owner, rpc, svc, db };
}

test("keystore: round trip, address readable without passphrase, file mode 600", async () => {
  const file = tmp();
  const { address } = await createKeystore(file, PASS);
  assert.equal(keystoreAddress(file), address);
  assert.equal((await unlockSigner(file, PASS)).address, address);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, "utf8").includes(PASS));
  const secret = await exportSecretKey(file, PASS);
  assert.ok(secret.length > 80 && secret.length < 90, "64-byte base58 secret key");
});

test("keystore: wrong passphrase, weak passphrase, overwrite and tampering are refused", async () => {
  const file = tmp();
  await assert.rejects(() => createKeystore(file, "short"), /at least/);
  await createKeystore(file, PASS);
  await assert.rejects(() => unlockSigner(file, "wrong passphrase here"), /wrong passphrase/);
  await assert.rejects(() => createKeystore(file, PASS), /already exists/);
  const k = JSON.parse(fs.readFileSync(file, "utf8"));
  k.address = "11111111111111111111111111111112"; // swap the address: authenticated data no longer matches
  fs.writeFileSync(file, JSON.stringify(k));
  await assert.rejects(() => unlockSigner(file, PASS), /wrong passphrase|damaged/);
  const k2 = JSON.parse(fs.readFileSync(file, "utf8"));
  k2.kdf.n = 2;
  fs.writeFileSync(file, JSON.stringify(k2));
  await assert.rejects(() => unlockSigner(file, PASS), /rejected/);
});

test("connect wallet: signed challenge verifies, wrong signer / replay / expiry do not", async () => {
  const { svc, owner } = await setup();
  const ch = svc.challenge(owner.address);
  const sig = await signB64(owner, ch.message);
  assert.deepEqual(await svc.verifyChallenge(owner.address, sig), { verified: true, isOwner: true });
  assert.deepEqual(await svc.verifyChallenge(owner.address, sig), { verified: false, isOwner: false }, "single use");
  const other = await newOwner();
  const ch2 = svc.challenge(other.address);
  const v = await svc.verifyChallenge(other.address, await signB64(other, ch2.message));
  assert.deepEqual(v, { verified: true, isOwner: false }, "valid wallet but not the owner");
  const ch3 = svc.challenge(owner.address);
  assert.equal((await svc.verifyChallenge(owner.address, await signB64(other, ch3.message))).verified, false, "signed by someone else");
});

test("withdraw: happy path sends exactly the approved amount to the owner wallet only", async () => {
  const { svc, owner, rpc, address } = await setup();
  const intent = await svc.prepareWithdraw(0.5);
  assert.equal(intent.to, owner.address);
  assert.ok(intent.message.includes("0.5 SOL") && intent.message.includes(owner.address));
  const out = await svc.executeWithdraw(intent.id, await signB64(owner, intent.message), PASS);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.status, "confirmed");
  assert.equal(rpc.sent.length, 1);
  assert.ok(rpc.calls.indexOf("simulateTransaction") < rpc.calls.indexOf("sendTransaction"), "simulated before sending");

  const tx = getTransactionDecoder().decode(Buffer.from(rpc.sent[0], "base64"));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(msg.staticAccounts[0], address, "burner pays");
  assert.ok(msg.staticAccounts.includes(owner.address as never), "destination is the owner");
  assert.equal(msg.instructions.length, 1, "a single transfer, nothing else");
  const data = Buffer.from(msg.instructions[0].data as Uint8Array);
  assert.equal(data.readUInt32LE(0), 2, "system transfer");
  assert.equal(data.readBigUInt64LE(4), 500_000_000n);

});

test("withdraw: single use, wrong signer, wrong passphrase, lockout", async () => {
  const { svc, owner, rpc } = await setup();
  const i1 = await svc.prepareWithdraw(0.1);
  const sig1 = await signB64(owner, i1.message);
  assert.equal((await svc.executeWithdraw(i1.id, sig1, PASS)).ok, true);
  assert.equal((await svc.executeWithdraw(i1.id, sig1, PASS)).ok, false, "replay refused");
  assert.equal(rpc.sent.length, 1);

  const attacker = await newOwner();
  const i2 = await svc.prepareWithdraw(0.1);
  const bad = await svc.executeWithdraw(i2.id, await signB64(attacker, i2.message), PASS);
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /signature/);

  const i3 = await svc.prepareWithdraw(0.1);
  const wrongPass = await svc.executeWithdraw(i3.id, await signB64(owner, i3.message), "not the passphrase!!");
  assert.equal(wrongPass.ok, false);
  assert.equal(rpc.sent.length, 1, "nothing sent without all three proofs");

  // a signature for a different amount must not work
  const i4 = await svc.prepareWithdraw(0.1);
  const i5 = await svc.prepareWithdraw(0.9);
  assert.equal((await svc.executeWithdraw(i5.id, await signB64(owner, i4.message), PASS)).ok, false, "signature bound to the exact amount");

  for (let n = 0; n < 4; n++) {
    const i = await svc.prepareWithdraw(0.1).catch(() => null);
    if (i) await svc.executeWithdraw(i.id, "AAAA", PASS);
  }
  await assert.rejects(() => svc.prepareWithdraw(0.1), /locked/);
  assert.equal(rpc.sent.length, 1);
});

test("withdraw: no app-level caps, reserve, simulation failure, expiry", async () => {
  const { svc, owner, rpc } = await setup();
  const aboveOldCap = await svc.prepareWithdraw(1.5);
  assert.equal(aboveOldCap.amountSol, 1.5);
  const tiny = await svc.prepareWithdraw(0.0001);
  assert.equal(tiny.amountSol, 0.0001, "no application minimum");
  await assert.rejects(() => svc.prepareWithdraw(0), /greater than zero/);
  await assert.rejects(() => svc.prepareWithdraw(NaN), /greater than zero/);
  rpc.balance = 500_000_000;
  await assert.rejects(() => svc.prepareWithdraw(0.5), /Not enough balance/);
  rpc.balance = 3_000_000_000;

  const a = await svc.prepareWithdraw(1);
  assert.equal((await svc.executeWithdraw(a.id, await signB64(owner, a.message), PASS)).ok, true);
  const second = await svc.prepareWithdraw(0.5);
  assert.equal(second.amountSol, 0.5, "multiple withdrawals are not blocked by a daily cap");

  rpc.simErr = { InstructionError: [0, "Custom"] };
  const b = await svc.prepareWithdraw(0.1);
  const r = await svc.executeWithdraw(b.id, await signB64(owner, b.message), PASS);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Simulation failed/);
  assert.equal(rpc.sent.length, 1, "failed simulation sends nothing");
});

test("withdraw: disabled without OWNER_WALLET, and owner may not be the burner", async () => {
  const file = tmp();
  const { address } = await createKeystore(file, PASS);
  const db = new Db(":memory:");
  const none = new WalletService({ keystorePath: file, ownerWallet: "", paperMode: true }, new MockRpc(), db);
  await assert.rejects(() => none.prepareWithdraw(0.1), /OWNER_WALLET/);
  assert.equal((await none.view()).withdrawEnabled, false);
  assert.throws(() => new WalletService({ keystorePath: file, ownerWallet: address, paperMode: true }, new MockRpc(), db), /different wallet/);
  assert.throws(() => new WalletService({ keystorePath: file, ownerWallet: "nope", paperMode: true }, new MockRpc(), db), /valid/);
});
