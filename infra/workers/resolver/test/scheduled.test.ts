import test from "node:test";
import assert from "node:assert/strict";
import { experimental_readRawConfig } from "wrangler";
import { fileURLToPath, URL as NodeURL } from "node:url";
import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import { scheduled } from "../src/scheduled.ts";
import { LIMITS } from "../src/config.ts";
import type { Env } from "../src/shared.ts";
import { testDatabase } from "./database.ts";

const controller = {
  cron: "2-59/5 * * * *",
  scheduledTime: Date.now(),
  noRetry() {},
} as ScheduledController;

function harness(networks?: string, enabled = "true") {
  const calls: string[] = [];
  const budgets: unknown[] = [];
  const { db } = testDatabase();
  const env: Env = { DB: db, RESOLVER_ENABLED: enabled, NETWORKS: networks };
  const run: NonNullable<Parameters<typeof scheduled>[2]> = async (
    bindings,
    network,
    ticks,
    options,
  ) => {
    assert.equal(bindings, env);
    assert.deepEqual(ticks, []);
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
  assert.deepEqual(config.triggers?.crons, ["2-59/5 * * * *"]);
  assert.deepEqual(data.triggers?.crons, ["* * * * *"]);
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

test("scheduled time selects a single global page and routes each tick to its chain", async (t) => {
  const { db, putTick } = testDatabase();
  const { resolver, resolverCodeHash } = manifest.chains[8453];
  const old = structuredClone(manifest.chains[1]);
  Object.assign(manifest.chains[1], { resolver, resolverCodeHash });
  t.after(() => {
    Object.assign(manifest.chains[1], old);
  });
  for (const [chain, size] of [
    [1, 6],
    [8453, 5],
    [4663, 10],
  ]) {
    for (let i = 1; i <= size; i++) {
      putTick(chain, {
        id: BigInt(i),
        asset: `0x${i.toString(16).padStart(40, "0")}`,
        quote: "0x2222222222222222222222222222222222222222",
        availableSupply: 1n,
        priceX128: 1n,
      });
    }
  }
  const env: Env = {
    DB: db,
    RESOLVER_ENABLED: "true",
    NETWORKS: '["base","ethereum","robinhood"]',
  };
  const runAt = async (scheduledTime: number) => {
    const selected: Record<string, bigint[]> = {};
    await scheduled(
      { ...controller, scheduledTime },
      env,
      async (_, chain, ticks) => {
        selected[chain] = ticks.map(({ id }) => id);
      },
    );
    return selected;
  };
  const clock = t.mock.method(Date, "now", () => 120_000);
  const first = {
    base: [1n, 2n],
    ethereum: [1n, 2n, 3n, 4n, 5n, 6n],
    robinhood: [],
  };
  assert.deepEqual(await runAt(120_000), first);
  clock.mock.mockImplementation(() => 420_000);
  assert.deepEqual(await runAt(120_000), first);
  assert.deepEqual(await runAt(420_000), {
    base: [3n, 4n, 5n],
    ethereum: [],
    robinhood: [],
  });
});

test("chains share a single external HTTP request budget of 50", async (t) => {
  const { db } = testDatabase();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(null, { status: 204 });
  });
  const calls: string[] = [];
  const env: Env = {
    DB: db,
    RESOLVER_ENABLED: "true",
    NETWORKS: '["ethereum","base","robinhood"]',
  };
  await scheduled(
    controller,
    env,
    async (_, chain, __, { subrequests } = {}) => {
      assert.ok(subrequests);
      calls.push(chain);
      for (let i = 0; i < 30; i++)
        await subrequests.fetch("https://example.test/");
    },
  );
  assert.deepEqual(calls, ["ethereum", "base"]);
  assert.equal(requests, 50);
});
