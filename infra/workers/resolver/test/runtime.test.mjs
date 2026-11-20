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
function runtime(vars = {}) {
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
    }),
  );
}
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
