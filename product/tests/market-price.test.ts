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
    expect(
      values.every((value) => value.price === "3000" && value.source === "amm"),
    ).toBe(true);
    expect(mocks.price).toHaveBeenCalledTimes(1);
    await getMarketPrice("base", a, b);
    expect(mocks.price).toHaveBeenCalledTimes(2);
    expect(values[0]).not.toHaveProperty("transaction");
    expect(values[0]).not.toHaveProperty("permitTransaction");
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
    expect(value).toMatchObject({ source: "amm", ammAvailable: true });
    expect(Number(value.price)).toBeCloseTo(0.0002125062, 12);
  });
  it("returns an explicit unavailable state for arbitrary pairs without a reference", async () => {
    const response = await GET(
      new Request(
        `https://yld.cx/api/market-price?chainId=8453&tokenA=${a}&tokenB=0xffffffffffffffffffffffffffffffffffffffff`,
      ),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = await response.json();
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
        price: "3000",
        ammAvailable: true,
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
