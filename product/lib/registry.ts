import list from "../public/yieldlist.json";
import { Registry, pairKey, displayTokens } from "@yld-cx/sdk/registry";
import { getNetwork, networks, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { Market, NetworkId } from "@yld-cx/sdk";
export const registry = new Registry(list);
export const ORIGIN = "https://yld.cx";
export function marketPath(market: Pick<Market, "network" | "key">): string {
  return `/market/${getNetwork(market.network).slug}/${market.key}`;
}
export function parseMarketRoute(
  network: string,
  pair: string,
): {
  network: ReturnType<typeof getNetwork>;
  key: string;
  canonicalPath: string;
} {
  const n = getNetwork(decodeURIComponent(network).toLowerCase());
  const tokens = decodeURIComponent(pair).split(":");
  if (tokens.length !== 2) throw new Error("Invalid token pair");
  const key = pairKey(n.id, tokens[0], tokens[1]);
  return { network: n, key, canonicalPath: `/market/${n.slug}/${key}` };
}
export function marketLabel(network: NetworkId, key: string): string {
  const [a, b] = key.split(":");
  const market = registry.getMarket(network, a, b);
  return market
    ? displayTokens(market)
        .map((t) => t.symbol)
        .join(" / ")
    : `${a.slice(0, 6)}…${a.slice(-4)} / ${b.slice(0, 6)}…${b.slice(-4)}`;
}
export const isNetworkSlug = (value: string): value is NetworkSlug =>
  networks.some((network) => network.slug === value);
