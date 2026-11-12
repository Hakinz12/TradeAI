# Alpha.fun

A Solana "degen" auto-trading agent with a web dashboard. **Paper trading only in this version**: it simulates trades
with a pretend balance, and it never places a real order. The burner wallet, deposit and withdraw features move real SOL,
but nothing in the engine spends that SOL yet.

> No trading agent can promise profit. What this project gives you is a way to **measure** whether an edge exists
> before any real money is involved: logged decisions, labelled outcomes, honest validation and pessimistic fills.

## What it does

- **Pipeline:** feed -> scanner (rug filter, fails closed) -> predictor (0-100 score) -> strategy (entry + size) -> risk manager (veto, stops, caps, kill switch) -> paper executor -> SQLite -> dashboard.
- **Exits:** automatic stop loss, partial take-profit at 2x (rest trails), final take-profit, trailing stop, time stop, rug exit, kill switch.
- **Portfolio risk:** exposure cap, per-theme cap, pool-share sizing, daily loss limit, market regime guard.
- **Strategy lab:** several strategies trade the same market side by side; promote a winner to champion.
- **Honest measurement:** pessimistic paper fills, every signal logged with features and a forward-looking label, backtest CLI, Python model pipeline with walk-forward validation.
- **Dashboard (React):** Overview, Tokens (narrative heat), Token detail (candles, entry/exit markers, stop/TP lines, replay, safety card, manual ticket with impact preview), Strategy lab, Trades (CSV), Wallet, Settings, Reports, and Manager AI conversational chat.
- **Wallet:** connect Phantom/Solflare/Backpack to prove ownership, an encrypted burner wallet, deposit, and withdraw to your own wallet only.
- **Alerts:** Discord and Telegram for kill switch, daily loss, regime changes, feed outages, wallet balance drops.

## Quick start (simulated market, 2 minutes)

```bash
npm install
npm run build:web
cp .env.example .env
npm start                   # open http://127.0.0.1:3000
```

The dashboard API has no token authentication and listens on `127.0.0.1` by default. Do not expose it directly to the
public internet. Any remote deployment requires a separate security review and appropriate access controls.

The simulated market is a plumbing test. It deliberately contains learnable patterns, so its profits mean nothing.

## Using real market data

1. Get a free key at helius.dev and put `HELIUS_API_KEY=...` in `.env`, then set `FEED=live`.
2. Run `npm run feed:check` first. It calls each data source once and tells you what works. (These adapters were built against the providers' documentation and tested with mocked responses; they could not be run against the real services where they were written, so this check matters.)
3. Without the RPC key every token stays untradable, by design.
4. Set `RECORD_SNAPSHOTS=true` (default for live) and let it run for days. Then:
   - `npm run backtest -- --source db` replays recorded data through all strategies.
   - Export signals (Reports page) and train: `pip install -r python/requirements.txt` then `python python/train.py signals.csv --out data/model.json`. Set `PREDICTOR=model`.
   - The trainer refuses to export a model with out-of-sample AUC under 0.55 or fewer than 500 labelled signals. A model trained on simulated data is refused on live data.

## Burner wallet, deposit, withdraw

```bash
npm run wallet -- create      # encrypted keystore, passphrase of 12+ characters, no recovery if lost
npm run wallet -- address
```

Set `OWNER_WALLET` in `.env` to a wallet you control (never the burner). Deposit from the Wallet page using your connected
wallet. Withdrawals can only go to `OWNER_WALLET` and need an owner-wallet signature over the exact amount and the
keystore passphrase. See SECURITY.md. **Keep only small amounts in the burner.**

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | engine + dashboard |
| `npm test` | all tests |
| `npm run typecheck` | server and dashboard |
| `npm run backtest` | compare strategies (`--source sim --seeds 5` or `--source db`) |
| `npm run feed:check` | smoke-test live data sources |
| `npm run wallet -- <cmd>` | create / address / verify / export |
| `docker compose up --build` | run in a container (published on 127.0.0.1 only) |

Docker files are included but were not built or run where this was developed (no Docker daemon); build once and check `docker compose ps` shows healthy.

## Layout

`src/` engine, risk, feeds, wallet, API. `web/` dashboard. `python/` model training. `scripts/` CLIs. `test/` tests. See ARCHITECTURE.md.

## Transaction intelligence

This build adds a transaction intelligence layer for Solana pools when `HELIUS_API_KEY` is configured:

- **Volume Intelligence:** samples indexed pool swaps and scores wallet concentration, repeated swap sizes, short-window synchronized activity, and rapid buy/sell round trips.
- **Wallet Relationship Analysis:** samples recent histories for a bounded set of active wallets and identifies shared incoming SOL funders where that evidence is present.
- **Transaction-level analysis:** consumes Helius Enhanced Transactions for the selected pool and wallet histories; the token detail view reports sample size, confidence, indicators and relationship clusters.
- **Model validation:** chronological-only fallback is now explicitly classified as weaker validation. Training refuses to export on that fallback unless `--allow-chronological-only` is supplied (or `--force` is used). The validation mode is stored in model metadata.

These are explainable heuristics, not proof of wash trading, bots, or common ownership. A shared funder can be an exchange or service wallet. The UI reports confidence and sample size and does not treat a low sample as an organic-volume pass.

### Transaction intelligence setup

Set `HELIUS_API_KEY` in `.env`. The live feed samples up to two liquid/high-volume pools per refresh interval and makes a small, bounded set of wallet-history requests. Without this key, market discovery and paper trading still work, but transaction intelligence remains unavailable. Provider calls are rate-limited and failures do not block the rest of the market feed.

### Wallet withdrawals

The application no longer enforces a per-transaction or daily withdrawal cap. Withdrawals remain restricted to the configured `OWNER_WALLET` and require a wallet signature bound to the exact amount/destination, the keystore passphrase, HTTPS for remote access, transaction simulation, and enough SOL to pay the network transaction fee. There is no app-level minimum, per-transaction cap, daily cap, or retained balance reserve. The dashboard API has no token authentication; keep it on loopback unless a separate security review establishes appropriate remote access controls.

### Interface

The dashboard has a refreshed dark, minimal trading-terminal visual system with a restrained lime accent, simplified token discovery table, and transaction intelligence panels on token detail pages.


## Trading workspace status (Nov 2026)

The refreshed dashboard adds a dedicated Trade workspace, a Paper/Devnet/Mainnet environment selector, wallet detection for Phantom/Solflare/Backpack, and an Orca Devnet pair registry. Transaction-level volume and wallet-relationship intelligence and stricter model-validation metadata are included in the existing engine.

**Execution safety:** the current trading engine is paper-only. Mainnet live execution and Devnet Orca quote/build/sign/submit are not enabled in this build. The Trade page deliberately blocks swap submission until the corresponding adapter is implemented and tested. The wallet connection UI does not imply that a swap has been executed. See [DEVNET.md](DEVNET.md) for the Devnet adapter requirements.


## Alpha.fun integration status

- Gemini powers both advisory analysis (`/api/ai/analyze`) and the Manager AI conversation (`/api/manager/chat`) when `GEMINI_API_KEY` is configured. Manager AI can answer platform, Solana/Web3, market, portfolio, position, trade-history, strategy, risk, and troubleshooting questions. It receives a read-only snapshot of the selected strategy and recent portfolio/trade context. Chat history is kept in the browser local storage; it is not written to the trading database. Manager AI cannot execute trades, sign transactions, move funds, change settings, or override the independent Risk Manager.
- Jupiter Mainnet quote retrieval and unsigned swap transaction preparation are available when `JUPITER_API_KEY` is configured. The backend never signs transactions and does not custody wallet keys.
- Wallet signing and raw transaction submission are not yet enabled in this release. A prepared Jupiter transaction is not an executed trade.
- Devnet Orca execution remains disabled until a funded pool-specific quote/build/sign/submit adapter is implemented and validated.
- The app remains paper-first. Keep `HOST=127.0.0.1`; the dashboard API has no token authentication and must not be exposed directly to the public internet.


See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exactly what this extension implements and what remains disabled.
