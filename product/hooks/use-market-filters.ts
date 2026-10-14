"use client";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useNetwork } from "@/components/layout/providers";
import {
  marketFilterParams,
  parseMarketFilters,
  type MarketFilters,
} from "@/lib/market-filters";

export function useMarketFilters() {
  const params = useSearchParams();
  const { network } = useNetwork();
  const filters = parseMarketFilters(params, network);
  const query = marketFilterParams(
    filters,
    new URLSearchParams(params),
  ).toString();
  useEffect(() => {
    if (query !== window.location.search.slice(1)) {
      window.history.replaceState(null, "", `?${query}${window.location.hash}`);
    }
  }, [query]);

  function updateFilters(patch: Partial<MarketFilters>, replace = false) {
    const current = new URLSearchParams(window.location.search);
    const next = marketFilterParams(
      { ...parseMarketFilters(current, network), ...patch },
      current,
    );
    const url = `?${next}${window.location.hash}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }
  return { ...filters, updateFilters };
}
