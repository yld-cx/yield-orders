import { beforeEach, describe, expect, it, vi } from "vitest";
import { Duration, DURATIONS, type Tick } from "@yld-cx/sdk";
import { displayTokens } from "@yld-cx/sdk/registry";
import { GET } from "@/app/api/markets/route";
import { registry } from "@/lib/registry";
import { getSortedMarkets, getTrendingMarkets } from "@/server/markets";
import { tokenFixture } from "./browser/token-fixtures";

const sdk = vi.hoisted(() => ({
  getPair: vi.fn(),
  tokenMetadata: vi.fn(),
  discover: vi.fn(),
  publicClient: { getBlockNumber: vi.fn(), readContract: vi.fn() },
}));
vi.mock("@/lib/rpc", () => ({ getSdk: () => sdk }));
const cacheConfigs = vi.hoisted(
  () => [] as { keys: string[]; revalidate: number }[],
);
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: unknown,
    keys: string[],
    options: { revalidate: number },
  ) => {
    cacheConfigs.push({ keys, revalidate: options.revalidate });
    return fn;
  },
}));
vi.mock("@/lib/token-metadata", async (original) => ({
  ...(await original<typeof import("@/lib/token-metadata")>()),
  fetchTokenMetadata: vi.fn(async (network, addresses: string[]) =>
    addresses.map((address) => ({
      network,
      address,
      ...tokenFixture(address),
      status: "available",
    })),
  ),
}));

const discovery = vi.hoisted(() => vi.fn());
vi.mock("@/server/token-discovery", () => ({ discoverTokens: discovery }));

const configs = registry.getMarkets("eip155:8453");
const request = (query = "chainId=8453&duration=7") =>
  new Request(`https://yld.cx/api/markets?${query}`);

beforeEach(() => {
  sdk.publicClient.getBlockNumber.mockReset().mockResolvedValue(123n);
  sdk.publicClient.readContract
    .mockReset()
    .mockImplementation(async ({ address }) => tokenFixture(address).decimals);
  discovery
    .mockReset()
    .mockResolvedValue([
      { address: "0xffffffffffffffffffffffffffffffffffffffff" },
      { address: configs[0].token0.address },
      { address: configs[0].token1.address },
      { address: configs[0].token0.address },
    ]);
  sdk.getPair
    .mockReset()
    .mockImplementation(async (a, b) => [
      BigInt(configs.findIndex((m) => m.key === `${a}:${b}`)),
      a,
      b,
      true,
    ]);
  sdk.tokenMetadata.mockReset().mockImplementation(async (address) => ({
    network: "eip155:8453",
    address,
    ...tokenFixture(address),
    listed: true,
  }));
  sdk.discover.mockReset().mockImplementation(async (pair: bigint) => {
    const config = configs[Number(pair)];
    const bid = displayTokens({
      token0: {
        address: config.token0.address,
        ...tokenFixture(config.token0.address),
      },
      token1: {
        address: config.token1.address,
        ...tokenFixture(config.token1.address),
      },
    })[1];
    return {
      complete: true,
      reads: DURATIONS.map((duration) => ({
        status: "exists",
        tick: {
          durationDays: duration,
          state: {
            asset: bid.address,
            availableSupply:
              BigInt(
                duration === Duration.Weekly
                  ? Number(pair) + 1
                  : configs.length - Number(pair),
              ) *
              10n ** BigInt(bid.decimals),
          },
        } as Tick,
      })),
    };
  });
});

describe("markets API", () => {
  it("caches both duration rankings together by network and registry revision for one day", () => {
    expect(cacheConfigs).toContainEqual({
      keys: ["market-rankings", JSON.stringify(registry.data)],
      revalidate: 86400,
    });
  });

  it("returns the full ranking and reads shared onchain tokens once", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.markets.map((m: { key: string }) => m.key)).toEqual(
      [...configs].reverse().map((m) => m.key),
    );
    expect(sdk.publicClient.readContract).toHaveBeenCalledTimes(
      registry.getTokens("eip155:8453").length,
    );
    expect(sdk.tokenMetadata).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(
      /availableSupply|priceUsd|decimals/,
    );
  });

  it("coalesces concurrent 7D/30D cold scans and reads only bids at one block", async () => {
    const [weekly, monthly] = await Promise.all([
      getSortedMarkets("base", Duration.Weekly),
      getSortedMarkets("base", Duration.Monthly),
    ]);
    expect(weekly).toEqual([...configs].reverse());
    expect(monthly).toEqual(configs);
    expect(sdk.getPair).toHaveBeenCalledTimes(configs.length);
    expect(sdk.publicClient.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(sdk.discover).toHaveBeenCalledTimes(configs.length);
    for (const [pair, options] of sdk.discover.mock.calls) {
      const config = configs[Number(pair)];
      const token0 = {
        address: config.token0.address,
        ...tokenFixture(config.token0.address),
      };
      const bid = displayTokens({
        token0,
        token1: {
          address: config.token1.address,
          ...tokenFixture(config.token1.address),
        },
      })[1];
      expect(options).toMatchObject({
        blockNumber: 123n,
        direction: bid.address === token0.address ? 0 : 1,
      });
      expect(options.duration).toBeUndefined();
    }
    for (const args of sdk.getPair.mock.calls) expect(args[2]).toBe(123n);
  });

  it("separates duration rankings, keeps ties stable and skips uncreated pairs", async () => {
    const monthly = await getSortedMarkets("base", Duration.Monthly);
    expect(monthly).toEqual(configs);
    sdk.getPair.mockImplementation(async (a, b) => [0n, a, b, false]);
    sdk.discover.mockClear();
    sdk.tokenMetadata.mockClear();
    expect(await getSortedMarkets("base", Duration.Weekly)).toEqual(configs);
    expect(sdk.discover).not.toHaveBeenCalled();
    expect(sdk.tokenMetadata).not.toHaveBeenCalled();
  });

  it("leaves search, categories and pagination to the frontend", async () => {
    const body = await (
      await GET(request("chainId=8453&search=no-match&page=999"))
    ).json();
    expect(body).toEqual({ markets: [...configs].reverse() });
    expect(Object.keys(body)).toEqual(["markets"]);
  });

  it("builds the full Trending list in discovery order without liquidity reads", async () => {
    const response = await GET(request("chainId=8453&tag=trending"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.markets.map((m: { key: string }) => m.key)).toEqual([
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:0xffffffffffffffffffffffffffffffffffffffff",
      configs[0].key,
    ]);
    expect(sdk.getPair).not.toHaveBeenCalled();
    expect(sdk.discover).not.toHaveBeenCalled();
    expect(cacheConfigs).toContainEqual({
      keys: ["trending-markets", JSON.stringify(registry.data)],
      revalidate: 86400,
    });
  });

  it("falls back to the full YieldList on discovery failure without RPC and can recover", async () => {
    discovery.mockRejectedValueOnce(new Error("private detail"));
    const response = await GET(request("chainId=8453&tag=trending"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ markets: configs });
    expect(sdk.getPair).not.toHaveBeenCalled();
    expect(sdk.publicClient.getBlockNumber).not.toHaveBeenCalled();
    expect(await getTrendingMarkets("base")).toHaveLength(2);
  });

  it.each([
    "",
    "chainId=10",
    "chainId=8453&chainId=1",
    "chainId=8453&duration=14",
    "chainId=8453&duration=7&duration=30",
    "chainId=8453&tag=invalid",
    "chainId=8453&tag=all&tag=trending",
  ])("rejects invalid filters before RPC: %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sdk.getPair).not.toHaveBeenCalled();
  });

  it.each(["rpc", "incomplete"])(
    "returns uncached YieldList fallback after %s failure",
    async (failure) => {
      if (failure === "rpc")
        sdk.getPair.mockRejectedValue(new Error("private RPC detail"));
      else sdk.discover.mockResolvedValue({ complete: false, reads: [] });
      const response = await GET(request());
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ markets: configs });
    },
  );
});
