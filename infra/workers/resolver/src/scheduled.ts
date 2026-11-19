import { errorKind, log, type Env } from "./shared.ts";

export async function scheduled(_controller: ScheduledController, env: Env) {
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
  for (const chain of new Set(chains)) {
    try {
      const coordinator = env.CHAINS.get(env.CHAINS.idFromName(chain));
      const result = await coordinator.fetch(
        `https://resolver.internal/${chain}`,
      );
      log({ type: "resolver_run", chain, status: result.status });
    } catch (e) {
      log({ type: "resolver_run_failed", chain, error: errorKind(e) });
    }
  }
}
