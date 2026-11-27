# @yld-cx/skills

Yield Orders agent instructions, CLI, and a read-only TypeScript API for Node.js and Cloudflare Workers. See [SKILL.md](SKILL.md) for protocol mechanics and workflows.

```sh
npx @yld-cx/skills --help
npx @yld-cx/skills markets --chain base
npx @yld-cx/skills prepare --help
```

```ts
import { createSkills } from "@yld-cx/skills";

const yld = createSkills();
const { markets } = await yld.markets({ chain: "base" });
const liquidity = await yld.book({
  chain: "base",
  tokenA: markets[0].token0,
  tokenB: markets[0].token1,
});
```

The API and CLI provide `protocol`, `networks`, `markets`, `book`, `balances`, `portfolio`, `quote`, `prepare`, `simulate` and `status`. `createSkills` uses the selected chain's viem default RPC unless you supply a custom public client. The CLI tries `YLD_RPC_URL` first and falls back to viem's default on remote RPC failures. Loopback endpoints stay pinned for local fork work. Skills returns ordered unsigned calls with JSON-safe amounts. Use an external wallet to authorize and submit them.

Remote RPC reads use JSON-RPC batching and Multicall3 for compatible calls. Skills retries transient failures once after trying the configured endpoints and gives each operation a 30-second RPC budget.

Build from the repository with `npm run setup` followed by `npm run build` in this directory. The npm build bundles the private SDK and deployment manifest. `npm pack` includes the executable, API, TypeScript declarations and agent instructions.
