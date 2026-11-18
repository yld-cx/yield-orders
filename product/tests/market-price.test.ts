import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_MARKET } from "@yld-cx/sdk";
import { getMarketPrice } from "@/server/market-price";
import { GET } from "@/app/api/market-price/route";
import { displayReference, referenceAmount } from "@/lib/market-reference";
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const mocks = vi.hoisted(() => ({
  price: vi.fn(),
  token: vi.fn(),
  metadata: vi.fn(),
  cache: new Map<string, unknown>(),
  config: [] as { keys: string[]; revalidate: number }[],
}));
vi.mock("next/cache", () => ({
  unstable_cache: (
    fn: (...args: unknown[]) => Promise<unknown>,
    keys: string[],
    options: { revalidate: number },
  ) => {
    mocks.config.push({ keys, ...options });
    return async (...args: unknown[]) => {
      const key = JSON.stringify(args);
      if (mocks.cache.has(key)) return mocks.cache.get(key);
      const value = await fn(...args);
      mocks.cache.set(key, value);
      return value;
    };
  },
}));
vi.mock("@/lib/rpc", () => ({
  getSdk: () => ({ tokenMetadata: mocks.token }),
}));
vi.mock("@/lib/token-metadata", () => ({ fetchTokenMetadata: mocks.metadata }));
vi.mock("@yld-cx/sdk/uniswap", async (original) => ({
  ...(await original<typeof import("@yld-cx/sdk/uniswap")>()),
  UniswapClient: class {
    price = mocks.price;
  },
}));
beforeEach(() => {
  mocks.cache.clear();
  mocks.metadata.mockReset().mockResolvedValue([]);
  mocks.token
    .mockReset()
    .mockImplementation(async (address) => ({
      address,
      decimals: address === a ? 18 : 6,
    }));
  mocks.price
    .mockReset()
    .mockImplementation(async () => ({
      tokenIn: a,
      tokenOut: b,
      amountIn: "1000000000000000",
      estimatedAmountOut: "3000000",
      priceImpact: 0.01,
      quotedAt: Date.now(),
    }));
});
describe("indicative reference cache", () => {
  it("shares one-hour results across callers and coalesces cold misses", async () => {
    const values = await Promise.all(
      Array.from({ length: 8 }, () => getMarketPrice("base", a, b)),
    );
    expect(
      values.every((value) => value.price === "3000" && value.source === "amm"),
    ).toBe(true);
    await getMarketPrice("base", a, b);
    expect(mocks.price).toHaveBeenCalledTimes(1);
    expect(mocks.config[0].revalidate).toBe(
      PRODUCT_MARKET.referenceCacheSeconds,
    );
    expect(values[0]).not.toHaveProperty("transaction");
    expect(values[0]).not.toHaveProperty("permitTransaction");
  });
  it("does not serve an expired indication while the shared cache revalidates", async () => {
    const first = await getMarketPrice("base", a, b);
    mocks.cache.set(JSON.stringify(["base", a, b]), {
      ...first,
      timestamp: Date.now() - 3600001,
    });
    const next = await getMarketPrice("base", a, b);
    expect(next.timestamp).toBeGreaterThan(Date.now() - 1000);
    expect(mocks.price).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, -1, 2, NaN])(
    "rejects unusable impact %s and uses trusted metadata",
    async (impact) => {
      mocks.price.mockResolvedValue({
        tokenIn: a,
        tokenOut: b,
        amountIn: "3333333333333333",
        estimatedAmountOut: "10000000",
        priceImpact: impact,
        quotedAt: Date.now(),
      });
      mocks.metadata.mockResolvedValue([
        { address: a, status: "available", priceUsd: "3000" },
        { address: b, status: "available", priceUsd: "1" },
      ]);
      const value = await getMarketPrice("base", a, b);
      expect(value).toMatchObject({
        source: "metadata",
        price: "3000",
        ammAvailable: false,
      });
    },
  );
  it("uses configured baseTick after AMM and metadata failure", async () => {
    mocks.price.mockRejectedValue(new Error("no route"));
    const value = await getMarketPrice("base", a, b);
    expect(value).toMatchObject({
      source: "configured",
      baseTick: -196000,
      ammAvailable: false,
    });
  });
  it("returns an explicit unavailable state for arbitrary pairs without a reference", async () => {
    const value = await getMarketPrice(
      "base",
      a,
      "0xffffffffffffffffffffffffffffffffffffffff",
    );
    expect(value).toMatchObject({
      status: "unavailable",
      source: null,
      ammAvailable: false,
    });
    expect(mocks.price).not.toHaveBeenCalled();
  });
  it("ignores stale metadata pricing", async () => {
    mocks.price.mockRejectedValue(new Error("no route"));
    mocks.metadata.mockResolvedValue([
      { address: a, status: "available", priceUsd: "3000", stale: true },
      { address: b, status: "available", priceUsd: "1" },
    ]);
    expect((await getMarketPrice("base", a, b)).source).toBe("configured");
  });
  it("canonicalizes inverse requests before cache lookup", async () => {
    for (const [tokenA, tokenB] of [
      [a, b],
      [b, a],
    ]) {
      const result = await GET(
        new Request(
          `https://yld.cx/api/market-price?chainId=8453&tokenA=${tokenA}&tokenB=${tokenB}`,
        ),
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        price: "3000",
        ammAvailable: true,
      });
    }
    expect(mocks.price).toHaveBeenCalledTimes(1);
  });
  it.each([
    "chainId=10",
    `chainId=8453&tokenA=${a}&tokenB=${a}`,
    `chainId=8453&tokenA=${a}&tokenB=${b}&tokenB=${b}`,
  ])("validates requests %s", async (query) => {
    expect(
      (await GET(new Request(`https://yld.cx/api/market-price?${query}`)))
        .status,
    ).toBe(400);
    expect(mocks.price).not.toHaveBeenCalled();
  });
  it("uses bounded consistent reference amounts and integer inverse prices", () => {
    expect(referenceAmount({ decimals: 18, priceUsd: "3000" })).toBe(
      3333333333333333n,
    );
    expect(referenceAmount({ decimals: 6, priceUsd: "0.000001" })).toBe(
      1000000n,
    );
    expect(referenceAmount({ decimals: 0 })).toBe(1n);
    expect(referenceAmount({ decimals: 255 })).toBeLessThanOrEqual(10n ** 30n);
    expect(
      displayReference(
        {
          status: "available",
          source: "amm",
          price: "2",
          timestamp: 0,
          ammAvailable: true,
        },
        true,
      ),
    ).toBe("0.5");
  });
});
