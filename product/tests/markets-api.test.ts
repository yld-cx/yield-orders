import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/markets/route";
import { registry } from "@/lib/registry";
import { getTrendingMarkets } from "@/server/markets";
const mocks = vi.hoisted(() => ({
  sdk: vi.fn(),
  discovery: vi.fn(),
  caches: [] as { keys: string[]; revalidate: number }[],
}));
vi.mock("@/lib/rpc", () => ({ getSdk: mocks.sdk }));
vi.mock("@/server/token-discovery", () => ({
  discoverTokens: mocks.discovery,
}));
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: unknown,
    keys: string[],
    options: { revalidate: number },
  ) => {
    mocks.caches.push({ keys, ...options });
    return fn;
  },
}));
const configs = registry.getMarkets("eip155:8453");
const request = (query = "chainId=8453") =>
  new Request(`https://yld.cx/api/markets?${query}`);
beforeEach(() => {
  mocks.sdk.mockClear();
  mocks.discovery
    .mockReset()
    .mockResolvedValue([
      { address: "0xffffffffffffffffffffffffffffffffffffffff" },
      { address: configs[0].token0.address },
    ]);
});
describe("lightweight market explorer", () => {
  it.each([
    "chainId=8453",
    "chainId=8453&tag=all",
    "chainId=8453&search=ignored&page=999",
  ])("returns registry order without any RPC: %s", async (query) => {
    expect(await (await GET(request(query))).json()).toEqual({
      markets: configs,
    });
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.discovery).not.toHaveBeenCalled();
  });
  it("discovers trending tokens without tick scans and caches for one day", async () => {
    const body = await (await GET(request("chainId=8453&tag=trending"))).json();
    expect(body.markets).toHaveLength(2);
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.caches).toContainEqual({
      keys: ["trending-markets-v2", JSON.stringify(registry.data)],
      revalidate: 86400,
    });
  });
  it("retries empty discovery instead of caching an empty list for a day", async () => {
    mocks.discovery.mockResolvedValueOnce([]);
    expect(await getTrendingMarkets("base")).toEqual([]);
    expect(await getTrendingMarkets("base")).toHaveLength(2);
    expect(mocks.discovery).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent trending misses", async () => {
    await Promise.all([getTrendingMarkets("base"), getTrendingMarkets("base")]);
    expect(mocks.discovery).toHaveBeenCalledTimes(1);
  });
  it("keeps listed markets accessible after discovery failure", async () => {
    mocks.discovery.mockRejectedValueOnce(new Error("private upstream error"));
    const response = await GET(request("chainId=8453&tag=trending"));
    expect(await response.json()).toEqual({ markets: configs });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.sdk).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "chainId=10",
    "chainId=8453&chainId=1",
    "chainId=8453&duration=14",
    "chainId=8453&duration=7",
    "chainId=8453&duration=30",
    "chainId=8453&duration=7&duration=30",
    "chainId=8453&tag=invalid",
    "chainId=8453&tag=all&tag=trending",
  ])("preserves request validation: %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.sdk).not.toHaveBeenCalled();
  });
});
