import type { MarketConfiguration } from "@yld-cx/sdk";

export const MARKET_PAGE_SIZE = 10;
export const MARKET_CACHE_SECONDS = 86400;

export interface MarketList {
  markets: (MarketConfiguration & { assetTLV?: string })[];
}
