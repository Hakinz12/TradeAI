# Alpha.fun Devnet Swap Lab

Alpha.fun separates three environments:

- **Paper** — local simulated fills. No blockchain transaction is created.
- **Devnet** — real Solana Devnet transactions using test SOL and test SPL tokens. Test assets have no monetary value.
- **Mainnet** — real assets. This build intentionally keeps Mainnet execution disabled until a production swap adapter is integrated, simulated, and independently reviewed.

## Devnet AMM choice

The planned Devnet AMM adapter is **Orca Whirlpools**. Orca publishes its Whirlpool program on both Solana Mainnet and Devnet. The SDK has an explicit `WhirlpoolDeployment.devnet` target. A swap requires an actual initialized Whirlpool pool with funded liquidity; merely having two token mint addresses is not enough.

References:

- Orca Whirlpools SDK: https://orca-so.github.io/whirlpools/ts/
- Orca program and supported deployments: https://github.com/orca-so/whirlpools
- Solana Devnet faucet: https://faucet.solana.com/
- Solana Explorer (Devnet): https://explorer.solana.com/?cluster=devnet

## Pair registry

The Trade page reads a verified pair registry from `DEVNET_ORCA_POOLS`. The value must be a JSON array, for example:

```json
[
  {
    "label": "SOL / devUSDC",
    "pool": "REPLACE_WITH_VERIFIED_DEVNET_WHIRLPOOL_ADDRESS",
    "mintA": "REPLACE_WITH_VERIFIED_TOKEN_A_MINT",
    "mintB": "REPLACE_WITH_VERIFIED_TOKEN_B_MINT",
    "tokenA": "SOL",
    "tokenB": "devUSDC"
  }
]
```

Only use addresses read from the Devnet chain and confirmed against the Orca Whirlpool deployment. Do not copy Mainnet mint addresses into this registry. Restart Alpha.fun after editing `.env`.

## Current implementation status

The Alpha.fun workspace supports the environment selector, wallet discovery/connection (Phantom, Solflare, Backpack), and the Devnet pair registry. The quote builder, Orca transaction construction, wallet transaction-signing flow, and on-chain swap submission are **not yet implemented in this build**. The UI therefore disables swap submission instead of showing fake quotes or pretending that a transaction was sent.

Before enabling Devnet swaps, the remaining adapter must:

1. Read the selected pool and verify its owner/program ID is the official Orca Whirlpool program on Devnet.
2. Verify the pool's two mints match the configured pair and read current vault balances/liquidity.
3. Build an exact-in quote with a bounded slippage tolerance and compute the minimum output.
4. Construct the transaction using the Orca Devnet SDK and the connected wallet as signer.
5. Simulate the transaction, show input/output/fees/minimum output to the user, and request an explicit wallet signature.
6. Submit only to `https://api.devnet.solana.com` (or a configured Devnet RPC), confirm the signature, and link to Devnet Explorer.
7. Add tests for wrong cluster, wrong pool program, wrong mints, stale quotes, slippage failure, insufficient funds, and rejected signatures.

Never send a user's seed phrase or private key to Alpha.fun. Never allow the server to sign on behalf of the connected wallet.
