"use client";
import { useQuery } from "@tanstack/react-query";
import { getSdk } from "@/lib/rpc";
import { registry } from "@/lib/registry";
import { DEFAULT_DURATION, type Market, type Token } from "@yld-cx/sdk";
import { getNetwork, pairIdFor, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { Address } from "viem";
export function useToken(
  network: NetworkSlug,
  address: string,
  enabled = true,
) {
  return useQuery<Token>({
    queryKey: ["token", network, address.toLowerCase()],
    initialData: () => registry.getToken(getNetwork(network).id, address),
    queryFn: async () =>
      registry.getToken(getNetwork(network).id, address) ??
      (await getSdk(network).tokenMetadata(address as Address)),
    staleTime: 3600000,
    enabled,
  });
}
export function useMarket(network: NetworkSlug, key: string) {
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
          stepTicks: config?.stepTicks ?? 1000,
          baseTick: config?.baseTick ?? 0,
          defaultDuration: config?.defaultDuration ?? DEFAULT_DURATION,
        }
      : undefined;
  const pair = useQuery({
    queryKey: ["pair", network, key],
    queryFn: () => getSdk(network).getPair(a as Address, b as Address),
    refetchInterval: 30000,
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
    queryKey: ["deployment", network],
    queryFn: async () => {
      await getSdk(network).verifyDeployment();
      return true;
    },
    staleTime: 60000,
  });
}
