import {
  DEFAULT_DURATION,
  DISCOVERY_DEFAULTS,
  type MarketConfiguration,
  type NetworkId,
} from "@yld-cx/sdk";
import { canonicalPair } from "@yld-cx/sdk/registry";
import { isAddress } from "viem";
import { registry } from "./registry";

export const USD_ADDRESSES: Partial<Record<NetworkId, string>> = {
  "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:4663": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

export function trendingMarkets(
  network: NetworkId,
  addresses: readonly string[],
): MarketConfiguration[] {
  const quoteAddress = USD_ADDRESSES[network]?.toLowerCase();
  if (!quoteAddress) return [];
  const seen = new Set<string>([quoteAddress]);
  return addresses.flatMap((value) => {
    const address = value.toLowerCase();
    if (!isAddress(address) || seen.has(address)) return [];
    seen.add(address);
    const [a, b] = canonicalPair(network, address, quoteAddress);
    const key = `${a}:${b}`;
    return [
      registry.getMarket(network, a, b) ?? {
        network,
        key,
        token0: { network, address: a },
        token1: { network, address: b },
        defaultDuration: DEFAULT_DURATION,
        stepTicks: DISCOVERY_DEFAULTS.stepTicks,
      },
    ];
  });
}
