import {
  formatRatio,
  protocolAbi,
  Q128,
  snappedPrice,
  tickCandidates,
} from "@yld-cx/sdk/ethereum";
import { same, type SwapPriceResult } from "@yld-cx/sdk/uniswap";
import type { TickState } from "@yld-cx/sdk";
import type { Address, PublicClient } from "viem";
import type { MarketIdentity } from "./markets.ts";
export const INITIAL_RADIUS = 2;

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
    market.stepTicks,
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

export function discoveryRadii(maximum = 4) {
  if (!Number.isInteger(maximum) || maximum < INITIAL_RADIUS || maximum > 8)
    throw new Error("Discovery radius must be between 2 and 8");
  const radii = [INITIAL_RADIUS];
  while (radii.at(-1)! < maximum)
    radii.push(Math.min(maximum, radii.at(-1)! * 2));
  return radii;
}

/** Stop iteration once a window yields executable opportunities. */
export async function* ticks(
  client: PublicClient,
  yld: Address,
  market: MarketIdentity,
  reference: SwapPriceResult,
  blockNumber: bigint,
  maximumRadius = 4,
) {
  const baseTick = baseTickFromPrice(market, reference);
  const seen = new Set<bigint>();
  for (const radius of discoveryRadii(maximumRadius)) {
    if (Date.now() - reference.quotedAt > 40000) return;
    const identities = tickCandidates(
      market.pairId,
      baseTick,
      market.stepTicks,
      radius,
    ).filter((t) => !seen.has(t.id));
    identities.forEach((t) => seen.add(t.id));
    const result = await client.multicall({
      blockNumber,
      allowFailure: true,
      contracts: identities.map((t) => ({
        address: yld,
        abi: protocolAbi,
        functionName: "getTick" as const,
        args: [t.id] as const,
      })),
    });
    const available = result.flatMap((r, i) =>
      r.status === "success" &&
      r.result.availableSupply > 0n &&
      promising(r.result, market, reference)
        ? [{ id: identities[i].id, ...r.result }]
        : [],
    );
    yield { baseTick, radius, checked: identities.length, ticks: available };
  }
}
export function sizes(available: bigint, cap: bigint) {
  const maximum = available < cap ? available : cap;
  return [
    ...new Set([100n, 50n, 25n, 10n].map((p) => (maximum * p) / 100n)),
  ].filter((n) => n > 0n && n <= 10n ** 30n);
}
export function quotePrincipal(amount: bigint, priceX128: bigint) {
  return (amount * priceX128 + (1n << 128n) - 1n) >> 128n;
}
