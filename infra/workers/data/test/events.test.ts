import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiParameter,
  type Hex,
} from "viem";
import {
  affectedTick,
  decodeLog,
  eventAbi,
  eventNames,
  eventQuery,
  getEvents,
} from "../src/events.ts";
import { indexingNetwork, supportedNetworks } from "../src/networks.ts";
import { checkpoint, lastBlock, persistChunk } from "../src/sync.ts";
import worker from "../src/index.ts";
import {
  A,
  B,
  TestDatabase,
  environment,
  hash,
  insertRow,
  row,
  supplied,
} from "./helpers.ts";

test("ABI is authoritative and contains every expected emitted event", () => {
  for (const name of [
    "PairCreated",
    "TickCreated",
    "Supplied",
    "Withdrawn",
    "Collected",
    "UseOpened",
    "TermRepaid",
    "TermClosed",
    "ImmediateSwap",
    "DomainScaleChanged",
    "DomainGenerationFinalized",
    "ProtocolFeesCollected",
  ]) {
    assert.ok(eventNames.includes(name), name);
  }
});

test("decode ABI arguments, preserve bigint precision, addresses and blockchain timestamps", () => {
  const amount = 2n ** 200n;
  const result = decodeLog(8453, supplied(10, 0, amount), 1792252800n)!;
  assert.equal(result.id, `8453:${hash(500)}:0`);
  assert.equal(result.timestamp, 1792252800);
  assert.deepEqual(JSON.parse(result.meta), {
    tickId: "123",
    supplier: A,
    assetAmount: amount.toString(),
    referrer: B,
    transactionHash: hash(500),
    blockHash: hash(10),
    logIndex: 0,
    transactionIndex: 0,
  });
  assert.throws(() => decodeLog(8453, { ...supplied(), data: "0x" }, 100n));
  assert.equal(
    decodeLog(8453, { ...supplied(), topics: [hash(10000)] }, 100n),
    null,
  );
});

test("multiple event names, allowlisted JSON properties, timestamp and block ranges", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  insertRow(db, row(1));
  insertRow(db, row(2, "UseOpened"));
  insertRow(db, row(3, "Withdrawn"));
  insertRow(db, row(4, "Supplied", 500, { tickId: "456" }));
  const params = new URLSearchParams({
    chainId: "8453",
    eventNames: "Supplied,UseOpened",
    tickId: "123",
    supplier: A,
    referrer: B.toUpperCase().replace("0X", "0x"),
    from: "99",
    to: "101",
    fromBlock: "1",
    toBlock: "3",
  });
  const result = await getEvents(params, env);
  assert.deepEqual(
    result.events.map((r) => r.block_number),
    [2, 1],
  );
  for (const key of ["positionId", "pairId", "user", "taker"]) {
    const value = ["user", "taker"].includes(key) ? A : "123";
    assert.ok(
      eventQuery(
        new URLSearchParams({ chainId: "8453", [key]: value }),
      ).sql.includes(`$.${key}`),
    );
  }
});

test("cursor pagination is deterministic with timestamp ties, bounded and scoped to filters", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  for (let i = 1; i <= 5; i++) insertRow(db, row(i));
  const params = new URLSearchParams({ chainId: "8453", limit: "2" });
  const first = await getEvents(params, env);
  assert.deepEqual(
    first.events.map((r) => r.block_number),
    [5, 4],
  );
  assert.ok(first.nextCursor);
  params.set("cursor", first.nextCursor!);
  const second = await getEvents(params, env);
  assert.deepEqual(
    second.events.map((r) => r.block_number),
    [3, 2],
  );
  params.set("cursor", second.nextCursor!);
  const third = await getEvents(params, env);
  assert.deepEqual(
    third.events.map((r) => r.block_number),
    [1],
  );
  assert.equal(third.nextCursor, null);
  params.set("tickId", "123");
  await assert.rejects(getEvents(params, env), /cursor/);
});

test("query validation rejects SQL injection, unknown filters, malformed cursors and ranges", () => {
  for (const query of [
    "chainId=8453&sql=SELECT",
    "chainId=8453&eventNames=Supplied%27",
    "chainId=8453&tickId=1%20OR%201=1",
    "chainId=8453&supplier=bad",
    "chainId=8453&limit=101",
    "chainId=8453&limit=0",
    "chainId=8453&cursor=invalid",
    "chainId=8453&from=20&to=10",
    "chainId=8453&fromBlock=5&toBlock=1",
    "chainId=8453&from=-1",
    "chainId=8453&tickId=0&tickId=1",
    "",
    "chainId=1e0",
  ])
    assert.throws(() => eventQuery(new URLSearchParams(query)), query);
});

test("each required protocol log resolves the named tickId, regardless of indexed argument order", () => {
  const id = (1n << 256n) - 1n;
  const changes = new Set([
    "TickCreated",
    "Supplied",
    "Withdrawn",
    "UseOpened",
    "TermRepaid",
    "TermClosed",
    "ImmediateSwap",
  ]);
  const value = ({ name, type }: AbiParameter) =>
    name === "tickId"
      ? id
      : type === "address"
        ? A
        : ["uint8", "int32"].includes(type)
          ? 0
          : 7n;
  for (const event of eventAbi.filter(
    ({ name }) => changes.has(name) || name === "Collected",
  )) {
    const indexed = event.inputs.filter((input) => input.indexed);
    const data = event.inputs.filter((input) => !input.indexed);
    const entry = {
      ...supplied(),
      topics: encodeEventTopics({
        abi: [event],
        eventName: event.name,
        args: Object.fromEntries(
          indexed.map((input) => [input.name, value(input)]),
        ),
      }) as Hex[],
      data: encodeAbiParameters(data, data.map(value)),
    };
    const decoded = decodeLog(8453, entry, 120n)!;
    assert.equal(
      affectedTick(decoded),
      changes.has(event.name) ? id : undefined,
      event.name,
    );
  }
});

test("empty ranges advance the checkpoint without discarding prior events", async () => {
  const db = new TestDatabase();
  const n = indexingNetwork(
    environment(db),
    supportedNetworks.find((n) => n.chainId === 8453)!,
  );
  const initial = await checkpoint(db.db, n, 100);
  const event = decodeLog(8453, supplied(), 120n)!;
  const saved = (await persistChunk(db.db, 8453, initial, 20n, [event], 100))!;
  const next = (await persistChunk(db.db, 8453, saved, 21n, [], 101))!;
  assert.equal(lastBlock(next), 21n);
  assert.equal(db.rows("SELECT id FROM events")[0]!.id, event.id);
});

test("superseded revisions cannot write events or tick rows", async () => {
  const db = new TestDatabase();
  const n = indexingNetwork(
    environment(db),
    supportedNetworks.find((n) => n.chainId === 8453)!,
  );
  const old = await checkpoint(db.db, n, 100);
  const canonical = decodeLog(8453, supplied(), 120n)!;
  const competing = decodeLog(8453, supplied(10, 1), 120n)!;
  const tick = {
    id: "8453:123",
    chain_id: 8453,
    timestamp: 120,
    meta: '{"active":true}',
  };
  const next = await persistChunk(db.db, 8453, old, 30n, [canonical], 100, 0, [
    tick,
  ]);
  assert.equal(
    await persistChunk(db.db, 8453, old, 15n, [competing], 101, 0, [
      { ...tick, meta: '{"active":false}' },
    ]),
    null,
  );
  assert.deepEqual(
    db.rows("SELECT id FROM events").map((row) => row.id),
    [canonical.id],
  );
  assert.equal(db.rows("SELECT meta FROM ticks")[0]!.meta, tick.meta);
  assert.equal(
    db.rows("SELECT meta FROM state WHERE key='events:8453'")[0]!.meta,
    next,
  );
});

test("HTTP routing handles CORS, invalid inputs, methods and database failures", async () => {
  const env = environment();
  const request = (path: string, init?: RequestInit) =>
    new Request(`https://data.test${path}`, init);
  let response = await worker.fetch(
    request("/events?chainId=8453", { headers: { origin: "https://yld.cx" } }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "https://yld.cx",
  );
  assert.equal(
    (
      await worker.fetch(
        request("/events", { headers: { origin: "https://evil.test" } }),
        env,
      )
    ).status,
    403,
  );
  assert.equal((await worker.fetch(request("/events"), env)).status, 400);
  assert.equal(
    (await worker.fetch(request("/events", { method: "POST" }), env)).status,
    405,
  );
  assert.equal(
    (await worker.fetch(request("/events", { method: "OPTIONS" }), env)).status,
    204,
  );
  assert.equal((await worker.fetch(request("/sql"), env)).status, 404);
  const broken = {
    ...env,
    DB: {
      prepare() {
        throw new Error("secret");
      },
    } as unknown as D1Database,
  };
  response = await worker.fetch(request("/events?chainId=8453"), broken);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret"));
});
