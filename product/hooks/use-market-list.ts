"use client";

import { getNetwork } from "@yld-cx/sdk/ethereum";
import { useTokens } from "@/hooks/use-market";
import {
  useTokenDiscovery,
  useTokenMetadata,
} from "@/hooks/use-token-metadata";
import { MarketTab, type MarketFilters } from "@/lib/market-filters";
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
  const discoveryTokens = discovery.data ?? [];
  const addresses = trending
    ? quoteAddress
      ? [quoteAddress]
      : []
    : registry.getTokens(id).map((token) => token.address);
  const metadata = useTokenMetadata(network, addresses);
  const cachedTokens = useTokens(network, addresses, trending);
  const quote = cachedTokens.find(
    (token) => token.address === quoteAddress?.toLowerCase(),
  );
  const markets = trending
    ? trendingMarkets(id, discoveryTokens, search, quote)
    : registry
        .searchMarkets(id, search, [...cachedTokens, ...metadata])
        .filter(
          (market) =>
            tag === MarketTab.YieldList ||
            registry.getMarketsByTag(id, tag).includes(market),
        );
  const failed =
    trending && !!quoteAddress && discovery.isError && !discovery.data;

  return {
    markets,
    marketCount: trending
      ? trendingMarkets(id, discoveryTokens).length
      : registry.getMarkets(id).length,
    discoveryTokens,
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
