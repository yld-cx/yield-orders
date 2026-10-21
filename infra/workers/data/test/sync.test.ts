import { test } from "node:test";
import assert from "node:assert/strict";
import manifest from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import { synchronize } from "../src/sync.ts";
import type { RpcLog } from "../src/events.ts";
import { TestDatabase, environment, fakeRpc, supplied } from "./helpers.ts";

function progress(db: TestDatabase) {
  return Object.fromEntries(
    db
      .rows(
        "SELECT key, json_extract(meta, '$.lastBlock') AS lastBlock FROM state WHERE key LIKE 'events:%'",
      )
      .map((r) => [String(r.key), r.lastBlock]),
  );
}

test("every manifest network is configured, uses manifest address and permits an optional start block", () => {
  assert.deepEqual(
    supportedNetworks.map((n) => n.chainId),
    Object.values(manifest.networks),
  );
  assert.deepEqual(
    supportedNetworks.map((n) => n.chainId),
    [1, 8453, 4663],
  );
  const env = environment();
  for (const n of supportedNetworks) {
    const configured = indexingNetwork(env, n);
    assert.equal(configured.address, manifest.address.toLowerCase());
    assert.equal(configured.startBlock, 10n);
    assert.ok(configured.rpcUrl.startsWith("https://"));
    assert.equal(
      indexingNetwork({ ...env, NETWORK_CONFIG: "{}" }, n).startBlock,
      undefined,
    );
    assert.equal(
      indexingNetwork(
        {
          ...env,
          RPC_URLS: JSON.stringify({
            [n.chainId]: "https://custom.test/secret",
          }),
        },
        n,
      ).rpcUrl,
      "https://custom.test/secret",
    );
  }
});

test("hourly invocation processes all chains with independent checkpoints and events", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  const visited: number[] = [];
  await synchronize(env, 0, {
    rpc: (n) => {
      visited.push(n.chainId);
      return fakeRpc(31n, [supplied(10, 0, 42n, n.chainId)]);
    },
  });
  assert.deepEqual(
    visited.sort((a, b) => a - b),
    [1, 4663, 8453],
  );
  assert.deepEqual(progress(db), {
    "events:1": 29,
    "events:8453": 29,
    "events:4663": 29,
  });
  assert.equal(db.rows("SELECT * FROM events").length, 3);
  assert.ok(db.queries <= 80);
});

test("one network RPC failure does not block other networks or advance its checkpoint", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  await synchronize(env, 0, {
    rpc: (n) =>
      n.chainId === 8453
        ? {
            ...fakeRpc(),
            logs: async () => {
              throw new Error("RPC timeout");
            },
          }
        : fakeRpc(),
  });
  assert.deepEqual(progress(db), {
    "events:1": 29,
    "events:8453": 9,
    "events:4663": 29,
  });
});

test("invalid configuration on one chain does not disable configured chains", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  const config = JSON.parse(env.NETWORK_CONFIG!);
  config["8453"].startBlock = "invalid";
  env.NETWORK_CONFIG = JSON.stringify(config);
  await synchronize(env, 0, { rpc: () => fakeRpc() });
  assert.deepEqual(progress(db), { "events:1": 29, "events:4663": 29 });
});

test("backfill resumes and eventually catches up across multiple scheduled invocations", async () => {
  const db = new TestDatabase(),
    env = { ...environment(db), MAX_CHUNKS: "3" };
  const saved: number[] = [];
  for (let i = 0; i < 4; i++) {
    await synchronize(env, i * 3600000, { rpc: () => fakeRpc(31n) });
    saved.push(Number(progress(db)["events:8453"]));
  }
  assert.ok(saved[0]! < 29);
  assert.ok(saved[1]! > saved[0]!);
  assert.equal(saved.at(-1), 29);
  assert.ok(
    saved.every((value, index) => index === 0 || value >= saved[index - 1]!),
  );
});

test("range-limit errors shrink requests with bounded backoff and retain historical coverage", async () => {
  const db = new TestDatabase(),
    env = { ...environment(db), MAX_CHUNKS: "30", MAX_D1_QUERIES: "150" };
  const attempts: bigint[] = [],
    waits: number[] = [];
  await synchronize(env, 0, {
    sleep: async (ms) => {
      waits.push(ms);
    },
    rpc: () => ({
      ...fakeRpc(),
      logs: async (from, to) => {
        attempts.push(to - from + 1n);
        if (to - from + 1n > 2n)
          throw new Error("eth_getLogs block range limit exceeded");
        return [];
      },
    }),
  });
  assert.ok(
    attempts.includes(10n) && attempts.includes(5n) && attempts.includes(2n),
  );
  assert.ok(waits.length > 0 && waits.every((ms) => ms <= 1000));
  assert.equal(progress(db)["events:1"], 29);
});

test("execution deadline stops before committing an incomplete range, then resumes", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  let clock = 0;
  await synchronize(env, 0, {
    now: () => clock,
    rpc: () => ({
      ...fakeRpc(),
      logs: async () => {
        clock = 119000;
        return [];
      },
    }),
  });
  assert.deepEqual(progress(db), {
    "events:1": 9,
    "events:8453": 9,
    "events:4663": 9,
  });
  await synchronize(env, 0, { rpc: () => fakeRpc() });
  assert.equal(progress(db)["events:1"], 29);
});

test("maximum chunks, RPC requests and D1 queries bound invocation work", async () => {
  const db = new TestDatabase(),
    env = {
      ...environment(db),
      MAX_CHUNKS: "3",
      MAX_RPC_REQUESTS: "6",
      MAX_D1_QUERIES: "15",
    };
  let rpcCalls = 0;
  await synchronize(env, 0, {
    rpc: () => ({
      ...fakeRpc(100000n),
      head: async () => {
        rpcCalls++;
        return 100000n;
      },
      logs: async () => {
        rpcCalls++;
        return [];
      },
    }),
  });
  assert.equal(rpcCalls, 6);
  assert.equal(db.queries, 15);
  assert.deepEqual(progress(db), {
    "events:1": 19,
    "events:8453": 19,
    "events:4663": 19,
  });
});

test("rotation prevents starvation even when only one chunk is allowed per hour", async () => {
  const db = new TestDatabase(),
    env = { ...environment(db), MAX_CHUNKS: "1" };
  for (let i = 0; i < 3; i++)
    await synchronize(env, i * 3600000, { rpc: () => fakeRpc() });
  assert.ok(Object.values(progress(db)).every((last) => Number(last) > 9));
});

test("overlapping scheduled invocations preserve checkpoints and unique events", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  await Promise.all(
    [0, 1].map(() =>
      synchronize(env, 0, {
        rpc: (n) => fakeRpc(31n, [supplied(10, 0, 42n, n.chainId)]),
      }),
    ),
  );
  assert.deepEqual(progress(db), {
    "events:1": 29,
    "events:8453": 29,
    "events:4663": 29,
  });
  assert.equal(db.rows("SELECT * FROM events").length, 3);
});

test("inconsistent block hashes and malformed event data never advance checkpoints", async () => {
  for (const invalid of [
    { ...supplied(), blockHash: `0x${"f".repeat(64)}` },
    { ...supplied(), data: "0x" },
  ] as RpcLog[]) {
    const db = new TestDatabase(),
      env = environment(db);
    await synchronize(env, 0, {
      rpc: (n) => fakeRpc(31n, [{ ...invalid, address: n.address }]),
    });
    assert.ok(Object.values(progress(db)).every((last) => last === 9));
    assert.equal(db.rows("SELECT * FROM events").length, 0);
  }
});

test("dense ranges reduce timestamp fanout before issuing block RPCs", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  env.NETWORK_CONFIG = JSON.stringify(
    Object.fromEntries(
      supportedNetworks.map((n) => [
        n.chainId,
        { startBlock: 10, confirmations: 2, chunkSize: 100 },
      ]),
    ),
  );
  let blockCalls = 0;
  await synchronize(env, 0, {
    sleep: async () => {},
    rpc: (n) => ({
      ...fakeRpc(61n),
      logs: async (from, to) =>
        Array.from({ length: Number(to - from + 1n) }, (_, i) =>
          supplied(Number(from) + i, Number(from) + i, 1n, n.chainId),
        ),
      block: async (block) => {
        blockCalls++;
        return fakeRpc().block(block);
      },
    }),
  });
  assert.ok(blockCalls <= 180);
  assert.ok(Object.values(progress(db)).every((last) => Number(last) > 9));
});

test("first run snapshots each current head once and waits for confirmations", async () => {
  const db = new TestDatabase(),
    env = { ...environment(db), NETWORK_CONFIG: "{}" };
  let logCalls = 0;
  await synchronize(env, 0, {
    rpc: () => ({
      ...fakeRpc(100n),
      logs: async () => {
        logCalls++;
        return [];
      },
    }),
  });
  assert.equal(logCalls, 0);
  assert.deepEqual(progress(db), {
    "events:1": 99,
    "events:8453": 99,
    "events:4663": 99,
  });
  for (const saved of db.rows(
    "SELECT meta FROM state WHERE key LIKE 'events:%'",
  )) {
    assert.equal(JSON.parse(String(saved.meta)).startBlock, 100);
  }
  const ranges: bigint[] = [];
  await synchronize(env, 3600000, {
    rpc: () => ({
      ...fakeRpc(200n),
      logs: async (from) => {
        ranges.push(from);
        return [];
      },
    }),
  });
  assert.deepEqual(ranges, [100n, 100n, 100n]);
  assert.deepEqual(progress(db), {
    "events:1": 188,
    "events:8453": 136,
    "events:4663": 136,
  });
});

test("concurrent first runs retain the winning start block instead of resetting to a newer head", async () => {
  const db = new TestDatabase(),
    env = { ...environment(db), NETWORK_CONFIG: "{}" };
  await Promise.all(
    [100n, 110n].map((head) =>
      synchronize(env, 0, { rpc: () => fakeRpc(head) }),
    ),
  );
  for (const saved of db.rows(
    "SELECT meta FROM state WHERE key LIKE 'events:%'",
  )) {
    assert.equal(JSON.parse(String(saved.meta)).startBlock, 100);
  }
});

test("failed initial head retrieval does not persist a guessed start block", async () => {
  const db = new TestDatabase(),
    env = { ...environment(db), NETWORK_CONFIG: "{}" };
  await synchronize(env, 0, {
    rpc: () => ({
      ...fakeRpc(),
      head: async () => {
        throw new Error("Unavailable");
      },
    }),
  });
  assert.deepEqual(progress(db), {});
});
