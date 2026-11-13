import type { Duration, Market, Tick } from "@yld-cx/sdk";
import { displayTokens } from "@yld-cx/sdk/registry";

export function bidLiquidity(
  market: Market,
  ticks: readonly Tick[],
  duration: Duration,
) {
  const bidToken = displayTokens(market)[1];
  return {
    available: ticks.reduce(
      (sum, tick) =>
        tick.durationDays === duration &&
        tick.state.asset.toLowerCase() === bidToken.address.toLowerCase()
          ? sum + tick.state.availableSupply
          : sum,
      0n,
    ),
    decimals: bidToken.decimals,
  };
}

export function compareBidLiquidity(
  a: ReturnType<typeof bidLiquidity> | undefined,
  b: ReturnType<typeof bidLiquidity> | undefined,
) {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  const left = a.available * 10n ** BigInt(b.decimals);
  const right = b.available * 10n ** BigInt(a.decimals);
  return left > right ? -1 : left < right ? 1 : 0;
}
