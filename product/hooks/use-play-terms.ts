"use client";

import { useQuery } from "@tanstack/react-query";
import { PRODUCT_MARKET, QUERY_TIMING, type MarketConfiguration } from "@yld-cx/sdk";
import { getNetwork, snappedPrice, tokenAmount, decimalFraction, formatRatio } from "@yld-cx/sdk/ethereum";
import { formatUnits } from "viem";
import { useMarket } from "@/hooks/use-market";
import { playAddresses } from "@/lib/play-market";
import { displayReference, type MarketReference } from "@/lib/market-reference";
import { bookWindow, initialBookWindow } from "@/lib/market-selection";
import { isRentalPlay, playDecimal, scenarioNumber, type PlayStrategy } from "@/lib/play";
import { queryKeys } from "@/lib/query-keys";
import { getSdk } from "@/lib/rpc";
import { marginalTermYield } from "@/lib/yield";

export function usePlayMarket(config: MarketConfiguration, metadataEntry?: string) {
  const network = getNetwork(config.network).slug;
  const result = useMarket(network, config.key);
  const reference = useQuery({
    queryKey: queryKeys.reference(network, config.key),
    queryFn: async (): Promise<MarketReference> => {
      const [a, b] = config.key.split(":");
      const params = new URLSearchParams({ chainId: String(getNetwork(network).chain.id), tokenA: a, tokenB: b });
      const response = await fetch(`/api/market-price?${params}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("Reference unavailable");
      return response.json();
    },
    staleTime: PRODUCT_MARKET.referenceCacheSeconds * 1000,
  });
  const [assetAddress, quoteAddress] = playAddresses(config);
  const asset = result.market?.token0.address === assetAddress ? result.market.token0 : result.market?.token1;
  const quote = result.market?.token0.address === quoteAddress ? result.market.token0 : result.market?.token1;
  const inverse = config.token0.address !== assetAddress;
  const live = reference.isError || !reference.data ? undefined :
    displayReference(reference.data, inverse, "amm") ?? displayReference(reference.data, inverse, "meta");
  const candidate = live ? playDecimal(Number(live)) : "";
  const liveEntry = scenarioNumber(candidate) !== undefined ? candidate : metadataEntry;
  return { ...result, network, asset, quote, liveEntry, referencePending: reference.isPending };
}

// Read only the selected market and a bounded price window. No new indexer.
export function usePlayTerms(
  market: ReturnType<typeof usePlayMarket>,
  strategy: PlayStrategy,
  amount: string,
  order: string,
  scenarioEntry?: string,
) {
  const { asset, quote, network, pairId, liveEntry } = market;
  const rental = isRentalPlay(strategy);
  const suppliedQuote = strategy === "long" || strategy === "buy-the-dip";
  const supplied = suppliedQuote ? quote : asset;
  const locked = suppliedQuote ? asset : quote;
  const direction = supplied?.address === market.market?.token0.address ? 0 : 1;
  let center: number | undefined;
  let raw = 0n;
  try {
    const price = rental ? liveEntry : order;
    if (asset && quote && price && scenarioNumber(price) !== undefined) {
      const snapped = snappedPrice(price, asset.decimals, quote.decimals, PRODUCT_MARKET.stepTicks);
      center = asset.address === market.market?.token0.address ? snapped.priceTick : -snapped.priceTick;
    }
    if (rental && supplied && scenarioNumber(amount) !== undefined && scenarioEntry) {
      if (suppliedQuote) raw = tokenAmount(amount, supplied.decimals);
      else {
        const [a, b] = decimalFraction(amount);
        const [c, d] = decimalFraction(scenarioEntry);
        if (c > 0n) raw = tokenAmount(formatRatio(a * d, b * c, supplied.decimals), supplied.decimals);
      }
    }
  } catch {
    // Invalid or out-of-grid scenario. Keep the calculator usable without a quote.
  }
  const ticks = center === undefined ? [] : rental ? bookWindow(initialBookWindow(center)) : [center];
  const key = market.market?.key ?? "";
  const enabled = !!market.pair.data?.[3] && ticks.length > 0 && !!supplied && !market.error;
  const discovery = useQuery({
    queryKey: queryKeys.ticks(network, key, direction, PRODUCT_MARKET.duration, PRODUCT_MARKET.stepTicks, ticks),
    queryFn: () => getSdk(network).discover(pairId, {
      canonicalTicks: ticks, direction, duration: PRODUCT_MARKET.duration, stepTicks: PRODUCT_MARKET.stepTicks,
    }),
    enabled,
    staleTime: QUERY_TIMING.marketRefresh,
    refetchInterval: enabled ? QUERY_TIMING.liveRefresh : false,
  });
  const reads = enabled && !discovery.isError ? discovery.data?.reads ?? [] : [];
  const canonical = (identity: { direction: number; priceTick: number }) =>
    identity.direction === 0 ? identity.priceTick : -identity.priceTick;
  const candidates = reads.flatMap((read) => read.status === "exists" ? [read] : [])
    .filter((read) => !rental || (raw > 0n && read.tick.state.availableSupply >= raw))
    .sort((a, b) => Math.abs(canonical(a.identity) - (center ?? 0)) - Math.abs(canonical(b.identity) - (center ?? 0)));
  const chosen = candidates[0];
  const quoted = useQuery({
    queryKey: queryKeys.quote(network, key, chosen?.identity.id, raw),
    queryFn: () => getSdk(network).quoteUse(chosen!.identity.id, raw),
    enabled: rental && !!chosen && raw > 0n,
    refetchInterval: rental && chosen ? QUERY_TIMING.liveRefresh : false,
  });
  const fullTermRate = rental && chosen && !quoted.isError && quoted.data && raw > 0n
    ? Number(quoted.data[1]) / Number(raw) * 100
    : undefined;
  // Provider estimate: indicative marginal rental yield less the 1% protocol fee,
  // assuming the full supplied amount participates and is repaid. Not an allocation quote.
  const providerRate = !rental && chosen ? marginalTermYield(chosen.tick.state) : undefined;
  const candidateRate = rental ? fullTermRate : providerRate === undefined ? undefined : providerRate * 99;
  const rate = candidateRate !== undefined && Number.isFinite(candidateRate) && candidateRate >= 0
    ? Number(playDecimal(candidateRate)) : undefined;
  const tick = rental ? (chosen ? canonical(chosen.identity) : undefined) : center;
  const collateral = rental && chosen && quoted.data && !quoted.isError && locked
    ? formatUnits(quoted.data[0], locked.decimals) + " " + locked.symbol : undefined;
  const pending = market.isPending || market.referencePending || (enabled && discovery.isPending) ||
    (rental && !!chosen && quoted.isPending);
  const failed = !!market.error || discovery.isError || (rental && !!chosen && quoted.isError) ||
    reads.some((read) => read.status === "failed");
  const status = pending ? "Checking liquidity…"
    : rental && rate !== undefined ? "Rental quote available"
    : failed ? "Some market reads unavailable"
    : !market.pair.data?.[3] ? "Market is not open"
    : rental && raw === 0n ? "Enter a supported rental amount"
    : rental ? "No matching rental liquidity in the checked price range"
    : rate === undefined ? "No rental estimate at this price" : "Indicative rental Yield";
  return { rate, tick, collateral, status, pending };
}
