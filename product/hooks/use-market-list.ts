"use client";

import type { Duration } from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { useQuery } from "@tanstack/react-query";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import {
  MarketTab,
  searchMarkets,
  type MarketFilters,
} from "@/lib/market-filters";
import { registry } from "@/lib/registry";
import { USD_ADDRESSES } from "@/lib/trending-markets";
import {
  MARKET_CACHE_SECONDS,
  MARKET_PAGE_SIZE,
  type MarketList,
} from "@/lib/market-list";
import { queryKeys } from "@/lib/query-keys";

export function marketListOptions(
  network: NetworkSlug,
  duration: Duration | undefined,
  source: MarketTab,
) {
  return {
    queryKey: queryKeys.markets(network, duration, source),
    queryFn: async (): Promise<MarketList> => {
      const params = new URLSearchParams({
        chainId: String(getNetwork(network).chain.id),
        tag: source,
        ...(duration === undefined ? {} : { duration: String(duration) }),
      });
      const response = await fetch(`/api/markets?${params}`);
      if (!response.ok) throw new Error("Markets unavailable");
      return response.json();
    },
    staleTime: MARKET_CACHE_SECONDS * 1000,
  } as const;
}

export function useMarketList({
  network,
  tag,
  search,
  duration,
  page,
}: MarketFilters) {
  const id = getNetwork(network).id;
  const trending = tag === MarketTab.Trending;
  const quoteAddress = USD_ADDRESSES[id];
  const source = trending ? MarketTab.Trending : MarketTab.YieldList;
  const list = useQuery(
    marketListOptions(network, trending ? undefined : duration, source),
  );
  const sourceMarkets = list.data?.markets ?? [];
  const addresses = sourceMarkets.flatMap((market) => [
    market.token0.address,
    market.token1.address,
  ]);
  const metadata = useTokenMetadata(network, addresses);
  const markets = searchMarkets(sourceMarkets, search, metadata).filter(
    (market) =>
      tag === MarketTab.Trending ||
      tag === MarketTab.YieldList ||
      market.tags?.includes(tag),
  );
  const failed = list.isError && !list.data;
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(markets.length / MARKET_PAGE_SIZE)),
  );
  const start = (currentPage - 1) * MARKET_PAGE_SIZE;

  return {
    markets: markets.slice(start, start + MARKET_PAGE_SIZE),
    total: markets.length,
    currentPage,
    marketCount: list.data
      ? sourceMarkets.length
      : trending
        ? 0
        : registry.getMarkets(id).length,
    tokenCount: list.data
      ? new Set(addresses).size
      : trending
        ? 0
        : registry.getTokens(id).length,
    loading: list.isPending,
    loadingLabel: trending ? "Loading trending markets…" : "Loading markets…",
    error: failed
      ? {
          title: trending
            ? "Trending markets unavailable"
            : "Markets unavailable",
          description: "Could not load markets. Please try again.",
          retry: () => list.refetch(),
        }
      : undefined,
    empty:
      trending && !quoteAddress
        ? {
            title: "Markets unavailable",
            description:
              "Trending markets are not available on this network yet.",
          }
        : {
            title: "No matching markets",
            description:
              "Try another token or category, or open a permissionless market.",
          },
  };
}
