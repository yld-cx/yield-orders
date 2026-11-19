import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Category, type MarketConfiguration } from "@yld-cx/sdk";
import { useMarketList } from "@/hooks/use-market-list";
import { MarketTab, type MarketFilters } from "@/lib/market-filters";
import { MARKET_PAGE_SIZE } from "@/lib/market-list";
import { queryKeys } from "@/lib/query-keys";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";

const network = "eip155:8453";
const quote = USD_ADDRESSES[network]!;
const assets = Array.from(
  { length: MARKET_PAGE_SIZE + 2 },
  (_, index) => `0x${(BigInt(index) + 1n).toString(16).padStart(40, "0")}`,
);

function setup(markets: MarketConfiguration[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const source of [MarketTab.YieldList, MarketTab.Trending])
    client.setQueryData(queryKeys.markets("base", source), { markets });
  for (const address of new Set([
    quote,
    ...markets.flatMap((market) => [
      market.token0.address,
      market.token1.address,
    ]),
  ])) {
    client.setQueryData(queryKeys.tokenMetadata("base", address), {
      network,
      address,
      symbol: address === quote ? "USDC" : `ASSET${address}`,
      name: address === quote ? "USD Coin" : "Asset",
      status: "available",
    });
  }
  return client;
}

function readList(client: QueryClient, filters: Partial<MarketFilters> = {}) {
  let result!: ReturnType<typeof useMarketList>;
  function Harness() {
    result = useMarketList({
      network: "base",
      tag: MarketTab.YieldList,
      search: "",
      page: 1,
      ...filters,
    });
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return result;
}

describe("server-ordered market list", () => {
  it("paginates API order without creating TVL queries for sorting", () => {
    const markets = trendingMarkets(network, assets);
    const ordered = [
      ...markets.slice(MARKET_PAGE_SIZE),
      ...markets.slice(0, MARKET_PAGE_SIZE),
    ];
    const client = setup(ordered);
    const firstPage = readList(client);
    expect(firstPage.markets).toEqual(ordered.slice(0, MARKET_PAGE_SIZE));
    expect(firstPage.total).toBe(markets.length);
    expect(readList(client, { page: 2 }).markets).toEqual(
      ordered.slice(MARKET_PAGE_SIZE),
    );
    expect(
      client.getQueryCache().findAll({ queryKey: ["asset-tvl"] }),
    ).toHaveLength(0);
    client.clear();
  });

  it("preserves API order in category tabs and search results", () => {
    const markets = trendingMarkets(network, assets.slice(0, 4)).map(
      (market, index) => ({
        ...market,
        tags: [index === 3 ? Category.BlueChip : Category.Stock],
      }),
    );
    const client = setup([markets[1], markets[2], markets[3], markets[0]]);
    expect(readList(client, { tag: Category.Stock }).markets).toEqual([
      markets[1],
      markets[2],
      markets[0],
    ]);
    expect(
      readList(client, { tag: Category.Stock, search: assets[0] }).markets,
    ).toEqual([markets[0]]);
    client.clear();
  });

  it("keeps Trending in source order regardless of cached TVL", () => {
    const markets = trendingMarkets(network, assets.slice(0, 3));
    const client = setup(markets);
    expect(readList(client, { tag: MarketTab.Trending }).markets).toEqual(
      markets,
    );
    expect(
      client.getQueryCache().findAll({ queryKey: ["asset-tvl"] }),
    ).toHaveLength(0);
    client.setQueryData(queryKeys.assetTvl("base", assets[2]), 1000n);
    expect(readList(client, { tag: MarketTab.Trending }).markets).toEqual(
      markets,
    );
    client.clear();
  });

  it("preserves the default YieldList fallback regardless of cached TVL", () => {
    const markets = trendingMarkets(network, assets.slice(0, 3));
    const client = setup(markets);
    client.setQueryData(queryKeys.assetTvl("base", assets[2]), 1n);
    expect(readList(client).markets).toEqual(markets);
    client.clear();
  });
});
