import test from "node:test";
import assert from "node:assert/strict";
import { experimental_readRawConfig } from "wrangler";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { scheduled } from "../src/scheduled.ts";
import type { Env } from "../src/shared.ts";

const controller = {
  cron: "*/5 * * * *",
  scheduledTime: Date.now(),
  noRetry() {},
} as ScheduledController;
function harness(networks?: string, enabled = "true") {
  const calls: string[] = [];
  const env = {
    RESOLVER_ENABLED: enabled,
    NETWORKS: networks,
    CHAINS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async () => {
          calls.push(name);
          if (name === "ethereum") throw new Error("network failure");
          return new Response("Complete");
        },
      }),
    },
  } as unknown as Env;
  return { env, calls };
}
test("shipped cron configuration enables live execution and its network JSON parses", async () => {
  const config = experimental_readRawConfig({
    config: fileURLToPath(new NodeURL("../wrangler.jsonc", import.meta.url)),
  }).rawConfig;
  assert.equal(config.vars?.RESOLVER_ENABLED, "true");
  assert.deepEqual(Object.keys(config.vars ?? {}).sort(), [
    "DRY_RUN",
    "MARKETS_API",
    "NETWORKS",
    "RESOLVER_ENABLED",
    "RPC_URLS",
  ]);
  assert.equal(config.vars?.DRY_RUN, "false");
  assert.deepEqual(config.triggers?.crons, ["*/5 * * * *"]);
  const h = harness(
    String(config.vars?.NETWORKS),
    String(config.vars?.RESOLVER_ENABLED),
  );
  await scheduled(controller, h.env);
  assert.deepEqual(h.calls, ["base"]);
});
test("disabled schedules cannot create a coordinator or submit work", async () => {
  const h = harness("invalid JSON is not read while disabled", "false");
  await scheduled(controller, h.env);
  assert.deepEqual(h.calls, []);
});
test("default Base scheduling deduplicates networks and isolates chain failures", async () => {
  const defaults = harness();
  await scheduled(controller, defaults.env);
  assert.deepEqual(defaults.calls, ["base"]);
  const h = harness('["ethereum","base","base","robinhood"]');
  await scheduled(controller, h.env);
  assert.deepEqual(h.calls, ["ethereum", "base", "robinhood"]);
});
test("unknown networks are rejected before starting any coordinator", async () => {
  const h = harness('["base","unsupported"]');
  await assert.rejects(scheduled(controller, h.env), /Invalid networks/);
  assert.deepEqual(h.calls, []);
});
