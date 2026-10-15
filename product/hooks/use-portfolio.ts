"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import { getSdk } from "@/lib/rpc";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";

export function usePortfolio(network: NetworkSlug) {
  const account = useConnection();
  return useInfiniteQuery({
    queryKey: ["portfolio", network, account.address],
    initialPageParam: { offset: 0, block: undefined as bigint | undefined },
    queryFn: ({ pageParam }) =>
      getSdk(network).portfolio(
        account.address!,
        pageParam.offset,
        24,
        pageParam.block,
      ),
    getNextPageParam: (last) =>
      last.hasMore
        ? { offset: last.offset + 24, block: last.blockNumber }
        : undefined,
    enabled: !!account.address,
    refetchInterval: 30000,
  });
}
