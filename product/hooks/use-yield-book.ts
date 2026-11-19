"use client";
import { useQuery } from "@tanstack/react-query";
import {
  PRODUCT_MARKET,
  QUERY_TIMING,
  type Direction,
  type Market,
  type Tick,
  type TickIdentity,
  type TickState,
} from "@yld-cx/sdk";
import {
  getNetwork,
  priceAtTick,
  tickCandidates,
  explainError,
  type DiscoveryRead,
} from "@yld-cx/sdk/ethereum";
import { queryKeys } from "@/lib/query-keys";
import { getSdk } from "@/lib/rpc";

export type BookTick = Tick;
export type BookLevel = TickIdentity & {
  asset: TickState["asset"];
  priceX128: bigint;
} & (
    | { status: "exists"; state: TickState }
    | { status: "missing"; state?: never }
    | { status: "failed"; error: string; state?: never }
  );

export function useYieldBook(
  market: Market,
  pairId: bigint,
  canonicalTicks: readonly number[],
  direction: Direction,
  enabled = true,
) {
  const network = getNetwork(market.network).slug;
  const discovery = useQuery({
    queryKey: queryKeys.ticks(
      network,
      market.key,
      direction,
      PRODUCT_MARKET.duration,
      PRODUCT_MARKET.stepTicks,
      canonicalTicks,
    ),
    queryFn: () =>
      getSdk(network).discover(pairId, {
        canonicalTicks,
        direction,
        duration: PRODUCT_MARKET.duration,
        stepTicks: PRODUCT_MARKET.stepTicks,
      }),
    enabled,
    staleTime: QUERY_TIMING.marketRefresh,
    refetchInterval: enabled ? QUERY_TIMING.liveRefresh : false,
  });
  const identities = canonicalTicks
    .flatMap((tick) =>
      tickCandidates(pairId, tick, PRODUCT_MARKET.stepTicks, 0),
    )
    .filter(
      (tick) =>
        tick.direction === direction &&
        tick.durationDays === PRODUCT_MARKET.duration,
    );
  const reads = new Map(
    discovery.data?.reads.map((read) => [read.identity.id, read]),
  );
  const levels: BookLevel[] = identities.map((identity) => {
    const read: DiscoveryRead | undefined = reads.get(identity.id);
    const base = {
      ...identity,
      asset: (direction === 0 ? market.token0 : market.token1)
        .address as TickState["asset"],
      priceX128: priceAtTick(identity.priceTick),
    };
    if (discovery.isError || !read)
      return {
        ...base,
        status: "failed",
        error: discovery.isError
          ? explainError(discovery.error)
          : "Price level unavailable",
      };
    if (read.status === "exists")
      return {
        ...base,
        status: "exists",
        priceX128: read.tick.state.priceX128,
        state: read.tick.state,
      };
    if (read.status === "failed")
      return { ...base, status: "failed", error: read.error };
    return { ...base, status: "missing" };
  });
  return {
    discovery,
    levels,
    ticks: levels.filter(
      (level): level is BookLevel & { status: "exists" } =>
        level.status === "exists",
    ),
    checked: discovery.data?.reads.length ?? 0,
    missing: levels.filter((level) => level.status === "missing").length,
    failed: levels.filter((level) => level.status === "failed").length,
  };
}
