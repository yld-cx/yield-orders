import { describe, it, expect, vi } from "vitest";
import {
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import {
  UniswapClient,
  parseSwapInput,
  PERMIT2,
  permit2Abi,
  type SwapInput,
} from "@yld-cx/sdk/uniswap";

const A = "0x1111111111111111111111111111111111111111",
  B = "0x2222222222222222222222222222222222222222",
  USER = "0x3333333333333333333333333333333333333333",
  ROUTER = "0x4444444444444444444444444444444444444444";
const input: SwapInput = {
  chainId: 8453,
  mode: "wallet-router",
  tokenIn: A,
  tokenOut: B,
  amount: "100",
  swapper: USER,
  slippage: 0.5,
};
const tx = (to: string) => {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const args = encodeAbiParameters(
    parseAbiParameters("address,uint256,uint256,bytes,bool,uint256[]"),
    [USER, 100n, 199n, `0x${A.slice(2)}0001f4${B.slice(2)}`, true, []],
  );
  const data = `0x3593564c${encodeAbiParameters(parseAbiParameters("bytes,bytes[],uint256"), ["0x00", [args], deadline]).slice(2)}`;
  return { to, from: USER, chainId: 8453, value: "0", data };
};
function response() {
  return {
    routing: "CLASSIC",
    permitData: null,
    quote: {
      chainId: 8453,
      swapper: USER,
      tradeType: "EXACT_INPUT",
      slippage: 0.5,
      quoteId: "test-route",
      input: { token: A, amount: "100" },
      output: { token: B, amount: "200", recipient: USER },
      aggregatedOutputs: [
        {
          token: B,
          amount: "200",
          minAmount: "199",
          recipient: USER,
          bps: 10000,
        },
      ],
      route: [
        [
          {
            type: "v3-pool",
            tokenIn: { chainId: 8453, address: A },
            tokenOut: { chainId: 8453, address: B },
          },
        ],
      ],
    },
    swapTransaction: tx(ROUTER),
  };
}
function service(
  responses: unknown[],
  options: Partial<ConstructorParameters<typeof UniswapClient>[0]> = {},
) {
  const calls: {
    endpoint: string;
    headers: Headers;
    redirect?: RequestRedirect;
    body: Record<string, unknown>;
  }[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({
        endpoint: String(url).split("/").at(-1)!,
        headers: new Headers(options?.headers),
        redirect: options?.redirect,
        body: JSON.parse(options?.body as string),
      });
      const body = responses.shift();
      return body instanceof Response ? body : Response.json(body);
    },
  ) as typeof fetch;
  return {
    calls,
    client: new UniswapClient({
      apiKey: "server-secret",
      router: ROUTER,
      fetch: fetcher,
      ...options,
    }),
  };
}
describe("Uniswap SDK integration", () => {
  it("rejects redirects without forwarding the API key to another endpoint", async () => {
    const s = service([
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test" },
      }),
    ]);
    await expect(s.client.price(input)).rejects.toThrow(
      "Swap provider unavailable",
    );
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].redirect).toBe("manual");
  });
  it("accepts split and mixed routes without requoting or decoding calldata", async () => {
    const split = response();
    split.quote.route.push([...split.quote.route[0]]);
    split.quote.route[1][0].type = "future-compatible-pool";
    const s = service([split]);
    const quote = await s.client.quote(input);
    expect(quote.transaction.data).toBe(split.swapTransaction.data);
    expect(s.calls.map((c) => c.endpoint)).toEqual(["quote"]);
    expect(s.calls[0].body.routingPreference).toBe("BEST_PRICE");
    expect(s.calls[0].body.protocols).toEqual(["V2", "V3", "V4"]);
    expect(s.calls[0].body).not.toHaveProperty("hooksOptions");
  });
  it("accepts native intermediates when ERC20 endpoints and zero transaction value are preserved", async () => {
    const native = response();
    native.quote.route[0][0].tokenOut.address =
      "0x0000000000000000000000000000000000000000";
    const s = service([native]);
    await s.client.quote(input);
    expect(s.calls).toHaveLength(1);
  });
  it("enforces an upstream request budget before each network request", async () => {
    const r = response();
    delete (r as Partial<typeof r>).swapTransaction;
    let requests = 0;
    const s = service([r], {
      beforeRequest: () => {
        if (++requests > 1) throw new Error("Budget exhausted");
      },
    });
    await expect(s.client.quote(input)).rejects.toThrow("Budget exhausted");
    expect(s.calls).toHaveLength(1);
  });
  it("fetches a non-executable AMM reference without building swap calldata", async () => {
    const r = response();
    delete (r as Partial<typeof r>).swapTransaction;
    const s = service([r]);
    const price = await s.client.price(input);
    expect(price.estimatedAmountOut).toBe("200");
    expect(price.minimumAmountOut).toBe("199");
    expect(price).not.toHaveProperty("transaction");
    expect(s.calls.map((c) => c.endpoint)).toEqual(["quote"]);
  });
  it.each([123, "123", 0, -1, "invalid", "999999999999999999999"])(
    "only exposes a valid quote block: %s",
    async (blockNumber) => {
      const r = { ...response(), quote: { ...response().quote, blockNumber } };
      const price = await service([r]).client.price(input);
      expect(price.blockNumber).toBe(
        blockNumber === 123 || blockNumber === "123" ? "123" : undefined,
      );
    },
  );
  it.each([-100, -1, 0, 1.99, 85.21, 100, undefined])(
    "preserves signed price-impact annotations without invalidating quotes: %s",
    async (priceImpact) => {
      const r = { ...response(), quote: { ...response().quote, priceImpact } };
      const price = await service([r]).client.price(input);
      expect(price.estimatedAmountOut).toBe("200");
      expect(price.priceImpact).toBe(priceImpact);
    },
  );
  it.each([-101, 101, "1", null])(
    "rejects malformed price-impact annotations: %s",
    async (priceImpact) => {
      const r = { ...response(), quote: { ...response().quote, priceImpact } };
      await expect(service([r]).client.price(input)).rejects.toThrow(
        "Invalid reference price impact",
      );
    },
  );
  it("requests exact onchain Permit2 authorization and pins router version", async () => {
    const r = response();
    delete (r as Partial<typeof r>).swapTransaction;
    const s = service([r, { swap: tx(ROUTER) }]);
    const q = await s.client.quote(input);
    expect(q.minimumAmountOut).toBe("199");
    expect(q.transaction.to.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(s.calls.map((c) => c.endpoint)).toEqual(["quote", "swap"]);
    for (const call of s.calls) {
      expect([...call.headers.keys()]).toEqual([
        "content-type",
        "x-api-key",
        "x-universal-router-version",
      ]);
      expect(call.headers.get("x-universal-router-version")).toBe("2.1.2");
      expect(call.body).not.toHaveProperty("signature");
      if (call.endpoint === "quote") {
        expect(call.body.generatePermitAsTransaction).toBe(true);
        expect(call.body.permitAmount).toBe("EXACT");
      } else {
        expect(call.body).not.toHaveProperty("generatePermitAsTransaction");
        expect(call.body).not.toHaveProperty("permitAmount");
      }
      expect(call.body).not.toHaveProperty("swapSource");
    }
  });
  it.each(["wallet-router", "resolver-router"] as const)(
    "builds custom-deadline %s calldata using only swap request fields",
    async (mode) => {
      const deadline = Math.floor(Date.now() / 1000) + 180;
      const r = response();
      const s = service([r, { swap: tx(ROUTER) }]);
      await s.client.quote({ ...input, mode, deadline });
      expect(s.calls.map((call) => call.endpoint)).toEqual(["quote", "swap"]);
      expect(s.calls[1].body).toEqual({
        quote: r.quote,
        deadline,
        safetyMode: "SAFE",
      });
    },
  );
  it("uses the same signature-free Permit2 route for the resolver", async () => {
    const s = service([response()]);
    const q = await s.client.quote({ ...input, mode: "resolver-router" });
    expect(q.transaction.to).toBe(ROUTER);
    expect(s.calls[0].body).toMatchObject({
      generatePermitAsTransaction: true,
      permitAmount: "EXACT",
      recipient: USER,
      routingPreference: "BEST_PRICE",
      protocols: ["V2", "V3", "V4"],
    });
    expect(s.calls[0].body).not.toHaveProperty("swapSource");
  });
  it("only requests the quote when executable calldata is included", async () => {
    const s = service([response()]);
    await s.client.quote(input);
    expect(s.calls.map((call) => call.endpoint)).toEqual(["quote"]);
  });
  it("returns the API-generated exact Permit2 transaction before the swap", async () => {
    const r = {
      ...response(),
      permitTransaction: {
        ...tx(PERMIT2),
        data: encodeFunctionData({
          abi: permit2Abi,
          functionName: "approve",
          args: [A, ROUTER, 100n, Math.floor(Date.now() / 1000) + 86400],
        }),
      },
    };
    const q = await service([r]).client.quote(input);
    expect(q.permitTransaction?.data).toBe(r.permitTransaction.data);
    expect(q.permitTransaction?.to).toBe(PERMIT2);
  });
  it.each(["spender", "token", "amount", "expiration"])(
    "rejects unsafe Permit2 %s",
    async (field) => {
      const args = [
        field === "token" ? B : A,
        field === "spender" ? A : ROUTER,
        field === "amount" ? 101n : 100n,
        field === "expiration" ? 0 : Math.floor(Date.now() / 1000) + 86400,
      ] as const;
      const r = {
        ...response(),
        permitTransaction: {
          ...tx(PERMIT2),
          data: encodeFunctionData({
            abi: permit2Abi,
            functionName: "approve",
            args,
          }),
        },
      };
      await expect(service([r]).client.quote(input)).rejects.toThrow(
        "Unsafe Permit2 authorization",
      );
    },
  );
  it.each([
    "target",
    "recipient",
    "chain",
    "permit",
    "routing",
    "minimum",
    "native-value",
    "cross-chain",
  ])("rejects unsafe %s", async (kind) => {
    const r = response();
    if (kind === "target") r.swapTransaction.to = A;
    if (kind === "recipient") r.quote.aggregatedOutputs[0].recipient = A;
    if (kind === "chain") r.swapTransaction.chainId = 1;
    if (kind === "permit") (r as Record<string, unknown>).permitData = {};
    if (kind === "routing") r.routing = "DUTCH_V3";
    if (kind === "minimum") r.quote.aggregatedOutputs[0].minAmount = "100";
    if (kind === "native-value") r.swapTransaction.value = "1";
    if (kind === "cross-chain") r.quote.chainId = 1;
    await expect(service([r]).client.quote(input)).rejects.toThrow();
  });
  it.each([422, 429, 504])(
    "filters upstream %i without exposing the response",
    async (status) => {
      await expect(
        service([new Response("secret diagnostic", { status })]).client.quote(
          input,
        ),
      ).rejects.not.toThrow("secret diagnostic");
    },
  );
  it("rejects native tokens, arbitrary calldata and unsupported chains", () => {
    for (const patch of [
      { tokenIn: "0x0000000000000000000000000000000000000000" },
      { chainId: 10 },
      { data: "0x00" },
      { slippage: 10 },
      { amount: "1e18" },
    ])
      expect(() => parseSwapInput({ ...input, ...patch })).toThrow();
  });
});
