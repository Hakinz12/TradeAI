import test from "node:test";
import assert from "node:assert/strict";
import { loadAppConfig } from "../src/config";

test("provider credentials and endpoints load from environment without changing paper-first defaults", () => {
  const cfg = loadAppConfig({
    HELIUS_API_KEY: "helius-test-key",
    JUPITER_API_KEY: "jupiter-test-key",
    GEMINI_API_KEY: "gemini-test-key",
    GEMINI_MODEL: "gemini-2.5-flash",
    HELIUS_DEVNET_RPC_URL: "https://api.devnet.solana.com",
  } as NodeJS.ProcessEnv);

  assert.equal(cfg.paperMode, true);
  assert.match(cfg.rpcUrl, /mainnet\.helius-rpc\.com/);
  assert.equal(cfg.heliusApiKey, "helius-test-key");
  assert.equal(cfg.jupiterApiKey, "jupiter-test-key");
  assert.equal(cfg.geminiApiKey, "gemini-test-key");
  assert.equal(cfg.geminiModel, "gemini-2.5-flash");
  assert.equal(cfg.devnetRpcUrl, "https://api.devnet.solana.com");
});

test("provider credentials remain optional and do not enable live trading", () => {
  const cfg = loadAppConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.paperMode, true);
  assert.equal(cfg.heliusApiKey, "");
  assert.equal(cfg.jupiterApiKey, "");
  assert.equal(cfg.geminiApiKey, "");
});
