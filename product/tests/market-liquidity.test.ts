import { describe, expect, it } from "vitest";
import { Duration, type Market, type Tick } from "@yld-cx/sdk";
import { bidLiquidity, compareBidLiquidity } from "@/lib/market-liquidity";

const market: Market = {
  network: "eip155:8453",
  key: "asset:quote",
  token0: {
    network: "eip155:8453",
    address: "asset",
    symbol: "WETH",
    name: "Ether",
    decimals: 18,
    listed: true,
  },
  token1: {
    network: "eip155:8453",
    address: "quote",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    listed: true,
  },
  baseTick: 0,
  stepTicks: 1000,
  defaultDuration: Duration.Weekly,
};

function tick(
  asset: string,
  availableSupply: bigint,
  durationDays: Duration = Duration.Weekly,
) {
  return {
    durationDays,
    state: { asset, availableSupply, activeWorking: 999999999n },
  } as Tick;
}

describe("market bid liquidity sorting", () => {
  it("sums available bids for the selected duration, using display order", () => {
    const ticks = [
      tick("QUOTE", 20n),
      tick("quote", 30n),
      tick("asset", 999n),
      tick("quote", 999n, Duration.Monthly),
    ];
    expect(bidLiquidity(market, ticks, Duration.Weekly)).toEqual({
      available: 50n,
      decimals: 6,
    });
    expect(
      bidLiquidity(
        { ...market, token0: market.token1, token1: market.token0 },
        ticks,
        Duration.Weekly,
      ),
    ).toEqual({ available: 50n, decimals: 6 });
    expect(bidLiquidity(market, ticks, Duration.Monthly).available).toBe(999n);
    expect(bidLiquidity(market, [], Duration.Weekly).available).toBe(0n);
  });

  it("ranks highest first after normalizing token decimals", () => {
    const smaller = { available: 2n * 10n ** 18n, decimals: 18 };
    const larger = { available: 3n * 10n ** 6n, decimals: 6 };
    expect([smaller, larger].sort(compareBidLiquidity)).toEqual([
      larger,
      smaller,
    ]);
    expect(
      compareBidLiquidity(smaller, { available: 2n * 10n ** 6n, decimals: 6 }),
    ).toBe(0);
  });

  it("preserves precision above the safe integer range", () => {
    const smaller = { available: 10n ** 30n, decimals: 18 };
    expect(
      compareBidLiquidity(
        { ...smaller, available: smaller.available + 1n },
        smaller,
      ),
    ).toBe(-1);
  });

  it("puts unread and incomplete liquidity after confirmed zero liquidity", () => {
    const zero = { available: 0n, decimals: 6 };
    expect([undefined, zero].sort((a, b) => compareBidLiquidity(a, b))).toEqual(
      [zero, undefined],
    );
    expect(compareBidLiquidity(undefined, zero)).toBe(1);
    expect(compareBidLiquidity(zero, undefined)).toBe(-1);
    expect(compareBidLiquidity(undefined, undefined)).toBe(0);
  });
});
