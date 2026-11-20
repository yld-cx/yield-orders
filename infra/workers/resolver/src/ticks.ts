import {
  formatRatio,
  protocolAbi,
  Q128,
  snappedPrice,
  tickCandidates,
} from "@yld-cx/sdk/ethereum";
import { same, type SwapPriceResult } from "@yld-cx/sdk/uniswap";
import {
  PRODUCT_MARKET,
  DISCOVERY_BATCH_SIZE,
  type TickState,
} from "@yld-cx/sdk";
import type { Address, PublicClient } from "viem";
import type { MarketIdentity } from "./markets.ts";
import { LIMITS } from "./config.ts";

export function baseTickFromPrice(
  market: MarketIdentity,
  reference: SwapPriceResult,
) {
  if (
    !same(reference.tokenIn, market.token0) ||
    !same(reference.tokenOut, market.token1) ||
    BigInt(reference.amountIn) <= 0n ||
    BigInt(reference.estimatedAmountOut) <= 0n
  )
    throw new Error("Invalid AMM reference");
  // Raw token1/token0 already includes decimal scaling. The SDK performs the
  // bounded integer price search and nearest-grid snapping without floats.
  return snappedPrice(
    formatRatio(
      BigInt(reference.estimatedAmountOut),
      BigInt(reference.amountIn),
      80,
    ),
    0,
    0,
    PRODUCT_MARKET.stepTicks,
  ).priceTick;
}

export function promising(
  tick: Pick<TickState, "asset" | "quote" | "priceX128">,
  market: MarketIdentity,
  reference: SwapPriceResult,
) {
  const input = BigInt(reference.amountIn),
    output = BigInt(reference.estimatedAmountOut);
  if (same(tick.asset, market.token0) && same(tick.quote, market.token1))
    return tick.priceX128 * input < output * Q128;
  if (same(tick.asset, market.token1) && same(tick.quote, market.token0))
    return tick.priceX128 * output < input * Q128;
  return false;
}

/** Read the complete configured window in one multicall at the quote block. */
export async function ticks(
  client: PublicClient,
  yld: Address,
  market: MarketIdentity,
  reference: SwapPriceResult,
  blockNumber: bigint,
  radius: number = LIMITS.discoveryRadius,
) {
  if (
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > LIMITS.discoveryRadius
  )
    throw new Error(
      `Discovery radius must be between 0 and ${LIMITS.discoveryRadius}`,
    );
  const baseTick = baseTickFromPrice(market, reference);
  if (Date.now() - reference.quotedAt > 40000)
    return { baseTick, radius, checked: 0, ticks: [] };
  const identities = tickCandidates(
    market.pairId,
    baseTick,
    PRODUCT_MARKET.stepTicks,
    radius,
  );
  if (identities.length > DISCOVERY_BATCH_SIZE)
    throw new Error("Discovery window exceeds multicall limit");
  const result = await client.multicall({
    blockNumber,
    allowFailure: true,
    batchSize: 0,
    contracts: identities.map((tick) => ({
      address: yld,
      abi: protocolAbi,
      functionName: "getTick" as const,
      args: [tick.id] as const,
    })),
  });
  const available = result.flatMap((read, i) =>
    read.status === "success" &&
    read.result.availableSupply > 0n &&
    promising(read.result, market, reference)
      ? [{ id: identities[i].id, ...read.result }]
      : [],
  );
  return { baseTick, radius, checked: identities.length, ticks: available };
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
  return (amount * priceX128 + (1n << 128n) - 1n) >> 128n;
}
