import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import { rpcFor, synchronize } from "../src/sync.ts";
import {
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  toHex,
  type Hex,
} from "viem";
import { abi } from "../src/events.ts";
import {
  environment,
  hash,
  supplied,
  TestDatabase,
  tickState,
} from "./helpers.ts";

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
  const requests = JSON.parse(String(init?.body));
  return Response.json(
    requests.map(({ id }: { id: number }) => ({ jsonrpc: "2.0", id, result })),
  );
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
    ["http://secret.test/key"],
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
      const [{ method, params }] = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return reply(init, "0x1f");
      if (method === "eth_getLogs") {
        assert.equal(params[0].address, base.address);
        return reply(init, []);
      }
      assert.equal(method, "eth_getBlockByNumber");
      return reply(init, { number: "0xa", timestamp: "0x78", hash: hash(10) });
    },
  );
  const rpc = rpcFor(network());
  assert.equal(await rpc.head(), 31n);
  assert.deepEqual(await rpc.logs(10n, 20n), []);
  const block = await rpc.block(10n);
  assert.equal(block.timestamp, 120n);
  assert.equal(block.hash, hash(10));
  assert.deepEqual(calls, [primary, primary, primary]);
});

for (const failPrimary of [false, true]) {
  test(`concurrent block reads share one HTTP batch per provider; fallback=${failPrimary}`, async (t) => {
    const calls: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        const requests = JSON.parse(String(init?.body));
        assert.equal(requests.length, 3);
        if (failPrimary && url === primary)
          return new Response("Unavailable", { status: 503 });
        return Response.json(
          requests.map(
            ({
              id,
              method,
              params,
            }: {
              id: number;
              method: string;
              params: [string];
            }) => {
              assert.equal(method, "eth_getBlockByNumber");
              const number = Number(BigInt(params[0]));
              return {
                jsonrpc: "2.0",
                id,
                result: {
                  number: params[0],
                  timestamp: `0x${(number * 12).toString(16)}`,
                  hash: hash(number),
                },
              };
            },
          ),
        );
      },
    );
    const rpc = rpcFor(network());
    const blocks = await Promise.all(
      [10n, 11n, 12n].map((number) => rpc.block(number)),
    );
    assert.deepEqual(
      blocks.map((block) => block.timestamp),
      [120n, 132n, 144n],
    );
    assert.deepEqual(
      blocks.map((block) => block.hash),
      [hash(10), hash(11), hash(12)],
    );
    assert.deepEqual(calls, failPrimary ? [primary, secondary] : [primary]);
  });
}

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
      const [{ method }] = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return reply(init, "0x1f");
      if (method === "eth_getLogs") return reply(init, []);
      return reply(init, { number: "0xa", timestamp: "0x78", hash: hash(10) });
    },
  );
  const rpc = rpcFor(network());
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
            const requests = JSON.parse(String(init?.body));
            return Response.json(
              requests.map(({ id }: { id: number }) => ({
                jsonrpc: "2.0",
                id,
                error: { code: -32005, message: "Limit exceeded" },
              })),
            );
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
      if (failure === "timeout") {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const head = rpcFor(network()).head();
        t.mock.timers.tick(0);
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(10_000);
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(0);
        assert.equal(await head, 31n);
      } else {
        assert.equal(await rpcFor(network()).head(), 31n);
      }
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
  assert.equal(await rpcFor(network()).head(), 31n);
  assert.deepEqual(calls, [primary, secondary]);
});

test("failure of every endpoint exhausts only the bounded retry rounds", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("Unavailable", { status: 503 });
  });
  await assert.rejects(rpcFor(network()).head());
  assert.deepEqual(calls, [primary, secondary, primary, secondary]);
});

test("optional private endpoint precedes public endpoints and falls back in order", async (t) => {
  const url = "https://private.test/credential";
  const n = indexingNetwork(
    {
      ...environment(),
      RPC_URLS: JSON.stringify({ base: [primary, secondary] }),
      PRIVATE_RPC_BASE: url,
    },
    base,
  );
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return String(input) !== secondary
        ? new Response("Unavailable", { status: 503 })
        : reply(init, "0x1f");
    },
  );
  assert.equal(await rpcFor(n).head(), 31n);
  assert.deepEqual(calls, [url, primary, secondary]);
  assert.throws(
    () =>
      indexingNetwork(
        { ...environment(), PRIVATE_RPC_BASE: "secret-token!" },
        base,
      ),
    /^Error: Invalid RPC URL$/,
  );
});

test("all log endpoints can fail for a cron and public fallback later resumes from the saved block", async (t) => {
  const db = new TestDatabase();
  const privateUrl =
    "https://user:password@private.test/path-secret?key=query-secret";
  const logs: Array<Record<string, unknown>> = [];
  t.mock.method(console, "log", (message: string) =>
    logs.push(JSON.parse(message)),
  );
  const attempts: [string, bigint, bigint][] = [];
  let unavailable = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(String(input)).hostname;
      const [{ method, params }] = JSON.parse(String(init?.body));
      if (method === "eth_blockNumber") return reply(init, "0x1f");
      assert.equal(method, "eth_getLogs");
      attempts.push([
        host,
        BigInt(params[0].fromBlock),
        BigInt(params[0].toBlock),
      ]);
      if (host === "private.test") {
        throw new TypeError("Provider echoed path-secret and a bare-secret", {
          cause: Object.assign(new Error("query-secret"), {
            code: "ECONNRESET",
          }),
        });
      }
      return unavailable
        ? new Response("query-secret and bare-secret", { status: 503 })
        : reply(init, []);
    },
  );
  const env = {
    ...environment(db),
    RPC_URLS: JSON.stringify({ base: [secondary] }),
    PRIVATE_RPC_BASE: privateUrl,
  };
  const saved = () =>
    JSON.parse(
      String(
        db.rows("SELECT meta FROM state WHERE key = 'events:8453'")[0]!.meta,
      ),
    );
  const options = { sleep: async () => {} };
  await synchronize(env, 0, options);
  assert.equal(saved().lastBlock, 9);
  assert.equal(saved().chunkSize, 2);
  assert.deepEqual(attempts, [
    ["private.test", 10n, 19n],
    ["secondary.test", 10n, 19n],
    ["private.test", 10n, 19n],
    ["secondary.test", 10n, 19n],
    ["private.test", 10n, 14n],
    ["secondary.test", 10n, 14n],
  ]);
  const diagnostic = logs.find((entry) => entry.hostname === "private.test");
  assert.ok(diagnostic);
  assert.deepEqual(
    [
      diagnostic.network,
      diagnostic.method,
      diagnostic.fromBlock,
      diagnostic.toBlock,
      diagnostic.chunkSize,
      diagnostic.attempt,
      diagnostic.checkpoint,
      diagnostic.lagBlocks,
    ],
    ["base", "eth_getLogs", "10", "19", 10, 1, "9", "20"],
  );
  assert.equal(diagnostic.name, "HttpRequestError");
  assert.equal(diagnostic.message, "RPC HTTP request failed");
  assert.equal((diagnostic.cause as { name: string }).name, "TypeError");
  assert.match(JSON.stringify(diagnostic), /ECONNRESET/);
  for (const secret of [
    privateUrl,
    "path-secret",
    "query-secret",
    "bare-secret",
    "user:password",
  ])
    assert.ok(!JSON.stringify(logs).includes(secret));

  unavailable = false;
  attempts.length = 0;
  await synchronize(env, 300_000, options);
  assert.equal(saved().lastBlock, 29);
  const covered = attempts.filter(([host]) => host === "secondary.test");
  assert.deepEqual(covered[0], ["secondary.test", 10n, 11n]);
  assert.ok(
    covered.every(([, from], i) => i === 0 || from === covered[i - 1]![2] + 1n),
  );
});

test("getTick uses one multicall at the confirmed block and rejects any reverted read", async (t) => {
  let fail = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const [{ method, params }] = JSON.parse(String(init?.body));
      assert.equal(method, "eth_call");
      assert.equal(params[1], "0x2000");
      const data = decodeFunctionData({
        abi: multicall3Abi,
        data: params[0].data,
      });
      assert.equal(data.functionName, "aggregate3");
      if (data.functionName !== "aggregate3")
        throw new Error("Unexpected call");
      assert.deepEqual(
        data.args[0].map(({ target, callData }) => {
          assert.equal(target.toLowerCase(), base.address);
          return decodeFunctionData({ abi, data: callData }).args?.[0];
        }),
        [1n, 2n],
      );
      const result = encodeFunctionResult({
        abi,
        functionName: "getTick",
        result: tickState(),
      });
      return reply(
        init,
        encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: [
            { success: true, returnData: result },
            { success: !fail, returnData: fail ? "0x" : result },
          ],
        }),
      );
    },
  );
  const rpc = rpcFor(network());
  const states = await rpc.ticks([1n, 2n], 8192n);
  assert.deepEqual(
    states.map((tick) => tick.availableSupply),
    [tickState().availableSupply, tickState().availableSupply],
  );
  fail = true;
  await assert.rejects(rpc.ticks([1n, 2n], 8192n));
});

test(
  "the execution deadline bounds Viem's Retry-After delay",
  { timeout: 2000 },
  async (t) => {
    const controller = new AbortController();
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input) === secondary) setTimeout(() => controller.abort(), 20);
      return new Response("Rate limited", {
        status: 429,
        headers: { "Retry-After": "3600" },
      });
    });
    await assert.rejects(
      rpcFor(network(), { signal: controller.signal }).head(),
      {
        name: "AbortError",
      },
    );
    assert.deepEqual(calls, [primary, secondary]);
  },
);

for (const scenario of ["healthy", "transient failure", "outage"] as const) {
  test(`sync batches confirmed block and tick reads (${scenario})`, (t) =>
    verifyTickSync(t, scenario));
}

async function verifyTickSync(
  t: TestContext,
  scenario: "healthy" | "transient failure" | "outage",
) {
  const db = new TestDatabase();
  const start = 8200;
  const end = start + 9;
  const entries = Array.from({ length: 65 }, (_, i) => {
    const entry = supplied(start + (i % 2), i, 1n, base.chainId, BigInt(i + 1));
    return {
      ...entry,
      blockNumber: toHex(entry.blockNumber!),
      transactionIndex: toHex(entry.transactionIndex!),
      logIndex: toHex(entry.logIndex!),
    };
  });
  const tickData = encodeFunctionResult({
    abi,
    functionName: "getTick",
    result: tickState(),
  });
  const batches: string[][] = [];
  const heights: bigint[] = [];
  const groupSizes: number[] = [];
  const attempts: { url: string; time: number }[] = [];
  let outage = scenario === "outage";
  const checkpoint = () =>
    db.rows(
      "SELECT json_extract(meta, '$.lastBlock') AS block FROM state WHERE key = 'events:8453'",
    )[0]?.block;
  const countRows = (table: "events" | "ticks") =>
    db.rows(`SELECT count(*) AS count FROM ${table}`)[0]?.count;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const calls: {
        id: number;
        method: string;
        params: [Hex | { data: Hex }, Hex];
      }[] = JSON.parse(String(init?.body));
      batches.push(calls.map(({ method }) => method));
      if (calls[0]?.method === "eth_call") {
        attempts.push({ url, time: performance.now() });
        assert.equal(checkpoint(), start - 1);
        assert.equal(countRows("events"), 0);
        assert.equal(countRows("ticks"), 0);
        if (
          outage ||
          (scenario === "transient failure" && attempts.length <= 2)
        ) {
          if (url === primary) throw new TypeError("Temporary network failure");
          return new Response("Rate limited", { status: 429 });
        }
      } else {
        assert.equal(url, primary);
      }
      return Response.json(
        calls.map(({ id, method, params }) => {
          let result: unknown;
          switch (method) {
            case "eth_blockNumber":
              result = toHex(end + 2);
              break;
            case "eth_getLogs":
              result = entries;
              break;
            case "eth_getBlockByNumber": {
              const number = BigInt(params[0] as Hex);
              heights.push(number);
              result = {
                number: params[0],
                timestamp: toHex(number * 12n),
                hash: hash(Number(number)),
              };
              break;
            }
            case "eth_call": {
              assert.equal(params[1], toHex(end));
              assert.equal(typeof params[0], "object");
              const call = decodeFunctionData({
                abi: multicall3Abi,
                data: (params[0] as { data: Hex }).data,
              });
              assert.equal(call.functionName, "aggregate3");
              if (call.functionName !== "aggregate3")
                throw new Error("Unexpected call");
              groupSizes.push(call.args[0].length);
              result = encodeFunctionResult({
                abi: multicall3Abi,
                functionName: "aggregate3",
                result: call.args[0].map(() => ({
                  success: true,
                  returnData: tickData,
                })),
              });
              break;
            }
            default:
              throw new Error(`Unexpected RPC method ${method}`);
          }
          return { jsonrpc: "2.0", id, result };
        }),
      );
    },
  );
  const env = {
    ...environment(db),
    RPC_URLS: JSON.stringify({ base: [primary, secondary] }),
    NETWORK_CONFIG: JSON.stringify({
      [base.chainId]: { startBlock: start, confirmations: 2, chunkSize: 10 },
    }),
  };
  await synchronize(env, 0);
  const expectedAttempts =
    scenario === "healthy"
      ? [primary]
      : scenario === "transient failure"
        ? [primary, secondary, primary]
        : [primary, secondary, primary, secondary];
  assert.deepEqual(
    attempts.map(({ url }) => url),
    expectedAttempts,
  );
  if (scenario !== "healthy")
    assert.ok(
      attempts[2]!.time - attempts[1]!.time >= 125,
      "Viem waits before repeating the fallback round",
    );
  assert.deepEqual(batches, [
    ["eth_blockNumber"],
    ["eth_getLogs"],
    Array(3).fill("eth_getBlockByNumber"),
    ...expectedAttempts.map(() => Array(3).fill("eth_call")),
  ]);
  assert.deepEqual(heights, [BigInt(start), BigInt(start + 1), BigInt(end)]);

  if (outage) {
    assert.equal(checkpoint(), start - 1);
    assert.equal(countRows("events"), 0);
    assert.equal(countRows("ticks"), 0);
    outage = false;
    await synchronize(env, 300_000);
    assert.deepEqual(
      attempts.map(({ url }) => url),
      [...expectedAttempts, primary],
    );
  }
  assert.equal(checkpoint(), end);
  assert.equal(countRows("events"), 65);
  assert.deepEqual(groupSizes, [32, 32, 1]);
  const [count] = db.rows(
    "SELECT count(*) AS count, min(timestamp) AS timestamp FROM ticks",
  );
  assert.equal(count?.count, 65);
  assert.equal(count?.timestamp, end * 12);
}
