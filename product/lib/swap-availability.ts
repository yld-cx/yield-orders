import { address, swapNetwork } from "@yld-cx/sdk/uniswap";

export function walletSwapAvailable(chainId: number, a: string, b: string) {
  if (!swapNetwork(chainId)) return false;
  try {
    return address(a) !== address(b);
  } catch {
    return false;
  }
}
