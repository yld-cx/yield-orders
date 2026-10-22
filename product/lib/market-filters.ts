import {
  DEFAULT_DURATION,
  DURATIONS,
  type Duration,
  type Category,
} from "@yld-cx/sdk";
import { categorySchema } from "@yld-cx/sdk/registry";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";
import { isNetworkSlug } from "./registry";

export const enum MarketTab {
  Trending = "trending",
  YieldList = "all",
}

export const MARKET_TAGS = [
  MarketTab.Trending,
  MarketTab.YieldList,
  ...categorySchema.options,
] as const;
export interface MarketFilters {
  search: string;
  tag: Category | MarketTab;
  duration: Duration;
  network: NetworkSlug;
  page: number;
}

export function parseMarketFilters(
  params: Pick<URLSearchParams, "get">,
  fallbackNetwork: NetworkSlug,
): MarketFilters {
  const network = params.get("network");
  const page = Number(params.get("page"));
  return {
    search: params.get("search") ?? "",
    tag:
      MARKET_TAGS.find((tag) => tag === params.get("tag")) ??
      MarketTab.YieldList,
    duration:
      DURATIONS.find(
        (duration) => String(duration) === params.get("duration"),
      ) ?? DEFAULT_DURATION,
    network: network && isNetworkSlug(network) ? network : fallbackNetwork,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export function marketFilterParams(
  filters: MarketFilters,
  existing = new URLSearchParams(),
): URLSearchParams {
  const params = new URLSearchParams(existing);
  if (filters.search) params.set("search", filters.search);
  else params.delete("search");
  params.set("tag", filters.tag);
  params.set("duration", String(filters.duration));
  params.set("network", filters.network);
  if (filters.page > 1) params.set("page", String(filters.page));
  else params.delete("page");
  return params;
}
