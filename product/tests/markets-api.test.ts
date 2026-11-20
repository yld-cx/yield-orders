import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/markets/route";
import { registry } from "@/lib/registry";
import { getTrendingMarkets } from "@/server/markets";
const mocks = vi.hoisted(() => ({
  sdk: vi.fn(),
  discovery: vi.fn(),
  metadata: vi.fn(),
  liability: vi.fn(),
}));
vi.mock("@/lib/rpc", () => ({ getSdk: mocks.sdk }));
vi.mock("@/lib/token-metadata", () => ({
  fetchTokenMetadata: mocks.metadata,
}));
vi.mock("@/server/token-discovery", () => ({
  discoverTokens: mocks.discovery,
}));
const configs = registry.getMarkets("eip155:8453");
const quote = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const assetOf = (market: (typeof configs)[number]) =>
  [market.token0.address, market.token1.address].find(
    (address) => address !== quote,
  )!;
const metadata = registry.getTokens("eip155:8453").map((token) => ({
  ...token,
  status: "available",
  symbol: token.address === quote ? "USDC" : "ASSET",
  name: "Token",
}));
const request = (query = "chainId=8453") =>
  new Request(`https://yld.cx/api/markets?${query}`);
beforeEach(() => {
  mocks.sdk.mockReset().mockReturnValue({ tokenLiability: mocks.liability });
  mocks.liability.mockReset().mockResolvedValue(0n);
  mocks.metadata.mockReset().mockResolvedValue(metadata);
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
  ])(
    "returns funded markets first in a cacheable response: %s",
    async (query) => {
      mocks.liability.mockImplementation(async (asset) =>
        asset === assetOf(configs[2])
          ? 1n
          : asset === assetOf(configs[10])
            ? 1000n
            : 0n,
      );
      const response = await GET(request(query));
      expect(await response.json()).toEqual({
        markets: [
          configs[2],
          configs[10],
          ...configs.filter((_, index) => index !== 2 && index !== 10),
        ].map((market) =>
          market === configs[2]
            ? { ...market, assetTVL: "1" }
            : market === configs[10]
              ? { ...market, assetTVL: "1000" }
              : market,
        ),
      });
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=86400",
      );
      expect(mocks.sdk).toHaveBeenCalledExactlyOnceWith("base");
      expect(mocks.liability).toHaveBeenCalledTimes(
        new Set(configs.map(assetOf)).size,
      );
      expect(mocks.liability).not.toHaveBeenCalledWith(quote);
      expect(mocks.discovery).not.toHaveBeenCalled();
    },
  );
  it("preserves YieldList order and omits assetTVL when all asset TVLs are zero", async () => {
    const response = await GET(request());
    expect(await response.json()).toEqual({ markets: configs });
  });
  it("preserves raw asset TVL precision without adding liability reads", async () => {
    const amount = (1n << 200n) + 123n;
    mocks.liability.mockImplementation(async (asset) =>
      asset === assetOf(configs[0]) ? amount : 0n,
    );
    const body = await (await GET(request())).json();
    expect(
      body.markets.find(
        (market: { key: string }) => market.key === configs[0].key,
      ).assetTVL,
    ).toBe(amount.toString());
    expect(mocks.liability).toHaveBeenCalledTimes(
      new Set(configs.map(assetOf)).size,
    );
    expect(configs[0]).not.toHaveProperty("assetTVL");
  });
  it("coalesces concurrent YieldList sorting checks", async () => {
    await Promise.all([GET(request()), GET(request())]);
    expect(mocks.metadata).toHaveBeenCalledTimes(1);
    expect(mocks.liability).toHaveBeenCalledTimes(
      new Set(configs.map(assetOf)).size,
    );
  });
  it("falls back to the default YieldList on an RPC failure and retries on the next request", async () => {
    mocks.liability.mockRejectedValueOnce(new Error("RPC unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ markets: configs });
    expect(response.headers.get("cache-control")).toBe("no-store");
    mocks.liability.mockResolvedValue(1n);
    expect((await GET(request())).headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=86400",
    );
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
  });
  it("falls back to the default YieldList when asset metadata is unavailable", async () => {
    mocks.metadata.mockResolvedValueOnce(
      metadata.map((token) => ({ ...token, status: "unavailable" })),
    );
    const response = await GET(request());
    expect(await response.json()).toEqual({ markets: configs });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.sdk).not.toHaveBeenCalled();
  });
  it("discovers trending tokens without tick scans and caches for one day", async () => {
    const response = await GET(request("chainId=8453&tag=trending"));
    const body = await response.json();
    expect(body.markets).toHaveLength(2);
    expect(body.markets[0].key).toContain(
      "0xffffffffffffffffffffffffffffffffffffffff",
    );
    expect(
      body.markets.every(
        (market: { assetTVL?: string }) => !Object.hasOwn(market, "assetTVL"),
      ),
    ).toBe(true);
    expect(mocks.sdk).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=86400",
    );
  });
  it("retries empty discovery instead of caching an empty list for a day", async () => {
    mocks.discovery.mockResolvedValueOnce([]);
    const response = await GET(request("chainId=8453&tag=trending"));
    expect(await response.json()).toEqual({ markets: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(
      (await (await GET(request("chainId=8453&tag=trending"))).json()).markets,
    ).toHaveLength(2);
    expect(mocks.discovery).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent trending misses", async () => {
    await Promise.all([getTrendingMarkets("base"), getTrendingMarkets("base")]);
    expect(mocks.discovery).toHaveBeenCalledTimes(1);
    await getTrendingMarkets("base");
    expect(mocks.discovery).toHaveBeenCalledTimes(2);
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
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.sdk).not.toHaveBeenCalled();
  });
});
