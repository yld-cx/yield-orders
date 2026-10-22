import { describe, expect, it } from "vitest";
import { searchMarkets } from "@/lib/market-filters";
import { fallbackToken } from "@/lib/token-metadata";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";

const network = "eip155:8453";
const weth = "0x4200000000000000000000000000000000000006";
const quote = USD_ADDRESSES[network]!;
const arbitrary = "0xffffffffffffffffffffffffffffffffffffffff";
const markets = trendingMarkets(network, [arbitrary, weth]);
const metadata = [
  { address: weth, symbol: "WETH", name: "Wrapped Ether" },
  { address: quote, symbol: "USDC", name: "USD Coin" },
  { address: arbitrary, symbol: "NEW", name: "New token" },
];

describe("shared market search", () => {
  it.each([
    "weth",
    "Wrapped Ether",
    "WETH/USDC",
    "WETH / USDC",
    "USDC|weth",
    "WETH USD Coin",
    weth,
    `${weth}:${quote}`,
  ])(
    "matches resolved symbols, names, addresses and pairs for %s",
    (search) => {
      expect(searchMarkets(markets, search, metadata)).toEqual([markets[1]]);
    },
  );

  it("preserves source ordering and market settings", () => {
    expect(searchMarkets(markets, "USDC", metadata)).toEqual(markets);
    expect(searchMarkets(markets, "", [])).toEqual(markets);
  });

  it("searches addresses without metadata and standard fallback symbols", () => {
    expect(searchMarkets(markets, weth, [])).toEqual([markets[1]]);
    const fallback = metadata.map(({ address }) =>
      fallbackToken(network, address),
    );
    const [asset, quote] = fallback;
    expect(
      searchMarkets(markets, `${quote.symbol}/${asset.symbol}`, fallback),
    ).toEqual([markets[1]]);
  });
});
