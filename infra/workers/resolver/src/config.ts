import type { Address } from "viem";
import type { SwapChain } from "@yld-cx/sdk/uniswap";

export const LIMITS = {
  markets: 1,
  candidates: 8,
  batch: 8,
  durationMs: 120000,
  quoteRequests: 40,
  discoveryRadius: 20,
  referencePriceImpact: 0.1,
  slippage: 0.5,
  quoteValueUsd: 10000,
} as const;

export const chainConfig: Record<
  SwapChain,
  {
    wrappedNative: Address;
    accountingToken: Address;
    accountingDecimals: number;
    rpcUrls: readonly string[];
  }
> = {
  1: {
    wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    accountingToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    accountingDecimals: 6,
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://gateway.tenderly.co/public/mainnet",
    ],
  },
  8453: {
    wrappedNative: "0x4200000000000000000000000000000000000006",
    accountingToken: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    accountingDecimals: 6,
    rpcUrls: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  },
  4663: {
    wrappedNative: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    accountingToken: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    accountingDecimals: 6,
    rpcUrls: [
      "https://robinhood-rpc.publicnode.com",
      "https://rpc.mainnet.chain.robinhood.com",
    ],
  },
};
