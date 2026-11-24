import {
  createPublicClient,
  fallback,
  http,
  HttpRequestError,
  ResponseBodyTooLargeError,
} from "viem";
import { rpcFallbackOptions, rpcHttpOptions } from "../../rpc.ts";
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
} from "./networks.ts";
import { errorKind, integer, json, log, setting, type Env } from "./shared.ts";
import { cleanupEvents, retentionCutoff } from "./retention.ts";

const RESERVE_MS = 35_000;
const MAX_EVENTS = 256;
const MAX_EVENT_BLOCKS = 24;
const TICK_BATCH_SIZE = 32;
class CapacityError extends Error {
  constructor() {
    super("Chunk capacity exceeded");
    this.name = "CapacityError";
  }
}
class BudgetError extends Error {
  constructor() {
    super("Execution budget");
    this.name = "BudgetError";
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

export function rpcFor(n: Network, timeout: number): Rpc {
  const client = createPublicClient({
    chain: n.chain,
    transport: fallback(
      n.rpcUrls.map((url) =>
        http(url, rpcHttpOptions(timeout, n.rpcUrls.length)),
      ),
      rpcFallbackOptions,
    ),
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
): Promise<string | null> {
  if (to <= lastBlock(expected))
    throw new Error("Invalid checkpoint advancement");
  const next = json({
    ...JSON.parse(expected),
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
  // Inspect locally for classification only. Never emit these potentially secret-bearing messages.
  const message =
    error instanceof Error
      ? `${error.name} ${error.message} ${String(error.cause ?? "")}`
      : String(error);
  return /CapacityError|ResponseBodyTooLargeError|range|too many|too large|limit exceeded|response size|query returned|\b413\b|-32005/i.test(
    message,
  );
}

interface ChainRun {
  n: Network;
  rpc: Rpc;
  meta: string;
  initial: bigint;
  target: bigint;
  size: number;
  chunks: number;
  blocks: number;
  events: number;
  retries: number;
  status: string;
  active: boolean;
}

export interface SyncDependencies {
  now?: () => number;
  rpc?: (n: Network, timeout: number) => Rpc;
  sleep?: (ms: number) => Promise<void>;
}

export async function synchronize(
  env: Env,
  scheduledTime = Date.now(),
  dependencies: SyncDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  const started = now();
  const duration = setting(env.MAX_SYNC_DURATION_MS, 120_000, 40_000, 600_000);
  const deadline = started + duration;
  const maxChunks = setting(env.MAX_CHUNKS, 12, 1, 100);
  const maxRpc = setting(env.MAX_RPC_REQUESTS, 180, 6, 2000);
  const maxD1 = setting(env.MAX_D1_QUERIES, 80, 9, 900);
  const retentionMonths = setting(env.EVENT_RETENTION_MONTHS, 2, 0, 24);
  const cutoff =
    retentionMonths === 0
      ? undefined
      : retentionCutoff(Math.floor(started / 1000), retentionMonths);
  const cleanupBatchSize = setting(env.CLEANUP_BATCH_SIZE, 1000, 1, 1000);
  const maxCleanupBatches = setting(env.MAX_CLEANUP_BATCHES, 6, 1, 30);
  const timeout = setting(env.RPC_TIMEOUT_MS, 8000, 100, 10_000);
  const makeRpc = dependencies.rpc ?? rpcFor;
  const sleep =
    dependencies.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let rpcRequests = 0,
    d1Queries = 0,
    chunks = 0;
  let deletedEvents = 0,
    cleanupBatches = 0;
  const runs: ChainRun[] = [];
  const offset = Math.floor(scheduledTime / 300_000) % supportedNetworks.length;
  const ordered = [
    ...supportedNetworks.slice(offset),
    ...supportedNetworks.slice(0, offset),
  ];
  const withinBudget = () => now() < deadline - RESERVE_MS;
  if (cutoff !== undefined) {
    const pending = new Set(ordered.map((n) => n.chainId));
    // Cleanup has a short admission window and reserves checkpoint + one chunk per chain.
    for (
      let attempt = 0;
      attempt < maxCleanupBatches * ordered.length &&
      cleanupBatches < maxCleanupBatches &&
      pending.size &&
      withinBudget() &&
      now() < started + 10_000 &&
      d1Queries < maxD1 - ordered.length * 5;
      attempt++
    ) {
      const network = ordered[attempt % ordered.length]!;
      if (!pending.has(network.chainId)) continue;
      d1Queries++;
      cleanupBatches++;
      try {
        const deleted = await cleanupEvents(
          env.DB,
          network.chainId,
          cutoff,
          cleanupBatchSize,
        );
        deletedEvents += deleted;
        if (deleted < cleanupBatchSize) pending.delete(network.chainId);
        log({
          type: "events_cleanup",
          network: network.name,
          chainId: network.chainId,
          cutoff,
          deletedEvents: deleted,
          status: deleted < cleanupBatchSize ? "complete" : "partial",
        });
      } catch (error) {
        pending.delete(network.chainId);
        log({
          type: "events_cleanup_error",
          network: network.name,
          chainId: network.chainId,
          cutoff,
          error: errorKind(error),
        });
      }
    }
  }
  function reserveRpc(count: number) {
    if (!withinBudget() || rpcRequests + count > maxRpc)
      throw new BudgetError();
    rpcRequests += count;
  }
  async function rpcCall<T>(call: () => Promise<T>): Promise<T> {
    reserveRpc(1);
    return call();
  }
  async function rpcBatch<T, R>(
    items: T[],
    read: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (!items.length) return [];
    reserveRpc(items.length);
    // Concurrent reads share the HTTP batch. Drain any fallback attempts before proceeding.
    const results = await Promise.allSettled(
      items.map(async (item) => read(item)),
    );
    return results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }
  // Initialize all chains before processing chunks; one broken chain never aborts the others.
  for (const base of ordered) {
    let phase = "configuration";
    try {
      if (!withinBudget() || d1Queries + 2 > maxD1) throw new BudgetError();
      const n = indexingNetwork(env, base);
      const rpc = makeRpc(n, timeout);
      phase = "head";
      const head = await rpcCall(() => rpc.head());
      integer(head.toString(), "RPC head");
      phase = "checkpoint";
      d1Queries += 2;
      const meta = await checkpoint(env.DB, n, Math.floor(now() / 1000), head);
      const target = head - BigInt(n.confirmations);
      const initial = lastBlock(meta);
      const savedStart = (JSON.parse(meta) as { startBlock?: number })
        .startBlock;
      const startBlock =
        savedStart === undefined ? (n.startBlock ?? 0n) : BigInt(savedStart);
      const waitingForConfirmations = target < startBlock;
      const waitingForSafeHead = initial > target;
      const run: ChainRun = {
        n,
        rpc,
        meta,
        initial,
        target,
        size: n.chunkSize,
        chunks: 0,
        blocks: 0,
        events: 0,
        retries: 0,
        status: waitingForConfirmations
          ? "waiting_for_confirmations"
          : waitingForSafeHead
            ? "waiting_for_safe_head"
            : "partial",
        active: !waitingForConfirmations && !waitingForSafeHead,
      };
      runs.push(run);
      log({
        type: "sync_start",
        network: n.name,
        chainId: n.chainId,
        checkpoint: initial,
        safeBlock: target,
        startBlock,
      });
    } catch (error) {
      log({
        type: "sync_network_error",
        network: base.name,
        chainId: base.chainId,
        phase,
        error: errorKind(error),
        status: error instanceof BudgetError ? "budget" : "failed",
        elapsedMs: now() - started,
      });
    }
  }
  // Round robin: one attempt per chain per round; total attempts also have a hard bound.
  const maxAttempts = maxChunks + supportedNetworks.length * 12;
  for (
    let attempt = 0;
    attempt < maxAttempts && chunks < maxChunks && withinBudget();
    attempt++
  ) {
    const run = runs[attempt % Math.max(1, runs.length)];
    if (!run) break;
    if (!runs.some((r) => r.active)) break;
    if (!run.active) continue;
    const { n, rpc } = run;
    let phase = "logs";
    try {
      if (d1Queries + 3 > maxD1) throw new BudgetError();
      const from = lastBlock(run.meta) + 1n;
      if (from > run.target) {
        run.active = false;
        run.status = "complete";
        continue;
      }
      const end = from + BigInt(run.size) - 1n;
      const to = end < run.target ? end : run.target;
      const entries = await rpcCall(() => rpc.logs(from, to));
      if (entries.length > MAX_EVENTS) throw new CapacityError();
      const blockNumbers = new Set<bigint>();
      for (const { blockNumber } of entries) {
        if (blockNumber === null || blockNumber < from || blockNumber > to)
          throw new Error("Unexpected RPC log block");
        blockNumbers.add(blockNumber);
      }
      if (blockNumbers.size > MAX_EVENT_BLOCKS) throw new CapacityError();
      if (entries.some(isTickLog)) blockNumbers.add(to);
      phase = "block_timestamps";
      const blocks = new Map(
        await rpcBatch(
          [...blockNumbers],
          async (number) => [number, await rpc.block(number)] as const,
        ),
      );
      const events: EventRow[] = [];
      const affected = new Set<bigint>();
      phase = "decode";
      for (const entry of entries) {
        const block = blocks.get(entry.blockNumber!)!;
        if (
          entry.address.toLowerCase() !== n.address ||
          entry.blockHash !== block.hash
        )
          throw new Error("Inconsistent RPC log/block");
        const event = decodeLog(n.chainId, entry, block.timestamp);
        if (!event) continue;
        const tickId = affectedTick(event);
        if (tickId !== undefined) affected.add(tickId);
        if (cutoff === undefined || event.timestamp >= cutoff)
          events.push(event);
      }
      const tickRows: TickRow[] = [];
      if (affected.size) {
        phase = "ticks";
        const timestamp = integer(
          blocks.get(to)!.timestamp.toString(),
          "block timestamp",
        );
        const ids = [...affected];
        const batches: bigint[][] = [];
        for (let i = 0; i < ids.length; i += TICK_BATCH_SIZE)
          batches.push(ids.slice(i, i + TICK_BATCH_SIZE));
        const states = await rpcBatch(batches, async (batch) => {
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
      if (!withinBudget()) throw new BudgetError();
      phase = "database";
      d1Queries += 3;
      const next = await persistChunk(
        env.DB,
        n.chainId,
        run.meta,
        to,
        events,
        Math.floor(now() / 1000),
        cutoff,
        tickRows,
      );
      if (!next) {
        run.active = false;
        run.status = "superseded";
        continue;
      }
      run.meta = next;
      run.chunks++;
      chunks++;
      run.blocks += Number(to - from + 1n);
      run.events += events.length;
      if (to === run.target) {
        run.active = false;
        run.status = "complete";
      }
    } catch (error) {
      if (error instanceof BudgetError) {
        run.active = false;
        run.status = "budget";
      } else if (
        run.size > 1 &&
        run.retries < 11 &&
        ((phase === "logs" && rangeError(error)) ||
          (phase === "block_timestamps" &&
            (error instanceof ResponseBodyTooLargeError ||
              (error instanceof HttpRequestError && error.status === 413))))
      ) {
        run.size = Math.max(1, Math.floor(run.size / 2));
        run.retries++;
        log({
          type: "sync_rpc_retry",
          network: n.name,
          chainId: n.chainId,
          error: errorKind(error),
          retry: run.retries,
          chunkSize: run.size,
        });
        if (withinBudget())
          await sleep(Math.min(100 * 2 ** (run.retries - 1), 1000));
      } else {
        run.active = false;
        run.status = "failed";
        log({
          type: "sync_chunk_error",
          network: n.name,
          chainId: n.chainId,
          phase,
          error: errorKind(error),
        });
      }
    }
  }
  for (const r of runs) {
    log({
      type: "sync_result",
      network: r.n.name,
      chainId: r.n.chainId,
      startingCheckpoint: r.initial,
      checkpoint: lastBlock(r.meta),
      safeBlock: r.target,
      processedBlocks: r.blocks,
      indexedEvents: r.events,
      chunks: r.chunks,
      retries: r.retries,
      elapsedMs: now() - started,
      lagBlocks:
        r.target > lastBlock(r.meta) ? r.target - lastBlock(r.meta) : 0n,
      status: r.status,
    });
  }
  log({
    type: "sync_finished",
    elapsedMs: now() - started,
    chunks,
    rpcRequests,
    d1Queries,
    retentionCutoff: cutoff,
    deletedEvents,
    cleanupBatches,
  });
}
