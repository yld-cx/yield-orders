import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupEvents, retentionCutoff } from "../src/retention.ts";
import { checkpoint, persistChunk, synchronize } from "../src/sync.ts";
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import {
  TestDatabase,
  environment,
  fakeRpc,
  insertRow,
  row,
  supplied,
} from "./helpers.ts";

const nowMs = Date.parse("2026-10-20T12:34:56Z");
const nowSeconds = nowMs / 1000;
const cutoff = Date.parse("2026-08-20T12:34:56Z") / 1000;
const retainedEnvironment = (db: TestDatabase) => ({
  ...environment(db),
  EVENT_RETENTION_MONTHS: "2",
});
function seed(
  db: TestDatabase,
  chainId: number,
  id: number,
  timestamp: number,
  name = "Supplied",
) {
  const event = row(id, name, timestamp);
  insertRow(db, {
    ...event,
    chain_id: chainId,
    id: event.id.replace("8453:", `${chainId}:`),
  });
}

test("two calendar months use UTC and clamp month ends, leap years and year boundaries", () => {
  for (const [now, expected] of [
    ["2026-10-20T12:34:56Z", "2026-08-20T12:34:56Z"],
    ["2026-04-30T23:45:12Z", "2026-02-28T23:45:12Z"],
    ["2024-04-30T23:45:12Z", "2024-02-29T23:45:12Z"],
    ["2026-01-31T06:00:00Z", "2025-11-30T06:00:00Z"],
  ]) {
    assert.equal(
      retentionCutoff(Date.parse(now!) / 1000, 2),
      Date.parse(expected!) / 1000,
    );
  }
});

test("cleanup deletes by blockchain timestamp, retains exact cutoff, and isolates chains", async () => {
  const db = new TestDatabase();
  seed(db, 8453, 100, cutoff - 1, "PairCreated");
  seed(db, 8453, 1, cutoff);
  seed(db, 8453, 2, cutoff + 1, "TickCreated");
  seed(db, 1, 101, cutoff - 1);
  const deleted = await cleanupEvents(db.db, 8453, cutoff, 1000);
  assert.equal(deleted, 1);
  assert.deepEqual(
    db
      .rows("SELECT block_number FROM events ORDER BY block_number")
      .map((r) => r.block_number),
    [1, 2, 101],
  );
  const plan = db.sqlite
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM events
    WHERE chain_id = ? AND timestamp < ? ORDER BY timestamp ASC, id ASC LIMIT ?`,
    )
    .all(8453, cutoff, 1000);
  assert.ok(plan.some((r) => String(r.detail).includes("events_chain_time")));
});

test("bounded cleanup resumes over later batches without modifying token metadata or checkpoints", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  const n = indexingNetwork(
    env,
    supportedNetworks.find((n) => n.chainId === 8453)!,
  );
  const saved = await checkpoint(db.db, n, nowSeconds);
  db.sqlite
    .prepare("INSERT INTO tokens(id,meta,timestamp) VALUES(?,?,?)")
    .run("token", "{}", nowSeconds);
  for (let id = 1; id <= 5; id++) seed(db, 8453, id, cutoff - 1);
  assert.equal(await cleanupEvents(db.db, 8453, cutoff, 2), 2);
  assert.equal(await cleanupEvents(db.db, 8453, cutoff, 2), 2);
  assert.equal(await cleanupEvents(db.db, 8453, cutoff, 2), 1);
  assert.equal(await cleanupEvents(db.db, 8453, cutoff, 2), 0);
  assert.equal(db.rows("SELECT * FROM tokens").length, 1);
  assert.equal(
    db.rows("SELECT meta FROM state WHERE key='events:8453'")[0]!.meta,
    saved,
  );
});

test("atomic ingestion never restores expired events but still advances historical checkpoints", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  const n = indexingNetwork(
    env,
    supportedNetworks.find((n) => n.chainId === 8453)!,
  );
  const expected = await checkpoint(db.db, n, nowSeconds);
  const expired = row(10, "Supplied", cutoff - 1);
  const boundary = row(11, "Supplied", cutoff);
  seed(db, 8453, 10, cutoff - 1);
  await Promise.all([
    cleanupEvents(db.db, 8453, cutoff, 1000),
    persistChunk(
      db.db,
      8453,
      expected,
      10n,
      20n,
      [expired, boundary],
      nowSeconds,
      cutoff,
    ),
  ]);
  assert.deepEqual(
    db.rows("SELECT timestamp FROM events").map((r) => r.timestamp),
    [cutoff],
  );
  assert.equal(
    db.rows(
      "SELECT json_extract(meta, '$.lastBlock') AS n FROM state WHERE key='events:8453'",
    )[0]!.n,
    20,
  );
});

test("hourly job cleans all chains and filters expired RPC events while keeping the boundary", async () => {
  const db = new TestDatabase(),
    env = retainedEnvironment(db);
  for (const n of supportedNetworks) seed(db, n.chainId, 1, cutoff - 1);
  await synchronize(env, 0, {
    now: () => nowMs,
    rpc: (n) => ({
      ...fakeRpc(31n, [
        supplied(10, 10, 1n, n.chainId),
        supplied(11, 11, 1n, n.chainId),
      ]),
      block: async (block) => ({
        ...(await fakeRpc().block(block)),
        timestamp: BigInt(block === 10n ? cutoff - 1 : cutoff),
      }),
    }),
  });
  const events = db.rows(
    "SELECT chain_id, timestamp FROM events ORDER BY chain_id",
  );
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.timestamp === cutoff));
  assert.ok(
    db
      .rows("SELECT json_extract(meta,'$.lastBlock') AS n FROM state")
      .every((r) => r.n === 29),
  );
});

test("cleanup continues during RPC failures without moving sync checkpoints", async () => {
  const db = new TestDatabase(),
    env = retainedEnvironment(db);
  for (const n of supportedNetworks) {
    await checkpoint(db.db, indexingNetwork(env, n), nowSeconds);
    seed(db, n.chainId, 1, cutoff - 1);
  }
  const saved = db.rows("SELECT * FROM state");
  await synchronize(env, 0, {
    now: () => nowMs,
    rpc: () => ({
      ...fakeRpc(),
      head: async () => {
        throw new Error("RPC unavailable");
      },
    }),
  });
  assert.equal(db.rows("SELECT * FROM events").length, 0);
  assert.deepEqual(db.rows("SELECT * FROM state"), saved);
});

test("cleanup query limits reserve indexing capacity and cap deleted rows per invocation", async () => {
  const db = new TestDatabase(),
    env = {
      ...retainedEnvironment(db),
      CLEANUP_BATCH_SIZE: "2",
      MAX_CLEANUP_BATCHES: "2",
      MAX_D1_QUERIES: "20",
      MAX_CHUNKS: "3",
    };
  for (const n of supportedNetworks)
    for (let id = 1; id <= 3; id++) seed(db, n.chainId, id, cutoff - 1);
  await synchronize(env, 0, { now: () => nowMs, rpc: () => fakeRpc() });
  assert.equal(db.rows("SELECT * FROM events").length, 5);
  assert.equal(db.queries, 17); // Two cleanup statements + six checkpoint statements + three atomic chunks.
  assert.ok(
    db
      .rows("SELECT json_extract(meta,'$.lastBlock') AS n FROM state")
      .every((r) => r.n === 19),
  );
});

test("unused cleanup slots go to chains with remaining expired events", async () => {
  const db = new TestDatabase(),
    env = {
      ...retainedEnvironment(db),
      CLEANUP_BATCH_SIZE: "2",
      MAX_CLEANUP_BATCHES: "6",
    };
  for (let id = 1; id <= 7; id++) seed(db, 8453, id, cutoff - 1);
  await synchronize(env, 0, { now: () => nowMs, rpc: () => fakeRpc() });
  assert.equal(db.rows("SELECT * FROM events").length, 0);
});

test("small D1 budget prioritizes indexing over cleanup", async () => {
  const db = new TestDatabase(),
    env = { ...retainedEnvironment(db), MAX_D1_QUERIES: "15", MAX_CHUNKS: "3" };
  seed(db, 8453, 1, cutoff - 1);
  await synchronize(env, 0, { now: () => nowMs, rpc: () => fakeRpc() });
  assert.equal(db.rows("SELECT * FROM events").length, 1);
  assert.equal(db.queries, 15);
});

test("cleanup failures on one chain do not block other cleanup or indexing", async () => {
  const db = new TestDatabase(),
    env = retainedEnvironment(db);
  for (const n of supportedNetworks) seed(db, n.chainId, 1, cutoff - 1);
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("DELETE FROM events WHERE id IN")) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        if (values[0] === 1)
          bound.run = async () => {
            throw new Error("Cleanup unavailable");
          };
        return bound;
      };
    }
    return statement;
  };
  await synchronize(env, 0, { now: () => nowMs, rpc: () => fakeRpc() });
  assert.deepEqual(
    db.rows("SELECT chain_id FROM events").map((r) => r.chain_id),
    [1],
  );
  assert.ok(
    db
      .rows("SELECT json_extract(meta,'$.lastBlock') AS n FROM state")
      .every((r) => r.n === 29),
  );
});

test("cleanup stops admitting work when the execution deadline is exhausted", async () => {
  const db = new TestDatabase(),
    env = retainedEnvironment(db);
  for (const n of supportedNetworks) seed(db, n.chainId, 1, cutoff - 1);
  let clock = nowMs,
    rpcCalls = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("DELETE FROM events WHERE id IN")) {
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values),
          run = bound.run.bind(bound);
        bound.run = async () => {
          const result = await run();
          clock += 119000;
          return result;
        };
        return bound;
      };
    }
    return statement;
  };
  await synchronize(env, 0, {
    now: () => clock,
    rpc: () => {
      rpcCalls++;
      return fakeRpc();
    },
  });
  assert.equal(db.queries, 1);
  assert.equal(rpcCalls, 0);
  assert.equal(db.rows("SELECT * FROM events").length, 2);
});
