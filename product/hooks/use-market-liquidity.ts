"use client";

import { useQueries } from "@tanstack/react-query";
import {
  QUERY_TIMING,
  type Duration,
  type MarketConfiguration,
} from "@yld-cx/sdk";
import type { DiscoveryResult, NetworkSlug } from "@yld-cx/sdk/ethereum";
import { useMarkets } from "@/hooks/use-market";
import { queryKeys } from "@/lib/query-keys";
import { getSdk } from "@/lib/rpc";
import { bidLiquidity, compareBidLiquidity } from "@/lib/market-liquidity";
import { MarketSort } from "@/lib/market-filters";

export function useMarketLiquidity(
  network: NetworkSlug,
  configs: readonly MarketConfiguration[],
  duration: Duration,
  sortBy: MarketSort,
) {
  const results = useMarkets(
    network,
    configs.map((config) => config.key),
  );
  const queries = useQueries({
    queries: configs.map((config, i) => {
      const { market, pair } = results[i];
      return {
        queryKey: queryKeys.ticks(
          network,
          config.key,
          market?.baseTick,
          config.stepTicks,
          duration,
        ),
        enabled: !!market && !!pair.data,
        queryFn: async () => {
          if (!market) throw new Error("Token metadata unavailable");
          if (!pair.data![3])
            return { reads: [], complete: true, radius: 0, blockNumber: 0n };
          return getSdk(network).discover(pair.data![0], {
            baseTick: market.baseTick,
            stepTicks: market.stepTicks,
            duration,
          });
        },
        select: (result: DiscoveryResult) => ({
          ticks: result.reads.flatMap((read) =>
            read.status === "exists" ? [read.tick] : [],
          ),
          failed: result.reads.filter((read) => read.status === "failed")
            .length,
          checked: result.reads.length,
        }),
        refetchInterval: QUERY_TIMING.marketRefresh,
      };
    }),
  });
  const rows = configs.map((config, i) => {
    const result = results[i];
    const query = queries[i];
    return {
      config,
      result,
      query,
      bidLiquidity:
        result.market && !result.error && query.isSuccess && !query.data.failed
          ? bidLiquidity(result.market, query.data.ticks, duration)
          : undefined,
    };
  });
  switch (sortBy) {
    case MarketSort.BidLiquidity:
      return rows.sort((a, b) =>
        compareBidLiquidity(a.bidLiquidity, b.bidLiquidity),
      );
    case MarketSort.SourceOrder:
      return rows;
  }
}
