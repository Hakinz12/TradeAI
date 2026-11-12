# Architecture

```
 DexScreener --+                         +--> Predictor (heuristic | trained model.json)
 GeckoTerminal-+--> LiveFeed / Sim / Replay --> Scanner (fail-closed) --> Strategy (entry, size)
 Solana RPC ---+            |                                                  |
 Jupiter (opt) +            v                                                  v
                      Snapshots (SQLite)                              Risk manager (veto, exits)
                                                                               |
 Dashboard (React + Manager AI chat) <--- Express API <--- Lab (N strategies) <--- PaperExecutor (pessimistic)
        |                                                   |
        +-- Wallet (connect, deposit, withdraw) ----> WalletService --> Solana RPC     SQLite (state, trades, signals)
```

- **Lab** runs several strategies on one shared market tick. Each has its own balance, positions, config and kill switch.
- **Feed** is an interface (`sim`, `live`, `replay`). Unknown data stays `null`; the scanner fails closed on unknown authorities and holder concentration.
- **Signals** are logged with features and later labelled by what the price did (hit +X% before -Y% within a horizon), for every sampled token, traded or not, to avoid selection bias. This is the training set for `python/train.py`.
- **Engine** exits are decided by the risk manager only; the predictor and strategy cannot override them.
- **Manager AI** is the conversational orchestration and platform-assistance layer. Gemini receives bounded chat history plus a read-only snapshot of the selected strategy, portfolio, positions, recent trades, market regime, and feed health. It can explain and advise but has no execution tools, wallet signing access, or permission to mutate strategy controls. The deterministic Risk Manager remains independent and has final veto authority.
- **Storage:** one SQLite file (WAL). Position and trade ids are unique per strategy.
- **Languages:** TypeScript (engine, API, dashboard), Python (model training only). Rust is not used; nothing here is CPU-bound.
- **Shared types:** `src/api-types.ts` is imported type-only by the dashboard.
- **Not built:** the live executor. `LiveExecutor` throws. Planned: Jupiter swap signed by the burner wallet, simulate before send, program allowlist.
