import {
  DEFAULT_DURATION,
  DISCOVERY_DEFAULTS,
  type MarketConfiguration,
  type NetworkId,
} from "@yld-cx/sdk";
import { canonicalPair } from "@yld-cx/sdk/registry";
import { isAddress } from "viem";
import { registry } from "./registry";
import { fallbackToken, type TokenMetadata } from "./token-metadata";

const USD_ADDRESSES: Partial<Record<NetworkId, string>> = {
  "eip155:1": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:4663": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

export function usdToken(network: NetworkId): TokenMetadata | undefined {
  const address = USD_ADDRESSES[network];
  if (!address) return;
  return {
    ...fallbackToken(network, address),
  };
}

export function trendingMarkets(
  network: NetworkId,
  tokens: readonly TokenMetadata[],
  search = "",
): MarketConfiguration[] {
  const quote = usdToken(network);
  if (!quote) return [];
  const words = search
    .toLowerCase()
    .trim()
    .replace(/\s*[/|]\s*/g, "/")
    .split(/\s+/);
  const seen = new Set<string>([quote.address]);
  return tokens.flatMap((token) => {
    const address = token.address.toLowerCase();
    if (token.network !== network || !isAddress(address) || seen.has(address))
      return [];
    seen.add(address);
    const [a, b] = canonicalPair(network, address, quote.address);
    const key = `${a}:${b}`;
    const text =
      `${key} ${token.symbol} ${token.name} ${quote.symbol} ${quote.name} ${token.symbol}/${quote.symbol} ${quote.symbol}/${token.symbol}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) return [];
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
