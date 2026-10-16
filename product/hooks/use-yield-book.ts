"use client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  DISCOVERY_DEFAULTS,
  QUERY_TIMING,
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
  baseTick = market.baseTick,
) {
  const network = getNetwork(market.network).slug;
  const discovery = useQuery({
    queryKey: [
      "ticks",
      network,
      market.key,
      "book",
      baseTick,
      market.stepTicks,
      DISCOVERY_DEFAULTS.radius,
    ],
    queryFn: () =>
      getSdk(network).discover(pairId, {
        baseTick,
        stepTicks: market.stepTicks,
      }),
    placeholderData: keepPreviousData,
    staleTime: QUERY_TIMING.marketRefresh,
    refetchInterval: QUERY_TIMING.liveRefresh,
  });
  const reads: DiscoveryRead[] =
    discovery.data?.reads ??
    (discovery.isError
      ? tickCandidates(pairId, baseTick, market.stepTicks).map((identity) => ({
          identity,
          status: "failed",
          error: explainError(discovery.error),
        }))
      : []);
  const levels: BookLevel[] = reads.map((read) => {
    const identity = read.identity;
    const asset = (identity.direction === 0 ? market.token0 : market.token1)
      .address as TickState["asset"];
    const priceX128 =
      read.status === "exists"
        ? read.tick.state.priceX128
        : priceAtTick(identity.priceTick);
    if (discovery.isError)
      return {
        ...identity,
        asset,
        priceX128,
        status: "failed",
        error: explainError(discovery.error),
      };
    if (read.status === "exists")
      return {
        ...identity,
        asset,
        priceX128,
        status: read.status,
        state: read.tick.state,
      };
    if (read.status === "failed")
      return {
        ...identity,
        asset,
        priceX128,
        status: read.status,
        error: read.error,
      };
    return { ...identity, asset, priceX128, status: read.status };
  });
  const ticks = levels.filter(
    (level): level is BookLevel & { status: "exists" } =>
      level.status === "exists",
  );
  return {
    baseTick,
    discovery,
    levels,
    ticks,
    checked: reads.length,
    missing: levels.filter((r) => r.status === "missing").length,
    failed: levels.filter((r) => r.status === "failed").length,
    radius: discovery.data?.radius ?? DISCOVERY_DEFAULTS.radius,
  };
}
