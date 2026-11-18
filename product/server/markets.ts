import "server-only";
import { unstable_cache } from "next/cache";
import type { MarketConfiguration } from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { registry } from "@/lib/registry";
import { MARKET_CACHE_SECONDS } from "@/lib/market-list";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";
import { discoverTokens } from "@/server/token-discovery";

// Coalesce cold cache misses and revalidations within each server instance.
// Retain only in-flight work; Next owns the daily result cache.
function coalesce<T>(
  pending: Map<NetworkSlug, Promise<T>>,
  network: NetworkSlug,
  load: () => Promise<T>,
) {
  let result = pending.get(network);
  if (!result) {
    result = load().finally(() => pending.delete(network));
    pending.set(network, result);
  }
  return result;
}

const trendingLoads = new Map<NetworkSlug, Promise<MarketConfiguration[]>>();
class EmptyTrendingMarkets extends Error {}

const cachedTrendingMarkets = unstable_cache(
  (network: NetworkSlug) =>
    coalesce(trendingLoads, network, async () => {
      const id = getNetwork(network).id;
      if (!USD_ADDRESSES[id]) return [];
      const tokens = await discoverTokens(network);
      const markets = trendingMarkets(
        id,
        tokens.map((token) => token.address),
      );
      // An empty first load must not hide subsequently available tokens for a day.
      if (!markets.length) throw new EmptyTrendingMarkets();
      return markets;
    }),
  ["trending-markets-v2", JSON.stringify(registry.data)],
  { revalidate: MARKET_CACHE_SECONDS },
);

export async function getTrendingMarkets(network: NetworkSlug) {
  try {
    return await cachedTrendingMarkets(network);
  } catch (error) {
    if (error instanceof EmptyTrendingMarkets) return [];
    throw error;
  }
}
