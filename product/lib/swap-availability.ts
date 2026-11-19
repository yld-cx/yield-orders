import { Registry } from "@yld-cx/sdk/registry";
import yieldlist from "../public/yieldlist.json";
import { swapNetwork } from "@yld-cx/sdk/uniswap";

const registry = new Registry(yieldlist);

export function walletSwapAvailable(chainId: number, a: string, b: string) {
  if (!swapNetwork(chainId)) return false;
  try {
    return !!registry.getMarket(`eip155:${chainId}`, a, b);
  } catch {
    return false;
  }
}
