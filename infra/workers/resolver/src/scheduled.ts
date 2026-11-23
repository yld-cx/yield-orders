import type { NetworkName } from "../../rpc.ts";
import { LIMITS } from "./config.ts";
import { Subrequests } from "./subrequests.ts";
import { resolveChain } from "./execute.ts";
import { errorDetails, log, type Env } from "./shared.ts";

export async function scheduled(
  _controller: ScheduledController,
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
  const networks = [...new Set(chains as NetworkName[])];
  const deadline = Date.now() + LIMITS.durationMs;
  const subrequests = new Subrequests(LIMITS.externalRequests);
  for (const [index, chain] of networks.entries()) {
    const now = Date.now();
    if (now >= deadline || !subrequests.remaining) break;
    let stage = "configuration";
    try {
      await run(env, chain, {
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
        chain,
        stage,
        ...errorDetails(error),
      });
    }
  }
  if (!subrequests.remaining) log({ type: "resolver_external_request_limit" });
}
