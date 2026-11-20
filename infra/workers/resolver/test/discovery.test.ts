import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import {
  pairIdFor,
  priceAtTick,
  tickIdFor,
  Q128,
  snappedPrice,
  tickCandidates,
} from "@yld-cx/sdk/ethereum";
import type { SwapPriceResult } from "@yld-cx/sdk/uniswap";
import { markets, type MarketIdentity } from "../src/markets.ts";
import { LIMITS } from "../src/config.ts";
import { baseTickFromPrice, promising, ticks } from "../src/ticks.ts";

const A = "0x1111111111111111111111111111111111111111",
  Q = "0x2222222222222222222222222222222222222222";
const market: MarketIdentity = {
  pairId: pairIdFor(A, Q),
  token0: A,
  token1: Q,
};
const reference = (): SwapPriceResult => ({
  tokenIn: A,
  tokenOut: Q,
  amountIn: "1000000000000000",
  estimatedAmountOut: "3000000",
  minimumAmountOut: "2985000",
  quotedAt: Date.now(),
  priceImpact: 0.01,
});

test("fresh raw AMM quote centers mixed-decimal discovery with SDK snapping", () => {
  assert.equal(
    baseTickFromPrice(market, reference()),
    snappedPrice("3000", 18, 6, 100).priceTick,
  );
  const inverse = {
    ...reference(),
    amountIn: "3000000",
    estimatedAmountOut: "1000000000000000",
  };
  assert.equal(
    baseTickFromPrice(market, inverse),
    snappedPrice("0.0003333333333333333333333333333333333333", 6, 18, 100)
      .priceTick,
  );
  assert.throws(
    () => baseTickFromPrice(market, { ...reference(), tokenIn: Q }),
    /Invalid AMM reference/,
  );
});

test("price filtering handles cheap Asks and expensive Bids through actual Asset/Quote", () => {
  const tick = (
    asset: typeof A | typeof Q,
    quote: typeof A | typeof Q,
    priceX128: bigint,
  ) => ({ asset, quote, priceX128 });
  assert.equal(
    promising(tick(A, Q, (Q128 * 2990n) / 10n ** 12n), market, reference()),
    true,
  );
  assert.equal(
    promising(tick(A, Q, (Q128 * 3010n) / 10n ** 12n), market, reference()),
    false,
  );
  assert.equal(
    promising(tick(Q, A, (Q128 * 10n ** 12n) / 3100n), market, reference()),
    true,
  );
  assert.equal(
    promising(tick(Q, A, (Q128 * 10n ** 12n) / 2900n), market, reference()),
    false,
  );
  assert.equal(promising(tick(A, A, Q128), market, reference()), false);
});

function mockClient(available = 0n) {
  const reads: {
    blockNumber: bigint;
    batchSize: number;
    contracts: { args: readonly [bigint] }[];
  }[] = [];
  const client = {
    multicall: async (request: (typeof reads)[number]) => {
      reads.push(request);
      return request.contracts.map(() => ({
        status: "success",
        result: {
          asset: A,
          quote: Q,
          durationDays: 7n,
          priceX128: (Q128 * 2990n) / 10n ** 12n,
          availableSupply: available,
          workingSupply: 0n,
          exitWorking: 0n,
          activeWorking: 0n,
          activePrincipal: 0n,
          settleCursor: 0n,
        },
      }));
    },
  } as unknown as PublicClient;
  return { client, reads };
}

test("discovery reads the entire weekly window in one multicall at the quote block", async () => {
  const { client, reads } = mockClient(100n);
  const window = await ticks(client, A, market, reference(), 123n);
  assert.equal(window.radius, LIMITS.discoveryRadius);
  assert.equal(window.checked, 82);
  assert.equal(window.ticks.length, window.checked);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].blockNumber, 123n);
  assert.equal(
    reads[0].batchSize,
    0,
    "disable automatic viem multicall splitting",
  );
  assert.ok(reads[0].contracts.length <= 100);
  const ids = reads[0].contracts.map((contract) => contract.args[0]);
  assert.equal(new Set(ids).size, ids.length);
  const expected = tickCandidates(
    market.pairId,
    baseTickFromPrice(market, reference()),
    100,
    LIMITS.discoveryRadius,
  );
  assert.deepEqual(new Set(ids), new Set(expected.map((tick) => tick.id)));
});

test("discovery rejects a radius above the configured limit before making any RPC request", async () => {
  const { client, reads } = mockClient();
  await assert.rejects(
    ticks(client, A, market, reference(), 123n, LIMITS.discoveryRadius + 1),
    /Discovery radius/,
  );
  assert.equal(reads.length, 0);
});

test("coarser-grid weekly ticks remain discoverable within a 100-tick window", async () => {
  const { client, reads } = mockClient();
  const quote = {
    ...reference(),
    amountIn: "1000000000000000000",
    estimatedAmountOut: ((10n ** 18n * priceAtTick(1500)) / Q128).toString(),
  };
  const window = await ticks(client, A, market, quote, 123n, 8);
  assert.deepEqual(window.ticks, []);
  assert.equal(reads.length, 1);
  const ids = new Set(
    reads.flatMap((read) => read.contracts.map((contract) => contract.args[0])),
  );
  for (const canonicalTick of [1000, 2000])
    for (const direction of [0, 1] as const)
      assert.ok(
        ids.has(
          tickIdFor(
            market.pairId,
            direction,
            direction === 0 ? canonicalTick : -canonicalTick,
            7,
          ),
        ),
      );
});

test("stale AMM references never issue discovery multicalls", async () => {
  const { client, reads } = mockClient();
  const window = await ticks(
    client,
    A,
    market,
    { ...reference(), quotedAt: 0 },
    123n,
  );
  assert.deepEqual(window.ticks, []);
  assert.equal(window.checked, 0);
  assert.equal(reads.length, 0);
});

test("single-call discovery finds an executable bid fourteen grid steps above the AMM price", async () => {
  const referenceTick = -201700;
  const quote = {
    ...reference(),
    amountIn: "1000000000000000",
    estimatedAmountOut: (
      (10n ** 15n * priceAtTick(referenceTick)) /
      Q128
    ).toString(),
  };
  const identity = tickCandidates(market.pairId, referenceTick, 100, 16).find(
    (tick) => tick.direction === 1 && tick.priceTick === 200300,
  )!;
  const checked: bigint[] = [];
  const client = {
    multicall: async ({
      contracts,
    }: {
      contracts: { args: readonly [bigint] }[];
    }) =>
      contracts.map(({ args: [id] }) => {
        checked.push(id);
        return {
          status: "success",
          result: {
            asset: Q,
            quote: A,
            durationDays: 7n,
            priceX128: priceAtTick(200300),
            availableSupply: id === identity.id ? 1000000n : 0n,
          },
        };
      }),
  } as unknown as PublicClient;
  const window = await ticks(client, A, market, quote, 123n, 16);
  assert.equal(window.checked, 66);
  assert.equal(window.ticks.length, 1);
  assert.equal(window.ticks[0].id, identity.id);
  assert.equal(new Set(checked).size, checked.length);
});

test("market identities need no configured baseTick and ignore cached centers", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.origin, "https://yld.cx");
    assert.equal(url.pathname, "/api/markets");
    assert.equal(url.searchParams.get("tag"), "all");
    assert.equal(url.searchParams.get("chainId"), "8453");
    return Response.json({
      markets: [
        {
          network: "eip155:8453",
          token0: { address: Q },
          token1: { address: A },
        },
        {
          network: "eip155:8453",
          token0: { address: A },
          token1: { address: Q },
          baseTick: "stale or invalid",
        },
        { network: "eip155:1", token0: { address: A }, token1: { address: Q } },
        {
          network: "eip155:8453",
          token0: { address: A },
          token1: { address: A },
        },
        {
          network: "eip155:8453",
          token0: { address: "invalid" },
          token1: { address: Q },
        },
      ],
    });
  });
  assert.deepEqual(await markets("https://yld.cx/api/markets", 8453), [market]);
});

test("markets API overrides preserve paths and query parameters while enforcing YieldList filters", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    requests++;
    assert.equal(url.origin, "https://preview.yld.cx");
    assert.equal(url.pathname, "/custom/v2/yield-list");
    assert.equal(url.searchParams.get("source"), "resolver");
    assert.deepEqual(url.searchParams.getAll("chainId"), ["1"]);
    assert.deepEqual(url.searchParams.getAll("tag"), ["all"]);
    return Response.json({ markets: [] });
  });
  assert.deepEqual(
    await markets(
      "https://preview.yld.cx/custom/v2/yield-list?source=resolver&chainId=8453&chainId=4663&tag=trending&tag=all",
      1,
    ),
    [],
  );
  await assert.rejects(
    markets("http://preview.yld.cx/api/markets", 1),
    /HTTPS markets API URL required/,
  );
  await assert.rejects(
    markets("https://user:password@preview.yld.cx/api/markets", 1),
    /HTTPS markets API URL required/,
  );
  assert.equal(requests, 1);
});

test("market requests reject redirects without following them", async (t) => {
  let requests = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: URL, options: RequestInit) => {
      requests++;
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test" },
      });
    },
  );
  await assert.rejects(
    markets("https://yld.cx/api/markets", 8453),
    /Markets unavailable/,
  );
  assert.equal(requests, 1);
});
