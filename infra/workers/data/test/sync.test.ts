import { test } from "node:test";
import assert from "node:assert/strict";
import manifest from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import { scheduledNetwork, synchronize } from "../src/sync.ts";
import type { RpcLog } from "../src/events.ts";
import {
  TestDatabase,
  environment,
  fakeRpc,
  supplied,
  tickState,
} from "./helpers.ts";

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
  const env = environment();
  for (const n of supportedNetworks) {
    const configured = indexingNetwork(env, n);
    assert.equal(configured.address, manifest.address.toLowerCase());
    assert.equal(configured.startBlock, 10n);
    assert.equal(configured.rpcUrls.length, 2);
    assert.ok(configured.rpcUrls.every((url) => url.startsWith("https://")));
    assert.equal(
      indexingNetwork({ ...env, NETWORK_CONFIG: "{}" }, n).startBlock,
      undefined,
    );
    assert.deepEqual(
      indexingNetwork(
        {
          ...env,
          RPC_URLS: JSON.stringify({
            [n.chainId]: ["https://custom.test/secret"],
          }),
        },
        n,
      ).rpcUrls,
      ["https://custom.test/secret"],
    );
  }
});

test("one invocation selects one chain and round-robin order follows the manifest", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const visited: number[] = [];
  for (const [index, network] of supportedNetworks.entries()) {
    await synchronize(env, index * 60_000 + 1000, {
      rpc: (n) => {
        visited.push(n.chainId);
        return fakeRpc(31n, [supplied(10, 0, 42n, n.chainId)]);
      },
    });
    assert.equal(visited.length, index + 1);
    assert.equal(visited[index], network.chainId);
    assert.equal(Object.keys(progress(db)).length, index + 1);
    assert.equal(progress(db)[`events:${network.chainId}`], 29);
  }
  assert.equal(
    scheduledNetwork(supportedNetworks.length * 60_000),
    supportedNetworks[0],
  );
  assert.equal(
    db.rows("SELECT * FROM events").length,
    supportedNetworks.length,
  );
});

test("round-robin cadence follows the length of an expanded manifest", () => {
  const added = { ...supportedNetworks[0]!, chainId: 42_000 };
  const networks = [...supportedNetworks, added];
  for (let minute = 0; minute < 2 * networks.length; minute++) {
    assert.equal(
      scheduledNetwork(minute * 60_000 + 59_999, networks),
      networks[minute % networks.length],
    );
  }
});

test("one network RPC failure does not block later cron slots or advance its checkpoint", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  for (const minute of [0, 1, 2]) {
    await synchronize(env, minute * 60_000, {
      sleep: async () => {},
      rpc: (n) =>
        n.name === "base"
          ? {
              ...fakeRpc(),
              logs: async () => {
                throw new Error("RPC timeout");
              },
            }
          : fakeRpc(),
    });
  }
  assert.deepEqual(progress(db), {
    "events:1": 29,
    "events:8453": 9,
    "events:4663": 29,
  });
});

test("invalid configuration on one chain does not disable configured chains", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const config = JSON.parse(env.NETWORK_CONFIG!);
  config["8453"].startBlock = "invalid";
  env.NETWORK_CONFIG = JSON.stringify(config);
  for (const minute of [0, 1, 2])
    await synchronize(env, minute * 60_000, { rpc: () => fakeRpc() });
  assert.deepEqual(progress(db), { "events:1": 29, "events:4663": 29 });
});

test("a temporary TypeError retries the same uncommitted range and recovers", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const ranges: [bigint, bigint][] = [];
  const delays: number[] = [];
  const rpc = fakeRpc(31n, [supplied(10), supplied(19, 1), supplied(29, 2)]);
  await synchronize(env, 60_000, {
    sleep: async (ms) => {
      delays.push(ms);
    },
    rpc: (n) =>
      n.name === "base"
        ? {
            ...rpc,
            logs: async (from, to) => {
              ranges.push([from, to]);
              assert.equal(progress(db)["events:8453"], Number(from - 1n));
              if (ranges.length === 1)
                throw new TypeError("Network connection lost");
              return rpc.logs(from, to);
            },
          }
        : fakeRpc(),
  });
  assert.deepEqual(ranges, [
    [10n, 19n],
    [10n, 19n],
    [20n, 29n],
  ]);
  assert.deepEqual(delays, [150]);
  assert.equal(progress(db)["events:8453"], 29);
  assert.deepEqual(
    db
      .rows("SELECT block_number FROM events ORDER BY block_number")
      .map((row) => row.block_number),
    [10, 19, 29],
  );
});

test("smaller ranges survive failed cron runs and grow during catch-up without skipping blocks", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const config = JSON.parse(env.NETWORK_CONFIG!);
  config["8453"].chunkSize = 1000;
  env.NETWORK_CONFIG = JSON.stringify(config);

  let head = 12n;
  let unavailable = false;
  const requested: [bigint, bigint][] = [];
  const covered: [bigint, bigint][] = [];
  const run = (slot: number) =>
    synchronize(env, (1 + slot * supportedNetworks.length) * 60_000, {
      sleep: async () => {},
      rpc: (n) =>
        n.name === "base"
          ? {
              ...fakeRpc(head),
              logs: async (from, to) => {
                requested.push([from, to]);
                if (unavailable) throw new TypeError("Network unavailable");
                covered.push([from, to]);
                return [];
              },
            }
          : fakeRpc(),
    });

  await run(0);
  let previousSize = 1000n;
  for (let slot = 1; slot <= 6; slot++) {
    unavailable = true;
    head += 150n;
    requested.length = 0;
    await run(slot);
    assert.equal(progress(db)["events:8453"], 10);
    assert.ok(requested.every(([from]) => from === 11n));
    assert.ok(requested.length <= 3);
    const [from, to] = requested[0]!;
    if (slot > 1 && previousSize > 1n) assert.ok(to - from + 1n < previousSize);
    previousSize = to - from + 1n;
  }
  unavailable = false;
  head = 50_000n;
  requested.length = 0;
  for (
    let slot = 7;
    slot < 12 && progress(db)["events:8453"] !== 49_998;
    slot++
  )
    await run(slot);
  assert.equal(progress(db)["events:8453"], 49_998);
  assert.equal(covered[0]![0], 10n);
  assert.equal(covered.at(-1)![1], 49_998n);
  assert.ok(
    covered.every(([from], i) => i === 0 || from === covered[i - 1]![1] + 1n),
  );
  assert.ok(requested.length > 12);
  assert.ok(requested.some(([from, to]) => to - from + 1n === 1000n));
});

test("range-limit errors shrink requests immediately and retain historical coverage", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  const attempts: bigint[] = [],
    waits: number[] = [];
  await synchronize(env, 0, {
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
  assert.equal(progress(db)["events:1"], 29);
});

test("the round-robin execution deadline leaves an incomplete range for the next turn", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  let clock = 0;
  await synchronize(env, 0, {
    now: () => clock,
    rpc: () => ({
      ...fakeRpc(),
      logs: async () => {
        clock = supportedNetworks.length * 60_000;
        return [];
      },
    }),
  });
  assert.deepEqual(progress(db), { "events:1": 9 });
  await synchronize(env, supportedNetworks.length * 60_000, {
    rpc: () => fakeRpc(),
  });
  assert.equal(progress(db)["events:1"], 29);
});

test("other chains finish during a stalled Base lease, while another Base run yields", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  let reject!: (reason: Error) => void;
  const baseHead = new Promise<bigint>((_, fail) => {
    reject = fail;
  });
  const visited: string[] = [];
  const run = (scheduledTime: number) =>
    synchronize(env, scheduledTime, {
      rpc: (n) => {
        visited.push(n.name);
        return n.name === "base"
          ? { ...fakeRpc(), head: () => baseHead }
          : fakeRpc();
      },
    });
  const stalled = run(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await run(120_000);
  await run(180_000);
  await run(240_000);
  assert.deepEqual(visited, ["base", "robinhood", "ethereum"]);
  assert.deepEqual(progress(db), { "events:1": 29, "events:4663": 29 });
  assert.equal(
    db.rows("SELECT key FROM state WHERE key LIKE 'sync:lease:%'")[0]?.key,
    "sync:lease:8453",
  );
  reject(new TypeError("Network unavailable"));
  await stalled;
  assert.equal(
    db.rows("SELECT key FROM state WHERE key LIKE 'sync:lease:%'").length,
    0,
  );
});

test("overlapping runs for the same chain preserve checkpoints and unique events", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const heads: number[] = [];
  const run = () =>
    synchronize(env, 0, {
      rpc: (n) => {
        heads.push(n.chainId);
        return fakeRpc(31n, [supplied(10, 0, 42n, n.chainId)]);
      },
    });
  await Promise.all([run(), run()]);
  assert.deepEqual(heads, [1]);
  assert.deepEqual(progress(db), { "events:1": 29 });
  assert.equal(db.rows("SELECT * FROM events").length, 1);
});

test("a stale per-chain lease expires and indexing resumes automatically", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  db.sqlite
    .prepare("INSERT INTO state VALUES ('sync:lease:1', ?, ?)")
    .run(JSON.stringify("expired-owner"), 900_000);
  await synchronize(env, 180_000, { now: () => 180_000, rpc: () => fakeRpc() });
  assert.deepEqual(progress(db), {});
  await synchronize(env, 900_000, { now: () => 900_000, rpc: () => fakeRpc() });
  assert.deepEqual(progress(db), { "events:1": 29 });
  assert.equal(
    db.rows("SELECT key FROM state WHERE key LIKE 'sync:lease:%'").length,
    0,
  );
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
    assert.deepEqual(progress(db), { "events:1": 9 });
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
  for (let index = 0; index < supportedNetworks.length; index++)
    await synchronize(env, index * 60_000, {
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
  for (let index = 0; index < supportedNetworks.length; index++)
    await synchronize(env, (supportedNetworks.length + index) * 60_000, {
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

test("changed ticks are deduplicated at the confirmed end block and upserted without rescanning", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const id = (1n << 256n) - 1n;
  const supply = 1n << 250n;
  const reads: [bigint[], bigint][] = [];
  const ranges: [bigint, bigint][] = [];
  const run = (head: bigint, availableSupply: bigint, entries: RpcLog[]) =>
    synchronize(env, 60_000, {
      rpc: (n) => {
        if (n.chainId !== 8453) return fakeRpc(head);
        const rpc = fakeRpc(head, entries);
        return {
          ...rpc,
          logs: async (from, to) => {
            ranges.push([from, to]);
            return rpc.logs(from, to);
          },
          ticks: async (ids, block) => {
            reads.push([ids, block]);
            return ids.map(() => tickState(availableSupply));
          },
        };
      },
    });
  await run(21n, supply, [
    supplied(10, 0, 1n, 8453, id),
    supplied(11, 1, 1n, 8453, id),
  ]);
  assert.deepEqual(reads, [[[id], 19n]]);
  assert.equal(db.rows("SELECT count(*) AS n FROM events")[0]!.n, 2);
  const [row] = db.rows("SELECT * FROM ticks");
  assert.equal(row!.id, `8453:${id}`);
  assert.equal(row!.chain_id, 8453);
  assert.equal(row!.timestamp, 19 * 12);
  assert.deepEqual(
    JSON.parse(String(row!.meta)),
    JSON.parse(
      JSON.stringify(
        { ...tickState(supply), tickId: id, active: true },
        (_, value) => (typeof value === "bigint" ? value.toString() : value),
      ),
    ),
  );
  await run(24n, 0n, [
    supplied(18, 2, 1n, 8453, id),
    supplied(20, 3, 1n, 8453, id),
  ]);
  assert.deepEqual(ranges, [
    [10n, 19n],
    [20n, 22n],
  ]);
  assert.deepEqual(reads, [
    [[id], 19n],
    [[id], 22n],
  ]);
  const [updated] = db.rows("SELECT * FROM ticks");
  assert.equal(updated!.timestamp, 22 * 12);
  assert.equal(JSON.parse(String(updated!.meta)).availableSupply, "0");
  assert.equal(JSON.parse(String(updated!.meta)).active, false);
});

test("failed tick batches and failed D1 commits both preserve all data and retry the same blocks", async () => {
  const db = new TestDatabase();
  const env = environment(db);
  const ids = Array.from({ length: 65 }, (_, i) => BigInt(i + 1));
  const entries = ids.map((id, i) => supplied(10, i, 1n, 8453, id));
  let failRead = true;
  const reads: number[] = [];
  const run = () =>
    synchronize(env, 60_000, {
      rpc: (n) => ({
        ...fakeRpc(21n, n.chainId === 8453 ? entries : []),
        ticks: async (ids, block) => {
          assert.equal(block, 19n);
          reads.push(ids.length);
          if (failRead && ids[0] === 33n) throw new Error("multicall reverted");
          return ids.map(() => tickState());
        },
      }),
    });
  for (const failure of ["read", "write"]) {
    failRead = failure === "read";
    db.failBatchAt = failRead ? undefined : 2;
    await run();
    assert.equal(progress(db)["events:8453"], 9);
    assert.equal(db.rows("SELECT * FROM events").length, 0);
    assert.equal(db.rows("SELECT * FROM ticks").length, 0);
  }
  db.failBatchAt = undefined;
  await run();
  assert.deepEqual(reads, [32, 32, 1, 32, 32, 1, 32, 32, 1]);
  assert.equal(progress(db)["events:8453"], 19);
  assert.equal(db.rows("SELECT * FROM events").length, 65);
  assert.equal(db.rows("SELECT * FROM ticks").length, 65);
});
