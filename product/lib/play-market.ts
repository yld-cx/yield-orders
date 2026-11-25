import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { MarketConfiguration } from "@yld-cx/sdk";
import { isNetworkSlug, registry } from "@/lib/registry";
import { USD_ADDRESSES } from "@/lib/trending-markets";
import { playStrategy } from "@/lib/play";
import { fetchTokenMetadata } from "@/lib/token-metadata";

export function playMarkets(network: NetworkSlug) {
  const id = getNetwork(network).id;
  const quote = USD_ADDRESSES[id]?.toLowerCase();
  return registry.getMarkets(id).filter((market) =>
    quote && [market.token0.address, market.token1.address].includes(quote),
  );
}

export function playAddresses(market: MarketConfiguration): readonly [string, string] {
  const quote = USD_ADDRESSES[market.network]?.toLowerCase();
  const a = market.token0.address;
  const b = market.token1.address;
  return a === quote ? [b, a] : [a, b];
}

export function readPlaySelection(params: Pick<URLSearchParams, "get">) {
  const network = params.get("network");
  const strategy = playStrategy(params.get("strategy"));
  if (!network || !isNetworkSlug(network) || !strategy) return undefined;
  const market = playMarkets(network).find((item) => item.key === params.get("market"));
  if (!market) return undefined;
  return { network, market, strategy };
}

export async function playTokens(market: MarketConfiguration) {
  const addresses = playAddresses(market);
  const [asset, quote] = await fetchTokenMetadata(market.network, addresses);
  return { asset, quote };
}
