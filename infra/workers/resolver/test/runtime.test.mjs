import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { experimental_readRawConfig } from "wrangler";
import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import { getNetwork } from "@yld-cx/sdk/ethereum";

const config = experimental_readRawConfig({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
}).rawConfig;
function runtime(vars = {}, options = {}) {
  return new Miniflare(
    convertV4MiniflareOptions({
      name: "resolver",
      modules: true,
      scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      d1Databases: ["DB"],
      bindings: { ...config.vars, ...vars },
      ...options,
    }),
  );
}

async function migrate(mf) {
  const db = await mf.getD1Database("DB");
  for (const file of ["0001_init.sql", "0002_ticks.sql"]) {
    const sql = readFileSync(
      new URL(`../../data/migrations/${file}`, import.meta.url),
      "utf8",
    );
    await db.batch(
      sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => db.prepare(statement)),
    );
  }
}

test("packaged cron resolves an empty shared D1 index and exposes no HTTP execution endpoint", async () => {
  const methods = [];
  const mf = runtime(
    { DRY_RUN: "true" },
    {
      outboundService: async (request) => {
        const body = await request.json();
        methods.push(...body.map(({ method }) => method));
        return Response.json(
          body.map(({ id }) => ({ id, jsonrpc: "2.0", result: "0x2105" })),
        );
      },
    },
  );
  try {
    await migrate(mf);
    const worker = await mf.getWorker();
    assert.equal(
      (await worker.scheduled({ cron: config.triggers.crons[0] })).outcome,
      "ok",
    );
    assert.equal(
      (await worker.fetch("https://resolver.test/base", { method: "POST" }))
        .status,
      404,
    );
    assert.deepEqual(methods, ["eth_chainId"]);
  } finally {
    await mf.dispose();
  }
});

test("packaged cron logs provider failures without emitting private credentials", async () => {
  const rpc =
    "https://provider.test/v2/runtime-rpc-secret?key=runtime-query-secret";
  const publicRpc = "https://public.test/";
  const apiKey = "runtime-api-secret";
  const logs = [];
  const requests = [];
  const mf = runtime(
    {
      DRY_RUN: "true",
      PRIVATE_RPC_BASE: rpc,
      UNISWAP_API_KEY: apiKey,
      RPC_URLS: JSON.stringify({ base: [publicRpc] }),
    },
    {
      handleStructuredLogs: (entry) => logs.push(entry.message),
      outboundService: async (request) => {
        requests.push(request.url);
        return new Response(
          `Upstream unavailable ${rpc} runtime-query-secret ${apiKey}`,
          { status: 503 },
        );
      },
    },
  );
  try {
    await migrate(mf);
    const worker = await mf.getWorker();
    assert.equal(
      (await worker.scheduled({ cron: config.triggers.crons[0] })).outcome,
      "ok",
    );
    assert.deepEqual(requests, [rpc, publicRpc, rpc, publicRpc]);
    const failures = logs
      .filter((line) => line.includes("resolver_chain_failed"))
      .map(JSON.parse);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, 503);
    assert.equal(failures[0].stage, "rpc_chain_check");
    const endpoints = logs
      .filter((line) => line.includes("resolver_rpc_endpoint_error"))
      .map(JSON.parse);
    assert.deepEqual(
      endpoints.map((entry) => entry.hostname),
      ["provider.test", "public.test", "provider.test", "public.test"],
    );
    assert.ok(
      endpoints.every(
        (entry) =>
          entry.network === "base" &&
          entry.method === "eth_chainId" &&
          entry.name === "HttpRequestError" &&
          entry.status === 503,
      ),
    );
    for (const secret of [
      rpc,
      "runtime-rpc-secret",
      "runtime-query-secret",
      apiKey,
    ])
      assert.ok(!JSON.stringify(logs).includes(secret));
  } finally {
    await mf.dispose();
  }
});

test("enabled packaged cron skips chains with null resolver addresses", async (t) => {
  const disabled = Object.entries(manifest.chains).find(
    ([, chain]) => !chain.resolver,
  );
  if (!disabled) return t.skip("All supported chains have deployed resolvers");
  const chain = getNetwork(`eip155:${disabled[0]}`).slug;
  const mf = runtime({ NETWORKS: JSON.stringify([chain]) });
  try {
    const worker = await mf.getWorker();
    assert.equal(
      (await worker.scheduled({ cron: config.triggers.crons[0] })).outcome,
      "ok",
    );
  } finally {
    await mf.dispose();
  }
});
