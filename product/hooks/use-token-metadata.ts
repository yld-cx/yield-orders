"use client";
import { queryKeys } from "@/lib/query-keys";
import { useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { QUERY_TIMING } from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { registry } from "@/lib/registry";
import {
  fallbackToken,
  loadTokenMetadata,
  selectorTokens,
  tokenImageUrl,
  type TokenMetadata,
} from "@/lib/token-metadata";

export function tokenMetadataOptions(network: NetworkSlug, address: string) {
  const id = getNetwork(network).id;
  const queryKey = queryKeys.tokenMetadata(network, address);
  return {
    queryKey,
    queryFn: async ({ client }: { client: QueryClient }) => {
      const token = await loadTokenMetadata(id, address);
      const previous = client.getQueryData<TokenMetadata>(queryKey);
      return token.status !== "available" && previous?.status === "available"
        ? {
            ...previous,
            stale: true,
            retryAfter: Math.floor(Date.now() / 1000) + 300,
          }
        : token;
    },
    staleTime: (query: {
      state: { data?: TokenMetadata; dataUpdatedAt?: number };
    }) => {
      const token = query.state.data;
      if (token?.retryAfter && token.retryAfter * 1000 > Date.now())
        return (
          token.retryAfter * 1000 - (query.state.dataUpdatedAt ?? Date.now())
        );
      return token?.status === "available" && !token.stale
        ? QUERY_TIMING.tokenMetadataStale
        : 300_000;
    },
    retry: false,
  };
}
export function useTokenMetadata(
  network: NetworkSlug,
  addresses: readonly string[],
) {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))];
  const queries = useQueries({
    queries: unique.map((address) => tokenMetadataOptions(network, address)),
  });
  return queries.flatMap((query) => (query.data ? [query.data] : []));
}
export function useDiscoveryTokens(network: NetworkSlug) {
  const id = getNetwork(network).id;
  const configured = registry.getTokens(id);
  const metadata = useTokenMetadata(
    network,
    configured.map((t) => t.address),
  );
  const query = useQuery({
    queryKey: queryKeys.tokenDiscovery(network),
    queryFn: async (): Promise<TokenMetadata[]> => {
      const response = await fetch(
        `/api/tokens?chainId=${getNetwork(network).chain.id}`,
      );
      if (!response.ok) throw new Error("Token discovery unavailable");
      const body = (await response.json()) as { tokens: TokenMetadata[] };
      return body.tokens.map((token) => ({
        ...fallbackToken(id, token.address),
        symbol: token.symbol,
        name: token.name,
        imageUrl: tokenImageUrl(token.imageUrl),
      }));
    },
    staleTime: 86400_000,
    retry: false,
  });
  return {
    ...query,
    tokens: selectorTokens(configured, query.data ?? [], metadata),
  };
}
