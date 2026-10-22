import { describe, expect, it } from "vitest";
import { DEFAULT_DURATION, DISCOVERY_DEFAULTS } from "@yld-cx/sdk";
import { registry } from "@/lib/registry";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";

const network = "eip155:8453";
const weth = "0x4200000000000000000000000000000000000006";
const arbitrary = "0xffffffffffffffffffffffffffffffffffffffff";
const quote = USD_ADDRESSES[network]!;

describe("trending markets", () => {
  it("pairs only API tokens with USDC in API order and preserves registered market settings", () => {
    const markets = trendingMarkets(network, [
      arbitrary,
      weth,
      quote,
      weth.toUpperCase(),
      "invalid",
    ]);
    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject({
      network,
      key: `${quote}:${arbitrary}`,
      token0: { address: quote },
      token1: { address: arbitrary },
      defaultDuration: DEFAULT_DURATION,
      stepTicks: DISCOVERY_DEFAULTS.stepTicks,
    });
    expect(markets[1]).toEqual(registry.getMarket(network, weth, quote));
    expect(trendingMarkets(network, [])).toEqual([]);
  });

  it.each(["eip155:1", "eip155:8453", "eip155:4663"] as const)(
    "uses the selected network's USDC for %s",
    (selectedNetwork) => {
      const markets = trendingMarkets(selectedNetwork, [arbitrary]);
      expect(markets).toHaveLength(1);
      expect(markets[0].key).toContain(
        USD_ADDRESSES[selectedNetwork]!.toLowerCase(),
      );
    },
  );
});
