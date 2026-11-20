import "server-only";
import type { MarketConfiguration } from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { displayTokens } from "@yld-cx/sdk/registry";
import type { Address } from "viem";
import { registry } from "@/lib/registry";
import { getSdk } from "@/lib/rpc";
import { fetchTokenMetadata } from "@/lib/token-metadata";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";
import { discoverTokens } from "@/server/token-discovery";
import type { MarketList } from "@/lib/market-list";

const trendingLoads = new Map<NetworkSlug, Promise<MarketConfiguration[]>>();
const yieldListLoads = new Map<NetworkSlug, Promise<MarketList["markets"]>>();

export function getYieldListMarkets(network: NetworkSlug) {
  let result = yieldListLoads.get(network);
  if (!result) {
    result = (async () => {
      const id = getNetwork(network).id;
      const markets = registry.getMarkets(id);
      if (!markets.length) return markets;
      const metadata = await fetchTokenMetadata(
        id,
        registry.getTokens(id).map((token) => token.address),
      );
      const tokens = new Map(metadata.map((token) => [token.address, token]));
      const entries = markets.map((market) => {
        const token0 = tokens.get(market.token0.address);
        const token1 = tokens.get(market.token1.address);
        if (token0?.status !== "available" || token1?.status !== "available")
          throw new Error("Market asset metadata unavailable");
        return { market, asset: displayTokens({ token0, token1 })[0].address };
      });
      const assets = [...new Set(entries.map(({ asset }) => asset))];
      const sdk = getSdk(network);
      const liabilities = await Promise.all(
        assets.map((asset) => sdk.tokenLiability(asset as Address)),
      );
      const funded = new Set(
        assets.filter((_, index) => liabilities[index] > 0n),
      );
      return entries
        .sort(
          (a, b) => Number(funded.has(b.asset)) - Number(funded.has(a.asset)),
        )
        .map(({ market, asset }) => {
          const assetTVL = liabilities[assets.indexOf(asset)];
          return assetTVL > 0n
            ? { ...market, assetTVL: assetTVL.toString() }
            : market;
        });
    })().finally(() => yieldListLoads.delete(network));
    yieldListLoads.set(network, result);
  }
  return result;
}

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
