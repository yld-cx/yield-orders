import "server-only";
import { unstable_cache } from "next/cache";
import {
  DISCOVERY_DEFAULTS,
  DURATIONS,
  type Duration,
  type Market,
  type MarketConfiguration,
  type Token,
} from "@yld-cx/sdk";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { displayTokens } from "@yld-cx/sdk/registry";
import { erc20Abi, type Address } from "viem";
import { registry } from "@/lib/registry";
import { getSdk } from "@/lib/rpc";
import { fallbackToken, fetchTokenMetadata } from "@/lib/token-metadata";
import { calculatedBaseTick } from "@/lib/market-values";
import { bidLiquidity, compareBidLiquidity } from "@/lib/market-liquidity";
import { MARKET_CACHE_SECONDS } from "@/lib/market-list";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";
import { discoverTokens } from "@/server/token-discovery";

type Rankings = Record<Duration, MarketConfiguration[]>;

// Coalesce cold cache misses and revalidations within each server instance.
// Retain only in-flight work; Next owns the daily result cache.
function coalesce<T>(
  pending: Map<NetworkSlug, Promise<T>>,
  network: NetworkSlug,
  load: () => Promise<T>,
) {
  let result = pending.get(network);
  if (!result) {
    result = load().finally(() => pending.delete(network));
    pending.set(network, result);
  }
  return result;
}

async function loadRankings(network: NetworkSlug): Promise<Rankings> {
  const id = getNetwork(network).id;
  const configs = registry.getMarkets(id);
  if (!configs.length) return { 7: [], 30: [] };
  const sdk = getSdk(network);
  const addresses = [
    ...new Set(configs.flatMap((m) => [m.token0.address, m.token1.address])),
  ];
  const [metadata, blockNumber] = await Promise.all([
    fetchTokenMetadata(id, addresses),
    sdk.publicClient.getBlockNumber(),
  ]);
  const metadataByAddress = new Map(
    metadata.map((token) => [token.address, token]),
  );
  const tokens = new Map<string, Promise<Token>>();
  function token(address: string) {
    let pending = tokens.get(address);
    if (!pending) {
      const remote = metadataByAddress.get(address);
      // Sorting needs decimals and a symbol. Use discovery identity when known;
      // keep decimals authoritative without reading onchain name/symbol again.
      pending =
        remote?.status === "available" &&
        remote.symbol !== fallbackToken(id, address).symbol
          ? sdk.publicClient
              .readContract({
                address: address as Address,
                abi: erc20Abi,
                functionName: "decimals",
              })
              .then((decimals) => ({ ...remote, decimals, listed: true }))
          : sdk.tokenMetadata(address as Address).then((onchain) => ({
              ...onchain,
              priceUsd:
                remote?.status === "available" ? remote.priceUsd : undefined,
            }));
      tokens.set(address, pending);
    }
    return pending;
  }
  const rows = new Array<{
    config: MarketConfiguration;
    liquidity: Record<Duration, ReturnType<typeof bidLiquidity>>;
  }>(configs.length);
  let next = 0;
  let stopped = false;
  // Both durations share pair, token and block reads in one bounded daily scan.
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(8, configs.length) }, async () => {
      try {
        while (!stopped && next < configs.length) {
          const index = next++;
          const config = configs[index];
          const pair = await sdk.getPair(
            config.token0.address as Address,
            config.token1.address as Address,
            blockNumber,
          );
          if (!pair[3]) {
            rows[index] = {
              config,
              liquidity: {
                7: { available: 0n, decimals: 0 },
                30: { available: 0n, decimals: 0 },
              },
            };
            continue;
          }
          const [token0, token1] = await Promise.all([
            token(config.token0.address),
            token(config.token1.address),
          ]);
          const market: Market = {
            ...config,
            token0,
            token1,
            baseTick:
              calculatedBaseTick(token0, token1, config.stepTicks) ??
              config.baseTick ??
              DISCOVERY_DEFAULTS.baseTick,
          };
          const bidToken = displayTokens(market)[1];
          const discovery = await sdk.discover(pair[0], {
            baseTick: market.baseTick,
            stepTicks: market.stepTicks,
            direction: bidToken.address === token0.address ? 0 : 1,
            blockNumber,
          });
          if (
            !discovery.complete ||
            discovery.reads.some((r) => r.status === "failed")
          )
            throw new Error("Market liquidity unavailable");
          const ticks = discovery.reads.flatMap((r) =>
            r.status === "exists" ? [r.tick] : [],
          );
          rows[index] = {
            config,
            liquidity: {
              7: bidLiquidity(market, ticks, 7),
              30: bidLiquidity(market, ticks, 30),
            },
          };
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }),
  );
  const failed = outcomes.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return Object.fromEntries(
    DURATIONS.map((duration) => [
      duration,
      [...rows]
        .sort((a, b) =>
          compareBidLiquidity(a.liquidity[duration], b.liquidity[duration]),
        )
        .map((r) => r.config),
    ]),
  ) as Rankings;
}

const rankingLoads = new Map<NetworkSlug, Promise<Rankings>>();
const getRankings = unstable_cache(
  (network: NetworkSlug) =>
    coalesce(rankingLoads, network, () => loadRankings(network)),
  ["market-rankings", JSON.stringify(registry.data)],
  { revalidate: MARKET_CACHE_SECONDS },
);

export async function getSortedMarkets(
  network: NetworkSlug,
  duration: Duration,
) {
  return (await getRankings(network))[duration];
}

const trendingLoads = new Map<NetworkSlug, Promise<MarketConfiguration[]>>();
export const getTrendingMarkets = unstable_cache(
  (network: NetworkSlug) =>
    coalesce(trendingLoads, network, async () => {
      const id = getNetwork(network).id;
      if (!USD_ADDRESSES[id]) return [];
      const tokens = await discoverTokens(network);
      return trendingMarkets(
        id,
        tokens.map((token) => token.address),
      );
    }),
  ["trending-markets", JSON.stringify(registry.data)],
  { revalidate: MARKET_CACHE_SECONDS },
);
