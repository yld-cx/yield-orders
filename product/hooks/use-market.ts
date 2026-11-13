"use client";
import { queryKeys } from "@/lib/query-keys";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getSdk } from "@/lib/rpc";
import { registry } from "@/lib/registry";
import {
  DEFAULT_DURATION,
  DISCOVERY_DEFAULTS,
  QUERY_TIMING,
  type Market,
  type Token,
} from "@yld-cx/sdk";
import { getNetwork, pairIdFor, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { Address } from "viem";
import { tokenMetadataOptions, useTokenMetadata } from "./use-token-metadata";
import { fallbackToken, type TokenMetadata } from "@/lib/token-metadata";
import { calculatedBaseTick } from "@/lib/market-values";
function onchainTokenOptions(network: NetworkSlug, address: string) {
  return {
    queryKey: queryKeys.token(network, address),
    queryFn: () => getSdk(network).tokenMetadata(address as Address),
    staleTime: QUERY_TIMING.tokenMetadataStale,
  };
}
function resolveToken(onchain: Token, remote?: TokenMetadata): Token {
  return {
    ...onchain,
    ...(remote?.status === "available"
      ? {
          symbol:
            remote.symbol ===
            fallbackToken(onchain.network, onchain.address).symbol
              ? onchain.symbol
              : remote.symbol,
          name: remote.name === "Token" ? onchain.name : remote.name,
          imageUrl: remote.imageUrl,
          priceUsd: remote.priceUsd,
        }
      : {}),
    listed: !!registry.getToken(onchain.network, onchain.address),
  };
}
function useTokenQueries(
  network: NetworkSlug,
  addresses: readonly string[],
  enabled = true,
) {
  const metadata = useQueries({
    queries: addresses.map((address) => ({
      ...tokenMetadataOptions(network, address),
      enabled,
    })),
  });
  const onchain = useQueries({
    queries: addresses.map((address) => ({
      ...onchainTokenOptions(network, address),
      enabled,
    })),
  });
  return onchain.map((query, i) => ({
    ...query,
    isPending: query.isPending || metadata[i].isPending,
    data:
      query.data && !metadata[i].isPending
        ? resolveToken(query.data, metadata[i].data)
        : undefined,
  }));
}
export function useToken(
  network: NetworkSlug,
  address: string,
  enabled = true,
) {
  return useTokenQueries(network, [address], enabled)[0];
}
/** Full tokens for views that need balances and onchain fallback search. */
export function useTokens(
  network: NetworkSlug,
  addresses: readonly string[],
  enabled = true,
) {
  const unique = [
    ...new Set(addresses.map((address) => address.toLowerCase())),
  ];
  const metadata = useTokenMetadata(network, unique);
  const onchain = useQueries({
    queries: unique.map((address) => ({
      ...onchainTokenOptions(network, address),
      enabled,
    })),
  });
  return onchain.flatMap((query) =>
    query.data
      ? [
          resolveToken(
            query.data,
            metadata.find((token) => token.address === query.data.address),
          ),
        ]
      : [],
  );
}

export function useMarkets(network: NetworkSlug, keys: readonly string[]) {
  const canonicalKeys = keys.map((key) => queryKeys.pair(network, key)[2]);
  const addresses = [
    ...new Set(canonicalKeys.flatMap((key) => key.split(":"))),
  ];
  const tokens = useTokenQueries(network, addresses);
  const pairs = useQueries({
    queries: canonicalKeys.map((key) => {
      const [a, b] = key.split(":");
      return {
        queryKey: queryKeys.pair(network, key),
        queryFn: () => getSdk(network).getPair(a as Address, b as Address),
        refetchInterval: QUERY_TIMING.marketRefresh,
      };
    }),
  });
  return canonicalKeys.map((key, i) => {
    const [a, b] = key.split(":");
    const token0 = tokens[addresses.indexOf(a)];
    const token1 = tokens[addresses.indexOf(b)];
    const pair = pairs[i];
    const config = registry.getMarket(getNetwork(network).id, a, b);
    const market: Market | undefined =
      token0.data && token1.data
        ? {
            network: getNetwork(network).id,
            key,
            token0: token0.data as Token,
            token1: token1.data as Token,
            stepTicks: config?.stepTicks ?? DISCOVERY_DEFAULTS.stepTicks,
            baseTick:
              calculatedBaseTick(
                token0.data,
                token1.data,
                config?.stepTicks ?? DISCOVERY_DEFAULTS.stepTicks,
              ) ??
              config?.baseTick ??
              DISCOVERY_DEFAULTS.baseTick,
            tags: config?.tags,
            telegramPost: config?.telegramPost,
            defaultDuration: config?.defaultDuration ?? DEFAULT_DURATION,
          }
        : undefined;
    return {
      market,
      defaultDuration: config?.defaultDuration ?? DEFAULT_DURATION,
      pair,
      pairId: pairIdFor(a as Address, b as Address),
      error: token0.error ?? token1.error ?? pair.error,
      isPending: token0.isPending || token1.isPending || pair.isPending,
    };
  });
}
export function useMarket(network: NetworkSlug, key: string) {
  return useMarkets(network, [key])[0];
}
export function useDeployment(network: NetworkSlug) {
  return useQuery({
    queryKey: queryKeys.deployment(network),
    queryFn: async () => {
      await getSdk(network).verifyDeployment();
      return true;
    },
    staleTime: QUERY_TIMING.deploymentStale,
  });
}
