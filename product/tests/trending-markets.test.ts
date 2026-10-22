import { describe, expect, it } from "vitest";
import { DEFAULT_DURATION, DISCOVERY_DEFAULTS } from "@yld-cx/sdk";
import { registry } from "@/lib/registry";
import { fallbackToken } from "@/lib/token-metadata";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";

const network = "eip155:8453";
const weth = "0x4200000000000000000000000000000000000006";
const arbitrary = "0xffffffffffffffffffffffffffffffffffffffff";
const token = (address: string, symbol: string) => ({
  ...fallbackToken(network, address),
  symbol,
  name: `Token ${symbol}`,
});
const quote = { ...token(USD_ADDRESSES[network]!, "USDC"), name: "USD Coin" };

describe("trending markets", () => {
  it("pairs only API tokens with USDC in API order and preserves registered market settings", () => {
    const markets = trendingMarkets(network, [
      token(arbitrary, "NEW"),
      token(weth, "WETH"),
      quote,
      token(weth.toUpperCase(), "DUPLICATE"),
      token("invalid", "INVALID"),
      { ...token(arbitrary, "OTHER_CHAIN"), network: "eip155:1" },
    ]);
    expect(markets).toHaveLength(2);
    expect(markets[0]).toMatchObject({
      network,
      key: `${quote.address}:${arbitrary}`,
      token0: { address: quote.address },
      token1: { address: arbitrary },
      defaultDuration: DEFAULT_DURATION,
      stepTicks: DISCOVERY_DEFAULTS.stepTicks,
    });
    expect(markets[1]).toEqual(
      registry.getMarket(network, weth, quote.address),
    );
    expect(trendingMarkets(network, [])).toEqual([]);
  });

  it.each([
    "weth",
    "Token WETH",
    "WETH/USDC",
    "WETH / USDC",
    "USDC|weth",
    "WETH USD Coin",
    weth,
  ])(
    "searches available identities and both displayed pair orientations for %s",
    (search) => {
      const markets = trendingMarkets(
        network,
        [token(weth, "WETH"), token(arbitrary, "NEW")],
        search,
        quote,
      );
      expect(markets).toHaveLength(1);
      expect(markets[0].key).toContain(weth);
    },
  );

  it.each(["eip155:1", "eip155:8453", "eip155:4663"] as const)(
    "uses the selected network's USDC for %s",
    (selectedNetwork) => {
      const networkToken = {
        ...token(arbitrary, "NEW"),
        network: selectedNetwork,
      };
      const markets = trendingMarkets(selectedNetwork, [networkToken]);
      expect(markets).toHaveLength(1);
      expect(markets[0].key).toContain(
        USD_ADDRESSES[selectedNetwork]!.toLowerCase(),
      );
    },
  );
});
