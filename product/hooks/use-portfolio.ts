"use client";
import { queryKeys } from "@/lib/query-keys";
import { PORTFOLIO_DEFAULTS, QUERY_TIMING } from "@yld-cx/sdk";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { getSdk } from "@/lib/rpc";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";

export function usePortfolio(network: NetworkSlug) {
  const account = useConnection();
  return useInfiniteQuery({
    queryKey: queryKeys.portfolio(network, account.address),
    initialPageParam: {
      offset: PORTFOLIO_DEFAULTS.offset as number,
      block: undefined as bigint | undefined,
    },
    queryFn: ({ pageParam }) =>
      getSdk(network).portfolio(
        account.address!,
        pageParam.offset,
        PORTFOLIO_DEFAULTS.limit,
        pageParam.block,
      ),
    getNextPageParam: (last) =>
      last.hasMore
        ? {
            offset: last.offset + PORTFOLIO_DEFAULTS.limit,
            block: last.blockNumber,
          }
        : undefined,
    enabled: !!account.address,
    refetchInterval: QUERY_TIMING.marketRefresh,
  });
}
