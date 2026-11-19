"use client";

import { useQuery } from "@tanstack/react-query";
import { QUERY_TIMING } from "@yld-cx/sdk";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { Address } from "viem";
import { useToken } from "@/hooks/use-market";
import { queryKeys } from "@/lib/query-keys";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";

export function assetTvlOptions(network: string, asset: string) {
  return {
    queryKey: queryKeys.assetTvl(network, asset),
    queryFn: () => getSdk(network).tokenLiability(asset as Address),
    staleTime: QUERY_TIMING.marketRefresh,
    refetchInterval: QUERY_TIMING.marketRefresh,
  };
}

export function useAssetTvl(network: NetworkSlug, asset: string) {
  const liability = useQuery(assetTvlOptions(network, asset));
  const token = useToken(network, asset);
  return liability.data !== undefined && token.data
    ? `${amountText(liability.data, token.data.decimals)} ${token.data.symbol}`
    : "—";
}
