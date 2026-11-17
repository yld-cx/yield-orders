import { parseAbi, type Address } from "viem";
import type { SwapChain } from "./types.ts";

export const ROUTE_VERSION = "2.1.2" as const;
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
export const permit2Abi = parseAbi([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
]);
const swapNetworks: Record<SwapChain, { router: Address; permit2: Address }> = {
  1: { router: "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85", permit2: PERMIT2 },
  8453: {
    router: "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
    permit2: PERMIT2,
  },
  4663: {
    router: "0x204FAca1764B154221e35c0d20aBb3c525710498",
    permit2: PERMIT2,
  },
};
export function swapNetwork(chainId: number) {
  return swapNetworks[chainId as SwapChain];
}
