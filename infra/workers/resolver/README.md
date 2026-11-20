# YLD resolver Worker

Cloudflare Worker + Durable Objects for executing Yield Orders against Uniswap liquidity with Morpho flash loans. Requires Node.js 24+.

Runs every minute, selecting one market per chain using the persistent round-robin cursor. Reads nearby ticks through multicall, requests `BEST_PRICE` quotes across V2/V3/V4, and simulates batches before submitting profitable executions.

Candidate discovery uses `PRODUCT_MARKET.stepTicks` (100) and `PRODUCT_MARKET.duration` (7D), scanning the configured radius in one multicall of at most 100 reads.

## Local

From the repository root:

```sh
cd product
npm ci
npm run build --workspace=@yld-cx/sdk
cd ../infra/workers/resolver
npm ci
```

Set the deployed resolver address and runtime code hash in [resolver.json](../../../protocol/ethereum/deployments/resolver.json). Before starting locally, add dry-run settings to `.dev.vars`:

```dotenv
UNISWAP_API_KEY="..."
RESOLVER_ENABLED="true"
DRY_RUN="true"
```

`RESOLVER_SIGNING_KEY` is optional for dry runs and required for live execution.

Start the local Worker:

```sh
npm run dev
```

Run the scheduled job locally:

```sh
curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'
```

Checks: `npm run check`. Bundle without deploying: `npm run build`.

## Deployment

[resolver.json](../../../protocol/ethereum/deployments/resolver.json) contains each chain's resolver, Morpho, Universal Router, and Permit2 addresses. Record `resolver` and `resolverCodeHash` after deployment; a `null` resolver address disables that chain. The Worker verifies the resolver's runtime code and immutable addresses before execution.

For live execution, configure the settings below, add both secrets, and fund the signing wallet for gas.

```sh
npx wrangler login
npx wrangler secret put UNISWAP_API_KEY
npx wrangler secret put RESOLVER_SIGNING_KEY
npx wrangler deploy
```

Settings in `wrangler.jsonc`:

- `RESOLVER_ENABLED`: enables scheduled work; defaults to `"true"`.
- `DRY_RUN`: set to `"true"` to simulate without broadcasting; defaults to `"false"`.
- `NETWORKS`: defaults to `["base"]`; also supports `ethereum` and `robinhood`.
- `RPC_URLS`: ordered HTTPS endpoint arrays per network. Public defaults are provided.
- `MARKETS_API`: full HTTPS endpoint URL; defaults to `https://yld.cx/api/markets`. The worker sets `chainId` and `tag=all` for YieldList discovery.
- `MIN_EXPECTED_NET_USD`: optional additional profit after gas; defaults to `0`.
