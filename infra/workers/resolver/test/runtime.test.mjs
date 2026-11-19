import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { experimental_readRawConfig } from "wrangler";

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
  const mf = runtime({ RESOLVER_ENABLED: "false" });
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
test("packaged enabled cron parses its networks without exposing a public execution endpoint", async () => {
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
