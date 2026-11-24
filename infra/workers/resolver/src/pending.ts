import {
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { abi } from "./simulate.ts";
import { log } from "./shared.ts";

export interface Pending {
  hash: Hex;
  nonce: number;
  submittedBlock: string;
  createdAt: number;
  resolver: Address;
  expectedBitmap: string;
  expectedGross: string;
  expectedGasCost: string;
}

function pendingKey(chainId: number, bot: Address) {
  return `resolver:pending:${chainId}:${bot.toLowerCase()}`;
}

export async function reservePending(
  db: D1Database,
  chainId: number,
  bot: Address,
  pending: Pending,
) {
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO state(key, meta, timestamp) VALUES (?, ?, ?)",
    )
    .bind(
      pendingKey(chainId, bot),
      JSON.stringify(pending),
      Math.floor(pending.createdAt / 1000),
    )
    .run();
  return result.meta.changes === 1;
}

export async function observePending(
  client: PublicClient,
  db: D1Database,
  chainId: number,
  bot: Address,
) {
  const key = pendingKey(chainId, bot);
  const row = await db
    .prepare("SELECT meta FROM state WHERE key = ?")
    .bind(key)
    .first<{ meta: string }>();
  if (!row) return false;
  const pending = JSON.parse(row.meta) as Omit<Pending, "submittedBlock"> & {
    submittedBlock?: string;
  };
  let block: bigint;
  try {
    block = await client.getBlockNumber({ cacheTime: 0 });
  } catch {
    log({
      type: "resolver_pending",
      chainId,
      hash: pending.hash,
      nonce: pending.nonce,
      ageMs: Date.now() - pending.createdAt,
    });
    return true;
  }
  if (pending.submittedBlock === undefined) {
    // Both a successful initialization and a concurrent change block this run.
    await db
      .prepare("UPDATE state SET meta = ? WHERE key = ? AND meta = ?")
      .bind(
        JSON.stringify({ ...pending, submittedBlock: block.toString() }),
        key,
        row.meta,
      )
      .run();
    return true;
  }
  if (block < BigInt(pending.submittedBlock) + 3n) return true;

  const receipt = await client
    .getTransactionReceipt({ hash: pending.hash })
    .catch(() => undefined);
  if (
    receipt &&
    receipt.transactionHash.toLowerCase() === pending.hash.toLowerCase() &&
    receipt.from.toLowerCase() === bot.toLowerCase() &&
    receipt.to?.toLowerCase() === pending.resolver.toLowerCase()
  ) {
    const events = parseEventLogs({
      abi,
      logs: receipt.logs.filter(
        (entry) =>
          entry.address.toLowerCase() === pending.resolver.toLowerCase(),
      ),
    });
    let bitmap = 0n;
    for (const event of events)
      if (event.eventName === "ExecutionSucceeded")
        bitmap |= 1n << BigInt((event.args as { index: bigint }).index);
    log({
      type: "resolver_receipt",
      chainId,
      hash: pending.hash,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      bitmap,
      expectedBitmap: pending.expectedBitmap,
      partial: bitmap.toString() !== pending.expectedBitmap,
      expectedGross: pending.expectedGross,
      expectedGasCost: pending.expectedGasCost,
      events: events.map((e) => ({ event: e.eventName, args: e.args })),
    });
  } else {
    log({
      type: "resolver_receipt",
      chainId,
      hash: pending.hash,
      nonce: pending.nonce,
      status: "unresolved",
    });
  }
  const result = await db
    .prepare("DELETE FROM state WHERE key = ? AND meta = ?")
    .bind(key, row.meta)
    .run();
  return result.meta.changes !== 1;
}

export async function availableNonce(client: PublicClient, bot: Address) {
  const [confirmed, pending] = await Promise.all([
    client.getTransactionCount({ address: bot, blockTag: "latest" }),
    client.getTransactionCount({ address: bot, blockTag: "pending" }),
  ]);
  return confirmed === pending ? pending : undefined;
}
