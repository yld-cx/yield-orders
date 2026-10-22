"use client";

import { getNetwork } from "@yld-cx/sdk/ethereum";
import {
  useTokenDiscovery,
  useTokenMetadata,
} from "@/hooks/use-token-metadata";
import {
  MarketTab,
  searchMarkets,
  type MarketFilters,
} from "@/lib/market-filters";
import { registry } from "@/lib/registry";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";

export function useMarketList({
  network,
  tag,
  search,
}: Pick<MarketFilters, "network" | "tag" | "search">) {
  const id = getNetwork(network).id;
  const trending = tag === MarketTab.Trending;
  const quoteAddress = USD_ADDRESSES[id];
  const discovery = useTokenDiscovery(network, trending && !!quoteAddress);
  const sourceMarkets = trending
    ? trendingMarkets(
        id,
        (discovery.data ?? []).map((token) => token.address),
      )
    : registry.getMarkets(id);
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
  const failed =
    trending && !!quoteAddress && discovery.isError && !discovery.data;

  return {
    markets,
    marketCount: sourceMarkets.length,
    loading: trending && !!quoteAddress && discovery.isPending,
    loadingLabel: trending ? "Loading trending markets…" : "Loading markets…",
    error: failed
      ? {
          title: "Trending markets unavailable",
          description: "Could not load tokens. Please try again.",
          retry: () => discovery.refetch(),
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
