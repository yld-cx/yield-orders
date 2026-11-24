import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import { getNetwork } from "@yld-cx/sdk/ethereum";
import type { NetworkName } from "../../rpc.ts";
import { LIMITS } from "./config.ts";
import { Subrequests } from "./subrequests.ts";
import { resolveChain } from "./execute.ts";
import { errorDetails, log, type Env } from "./shared.ts";
import { discoverTicks, type Tick } from "./ticks.ts";

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  run = resolveChain,
) {
  if (env.RESOLVER_ENABLED !== "true") {
    log({ type: "resolver_disabled" });
    return;
  }
  const chains: unknown = JSON.parse(env.NETWORKS ?? '["base"]');
  if (
    !Array.isArray(chains) ||
    chains.some((n) => !["ethereum", "base", "robinhood"].includes(n))
  )
    throw new Error("Invalid networks");
  const networks = [...new Set(chains as NetworkName[])].map(getNetwork);
  const deadline = Date.now() + LIMITS.durationMs;
  const subrequests = new Subrequests(LIMITS.externalRequests);
  const slot = Math.floor(controller.scheduledTime / 300_000);
  const selected = await discoverTicks(
    env.DB,
    networks
      .map(({ chain }) => chain.id)
      .filter(
        (id) =>
          manifest.chains[id].resolver && manifest.chains[id].resolverCodeHash,
      ),
    slot,
  );
  const byChain = new Map<number, Tick[]>();
  for (const { chainId, tick } of selected) {
    const ticks = byChain.get(chainId);
    if (ticks) ticks.push(tick);
    else byChain.set(chainId, [tick]);
  }
  for (const [index, { slug, chain }] of networks.entries()) {
    const now = Date.now();
    if (now >= deadline || !subrequests.remaining) break;
    let stage = "configuration";
    try {
      await run(env, slug, byChain.get(chain.id) ?? [], {
        subrequests,
        deadline:
          now + Math.floor((deadline - now) / (networks.length - index)),
        onStage: (value) => {
          stage = value;
        },
      });
    } catch (error) {
      log({
        type: "resolver_chain_failed",
        chain: slug,
        stage,
        ...errorDetails(error),
      });
    }
  }
  if (!subrequests.remaining) log({ type: "resolver_external_request_limit" });
}
