import { describe, expect, it } from "vitest";
import { DEFAULT_DURATION, DISCOVERY_DEFAULTS } from "@yld-cx/sdk";
import { registry } from "@/lib/registry";
import { fallbackToken } from "@/lib/token-metadata";
import { trendingMarkets, usdToken } from "@/lib/trending-markets";

const network = "eip155:8453";
const weth = "0x4200000000000000000000000000000000000006";
const arbitrary = "0xffffffffffffffffffffffffffffffffffffffff";
const token = (address: string, symbol: string) => ({
  ...fallbackToken(network, address),
  symbol,
  name: `Token ${symbol}`,
});

describe("trending markets", () => {
  it("pairs only API tokens with USDC in API order and preserves registered market settings", () => {
    const quote = usdToken(network)!;
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

  // Quote metadata may still be pending; use its displayed fallback identity.
  it.each([
    "weth",
    "Token WETH",
    `WETH / ${usdToken(network)!.symbol}`,
    `${usdToken(network)!.symbol}|weth`,
    weth,
  ])(
    "searches available identities and both displayed pair orientations for %s",
    (search) => {
      const markets = trendingMarkets(
        network,
        [token(weth, "WETH"), token(arbitrary, "NEW")],
        search,
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
        usdToken(selectedNetwork)!.address.toLowerCase(),
      );
    },
  );
});
