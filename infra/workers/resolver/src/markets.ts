import { boundedJson, address, record } from "@yld-cx/sdk/uniswap";
import { pairIdFor } from "@yld-cx/sdk/ethereum";
import type { Address } from "viem";
export interface MarketIdentity {
  pairId: bigint;
  token0: Address;
  token1: Address;
}
export async function markets(
  endpoint: string,
  chainId: number,
): Promise<MarketIdentity[]> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("HTTPS markets API URL required");
  url.searchParams.set("chainId", String(chainId));
  url.searchParams.set("tag", "all");
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Markets unavailable");
  const payload = record(await boundedJson(response));
  if (!Array.isArray(payload.markets) || payload.markets.length > 2000)
    throw new Error("Invalid markets");
  const seen = new Set<string>();
  return payload.markets.flatMap((value) => {
    try {
      const m = record(value);
      if (m.network !== `eip155:${chainId}`) return [];
      const [token0, token1] = [
        address(record(m.token0).address),
        address(record(m.token1).address),
      ].sort();
      if (token0 === token1) return [];
      const pairId = pairIdFor(token0, token1);
      if (seen.has(String(pairId))) return [];
      seen.add(String(pairId));
      return [{ pairId, token0, token1 }];
    } catch {
      return [];
    }
  });
}
export function roundRobin<T>(items: T[], cursor: number, limit: number) {
  return Array.from(
    { length: Math.min(items.length, limit) },
    (_, i) => items[(cursor + i) % items.length],
  );
}
