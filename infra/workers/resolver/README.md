# YLD resolver Worker

Cloudflare Worker + Durable Objects for executing Yield Orders against Uniswap liquidity with Morpho flash loans. Requires Node.js 24+.

Runs every five minutes. Reads nearby ticks through multicall, requests `BEST_PRICE` quotes across V2/V3/V4, and simulates batches before submitting profitable executions. Starts disabled and in dry-run mode.

Candidate discovery uses `PRODUCT_MARKET.stepTicks` (100) and `PRODUCT_MARKET.duration` (7D), with a bounded radius and deduplicated multicalls of at most 100 reads.

## Local

From the repository root:

```sh
cd product
npm ci
npm run build --workspace=@yld-cx/sdk
cd ../infra/workers/resolver
npm ci
npm run dev
```

Set each chain's deployed resolver address and runtime code hash in [resolver.json](../../../protocol/ethereum/deployments/resolver.json). Add local settings to `.dev.vars`:

```dotenv
UNISWAP_API_KEY="..."
BOT_ADDRESS="0x..."
BENEFICIARY_ADDRESS="0x..."
RESOLVER_ENABLED="true"
DRY_RUN="true"
TOKEN_LIMITS='{"base":{"0x4200000000000000000000000000000000000006":"10000000000000000","0x833589fcd6edb6e08f4c7c32d4f71b54bda02913":"100000000"}}'
BRIDGE_TOKENS='{"base":{"accountingToken":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","accountingDecimals":6,"wrappedNative":"0x4200000000000000000000000000000000000006","bridges":[]}}'
```

Replace the key and wallet addresses. `TOKEN_LIMITS` sets maximum raw token amounts; this Base example caps WETH at 0.01 and USDC at 100. `BRIDGE_TOKENS` selects the USD accounting token, wrapped native token, and optional third-token flash-loan assets. `BOT_ADDRESS` is the simulated caller; `BENEFICIARY_ADDRESS` receives surplus.

Run the scheduled job locally:

```sh
curl 'http://localhost:8787/__scheduled?cron=*/5+*+*+*+*'
```

Checks: `npm run check`. Bundle without deploying: `npm run build`.

## Deployment

Configure production variables in [wrangler.jsonc](wrangler.jsonc), then store secrets and deploy:

```sh
npx wrangler login
npx wrangler secret put UNISWAP_API_KEY
npx wrangler secret put RESOLVER_SIGNING_KEY
npx wrangler deploy
```

For live execution, record the fork proof and set the chain's `resolverEnabled` to `true` in `resolver.json`. Set `RESOLVER_ENABLED="true"` and `DRY_RUN="false"`, and fund the signing wallet for gas. Local `.dev.vars` values are not deployed.

Optional settings in `wrangler.jsonc`:

- `NETWORKS`: network names; defaults to `["base"]`. Also supports `ethereum` and `robinhood`.
- `RPC_URLS`: ordered HTTPS endpoint arrays per network. Store credential-bearing URLs as a secret.
- `MARKETS_API_ORIGIN`: Product API origin; defaults to `https://yld.cx`.
- `MIN_EXPECTED_NET_USD`: minimum expected profit after gas; defaults to `1`.
- `MAX_*`: limits for discovery, batch size, quotes, slippage, and run duration.

Each chain has one coordinator to prevent overlapping runs and track pending transactions. Logs report simulations and execution results. There is no public execution API.
