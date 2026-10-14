"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Market, TickState } from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
export interface BookTick {
  id: bigint;
  state: TickState;
  priceTick?: number;
}
export function useYieldBook(market: Market, pairId: bigint, enabled = true) {
  const network = getNetwork(market.network).slug as NetworkSlug,
    sdk = getSdk(network);
  const discovery = useInfiniteQuery({
    queryKey: ["ticks", network, market.key, "book"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      sdk.discover(pairId, {
        baseTick: market.baseTick,
        stepTicks: market.stepTicks,
        radius: Math.min(pageParam + 4, 128),
        startRadius: pageParam === 0 ? 0 : pageParam + 1,
      }),
    getNextPageParam: (last) => (last.radius >= 128 ? undefined : last.radius),
    staleTime: Infinity,
    enabled,
  });
  const knownIds = [...sdk.knownTicks.values()]
    .filter((t) => t.pairId === pairId)
    .map((t) => t.id.toString())
    .sort()
    .join(",");
  const live = useQuery({
    queryKey: ["known-ticks", network, market.key, knownIds],
    queryFn: () => sdk.refreshKnownTicks(pairId),
    enabled: !!discovery.data,
    refetchInterval: 15000,
    staleTime: 0,
  });
  const readsById: BookTick[] =
    live.data ??
    discovery.data?.pages.flatMap((p) =>
      p.reads.flatMap((r) => (r.status === "exists" ? [r.tick] : [])),
    ) ??
    [];
  const ticks = [...new Map(readsById.map((tick) => [tick.id, tick])).values()];
  const reads = discovery.data?.pages.flatMap((p) => p.reads) ?? [];
  return {
    discovery,
    live,
    ticks,
    checked: reads.length,
    missing: reads.filter((r) => r.status === "missing").length,
    failed: reads.filter((r) => r.status === "failed").length,
    radius: discovery.data?.pages.at(-1)?.radius ?? 0,
  };
}
