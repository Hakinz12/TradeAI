# Alpha.fun implementation status

This build extends the supplied TradeAI codebase in place. The existing SQLite trading history, paper engine, risk controls, strategy lab, wallet ownership flow, and market-data adapters are retained.

## Implemented in this extension

- Alpha.fun identity, browser title, app metadata, and dark navy/orange brand treatment.
- Gemini server-side advisory analysis endpoint (`POST /api/ai/analyze`) and token-detail analysis panel. The Gemini key stays on the server; prompts explicitly prohibit trade execution and unsupported safety/profit claims.
- Jupiter Mainnet quote retrieval (`POST /api/swap/mainnet/quote`) with mint, amount, and slippage validation.
- Jupiter unsigned swap transaction preparation (`POST /api/swap/mainnet/build`). The server does not sign or submit transactions and never receives wallet private keys.
- Provider readiness information and environment-variable examples.
- Explicit input-token decimal configuration in the quote ticket.
- Configuration tests for Gemini, Jupiter, Helius, and paper-first defaults.

## Deliberately not enabled

- Wallet signing and signed-transaction submission. The current browser bundle has no Solana transaction codec dependency available in the offline build environment; the Jupiter response is therefore only an unsigned transaction payload. Do not treat it as an executed swap.
- Devnet Orca quote/build/sign/submit. A configured pool address alone is not proof of funded liquidity or a valid route. The actual Whirlpool adapter still needs to be installed and tested against a funded Devnet pool.
- Automated live execution. `PAPER_MODE=true` remains the default and the engine still refuses to start in non-paper mode. AI analysis cannot approve or trigger transactions.

## Required environment variables

- `HELIUS_API_KEY`
- `JUPITER_API_KEY`
- `GEMINI_API_KEY`
- Optional: `GEMINI_MODEL`, `HELIUS_DEVNET_RPC_URL`

Never commit `.env`. Keep the dashboard bound to `127.0.0.1` unless a separate access-control layer is deployed and reviewed. Rotate any API key previously pasted into a chat or committed to source control.

## Validation limits

TypeScript/TSX syntax transpilation passed for all 59 source files. Full typechecking, automated tests, and production build could not be run in this environment because project dependencies were not installed and the npm registry was unreachable. Run `npm ci`, `npm --prefix web ci`, `npm run typecheck`, `npm test`, and `npm run build:web` on a machine with registry access before using this build.
