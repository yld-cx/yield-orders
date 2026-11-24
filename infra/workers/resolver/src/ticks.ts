import { Q128 } from "@yld-cx/sdk/ethereum";
import { address, same, type SwapPriceResult } from "@yld-cx/sdk/uniswap";
import type { Address } from "viem";
import { LIMITS } from "./config.ts";
import { errorKind, log } from "./shared.ts";

export interface Tick {
  id: bigint;
  asset: Address;
  quote: Address;
  priceX128: bigint;
  availableSupply: bigint;
}

export async function discoverTicks(
  db: D1Database,
  chainIds: number[],
  slot: number,
): Promise<{ chainId: number; tick: Tick }[]> {
  if (!chainIds.length) return [];
  const pageSize = LIMITS.batch;
  // The data worker stores uint256 values as canonical decimal strings.
  const { results } = await db
    .prepare(
      `WITH ranked AS (
        SELECT id, chain_id, meta,
          lower(json_extract(meta, '$.asset')) AS asset,
          lower(json_extract(meta, '$.quote')) AS quote,
          ROW_NUMBER() OVER (
            PARTITION BY chain_id,
              lower(json_extract(meta, '$.asset')),
              lower(json_extract(meta, '$.quote'))
            ORDER BY length(json_extract(meta, '$.priceX128')),
              json_extract(meta, '$.priceX128'), id
          ) AS rank
        FROM ticks
        WHERE chain_id IN (${chainIds.map(() => "?").join(", ")})
          AND json_extract(meta, '$.active') = 1
          AND json_extract(meta, '$.availableSupply') <> '0'
      ), candidates AS (
        SELECT id, chain_id, meta,
          ROW_NUMBER() OVER (ORDER BY chain_id, asset, quote) - 1 AS position,
          COUNT(*) OVER () AS total
        FROM ranked
        WHERE rank = 1
      )
      SELECT id, chain_id, meta FROM candidates
      WHERE position / ${pageSize} = ? % ((total + ${pageSize} - 1) / ${pageSize})
      ORDER BY position LIMIT ${pageSize}`,
    )
    .bind(...chainIds, slot)
    .all<{ id: string; chain_id: number; meta: string }>();
  return results.flatMap(({ id, chain_id: chainId, meta }) => {
    try {
      const tick = JSON.parse(meta);
      return [
        {
          chainId,
          tick: {
            id: BigInt(tick.tickId),
            asset: address(tick.asset),
            quote: address(tick.quote),
            priceX128: BigInt(tick.priceX128),
            availableSupply: BigInt(tick.availableSupply),
          },
        },
      ];
    } catch (error) {
      log({
        type: "tick_index_row_skipped",
        chainId,
        id,
        error: errorKind(error),
      });
      return [];
    }
  });
}

export function estimatedSurplus(
  tick: Tick,
  reference: SwapPriceResult,
  amount: bigint,
) {
  // Every resolver order buys asset from Yield Orders and sells asset to the AMM.
  if (
    !same(tick.asset, reference.tokenIn) ||
    !same(tick.quote, reference.tokenOut) ||
    Date.now() - reference.quotedAt > 40000 ||
    tick.priceX128 <= 0n ||
    amount <= 0n
  )
    return 0n;
  const input = BigInt(reference.amountIn);
  if (input <= 0n) return 0n;
  const proceeds = (amount * BigInt(reference.estimatedAmountOut)) / input;
  return proceeds - quotePrincipal(amount, tick.priceX128);
}

export function sizes(available: bigint, cap: bigint) {
  const bounded = available < cap ? available : cap;
  const maximum = bounded < 10n ** 30n ? bounded : 10n ** 30n;
  return [
    ...new Set([100n, 50n, 25n, 10n].map((p) => (maximum * p) / 100n)),
  ].filter((n) => n > 0n && n <= 10n ** 30n);
}
export function referenceAmount(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30)
    throw new Error("Unsupported token decimals");
  // A thousandth of a token, rounded up for low-decimal assets.
  return 10n ** BigInt(Math.max(0, decimals - 3));
}

export function fundedSizes(
  tick: { availableSupply: bigint; priceX128: bigint },
  assetLiquidity: bigint,
  quoteLiquidity: bigint,
  cap: bigint,
  bridgeQuoteLiquidity = 0n,
) {
  if (tick.priceX128 <= 0n) return [];
  const fundingQuote =
    quoteLiquidity > bridgeQuoteLiquidity
      ? quoteLiquidity
      : bridgeQuoteLiquidity;
  const quoteFunded = (fundingQuote << 128n) / tick.priceX128;
  const direct = assetLiquidity > quoteFunded ? assetLiquidity : quoteFunded;
  return sizes(tick.availableSupply, direct > cap ? cap : direct);
}
export function quotePrincipal(amount: bigint, priceX128: bigint) {
  return (amount * priceX128 + Q128 - 1n) >> 128n;
}
