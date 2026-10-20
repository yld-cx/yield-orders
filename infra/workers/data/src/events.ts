import rawAbi from "@yld-cx/ethereum-protocol" with { type: "json" };
import {
  decodeEventLog,
  toEventSelector,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import {
  address,
  HttpError,
  integer,
  json,
  validateParams,
  type Env,
} from "./shared.ts";
import { networkFor } from "./networks.ts";

export const abi = rawAbi as Abi;
export const eventAbi = abi.filter(
  (item): item is AbiEvent => item.type === "event",
);
export const eventNames = eventAbi.map((item) => item.name);
const selectors = new Set(eventAbi.map((item) => toEventSelector(item)));

export interface RpcLog {
  address: string;
  data: Hex;
  topics: Hex[];
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  transactionIndex: number | null;
  logIndex: number | null;
  removed: boolean;
}

export interface EventRow {
  id: string;
  chain_id: number;
  block_number: number;
  event_name: string;
  meta: string;
  timestamp: number;
}

export function decodeLog(
  chainId: number,
  entry: RpcLog,
  timestamp: bigint,
): EventRow | null {
  if (!entry.topics[0] || !selectors.has(entry.topics[0])) return null;
  if (
    entry.removed ||
    entry.blockNumber === null ||
    !entry.blockHash ||
    !entry.transactionHash ||
    entry.logIndex === null
  ) {
    throw new Error("Incomplete canonical log");
  }
  const decoded = decodeEventLog({
    abi,
    data: entry.data,
    topics: entry.topics as [Hex, ...Hex[]],
    strict: true,
  });
  if (!decoded.eventName) throw new Error("Missing event name");
  return {
    id: `${chainId}:${entry.transactionHash.toLowerCase()}:${entry.logIndex}`,
    chain_id: chainId,
    block_number: integer(entry.blockNumber.toString(), "blockNumber"),
    event_name: decoded.eventName,
    meta: json({
      ...decoded.args,
      transactionHash: entry.transactionHash.toLowerCase(),
      blockHash: entry.blockHash.toLowerCase(),
      logIndex: entry.logIndex,
      transactionIndex: entry.transactionIndex,
    }),
    timestamp: integer(timestamp.toString(), "block timestamp"),
  };
}

const filters = {
  tickId: "$.tickId",
  positionId: "$.positionId",
  pairId: "$.pairId",
  supplier: "$.supplier",
  user: "$.user",
  taker: "$.taker",
  referrer: "$.referrer",
} as const;
const addressFilters = new Set(["supplier", "user", "taker", "referrer"]);

export function eventQuery(params: URLSearchParams) {
  validateParams(params, [
    "chainId",
    "eventNames",
    "from",
    "to",
    "fromBlock",
    "toBlock",
    "limit",
    "cursor",
    ...Object.keys(filters),
  ]);
  const network = networkFor(params.get("chainId"));
  const where = ["chain_id = ?"];
  const bindings: (string | number)[] = [network.chainId];
  const names = params.get("eventNames");
  if (names !== null) {
    const values = [...new Set(names.split(","))];
    if (
      values.length > eventNames.length ||
      values.some((v) => !eventNames.includes(v))
    )
      throw new HttpError(400, "Invalid eventNames");
    where.push(`event_name IN (${values.map(() => "?").join(",")})`);
    bindings.push(...values);
  }
  for (const [lower, upper, column] of [
    ["from", "to", "timestamp"],
    ["fromBlock", "toBlock", "block_number"],
  ] as const) {
    const a = params.has(lower)
      ? integer(params.get(lower)!, lower)
      : undefined;
    const b = params.has(upper)
      ? integer(params.get(upper)!, upper)
      : undefined;
    if (a !== undefined && b !== undefined && a > b)
      throw new HttpError(400, `Invalid ${lower}/${upper} range`);
    if (a !== undefined) {
      where.push(`${column} >= ?`);
      bindings.push(a);
    }
    if (b !== undefined) {
      where.push(`${column} <= ?`);
      bindings.push(b);
    }
  }
  for (const [key, path] of Object.entries(filters)) {
    const value = params.get(key);
    if (value === null) continue;
    let normalized: string;
    if (addressFilters.has(key)) normalized = address(value);
    else {
      if (!/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n)
        throw new HttpError(400, `Invalid ${key}`);
      normalized = value;
    }
    where.push(`json_extract(meta, '${path}') = ?`);
    bindings.push(normalized);
  }
  // Cursor is bound to all filters (except limit), so it cannot silently paginate a different query.
  const scope = JSON.stringify(
    [...params]
      .filter(([key]) => key !== "cursor" && key !== "limit")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const cursor = params.get("cursor");
  if (cursor !== null) {
    try {
      if (cursor.length > 4096) throw new Error();
      const c = JSON.parse(atob(cursor)) as {
        t: number;
        id: string;
        scope: string;
      };
      if (
        c.scope !== scope ||
        !Number.isSafeInteger(c.t) ||
        c.t < 0 ||
        !new RegExp(`^${network.chainId}:0x[0-9a-f]{64}:[0-9]+$`).test(c.id)
      )
        throw new Error();
      where.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
      bindings.push(c.t, c.t, c.id);
    } catch {
      throw new HttpError(400, "Invalid cursor for these filters");
    }
  }
  const limit = params.has("limit")
    ? integer(params.get("limit")!, "limit", 1, 100)
    : 50;
  bindings.push(limit + 1);
  return {
    sql: `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY timestamp DESC, id DESC LIMIT ?`,
    bindings,
    limit,
    scope,
  };
}

export async function getEvents(params: URLSearchParams, env: Env) {
  const q = eventQuery(params);
  const result = await env.DB.prepare(q.sql)
    .bind(...q.bindings)
    .all<EventRow>();
  const rows = result.results.slice(0, q.limit);
  const last = rows.at(-1);
  return {
    events: rows.map((row) => ({
      ...row,
      meta: JSON.parse(row.meta) as unknown,
    })),
    nextCursor:
      result.results.length > q.limit && last
        ? btoa(
            JSON.stringify({ t: last.timestamp, id: last.id, scope: q.scope }),
          )
        : null,
  };
}
