import {
  createPublicClient,
  fallback,
  http,
  HttpRequestError,
  ResponseBodyTooLargeError,
} from "viem";
import { createRpcFallbackTransport, rpcErrorDetails } from "../../rpc.ts";
import {
  abi,
  affectedTick,
  decodeLog,
  isTickLog,
  type EventRow,
  type RpcLog,
} from "./events.ts";
import {
  indexingNetwork,
  supportedNetworks,
  type Network,
  type SupportedNetwork,
} from "./networks.ts";
import { errorKind, integer, json, log, setting, type Env } from "./shared.ts";
import { cleanupEvents, retentionCutoff } from "./retention.ts";

const CRON_INTERVAL_MS = 60_000;
const CRON_LIMIT_MS = 15 * CRON_INTERVAL_MS;
const FREE_SUBREQUESTS = 50;
const MAX_EVENTS = 256;
const MAX_EVENT_BLOCKS = 24;
const TICK_BATCH_SIZE = 32;
class CapacityError extends Error {
  constructor() {
    super("Chunk capacity exceeded");
    this.name = "CapacityError";
  }
}

export interface Rpc {
  head(): Promise<bigint>;
  logs(from: bigint, to: bigint): Promise<RpcLog[]>;
  ticks(ids: bigint[], blockNumber: bigint): Promise<TickState[]>;
  block(number: bigint): Promise<{ timestamp: bigint; hash: string | null }>;
}

interface TickState {
  availableSupply: bigint;
}

interface TickRow {
  id: string;
  chain_id: number;
  meta: string;
  timestamp: number;
}

export function rpcFor(
  n: Network,
  options: {
    signal?: AbortSignal;
    beforeRequest?: () => void;
    onFailure?: (method: string, hostname: string, error: unknown) => void;
  } = {},
): Rpc {
  const client = createPublicClient({
    chain: n.chain,
    transport: createRpcFallbackTransport({ http, fallback }, n.rpcUrls, {
      ...options,
      noRetryMethods: ["eth_getLogs"],
    }),
  });
  return {
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    logs: (fromBlock, toBlock) =>
      client.getLogs({ address: n.address, fromBlock, toBlock }),
    block: (number) => client.getBlock({ blockNumber: number }),
    ticks: async (ids, blockNumber) =>
      (await client.multicall({
        blockNumber,
        allowFailure: false,
        batchSize: 0,
        contracts: ids.map((id) => ({
          address: n.address,
          abi,
          functionName: "getTick" as const,
          args: [id] as const,
        })),
      })) as TickState[],
  };
}

export async function checkpoint(
  db: D1Database,
  n: Network,
  now: number,
  head?: bigint,
): Promise<string> {
  const start = n.startBlock ?? head;
  if (start === undefined)
    throw new Error("A first-run chain head is required without startBlock");
  const initial = json({
    lastBlock: Number(start - 1n),
    startBlock: Number(start),
    revision: crypto.randomUUID(),
  });
  await db
    .prepare(
      "INSERT OR IGNORE INTO state(key, meta, timestamp) VALUES (?, ?, ?)",
    )
    .bind(`events:${n.chainId}`, initial, now)
    .run();
  const row = await db
    .prepare("SELECT meta FROM state WHERE key = ?")
    .bind(`events:${n.chainId}`)
    .first<{ meta: string }>();
  if (!row) throw new Error("Missing checkpoint");
  const saved = JSON.parse(row.meta) as {
    lastBlock: number;
    startBlock?: number;
  };
  const lower =
    saved.startBlock ?? (n.startBlock === undefined ? 0 : Number(n.startBlock));
  if (
    !Number.isSafeInteger(lower) ||
    lower < 0 ||
    !Number.isSafeInteger(saved.lastBlock) ||
    saved.lastBlock < lower - 1 ||
    (n.startBlock !== undefined && saved.lastBlock < Number(n.startBlock - 1n))
  )
    throw new Error("Invalid checkpoint/startBlock");
  return row.meta;
}

export function lastBlock(meta: string): bigint {
  return BigInt((JSON.parse(meta) as { lastBlock: number }).lastBlock);
}

// All statements execute in one D1 transaction. Each mutation is conditional
// on the same revision. A superseded invocation becomes an entirely harmless no-op.
export async function persistChunk(
  db: D1Database,
  chainId: number,
  expected: string,
  to: bigint,
  events: EventRow[],
  now: number,
  cutoff = 0,
  ticks: TickRow[] = [],
  chunkSize?: number,
): Promise<string | null> {
  if (to <= lastBlock(expected))
    throw new Error("Invalid checkpoint advancement");
  const next = json({
    ...JSON.parse(expected),
    ...(chunkSize === undefined ? {} : { chunkSize }),
    lastBlock: Number(to),
    revision: crypto.randomUUID(),
  });
  const key = `events:${chainId}`;
  const guard = "EXISTS (SELECT 1 FROM state WHERE key = ? AND meta = ?)";
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO events(id, chain_id, block_number, event_name, meta, timestamp)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.chain_id'), json_extract(value, '$.block_number'),
        json_extract(value, '$.event_name'), json_extract(value, '$.meta'), json_extract(value, '$.timestamp')
      FROM json_each(?) WHERE json_extract(value, '$.timestamp') >= ? AND ${guard}`,
      )
      .bind(JSON.stringify(events), cutoff, key, expected),
    db
      .prepare(
        `INSERT INTO ticks(id, chain_id, meta, timestamp)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.chain_id'),
        json_extract(value, '$.meta'), json_extract(value, '$.timestamp')
      FROM json_each(?) WHERE ${guard}
      ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, timestamp = excluded.timestamp`,
      )
      .bind(JSON.stringify(ticks), key, expected),
    db
      .prepare(
        "UPDATE state SET meta = ?, timestamp = ? WHERE key = ? AND meta = ?",
      )
      .bind(next, now, key, expected),
  ]);
  if (results.length !== 3 || results.some((result) => !result.success))
    throw new Error("Chunk write failed");
  return results[2]?.meta.changes === 1 ? next : null;
}

function rangeError(error: unknown): boolean {
  for (
    let depth = 0;
    error instanceof Error && depth < 5;
    depth++, error = error.cause
  ) {
    if (
      error instanceof CapacityError ||
      error instanceof ResponseBodyTooLargeError ||
      (error instanceof HttpRequestError && error.status === 413) ||
      /block range|range limit|too many (blocks|logs|results)|response (size|too large)|query returned more than/i.test(
        error.message,
      )
    )
      return true;
  }
  return false;
}

export interface SyncDependencies {
  now?: () => number;
  rpc?: (n: Network) => Rpc;
  sleep?: (ms: number) => Promise<void>;
}

// Drain every fallback attempt before starting another batch.
async function readAll<T, R>(
  items: T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  return (await Promise.allSettled(items.map(read))).map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

async function syncNetwork(
  env: Env,
  base: SupportedNetwork,
  options: {
    now: () => number;
    started: number;
    deadline: number;
    signal: AbortSignal;
    cutoff?: number;
    dependencies: SyncDependencies;
  },
) {
  const { now, started, deadline, signal, cutoff, dependencies } = options;
  const withinWindow = () => !signal.aborted && now() < deadline;
  // Reserve two lease calls, two checkpoint calls, a retry hint and optional cleanup.
  let remaining = FREE_SUBREQUESTS - (cutoff === undefined ? 5 : 6);
  // Keep one D1 batch available while reading the current chunk.
  const canRead = () => withinWindow() && remaining > 1;
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const network = { network: base.name, chainId: base.chainId };
  let endpointFailures = 0;
  let phase = "configuration";
  let method: string | undefined;
  let initial: bigint | undefined;
  let current: bigint | undefined;
  let target: bigint | undefined;
  let range:
    { fromBlock: bigint; toBlock: bigint; chunkSize: number } | undefined;
  let attempt = 1;
  let chunks = 0;
  let events = 0;
  let retries = 0;
  let status = "failed";
  let savedSize: number | undefined;
  let size: number | undefined;
  let meta: string | undefined;
  const lag = () =>
    target !== undefined && current !== undefined
      ? target > current
        ? target - current
        : 0n
      : undefined;
  const progress = () => ({
    ...range,
    attempt,
    checkpoint: current,
    lagBlocks: lag(),
  });

  try {
    const n = indexingNetwork(env, base);
    const rpc =
      dependencies.rpc?.(n) ??
      rpcFor(n, {
        signal,
        beforeRequest: () => {
          if (!canRead())
            throw new DOMException(
              "Synchronization budget exhausted",
              "AbortError",
            );
          remaining--;
        },
        onFailure: (method, hostname, error) => {
          if (++endpointFailures <= 20)
            log({
              type: "sync_rpc_endpoint_error",
              ...network,
              method,
              hostname,
              ...progress(),
              ...rpcErrorDetails(error),
            });
        },
      });
    phase = "head";
    method = "eth_blockNumber";
    const head = await rpc.head();
    integer(head.toString(), "RPC head");
    phase = "checkpoint";
    method = undefined;
    meta = await checkpoint(env.DB, n, Math.floor(now() / 1000), head);
    current = initial = lastBlock(meta);
    target = head - BigInt(n.confirmations);
    const saved = JSON.parse(meta) as {
      startBlock?: number;
      chunkSize?: number;
    };
    const startBlock =
      saved.startBlock === undefined
        ? (n.startBlock ?? 0n)
        : BigInt(saved.startBlock);
    savedSize =
      saved.chunkSize !== undefined &&
      Number.isSafeInteger(saved.chunkSize) &&
      saved.chunkSize > 0
        ? Math.min(n.chunkSize, saved.chunkSize)
        : n.chunkSize;
    size = savedSize;
    log({
      type: "sync_start",
      ...network,
      checkpoint: current,
      safeBlock: target,
      startBlock,
      chunkSize: size,
      lagBlocks: lag(),
    });
    if (target < startBlock) {
      status = "waiting_for_confirmations";
      return;
    }
    if (current > target) {
      status = "waiting_for_safe_head";
      return;
    }

    let fullChunks = 0;
    let transientFailures = 0;
    status = "budget";
    while (
      meta !== undefined &&
      size !== undefined &&
      current !== undefined &&
      current < target &&
      canRead()
    ) {
      const from: bigint = current + 1n;
      const end: bigint = from + BigInt(size) - 1n;
      const to: bigint = end < target ? end : target;
      const length: number = Number(to - from + 1n);
      range = { fromBlock: from, toBlock: to, chunkSize: length };
      phase = "logs";
      method = "eth_getLogs";

      try {
        const entries = await rpc.logs(from, to);
        if (length > 1 && entries.length > MAX_EVENTS)
          throw new CapacityError();
        const blockNumbers = new Set<bigint>();
        for (const { blockNumber } of entries) {
          if (blockNumber === null || blockNumber < from || blockNumber > to)
            throw new Error("Unexpected RPC log block");
          blockNumbers.add(blockNumber);
        }
        if (blockNumbers.size > MAX_EVENT_BLOCKS) throw new CapacityError();
        if (entries.some(isTickLog)) blockNumbers.add(to);
        phase = "block_timestamps";
        method = "eth_getBlockByNumber";
        const blocks = new Map(
          await readAll(
            [...blockNumbers],
            async (number) => [number, await rpc.block(number)] as const,
          ),
        );
        const rows: EventRow[] = [];
        const affected = new Set<bigint>();
        phase = "decode";
        method = undefined;
        for (const entry of entries) {
          const block = blocks.get(entry.blockNumber!)!;
          if (
            entry.removed ||
            entry.address.toLowerCase() !== n.address ||
            entry.blockHash !== block.hash
          )
            throw new Error("Inconsistent RPC log/block");
          const event = decodeLog(n.chainId, entry, block.timestamp);
          if (!event) continue;
          const tickId = affectedTick(event);
          if (tickId !== undefined) affected.add(tickId);
          if (cutoff === undefined || event.timestamp >= cutoff)
            rows.push(event);
        }

        const tickRows: TickRow[] = [];
        if (affected.size) {
          phase = "ticks";
          method = "eth_call";
          const timestamp = integer(
            blocks.get(to)!.timestamp.toString(),
            "block timestamp",
          );
          const ids = [...affected];
          const batches: bigint[][] = [];
          for (let i = 0; i < ids.length; i += TICK_BATCH_SIZE)
            batches.push(ids.slice(i, i + TICK_BATCH_SIZE));
          const states = await readAll(batches, async (batch) => {
            const result = await rpc.ticks(batch, to);
            if (result.length !== batch.length)
              throw new Error("Incomplete tick reads");
            return result;
          });
          for (const [index, state] of states.flat().entries()) {
            if (typeof state.availableSupply !== "bigint")
              throw new Error("Invalid tick state");
            const tickId = ids[index]!;
            tickRows.push({
              id: `${n.chainId}:${tickId}`,
              chain_id: n.chainId,
              meta: json({
                ...state,
                tickId,
                active: state.availableSupply > 0n,
              }),
              timestamp,
            });
          }
        }
        if (!withinWindow()) break;
        phase = "database";
        method = undefined;
        let nextSize: number = size;
        if (length === size && size < n.chunkSize && ++fullChunks >= 4) {
          nextSize = Math.min(size * 2, n.chunkSize);
          fullChunks = 0;
        }
        remaining--;
        const next = await persistChunk(
          env.DB,
          n.chainId,
          meta,
          to,
          rows,
          Math.floor(now() / 1000),
          cutoff,
          tickRows,
          nextSize,
        );
        if (!next) {
          meta = undefined;
          status = "superseded";
          break;
        }
        current = to;
        meta = next;
        savedSize = size = nextSize;
        chunks++;
        events += rows.length;
        attempt = 1;
        transientFailures = 0;
      } catch (error) {
        const budget = !canRead();
        const tooLarge = method !== undefined && rangeError(error);
        // The last provider's error can mask a temporary failure at an earlier endpoint.
        if (!budget && !tooLarge && phase === "logs") transientFailures++;
        if (
          (tooLarge || (phase === "logs" && transientFailures >= 2)) &&
          length > 1
        )
          size = Math.floor(length / 2);
        const retry =
          !budget &&
          (tooLarge
            ? length > 1
            : phase === "logs" &&
              (transientFailures === 1 ||
                (transientFailures === 2 && length > 1)));
        log({
          type: retry ? "sync_chunk_retry" : "sync_chunk_error",
          ...network,
          phase,
          method,
          ...progress(),
          nextChunkSize: size,
          ...rpcErrorDetails(error),
        });
        fullChunks = 0;
        if (!retry) {
          status = budget ? "budget" : "failed";
          break;
        }
        retries++;
        attempt++;
        if (!tooLarge) await sleep(150);
      }
    }
    if (current === target) status = "complete";
  } catch (error) {
    log({
      type: "sync_network_error",
      ...network,
      phase,
      method,
      ...rpcErrorDetails(error),
    });
  } finally {
    if (meta !== undefined && size !== undefined && size !== savedSize) {
      try {
        // Save the smaller retry hint without advancing the checkpoint.
        const saved = await env.DB.prepare(
          "UPDATE state SET meta = ? WHERE key = ? AND meta = ?",
        )
          .bind(
            json({
              ...JSON.parse(meta),
              chunkSize: size,
              revision: crypto.randomUUID(),
            }),
            `events:${base.chainId}`,
            meta,
          )
          .run();
        if (!saved.success) throw new Error("Chunk size write failed");
      } catch (error) {
        log({
          type: "sync_chunk_size_error",
          ...network,
          error: errorKind(error),
        });
      }
    }
    log({
      type: "sync_result",
      ...network,
      startingCheckpoint: initial,
      checkpoint: current,
      safeBlock: target,
      processedBlocks: current === undefined ? undefined : current - initial!,
      indexedEvents: events,
      chunkSize: size,
      chunks,
      retries,
      endpointFailures,
      elapsedMs: now() - started,
      lagBlocks: lag(),
      status,
    });
  }
}

export function scheduledNetwork(
  scheduledTime: number,
  networks: readonly SupportedNetwork[] = supportedNetworks,
): SupportedNetwork {
  return networks[
    Math.floor(scheduledTime / CRON_INTERVAL_MS) % networks.length
  ]!;
}

export async function synchronize(
  env: Env,
  scheduledTime = Date.now(),
  dependencies: SyncDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const started = now();
  const n = scheduledNetwork(scheduledTime);
  const deadline =
    started +
    Math.min(CRON_INTERVAL_MS * supportedNetworks.length, CRON_LIMIT_MS) -
    5_000;
  const retentionMonths = setting(env.EVENT_RETENTION_MONTHS, 2, 0, 24);
  const cutoff =
    retentionMonths === 0
      ? undefined
      : retentionCutoff(Math.floor(started / 1000), retentionMonths);
  const cleanupBatchSize = setting(env.CLEANUP_BATCH_SIZE, 1000, 1, 1000);
  const leaseKey = `sync:lease:${n.chainId}`;
  const lease = json(crypto.randomUUID());
  const acquired = await env.DB.prepare(
    `INSERT INTO state(key, meta, timestamp) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET meta = excluded.meta, timestamp = excluded.timestamp
     WHERE state.timestamp <= ?`,
  )
    // A scheduled invocation can live for up to 15 minutes on Cloudflare.
    .bind(leaseKey, lease, started + CRON_LIMIT_MS, started)
    .run();
  if (!acquired.success) throw new Error("Unable to acquire sync lease");
  if (!acquired.meta.changes) {
    log({
      type: "sync_overlap",
      network: n.name,
      chainId: n.chainId,
      scheduledTime,
    });
    return;
  }

  try {
    const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
    await syncNetwork(env, n, {
      now,
      started,
      deadline,
      signal,
      cutoff,
      dependencies,
    });
    if (cutoff !== undefined && now() < deadline) {
      try {
        const deletedEvents = await cleanupEvents(
          env.DB,
          n.chainId,
          cutoff,
          cleanupBatchSize,
        );
        log({
          type: "events_cleanup",
          network: n.name,
          chainId: n.chainId,
          cutoff,
          deletedEvents,
          status: deletedEvents < cleanupBatchSize ? "complete" : "partial",
        });
      } catch (error) {
        log({
          type: "events_cleanup_error",
          network: n.name,
          chainId: n.chainId,
          cutoff,
          error: errorKind(error),
        });
      }
    }
  } finally {
    const released = await env.DB.prepare(
      "DELETE FROM state WHERE key = ? AND meta = ?",
    )
      .bind(leaseKey, lease)
      .run();
    if (!released.success) throw new Error("Unable to release sync lease");
  }
}
