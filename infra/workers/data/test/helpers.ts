import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { abi, type EventRow, type RpcLog } from "../src/events.ts";
import { supportedNetworks } from "../src/networks.ts";
import type { Env } from "../src/shared.ts";
import type { Rpc } from "../src/sync.ts";

// Execute the production SQL against real SQLite/JSON1. Only the D1 transport is adapted.
export class TestDatabase {
  sqlite = new DatabaseSync(":memory:");
  failBatchAt: number | undefined;
  queries = 0;
  constructor() {
    this.sqlite.exec(
      readFileSync(
        new NodeURL("../migrations/0001_init.sql", import.meta.url),
        "utf8",
      ),
    );
  }
  prepare(sql: string) {
    return new Statement(this, sql, []);
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map((stmt, i) => {
        if (i === this.failBatchAt)
          throw new Error("Injected database failure");
        return stmt.execute();
      });
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  get db() {
    return this as unknown as D1Database;
  }
  rows(sql: string) {
    return this.sqlite.prepare(sql).all();
  }
}

class Statement {
  database: TestDatabase;
  sql: string;
  bindings: SQLInputValue[];
  constructor(database: TestDatabase, sql: string, bindings: SQLInputValue[]) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...values: SQLInputValue[]) {
    return new Statement(this.database, this.sql, values);
  }
  execute() {
    assert.ok(this.bindings.length <= 100, "D1 parameter limit");
    assert.ok(this.sql.length <= 100000, "D1 SQL length limit");
    this.database.queries++;
    const results = this.database.sqlite
      .prepare(this.sql)
      .all(...this.bindings);
    const changes = this.database.sqlite.prepare("SELECT changes() AS n").get()!
      .n;
    return { results, success: true, meta: { changes } };
  }
  async all() {
    return this.execute();
  }
  async run() {
    return this.execute();
  }
  async first() {
    return this.execute().results[0] ?? null;
  }
}

export const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const C = "0xcccccccccccccccccccccccccccccccccccccccc";
export const hash = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}` as Hex;
export function supplied(
  block = 10,
  index = 0,
  amount = 10n,
  chainId = 8453,
): RpcLog {
  return {
    address: supportedNetworks.find((n) => n.chainId === chainId)!.address,
    topics: encodeEventTopics({
      abi,
      eventName: "Supplied",
      args: { tickId: 123n, supplier: A },
    }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }],
      [amount, B],
    ),
    blockNumber: BigInt(block),
    blockHash: hash(block),
    transactionHash: hash(index + 500),
    transactionIndex: 0,
    logIndex: index,
    removed: false,
  };
}
export function row(
  id: number,
  event_name = "Supplied",
  timestamp = 100,
  meta = {},
): EventRow {
  return {
    id: `8453:${hash(id)}:0`,
    chain_id: 8453,
    block_number: id,
    timestamp,
    event_name,
    meta: JSON.stringify({ tickId: "123", supplier: A, referrer: B, ...meta }),
  };
}
export function insertRow(db: TestDatabase, row: EventRow) {
  db.sqlite
    .prepare(
      "INSERT INTO events(id,chain_id,block_number,event_name,meta,timestamp) VALUES(?,?,?,?,?,?)",
    )
    .run(
      row.id,
      row.chain_id,
      row.block_number,
      row.event_name,
      row.meta,
      row.timestamp,
    );
}
export function environment(db = new TestDatabase()): Env {
  // These fixtures use synthetic 1970 block times; retention is exercised separately.
  return {
    DB: db.db,
    EVENT_RETENTION_MONTHS: "0",
    NETWORK_CONFIG: JSON.stringify(
      Object.fromEntries(
        supportedNetworks.map((n) => [
          n.chainId,
          { startBlock: 10, confirmations: 2, overlap: 2, chunkSize: 10 },
        ]),
      ),
    ),
  };
}
export function fakeRpc(head = 31n, entries: RpcLog[] = []): Rpc {
  return {
    head: async () => head,
    logs: async (from, to) =>
      entries.filter((e) => e.blockNumber! >= from && e.blockNumber! <= to),
    block: async (block) => ({
      timestamp: block * 12n,
      hash: hash(Number(block)),
    }),
  };
}
export function gecko(addresses = [A], extra: Record<string, unknown> = {}) {
  return {
    data: addresses.map((address) => ({
      id: `base_${address}`,
      type: "token",
      attributes: {
        address,
        name: "Example",
        symbol: "EX",
        image_url: "https://example.com/token.png",
        decimals: 18,
        coingecko_coin_id: "example",
        price_usd: "1.234567890123456789",
        total_supply: "1000000000000000000000.0",
        normalized_total_supply: "1000",
        fdv_usd: "1234.56",
        volume_usd: { h24: "123" },
        ...extra,
      },
      relationships: {
        top_pools: { data: [{ id: "base_pool", type: "pool" }] },
      },
    })),
  };
}
export function fetchJson(value: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}
