import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SwapError } from "@yld-cx/sdk/uniswap";
import { POST } from "../app/api/swap/quote/route.ts";
const mocks = vi.hoisted(() => ({ quote: vi.fn() }));
vi.mock("@yld-cx/sdk/uniswap", async (original) => ({
  ...(await original<typeof import("@yld-cx/sdk/uniswap")>()),
  UniswapClient: class {
    quote = mocks.quote;
  },
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());
const input = {
  chainId: 8453,
  mode: "wallet-router",
  tokenIn: "0x4200000000000000000000000000000000000006",
  tokenOut: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  amount: "100",
  swapper: "0x1111111111111111111111111111111111111111",
  slippage: 0.5,
};
function request(body: unknown, origin = "https://yld.cx") {
  return new Request("https://yld.cx/api/swap/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}
describe("public swap boundary", () => {
  it("rejects cross-origin and unauthenticated machine requests", async () => {
    expect(
      (await POST(request(input, "https://attacker.example"))).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("https://yld.cx/api/swap/quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }),
        )
      ).status,
    ).toBe(403);
  });
  it.each([undefined, "Bearer arbitrary"])(
    "does not expose resolver quote mode with authorization %s",
    async (authorization) => {
      const resolverRequest = request({ ...input, mode: "resolver-router" });
      if (authorization)
        resolverRequest.headers.set("authorization", authorization);
      expect((await POST(resolverRequest)).status).toBe(403);
    },
  );
  it("caps streamed JSON and rejects client-supplied quote payloads", async () => {
    expect((await POST(request({ padding: "x".repeat(5000) }))).status).toBe(
      413,
    );
    expect(
      (
        await POST(
          request({
            ...input,
            quote: {},
            url: "https://internal.example/secret",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it.each([false, true])(
    "quotes tokens outside Yieldlist, inverted: %s",
    async (inverted) => {
      const unlisted = "0x2222222222222222222222222222222222222222";
      const swap = {
        ...input,
        tokenIn: inverted ? unlisted : input.tokenIn,
        tokenOut: inverted ? input.tokenIn : unlisted,
      };
      const quote = {
        ...swap,
        amountIn: swap.amount,
        estimatedAmountOut: "200",
      };
      mocks.quote.mockResolvedValueOnce(quote);
      const response = await POST(request(swap));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(quote);
      expect(mocks.quote).toHaveBeenCalledWith(swap);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
  it("reports upstream no-route results for unlisted pairs", async () => {
    mocks.quote.mockRejectedValueOnce(
      new SwapError("No compatible route for these tokens", 422),
    );
    const response = await POST(
      request({
        ...input,
        tokenOut: "0x2222222222222222222222222222222222222222",
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "No compatible route for these tokens",
    });
  });
  it("limits each wallet independently and resets its window after a minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60000);
    mocks.quote.mockResolvedValue({ routeId: "test" });
    for (let i = 0; i < 20; i++)
      expect((await POST(request(input))).status).toBe(200);
    const limited = await POST(request(input));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.quote).toHaveBeenCalledTimes(20);
    expect(
      (
        await POST(
          request({
            ...input,
            swapper: "0x2222222222222222222222222222222222222222",
          }),
        )
      ).status,
    ).toBe(200);
    vi.advanceTimersByTime(59500);
    const almostReset = await POST(request(input));
    expect(almostReset.status).toBe(429);
    expect(almostReset.headers.get("Retry-After")).toBe("1");
    vi.advanceTimersByTime(500);
    const reset = await POST(request(input));
    expect(reset.status).toBe(200);
    expect(reset.headers.has("Retry-After")).toBe(false);
  });
  it("does not impose a global request limit across wallets", async () => {
    mocks.quote.mockResolvedValue({ routeId: "test" });
    for (let i = 1; i <= 121; i++) {
      const swapper = `0x${i.toString(16).padStart(40, "0")}`;
      expect((await POST(request({ ...input, swapper }))).status).toBe(200);
    }
  });
});
