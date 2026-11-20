import test from "node:test";
import assert from "node:assert/strict";
import { resolveChain, type State } from "../src/execute.ts";
import type { Env } from "../src/shared.ts";

const urls = ["https://primary.rpc.test/", "https://secondary.rpc.test/"];
const env = {
  DRY_RUN: "true",
  RPC_URLS: JSON.stringify({ base: urls }),
} as Env;

test("RPC fallback retries a transient outage across the providers once", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(String(url));
    if (calls.length <= urls.length)
      return new Response("Temporarily unavailable", { status: 503 });
    const requests = JSON.parse(String(init.body));
    return Response.json(
      requests.map((request: { id: number; method: string }) => {
        assert.equal(request.method, "eth_chainId");
        return { jsonrpc: "2.0", id: request.id, result: "0x2105" };
      }),
    );
  });
  // Stop after successful chain verification, before deployment/discovery work.
  const verified = new Error("Chain verified; storage reached");
  const state = {
    get: async () => {
      throw verified;
    },
  } as unknown as State;
  const stages: string[] = [];
  await assert.rejects(
    resolveChain(env, "base", state, {
      onStage: (stage) => stages.push(stage),
    }),
    (error) => error === verified,
  );
  assert.deepEqual(calls, [urls[0], urls[1], urls[0]]);
  assert.equal(stages.at(-1), "pending_transaction");
});

for (const status of [503, 401]) {
  test(`permanent HTTP ${status} failures have bounded provider attempts`, async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
      calls.push(String(url));
      return new Response("Unavailable", { status });
    });
    const stages: string[] = [];
    await assert.rejects(
      resolveChain(env, "base", {} as State, {
        onStage: (stage) => stages.push(stage),
      }),
      { name: "HttpRequestError", status },
    );
    assert.deepEqual(calls, status === 503 ? [...urls, ...urls] : urls);
    assert.equal(stages.at(-1), "rpc_chain_check");
  });
}
