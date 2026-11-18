import "server-only";
import type { MarketConfiguration } from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";
import { discoverTokens } from "@/server/token-discovery";

const trendingLoads = new Map<NetworkSlug, Promise<MarketConfiguration[]>>();

export function getTrendingMarkets(network: NetworkSlug) {
  let result = trendingLoads.get(network);
  if (!result) {
    result = (async () => {
      const id = getNetwork(network).id;
      if (!USD_ADDRESSES[id]) return [];
      const tokens = await discoverTokens(network);
      return trendingMarkets(
        id,
        tokens.map((token) => token.address),
      );
    })().finally(() => trendingLoads.delete(network));
    trendingLoads.set(network, result);
  }
  return result;
}
