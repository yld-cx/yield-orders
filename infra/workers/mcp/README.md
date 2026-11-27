# Yield Orders MCP

Cloudflare Worker for Yield Orders tools and Agent Wallets over Streamable HTTP. Requires Node.js 24+.

## Local

```sh
cd infra/workers/mcp
npm run setup
npm run dev
```

Run `npm run check` for tests and a dry-run build. `npm run types` generates binding types in `.wrangler/`. Set `YLD_FORK_RPC_URL` to a disposable loopback-only Base Hardhat fork to include the fork tests.

## Deployment

Set the required `SIGNER_ENCRYPTION_KEY` binding before deployment. Changing the key invalidates issued credentials.

```sh
npx wrangler login
npx wrangler deploy
```

Deploy from `infra/workers/mcp`. Wrangler configures the Worker as `yld-mcp` on `mcp.yld.cx` with request, invocation, and tracing logs disabled. Exclude credential-bearing requests from custom-domain Logpush, analytics, proxies, redirects, tracing, and caching.

`wrangler.jsonc` supports these settings.

- `RPC_URLS` supplies an ordered list of HTTPS RPC URLs per network name (`ethereum`, `base`, `robinhood`) or chain ID. A chain-ID entry takes precedence. Public primary and fallback endpoints are already configured.
- `EXECUTION_ENABLED` defaults to `false`.

Set `PRIVATE_RPC_ETHEREUM`, `PRIVATE_RPC_BASE`, or `PRIVATE_RPC_ROBINHOOD` in Cloudflare, or in `.dev.vars` locally, to try a private endpoint before public fallbacks. Base execution uses the first endpoint for simulation, nonce checks, and a single broadcast attempt.

## Integration

Connect `yld-cx/yield-orders` through Cloudflare Workers & Pages → GitHub and select the `yld-mcp` Worker.

| Setting        | Value                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch         | `main`                                                                                                                                            |
| Preview builds | Disabled                                                                                                                                          |
| Root directory | `infra/workers/mcp`                                                                                                                               |
| Watch paths    | `infra/workers/mcp/*`, `infra/workers/rpc.ts`, `skills/*`, `product/packages/sdk/*`, `product/package-lock.json`, `product/public/yieldlist.json` |
| Build command  | `npm run setup && npm run check`                                                                                                                  |
| Deploy command | `npx wrangler deploy`                                                                                                                             |
| Node version   | 24 (`.node-version`)                                                                                                                              |

[Cloudflare build watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/)

Connect an MCP client to `https://mcp.yld.cx` for discovery, quotes, preparation, simulation, and status tools. For Agent Wallets, use the encrypted URL issued by the product. Treat it as a bearer credential. The signer has full onchain owner authority, and removing it revokes future execution access.

Authenticated clients also get `wallet` and `execute`. Broadcasting requires an authorized Base signer with gas and a client that supports MCP form confirmation. When broadcasting is unavailable, `execute` returns an unsigned plan. Use `status` to verify a submitted or uncertain transaction before trying again.
