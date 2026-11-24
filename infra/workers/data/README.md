# YLD data Worker

Cloudflare Worker + D1 for token metadata, prices, and protocol events on [supported networks](../../../protocol/ethereum/README.md#deployments). Requires Node.js 24+; use Workers Paid for production.

Indexing runs on the `triggers.crons` schedule in `wrangler.jsonc`. On a fresh database it records each chain's first observed head as the starting block, then waits for confirmations. Subsequent runs scan from the saved checkpoint plus one through the latest confirmed block. Each chunk commits events, changed ticks, and its checkpoint in one revision-guarded D1 batch. RPC or database failures leave that chunk for the next run. Events older than `EVENT_RETENTION_MONTHS` are automatically removed.

The `ticks` table stores complete `getTick()` snapshots keyed by `chainId:tickId`. The Worker deduplicates affected IDs across each chunk and reads them via multicall at the confirmed end block. The row timestamp comes from that block. Bigints are stored as decimal strings, and ticks with zero available supply are retained with `active: false`. Existing installations fill the index as relevant events are synchronized after their saved checkpoint, without resuming earlier ranges.

## Local

```sh
cd infra/workers/data
npm ci
npm run migrate:local
npm run dev
```

Run the scheduled job locally.

```sh
curl 'http://localhost:8787/__scheduled'
```

Format: `npm run format`. Checks: `npm run check`. Bundle without deploying: `npm run build`.

## Migrations

Add numbered SQL files under `migrations/`, then apply them:

```sh
npm run migrate:local
npm run migrate:remote
```

Run remote migrations after the first deployment has created the database. Deployment resolves the database ID and applies remote migrations automatically.

## Deployment

```sh
npx wrangler login
npm run deploy
```

Deployment provisions or reuses the `yld-data` database, applies migrations, then activates the configured schedule. Keep the Worker/database names unchanged to reuse existing resources.

Optional settings in `wrangler.jsonc`:

- `RPC_URLS`: a nonempty ordered array of HTTPS RPC URLs per network name (`ethereum`, `base`, `robinhood`) or chain ID. A chain-ID entry takes precedence if both keys are present. Public primary and fallback URLs are already provided.
- `RPC_TIMEOUT_MS`: timeout budget per pass through the endpoint list (default `8000`), divided between endpoints. Requests try URLs in order, with at most one fallback retry round. If all attempts fail, the failed range remains uncommitted for a later scheduled run.
- `NETWORK_CONFIG`: optional per-chain `startBlock` for historical indexing, set before the first run.
- `EVENT_RETENTION_MONTHS`: defaults to `2`; set `0` to retain all history.
- `CORS_ORIGINS`: allowed frontend origins.

The optional secrets `PRIVATE_RPC_ETHEREUM`, `PRIVATE_RPC_BASE`, and `PRIVATE_RPC_ROBINHOOD` take priority over the corresponding public URLs. Set them in Cloudflare for this Worker, or in `.dev.vars` for local development. RPC error logs omit provider messages.

## Integration

Connect `yld-cx/yield-orders` through Cloudflare Workers & Pages → GitHub. Choose a Worker, name it `yld-data`, and configure:

| Setting        | Value                                          |
| -------------- | ---------------------------------------------- |
| Branch         | `main`                                         |
| Preview builds | Disabled                                       |
| Root directory | `infra/workers/data`                           |
| Watch paths    | `infra/workers/data/*`, `infra/workers/rpc.ts` |
| Build command  | `npm run check`                                |
| Deploy command | `npm run deploy`                               |
| Node version   | 24 (`.node-version`)                           |

The deployment token needs Worker deployment and **D1 Write** permissions for this account. Cloudflare's default generated build token omits D1; add that permission or select a custom token before the first build. See [Cloudflare build token permissions](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token). Later builds automatically reuse the database; optionally pin its ID as `database_id` or the build variable `YLD_D1_DATABASE_ID`.

Use the Worker API for simple frontend reads (replace the local URL with your deployed Worker URL):

```sh
curl 'http://localhost:8787/tokens?chainId=8453&addresses=0x4200000000000000000000000000000000000006'
curl 'http://localhost:8787/events?chainId=8453&limit=50'
```

Token responses preserve the full `geckoTerminal` object, including prices, in one seven-day cache. Expired snapshots refresh on demand; failed refreshes preserve the previous data with `stale: true`. Prices are for discovery and baseTick estimates. Read transaction-critical decimals onchain.

For custom SQL, set these **server-only Vercel variables**: `CLOUDFLARE_ACCOUNT_ID`, `YLD_D1_DATABASE_ID`, and `YLD_D1_READ_TOKEN` (D1 Read permission only, scoped to your account). Never prefix them with `NEXT_PUBLIC_`.

```sh
curl --request POST \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$YLD_D1_DATABASE_ID/query" \
  --header "Authorization: Bearer $YLD_D1_READ_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"sql":"SELECT * FROM events WHERE chain_id = ? ORDER BY timestamp DESC LIMIT ?","params":["8453","50"]}'
```

Keep SQL parameterized and cache query results on the server. There is no custom SQL endpoint in the Worker.
