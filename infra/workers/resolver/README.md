# YLD resolver Worker

Cloudflare Worker that runs every five minutes. It reads active Yield Orders ticks from `yld-data` D1, checks current liquidity onchain, and submits profitable trades after simulation. Requires Node.js 24+.

Each run allows up to 50 external HTTP requests across all chains. On Workers Free, check CPU usage in Worker Logs during a dry run that reaches simulation. The scheduled CPU limit is 10 ms. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Local

```sh
cd infra/workers/resolver
npm run setup
npm ci --prefix ../data
npm run migrate:local --prefix ../data
```

Set `UNISWAP_API_KEY` in `.dev.vars`. Run in dry-run mode using the Data Worker's local D1 state.

```sh
npm run dev -- --var DRY_RUN:true --port 8788 --persist-to ../data/.wrangler/state
curl 'http://localhost:8788/__scheduled?cron=*/5+*+*+*+*'
```

Run checks with `npm run check` and bundle locally with `npm run build`.

## Deployment

Deploy `yld-data` first so it applies `0002_ticks.sql`. Wrangler resolves the resolver's `DB` binding to the existing `yld-data` database by name in the same Cloudflare account. Add `UNISWAP_API_KEY` and `RESOLVER_SIGNING_KEY` as runtime secrets before the first deploy. Fund the signing wallet for gas before enabling live execution. [Wrangler resource provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning) · [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

```sh
npx wrangler login
npx wrangler deploy --var DRY_RUN:true
```

Settings in `wrangler.jsonc` include `RESOLVER_ENABLED`, `DRY_RUN`, `NETWORKS` (defaults to Base), `RPC_URLS`, and `MIN_EXPECTED_NET_USD` (defaults to `0`). The optional secrets `PRIVATE_RPC_ETHEREUM`, `PRIVATE_RPC_BASE`, and `PRIVATE_RPC_ROBINHOOD` take priority over public RPC URLs. A chain is eligible only when its resolver address and runtime code hash are configured. [Resolver deployment manifest](../../../protocol/ethereum/deployments/resolver.json)

Ambiguous broadcasts are recorded in D1 under `resolver:pending:<chainId>:<lowercase wallet>`. Reconcile the hash and nonce before clearing a record. Cron runs can overlap, and an external sender using the same wallet can race the resolver.

## Integration

Create `yld-resolver` in Cloudflare Workers & Pages and connect `yld-cx/yield-orders` through GitHub. [Cloudflare Git integration](https://developers.cloudflare.com/workers/ci-cd/builds/)

| Setting        | Value                              |
| -------------- | ---------------------------------- |
| Branch         | `main`                             |
| Preview builds | Disabled                           |
| Root directory | `infra/workers/resolver`           |
| Build command  | `npm run setup`                    |
| Deploy command | `npx wrangler deploy`              |
| Node version   | 24 (`NODE_VERSION` build variable) |

Give the build token Workers deployment access and **D1 Read** so Wrangler can look up `yld-data` without permission to create a database. Append `--var DRY_RUN:true` to the deploy command while testing. The checked-in configuration enables live execution. [Cloudflare build tokens](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token) · [D1 lookup permissions](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/)
