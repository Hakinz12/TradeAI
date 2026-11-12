# Security checklist

Status key: DONE = in the repo now, TODO = must be built before live trading.

## Dashboard and API

- The dashboard API has no token authentication. **Keep it on loopback**: the server binds to `127.0.0.1` by default.
- Do not expose the unauthenticated dashboard to the public internet. Any remote deployment requires a separate security review and appropriate access controls.
- Docker binds the service to all interfaces inside its container, but `docker-compose.yml` publishes port 3000 on host loopback only. Do not broaden that host binding without the separate review and access controls.
- DONE: rate limit (300 requests/minute per IP).
- DONE: security headers (CSP, nosniff, frame deny, no-referrer, COOP/CORP, HSTS off loopback), `Cache-Control: no-store` on the API, no `X-Powered-By`, 8 KB body limit, no stack traces in errors.
- DONE: control actions (pause, resume, kill, rearm) are logged with the caller IP.
- Wallet passphrases are accepted only for withdrawal execution and require HTTPS when the server is configured for a non-loopback host (`TRUST_PROXY=true` only behind your own reverse proxy).
- DONE: strict CSP (`script-src 'self'; style-src 'self'`, no `unsafe-inline`). The React build uses external files only, never `dangerouslySetInnerHTML`, and React escapes all text, which matters once real token names (attacker-controlled) reach the dashboard.
- DONE: dashboard dependencies pinned to exact versions and `npm audit` clean (vite 6.4.5; older vite/esbuild had a dev-server advisory). Re-run `npm audit` in `web/` before each release.

The default `HOST` is `127.0.0.1`. Changing it makes the API reachable beyond loopback; do so only after a separate security review.

## Wallet and keys

- DONE: the burner key is stored only as an encrypted keystore (scrypt + AES-256-GCM, address bound as authenticated data). It is never in `.env`, logs, API responses or the browser.
- DONE: the Wallet page uses Phantom/Solflare/Backpack for ownership-message signatures only. The new Trade workspace detects and connects these wallets but does not yet request transaction signatures.
- DONE: **withdrawals only go to `OWNER_WALLET`** (configured on the server, not accepted from the browser) and the owner must differ from the burner.
- DONE: a withdrawal needs an owner-wallet signature over the exact amount, destination and a single-use nonce (expires in 2 minutes), and the keystore passphrase (typed each time, never stored).
- DONE: owner-wallet-only destination, exact owner signature, keystore passphrase, HTTPS for remote access, network-fee balance check, rate limits and lockout on prepare/execute, transaction simulation before sending. No per-transaction or daily application cap is imposed.
- DONE: RPC calls are made by the server, so the RPC key never reaches the browser; RPC URL must be https; keys are redacted from logs.
- DONE: deposits are ordinary transfers you sign in your own wallet.
- DONE: balance-drop alerts (`WALLET_ALERT_DROP_PCT`).
- TODO before live trading: implement the wallet transaction-signing adapter; simulate every swap; verify cluster, mint and AMM program allowlists; never approve token delegates; enforce per-trade caps at the signer; verify output/minimum received and fee budget.
- Residual risk: anyone who can access the local dashboard and obtain your owner-wallet signature and keystore passphrase could withdraw only to your configured owner wallet. Anyone who steals the keystore file still needs the passphrase. Use a long unique passphrase, keep the burner small, back up the keystore file safely.
- Not covered: SPL token deposits/withdrawals (SOL only). Anything sent to the burner other than SOL must be recovered with `npm run wallet -- export --i-understand` in a wallet app.

## Data and supply chain

- DONE: fail closed. Unknown mint/freeze authority or holder concentration blocks a token; a data outage blocks all new entries; open positions are closed as `feed_lost` after 3 missed ticks.
- DONE: outbound HTTP has timeouts, bounded retries, per-host rate gaps, no redirects, a 2 MB body cap, a generic User-Agent (no personal data), and all external fields are parsed defensively. Token names are stripped to safe characters.
- DONE: mints are validated as base58 before they appear in any URL.
- DONE: CSV exports neutralise spreadsheet formula injection.
- DONE: dependencies pinned to exact versions; `npm audit` is clean for the server and dashboard. The Solana library is `@solana/kit` (the older `@solana/web3.js` v1 pulls in packages with open advisories). Re-run `npm audit` before each release.
- DONE: Docker image runs as non-root, read-only filesystem, all capabilities dropped, published on 127.0.0.1 only (not built where this was developed).
- Reminder: paper results, especially on the simulated feed, are not evidence of live profit. Real fills are worse.

## Swap readiness

- DONE: Paper/Devnet/Mainnet environment selector and guarded Devnet Orca pool registry endpoint.
- TODO: Orca Devnet quote/build/sign/submit adapter and Jupiter Mainnet V2 order/execute adapter. Both must bind the wallet signature to the displayed network, mints, exact input, minimum output, slippage, fee budget and expiry. Mainnet must remain disabled until these checks and tests pass.
