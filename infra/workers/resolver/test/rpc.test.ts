import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi, multicall3Abi } from "viem";
import { abi } from "../src/simulate.ts";
import { resolveChain } from "../src/execute.ts";
import { Subrequests } from "../src/subrequests.ts";
import { LIMITS } from "../src/config.ts";
import type { Env } from "../src/shared.ts";

const urls = ["https://primary.rpc.test/", "https://secondary.rpc.test/"];
const env = {
  DRY_RUN: "true",
  RPC_URLS: JSON.stringify({ base: urls }),
} as Env;

test("deployment code reads and the immutable and decimals multicall share one HTTP batch", async (t) => {
  const batches: { method: string; id: number }[][] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(String(url), urls[0]);
    const requests = JSON.parse(String(init.body));
    assert.ok(Array.isArray(requests));
    batches.push(requests);
    return Response.json(
      requests.map(
        (request: {
          method: string;
          id: number;
          params: [{ data: `0x${string}` }];
        }) => {
          assert.ok(
            ["eth_chainId", "eth_getCode", "eth_call"].includes(request.method),
          );
          if (request.method === "eth_call") {
            const call = decodeFunctionData({
              abi: multicall3Abi,
              data: request.params[0].data,
            });
            assert.equal(call.functionName, "aggregate3");
            if (call.functionName !== "aggregate3")
              throw new Error("Unexpected call");
            assert.deepEqual(
              call.args[0].map(
                ({ callData }) =>
                  decodeFunctionData({
                    abi: [...abi, ...erc20Abi],
                    data: callData,
                  }).functionName,
              ),
              [
                "YLD",
                "MORPHO",
                "UNIVERSAL_ROUTER",
                "PERMIT2",
                ...Array(4).fill("decimals"),
              ],
            );
          }
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: request.method === "eth_chainId" ? "0x2105" : "0x",
          };
        },
      ),
    );
  });
  const tick = {
    id: 1n,
    asset: "0x1111111111111111111111111111111111111111",
    quote: "0x2222222222222222222222222222222222222222",
    priceX128: 1n,
    availableSupply: 1n,
  } as const;
  const subrequests = new Subrequests(LIMITS.externalRequests);
  await assert.rejects(
    resolveChain(env, "base", [tick], { subrequests }),
    /Resolver identity mismatch/,
  );
  assert.deepEqual(
    batches.map((batch) => batch.map((request) => request.method)),
    [["eth_chainId"], [...Array(5).fill("eth_getCode"), "eth_call"]],
  );
  assert.equal(subrequests.remaining, LIMITS.externalRequests - 2);
});

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
  await resolveChain(env, "base", []);
  assert.deepEqual(calls, [urls[0], urls[1], urls[0]]);
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
      resolveChain(env, "base", [], {
        onStage: (stage) => stages.push(stage),
      }),
      { name: "HttpRequestError", status },
    );
    assert.deepEqual(calls, status === 503 ? [...urls, ...urls] : urls);
    assert.equal(stages.at(-1), "rpc_chain_check");
  });
}

test("resolver tries the optional private endpoint first and signs off cleanly on public fallback", async (t) => {
  const privateUrl = "https://private.rpc.test/credential";
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(String(url));
    if (String(url) === privateUrl)
      return new Response("Rate Limited", { status: 429 });
    const [request] = JSON.parse(String(init.body));
    assert.equal(request.method, "eth_chainId");
    return Response.json([
      { jsonrpc: "2.0", id: request.id, result: "0x2105" },
    ]);
  });
  await resolveChain({ ...env, PRIVATE_RPC_BASE: privateUrl }, "base", []);
  assert.deepEqual(calls, [privateUrl, urls[0]]);
});

test("provider fallback and retries consume the invocation's remaining HTTP slots", async (t) => {
  const subrequests = new Subrequests(3);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(String(url));
    return new Response("Unavailable", { status: 503 });
  });
  await assert.rejects(resolveChain(env, "base", [], { subrequests }));
  assert.deepEqual(calls, [urls[0], urls[1], urls[0]]);
  assert.equal(subrequests.remaining, 0);
});

test("reserved broadcast slots stay available as the shared budget reaches 50 requests", async (t) => {
  const subrequests = new Subrequests(LIMITS.externalRequests);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null, { status: 204 });
  });
  const url = "https://example.test/";
  const broadcast = subrequests.reserve(2)!;
  for (let index = 0; index < LIMITS.externalRequests - 2; index++)
    await subrequests.fetch(url);
  await assert.rejects(
    subrequests.fetch(url),
    /External request budget exhausted/,
  );
  assert.equal(subrequests.reserve(1), undefined);
  await broadcast.fetch(url);
  broadcast.release();
  await subrequests.fetch(url);
  await assert.rejects(
    subrequests.fetch(url),
    /External request budget exhausted/,
  );
  assert.equal(calls, 50);
});
