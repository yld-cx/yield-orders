import test from "node:test";
import assert from "node:assert/strict";
import { experimental_readRawConfig } from "wrangler";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { scheduled } from "../src/scheduled.ts";
import { LIMITS } from "../src/config.ts";
import type { Env } from "../src/shared.ts";

const controller = {
  cron: "*/5 * * * *",
  scheduledTime: Date.now(),
  noRetry() {},
} as ScheduledController;

function harness(networks?: string, enabled = "true") {
  const calls: string[] = [];
  const budgets: unknown[] = [];
  const env = { RESOLVER_ENABLED: enabled, NETWORKS: networks } as Env;
  const run: NonNullable<Parameters<typeof scheduled>[2]> = async (
    bindings,
    network,
    options,
  ) => {
    assert.equal(bindings, env);
    assert.ok(
      options?.deadline && options.deadline - Date.now() <= LIMITS.durationMs,
    );
    budgets.push(options?.subrequests);
    assert.equal(options?.subrequests?.remaining, LIMITS.externalRequests);
    calls.push(network);
    if (network === "ethereum") throw new Error("network failure");
  };
  return { calls, budgets, invoke: () => scheduled(controller, env, run) };
}

test("shipped cron enables live execution with the shared D1 binding", async () => {
  const config = experimental_readRawConfig({
    config: fileURLToPath(new NodeURL("../wrangler.jsonc", import.meta.url)),
  }).rawConfig;
  const data = experimental_readRawConfig({
    config: fileURLToPath(
      new NodeURL("../../data/wrangler.jsonc", import.meta.url),
    ),
  }).rawConfig;
  assert.equal(config.vars?.RESOLVER_ENABLED, "true");
  assert.equal(config.vars?.DRY_RUN, "false");
  assert.equal(config.vars?.RPC_URLS, data.vars?.RPC_URLS);
  assert.ok(
    !Object.keys(config.vars ?? {}).some((key) =>
      key.startsWith("PRIVATE_RPC_"),
    ),
  );
  assert.ok(
    !config.secrets?.required?.some((key: string) =>
      key.startsWith("PRIVATE_RPC_"),
    ),
  );
  assert.equal(config.durable_objects, undefined);
  assert.equal(config.migrations, undefined);
  assert.equal(
    config.d1_databases?.[0].database_name,
    data.d1_databases?.[0].database_name,
  );
  assert.deepEqual(config.triggers?.crons, ["*/5 * * * *"]);
  const h = harness(String(config.vars?.NETWORKS));
  await h.invoke();
  assert.deepEqual(h.calls, ["base"]);
});

test("disabled schedules skip configuration and execution", async () => {
  const h = harness("invalid JSON", "false");
  await h.invoke();
  assert.deepEqual(h.calls, []);
});

test("scheduled execution defaults to Base, deduplicates networks and isolates failures", async () => {
  const defaults = harness();
  await defaults.invoke();
  assert.deepEqual(defaults.calls, ["base"]);
  const h = harness('["ethereum","base","base","robinhood"]');
  await h.invoke();
  assert.deepEqual(h.calls, ["ethereum", "base", "robinhood"]);
  assert.equal(new Set(h.budgets).size, 1);
});

test("unknown networks are rejected before starting any chain", async () => {
  const h = harness('["base","unsupported"]');
  await assert.rejects(h.invoke(), /Invalid networks/);
  assert.deepEqual(h.calls, []);
});
