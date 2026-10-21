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
export function useToken(
  network: NetworkSlug,
  address: string,
  enabled = true,
) {
  const metadata = useQuery({
    ...tokenMetadataOptions(network, address),
    enabled,
  });
  const onchain = useQuery({
    ...onchainTokenOptions(network, address),
    enabled,
  });
  return {
    ...onchain,
    isPending: onchain.isPending || metadata.isPending,
    data:
      onchain.data && !metadata.isPending
        ? resolveToken(onchain.data, metadata.data)
        : undefined,
  };
}
/** Full tokens for views that need balances and onchain fallback search. */
export function useTokens(network: NetworkSlug, addresses: readonly string[]) {
  const unique = [
    ...new Set(addresses.map((address) => address.toLowerCase())),
  ];
  const metadata = useTokenMetadata(network, unique);
  const onchain = useQueries({
    queries: unique.map((address) => onchainTokenOptions(network, address)),
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

export function useMarket(network: NetworkSlug, key: string) {
  key = queryKeys.pair(network, key)[2];
  const [a, b] = key.split(":");
  const token0 = useToken(network, a),
    token1 = useToken(network, b);
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
  const pair = useQuery({
    queryKey: queryKeys.pair(network, key),
    queryFn: () => getSdk(network).getPair(a as Address, b as Address),
    refetchInterval: QUERY_TIMING.marketRefresh,
  });
  return {
    market,
    defaultDuration: config?.defaultDuration ?? DEFAULT_DURATION,
    pair,
    pairId: pairIdFor(a as Address, b as Address),
    error: token0.error ?? token1.error ?? pair.error,
    isPending: token0.isPending || token1.isPending || pair.isPending,
  };
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
