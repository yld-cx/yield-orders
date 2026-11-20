import test from "node:test";
import assert from "node:assert/strict";
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
      durableObjects: {
        CHAINS: { className: "ChainCoordinator", useSQLite: true },
      },
      bindings: { ...config.vars, ...vars },
      ...options,
    }),
  );
}
test("coordinator logs HTTP diagnostics without secrets and releases its running guard after failure", async () => {
  const key = `0x${"ab".repeat(32)}`;
  const apiKey = "runtime-api-secret";
  const rpc =
    "https://provider.test/v2/runtime-rpc-secret?key=runtime-query-secret";
  const logs = [];
  let requests = 0;
  const mf = runtime(
    {
      RESOLVER_ENABLED: "true",
      DRY_RUN: "true",
      RESOLVER_SIGNING_KEY: key,
      UNISWAP_API_KEY: apiKey,
      RPC_URLS: JSON.stringify({ base: [rpc] }),
    },
    {
      handleStructuredLogs: (entry) => logs.push(entry.message),
      outboundService: () => {
        requests++;
        return new Response(`Upstream unavailable ${rpc} ${key} ${apiKey}`, {
          status: 503,
        });
      },
    },
  );
  try {
    const namespace = await mf.getDurableObjectNamespace("CHAINS");
    const coordinator = namespace.get(namespace.idFromName("base"));
    for (let i = 0; i < 2; i++) {
      const response = await coordinator.fetch(
        "https://resolver.internal/base",
      );
      assert.equal(response.status, 503);
      assert.equal(await response.text(), "Chain run failed");
    }
    assert.equal(requests, 4);
    const failures = logs
      .filter((line) => line.includes("resolver_chain_failed"))
      .map(JSON.parse);
    assert.equal(failures.length, 2);
    for (const failure of failures) {
      assert.equal(failure.type, "resolver_chain_failed");
      assert.equal(failure.error, "HttpRequestError");
      assert.equal(failure.status, 503);
      assert.equal(failure.stage, "rpc_chain_check");
      assert.match(failure.message, /HTTP request failed/);
      assert.match(failure.message, /Upstream unavailable/);
    }
    const output = JSON.stringify(failures);
    for (const secret of [
      key,
      apiKey,
      rpc,
      "runtime-rpc-secret",
      "runtime-query-secret",
      "provider.test",
    ])
      assert.equal(output.includes(secret), false);
  } finally {
    await mf.dispose();
  }
});
test("packaged worker and SQLite coordinator start safely in the Cloudflare runtime", async () => {
  const mf = runtime({ RESOLVER_ENABLED: "false", DRY_RUN: "true" });
  try {
    const worker = await mf.getWorker();
    assert.equal((await worker.fetch("https://resolver.test/")).status, 404);
    assert.equal(
      (await worker.scheduled({ cron: config.triggers.crons[0] })).outcome,
      "ok",
    );
    const namespace = await mf.getDurableObjectNamespace("CHAINS");
    const response = await namespace
      .get(namespace.idFromName("base"))
      .fetch("https://resolver.internal/base");
    assert.equal(await response.text(), "Disabled");
  } finally {
    await mf.dispose();
  }
});
test("packaged cron parses its networks without exposing a public execution endpoint", async () => {
  const mf = runtime({ RESOLVER_ENABLED: "true", NETWORKS: "[]" });
  try {
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
  const mf = runtime({
    RESOLVER_ENABLED: "true",
    NETWORKS: JSON.stringify([chain]),
  });
  try {
    const worker = await mf.getWorker();
    assert.equal(
      (await worker.scheduled({ cron: config.triggers.crons[0] })).outcome,
      "ok",
    );
    const namespace = await mf.getDurableObjectNamespace("CHAINS");
    const response = await namespace
      .get(namespace.idFromName(chain))
      .fetch(`https://resolver.internal/${chain}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "Complete");
  } finally {
    await mf.dispose();
  }
});
