import { test } from "node:test";
import assert from "node:assert/strict";
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import { rpcFor } from "../src/sync.ts";
import { environment, hash } from "./helpers.ts";

const primary = "https://primary.test/rpc";
const secondary = "https://secondary.test/rpc";
const base = supportedNetworks.find((n) => n.name === "base")!;
const network = () =>
  indexingNetwork(
    {
      ...environment(),
      RPC_URLS: JSON.stringify({ base: [primary, secondary] }),
    },
    base,
  );

function reply(init: RequestInit | undefined, result: unknown) {
  const { id } = JSON.parse(String(init?.body));
  return Response.json({ jsonrpc: "2.0", id, result });
}

test("RPC overrides accept ordered URL arrays by name or chain ID", () => {
  const env = environment();
  for (const n of supportedNetworks) {
    for (const key of [n.name, String(n.chainId)]) {
      for (const value of [[primary, secondary], [primary]]) {
        assert.deepEqual(
          indexingNetwork(
            { ...env, RPC_URLS: JSON.stringify({ [key]: value }) },
            n,
          ).rpcUrls,
          value,
        );
      }
    }
    assert.deepEqual(
      indexingNetwork(
        {
          ...env,
          RPC_URLS: JSON.stringify({
            [n.name]: [secondary],
            [n.chainId]: [primary],
          }),
        },
        n,
      ).rpcUrls,
      [primary],
    );
  }
});

test("invalid RPC lists fail configuration without exposing endpoint credentials", () => {
  const env = environment();
  for (const value of [
    [],
    "",
    primary,
    42,
    {},
    [primary, 42],
    ["ftp://secret.test/key"],
    ["secret-key"],
  ]) {
    assert.throws(
      () =>
        indexingNetwork(
          { ...env, RPC_URLS: JSON.stringify({ base: value }) },
          base,
        ),
      /^Error: Invalid RPC URLs?$/,
    );
  }
});

test("a healthy primary handles head, logs and block reads without contacting the fallback", async (t) => {
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      const { method, params } = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return reply(init, "0x1f");
      if (method === "eth_getLogs") {
        assert.equal(params[0].address, base.address);
        return reply(init, []);
      }
      assert.equal(method, "eth_getBlockByNumber");
      return reply(init, { number: "0xa", timestamp: "0x78", hash: hash(10) });
    },
  );
  const rpc = rpcFor(network(), 1000);
  assert.equal(await rpc.head(), 31n);
  assert.deepEqual(await rpc.logs(10n, 20n), []);
  const block = await rpc.block(10n);
  assert.equal(block.timestamp, 120n);
  assert.equal(block.hash, hash(10));
  assert.deepEqual(calls, [primary, primary, primary]);
});

test("head, logs and block reads fail over in order and return to a recovered primary", async (t) => {
  const calls: string[] = [];
  let primaryFailed = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === primary && primaryFailed)
        return new Response("Unavailable", { status: 503 });
      const { method } = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return reply(init, "0x1f");
      if (method === "eth_getLogs") return reply(init, []);
      return reply(init, { number: "0xa", timestamp: "0x78", hash: hash(10) });
    },
  );
  const rpc = rpcFor(network(), 1000);
  assert.equal(await rpc.head(), 31n);
  assert.deepEqual(await rpc.logs(10n, 20n), []);
  const block = await rpc.block(10n);
  assert.equal(block.timestamp, 120n);
  assert.equal(block.hash, hash(10));
  primaryFailed = false;
  assert.equal(await rpc.head(), 31n);
  assert.deepEqual(calls, [
    primary,
    secondary,
    primary,
    secondary,
    primary,
    secondary,
    primary,
  ]);
});

test("rate limits, RPC errors, network errors and timeouts reach the fallback", async (t) => {
  for (const failure of [
    "rate-limit",
    "rpc-error",
    "network",
    "timeout",
  ] as const) {
    await t.test(failure, async (t) => {
      const calls: string[] = [];
      t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          calls.push(url);
          if (url === secondary) return reply(init, "0x1f");
          if (failure === "rate-limit")
            return new Response("Too many requests", { status: 429 });
          if (failure === "rpc-error") {
            const { id } = JSON.parse(String(init?.body));
            return Response.json({
              jsonrpc: "2.0",
              id,
              error: { code: -32005, message: "Limit exceeded" },
            });
          }
          if (failure === "network") throw new TypeError("Network unavailable");
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal!.reason),
              { once: true },
            );
          });
        },
      );
      assert.equal(await rpcFor(network(), 100).head(), 31n);
      assert.deepEqual(calls, [primary, secondary]);
    });
  }
});

test("response-size limits apply to each endpoint and oversized responses fail over", async (t) => {
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return url === primary
        ? new Response("x".repeat(4 * 1024 * 1024 + 1))
        : reply(init, "0x1f");
    },
  );
  assert.equal(await rpcFor(network(), 1000).head(), 31n);
  assert.deepEqual(calls, [primary, secondary]);
});

test("failure of every endpoint exhausts only the bounded retry rounds", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("Unavailable", { status: 503 });
  });
  await assert.rejects(rpcFor(network(), 1000).head());
  assert.deepEqual(calls, [
    primary,
    secondary,
    primary,
    secondary,
    primary,
    secondary,
  ]);
});
