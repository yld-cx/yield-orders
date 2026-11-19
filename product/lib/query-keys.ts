import { PRODUCT_MARKET } from "@yld-cx/sdk";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import { pairKey } from "@yld-cx/sdk/registry";

export const QUERY_NAMES = {
  token: "token",
  tokenMetadata: "token-metadata",
  tokenDiscovery: "token-discovery",
  markets: "markets",
  pair: "pair",
  ticks: "ticks",
  quote: "quote",
  portfolio: "portfolio",
  deployment: "deployment",
  balance: "balance",
  assetTvl: "asset-tvl",
} as const;

function canonicalKey(network: string, key: string) {
  if (!key) return key; // Disabled Open Market query while selecting tokens.
  const [a, b] = key.split(":");
  return pairKey(getNetwork(network).id, a, b);
}

export const queryKeys = {
  assetTvl: (network: string, asset: string) =>
    [
      QUERY_NAMES.assetTvl,
      getNetwork(network).id,
      asset.toLowerCase(),
    ] as const,
  markets: (network: string, tag: string) =>
    [QUERY_NAMES.markets, getNetwork(network).id, tag] as const,
  balance: (network: string, token: string, owner?: string) =>
    [
      QUERY_NAMES.balance,
      getNetwork(network).id,
      token.toLowerCase(),
      owner?.toLowerCase(),
    ] as const,
  token: (network: string, address: string) =>
    [QUERY_NAMES.token, getNetwork(network).id, address.toLowerCase()] as const,
  tokenMetadata: (network: string, address: string) =>
    [
      QUERY_NAMES.tokenMetadata,
      getNetwork(network).id,
      address.toLowerCase(),
    ] as const,
  tokenDiscovery: (network: string) =>
    [QUERY_NAMES.tokenDiscovery, getNetwork(network).id] as const,
  pair: (network: string, key: string) =>
    [
      QUERY_NAMES.pair,
      getNetwork(network).id,
      canonicalKey(network, key),
    ] as const,
  ticks: (
    network: string,
    key: string,
    direction: 0 | 1,
    duration: typeof PRODUCT_MARKET.duration,
    stepTicks: number,
    canonicalTicks: readonly number[],
  ) =>
    [
      QUERY_NAMES.ticks,
      getNetwork(network).id,
      canonicalKey(network, key),
      direction,
      duration,
      stepTicks,
      canonicalTicks,
    ] as const,
  reference: (network: string, key: string) =>
    [
      "market-price",
      getNetwork(network).id,
      canonicalKey(network, key),
    ] as const,
  quote: (
    network: string,
    key: string,
    tickId: bigint | undefined,
    amount: bigint,
  ) =>
    [
      QUERY_NAMES.quote,
      getNetwork(network).id,
      canonicalKey(network, key),
      tickId?.toString(),
      amount.toString(),
    ] as const,
  portfolio: (network: string, owner?: string) =>
    [
      QUERY_NAMES.portfolio,
      getNetwork(network).id,
      owner?.toLowerCase(),
    ] as const,
  deployment: (network: string) =>
    [QUERY_NAMES.deployment, getNetwork(network).id] as const,
};
