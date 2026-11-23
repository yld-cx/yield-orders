import { Q128 } from "@yld-cx/sdk/ethereum";
import { address, same, type SwapPriceResult } from "@yld-cx/sdk/uniswap";
import { LIMITS } from "./config.ts";
import type { Address } from "viem";

export interface Tick {
  id: bigint;
  asset: Address;
  quote: Address;
  priceX128: bigint;
  availableSupply: bigint;
}

export async function activeTicks(
  db: D1Database,
  chainId: number,
): Promise<Tick[]> {
  const { results } = await db
    .prepare(
      `SELECT meta FROM ticks
    WHERE chain_id = ? AND json_extract(meta, '$.active') = 1
    ORDER BY timestamp DESC, id LIMIT ?`,
    )
    .bind(chainId, LIMITS.indexedTicks)
    .all<{ meta: string }>();
  return results.map(({ meta }) => {
    const tick = JSON.parse(meta);
    return {
      id: BigInt(tick.tickId),
      asset: address(tick.asset),
      quote: address(tick.quote),
      priceX128: BigInt(tick.priceX128),
      availableSupply: BigInt(tick.availableSupply),
    };
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
