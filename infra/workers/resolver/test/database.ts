import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL as NodeURL } from "node:url";
import type { Tick } from "../src/ticks.ts";

export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["0001_init.sql", "0002_ticks.sql"])
    sqlite.exec(
      readFileSync(
        new NodeURL(`../../data/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const statement = sqlite.prepare(sql);
          return {
            all: async () => ({ results: statement.all(...values) }),
            first: async () => statement.get(...values) ?? null,
            run: async () => ({ meta: statement.run(...values) }),
          };
        },
      };
    },
  } as unknown as D1Database;
  const putTick = (
    chain: number,
    { id, ...state }: Tick,
    active = state.availableSupply > 0n,
    timestamp = 0,
  ) =>
    sqlite
      .prepare(
        "INSERT INTO ticks(id, chain_id, meta, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(
        `${chain}:${id}`,
        chain,
        JSON.stringify({ ...state, tickId: id, active }, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
        timestamp,
      );
  return { db, putTick, sqlite };
}
