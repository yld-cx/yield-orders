// Subtract calendar months in UTC, clamping dates such as April 30 to February 28/29.
export function retentionCutoff(nowSeconds: number, months: number): number {
  const date = new Date(nowSeconds * 1000);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return Math.floor(date.getTime() / 1000);
}

export async function cleanupEvents(
  db: D1Database,
  chainId: number,
  cutoff: number,
  batchSize: number,
): Promise<number> {
  // Reuse events_chain_time to find a bounded batch; the outer DELETE uses the PK.
  const result = await db
    .prepare(
      `DELETE FROM events WHERE id IN (
    SELECT id FROM events WHERE chain_id = ? AND timestamp < ?
    ORDER BY timestamp ASC, id ASC LIMIT ?
  )`,
    )
    .bind(chainId, cutoff, batchSize)
    .run();
  return result.meta.changes;
}
