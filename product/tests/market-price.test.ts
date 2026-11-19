import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketPrice } from "@/server/market-price";
import { GET } from "@/app/api/market-price/route";
import { displayReference, referenceAmount } from "@/lib/market-reference";
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const mocks = vi.hoisted(() => ({
  price: vi.fn(),
  token: vi.fn(),
  metadata: vi.fn(),
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
  mocks.metadata.mockReset().mockResolvedValue([]);
  mocks.token.mockReset().mockImplementation(async (address) => ({
    address,
    decimals: address === a ? 18 : 6,
  }));
  mocks.price.mockReset().mockImplementation(async () => ({
    tokenIn: a,
    tokenOut: b,
    amountIn: "1000000000000000",
    estimatedAmountOut: "3000000",
    priceImpact: 0.01,
    quotedAt: Date.now(),
  }));
});
describe("indicative references", () => {
  it("coalesces in-flight loads without retaining completed results", async () => {
    const values = await Promise.all(
      Array.from({ length: 8 }, () => getMarketPrice("base", a, b)),
    );
    expect(values.every((value) => value.price.amm === "3000")).toBe(true);
    expect(mocks.price).toHaveBeenCalledTimes(1);
    await getMarketPrice("base", a, b);
    expect(mocks.price).toHaveBeenCalledTimes(2);
    expect(values[0]).not.toHaveProperty("transaction");
    expect(values[0]).not.toHaveProperty("permitTransaction");
  });
  it.each([undefined, -100, 1.99, 85.21])(
    "prefers the AMM reference over metadata regardless of impact annotation %s",
    async (impact) => {
      mocks.price.mockResolvedValue({
        tokenIn: a,
        tokenOut: b,
        amountIn: "3333333333333333",
        estimatedAmountOut: "12000000",
        priceImpact: impact,
        quotedAt: Date.now(),
      });
      mocks.metadata.mockResolvedValue([
        { address: a, status: "available", priceUsd: "3000" },
        { address: b, status: "available", priceUsd: "1" },
      ]);
      const value = await getMarketPrice("base", a, b);
      expect(Number(value.price.amm)).toBeCloseTo(3600, 10);
      expect(value.price.meta).toBe("3000");
      expect(displayReference(value, false)).toBe(value.price.amm);
      expect(value.price.configured).toBeDefined();
    },
  );
  it("uses configured baseTick after AMM and metadata failure", async () => {
    mocks.price.mockRejectedValue(new Error("no route"));
    const value = await getMarketPrice("base", a, b);
    expect(value.baseTick).toBe(-196000);
    expect(value.price.configured).toBeDefined();
    expect(value.price.amm).toBeUndefined();
    expect(value.price.meta).toBeUndefined();
    expect(displayReference(value, false)).toBe(value.price.configured);
  });
  it("quotes a meaningful BNKR amount and preserves its canonical USDC price", async () => {
    const bnkr = "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b";
    mocks.token.mockImplementation(async (address) => ({
      address,
      decimals: address === b ? 6 : 18,
    }));
    mocks.metadata.mockResolvedValue([
      { address: bnkr, status: "available", priceUsd: "0.00024" },
      { address: b, status: "available", priceUsd: "1" },
    ]);
    mocks.price.mockImplementation(async ({ amount, tokenIn, tokenOut }) => ({
      tokenIn,
      tokenOut,
      amountIn: amount,
      // A one-token BNKR sample loses precision in USDC's six decimals.
      estimatedAmountOut: amount === "1000000000000000000" ? "229" : "8854425",
      priceImpact: amount === "1000000000000000000" ? 2.66 : 0.99,
      quotedAt: Date.now(),
    }));
    const value = await getMarketPrice("base", bnkr, b);
    expect(mocks.price).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "41666666666666666666666" }),
    );
    expect(Number(value.price.amm)).toBeCloseTo(0.0002125062, 12);
  });
  it("quotes unlisted tokens without requiring a registry reference", async () => {
    const unlisted = "0x2222222222222222222222222222222222222222";
    mocks.price.mockImplementation(async ({ tokenIn, tokenOut, amount }) => ({
      tokenIn,
      tokenOut,
      amountIn: amount,
      estimatedAmountOut: "2000000000000000",
      priceImpact: 0.01,
      quotedAt: Date.now(),
    }));
    const value = await getMarketPrice("base", unlisted, a);
    expect(value).toMatchObject({
      price: { amm: "2" },
    });
    expect(mocks.price).toHaveBeenCalledWith(
      expect.objectContaining({ tokenIn: unlisted, tokenOut: a }),
    );
  });
  it("uses a valid AMM route as the reference without token pricing metadata", async () => {
    const unlisted = "0x2222222222222222222222222222222222222222";
    mocks.price.mockResolvedValue({
      tokenIn: unlisted,
      tokenOut: a,
      amountIn: "1000",
      estimatedAmountOut: "2000000000000000",
      priceImpact: -100,
      quotedAt: Date.now(),
    });
    expect(await getMarketPrice("base", unlisted, a)).toMatchObject({
      price: { amm: "2" },
    });
  });
  it("omits unavailable prices for arbitrary pairs without a route or reference", async () => {
    mocks.price.mockRejectedValue(new Error("no route"));
    const response = await GET(
      new Request(
        `https://yld.cx/api/market-price?chainId=8453&tokenA=${a}&tokenB=0xffffffffffffffffffffffffffffffffffffffff`,
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
    expect(value.price).toEqual({});
    expect(value.baseTick).toBeUndefined();
    expect(value).not.toHaveProperty("status");
    expect(value).not.toHaveProperty("source");
    expect(value).not.toHaveProperty("ammAvailable");
    expect(displayReference(value, false)).toBeUndefined();
    expect(mocks.price).toHaveBeenCalledTimes(1);
  });
  it.each(["unavailable", "mismatched"])(
    "falls back to token metadata when the AMM quote is %s",
    async (reason) => {
      mocks.metadata.mockResolvedValue([
        { address: a, status: "available", priceUsd: "3000" },
        { address: b, status: "available", priceUsd: "1" },
      ]);
      if (reason === "unavailable") {
        mocks.price.mockRejectedValue(new Error("no route"));
      } else {
        mocks.price.mockResolvedValue({
          tokenIn: b,
          tokenOut: a,
          amountIn: "3333333333333333",
          estimatedAmountOut: "12000000",
          quotedAt: Date.now(),
        });
      }
      const value = await getMarketPrice("base", a, b);
      expect(value.price.meta).toBe("3000");
      expect(value.price.amm).toBeUndefined();
      expect(displayReference(value, false)).toBe("3000");
      expect(displayReference(value, false, "amm")).toBeUndefined();
    },
  );
  it("ignores stale metadata pricing", async () => {
    mocks.price.mockRejectedValue(new Error("no route"));
    mocks.metadata.mockResolvedValue([
      { address: a, status: "available", priceUsd: "3000", stale: true },
      { address: b, status: "available", priceUsd: "1" },
    ]);
    const value = await getMarketPrice("base", a, b);
    expect(value.price.meta).toBeUndefined();
    expect(displayReference(value, false)).toBe(value.price.configured);
  });
  it("canonicalizes inverse requests and sets one-hour response caching", async () => {
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
      expect(result.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=3600",
      );
      expect(await result.json()).toMatchObject({
        price: { amm: "3000" },
      });
    }
    expect(mocks.price).toHaveBeenCalledTimes(2);
  });
  it.each([
    "chainId=10",
    `chainId=8453&tokenA=${a}&tokenB=${a}`,
    `chainId=8453&tokenA=${a}&tokenB=${b}&tokenB=${b}`,
  ])("validates requests %s", async (query) => {
    const response = await GET(
      new Request(`https://yld.cx/api/market-price?${query}`),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.price).not.toHaveBeenCalled();
  });
  it("uses bounded consistent reference amounts and integer inverse prices", () => {
    expect(referenceAmount({ decimals: 18, priceUsd: "3000" })).toBe(
      3333333333333333n,
    );
    expect(referenceAmount({ decimals: 6, priceUsd: "0.000001" })).toBe(
      10000000000000n,
    );
    expect(referenceAmount({ decimals: 0 })).toBe(1n);
    expect(referenceAmount({ decimals: 255 })).toBeLessThanOrEqual(10n ** 30n);
    expect(
      displayReference(
        {
          price: { amm: "2" },
          timestamp: 0,
        },
        true,
      ),
    ).toBe("0.5");
  });
});
