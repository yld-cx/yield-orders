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
import {
  baseTickFromPrice,
  discoveryRadii,
  promising,
  ticks,
} from "../src/ticks.ts";

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

test("nearby-first discovery reads only 7D identities on the product grid and stops before expanding when caller accepts them", async () => {
  const { client, reads } = mockClient(100n);
  for await (const window of ticks(client, A, market, reference(), 123n)) {
    assert.equal(window.radius, 2);
    assert.equal(window.checked, 10);
    assert.equal(window.ticks.length, window.checked);
    break;
  }
  assert.equal(reads.length, 1);
  assert.equal(reads[0].blockNumber, 123n);
});

test("adaptive expansion reads only new outer identities at the same block", async () => {
  const { client, reads } = mockClient();
  const counts: number[] = [];
  for await (const window of ticks(client, A, market, reference(), 123n)) {
    counts.push(window.checked);
    assert.deepEqual(window.ticks, []);
  }
  assert.deepEqual(counts, [10, 8]);
  const ids = reads.flatMap((r) => r.contracts.map((c) => c.args[0]));
  assert.equal(new Set(ids).size, ids.length);
  const expected = tickCandidates(
    market.pairId,
    baseTickFromPrice(market, reference()),
    100,
    4,
  ).filter((tick) => tick.durationDays === 7);
  assert.deepEqual(new Set(ids), new Set(expected.map((tick) => tick.id)));
  assert.ok(reads.every((r) => r.contracts.length <= 100));
  assert.ok(reads.every((r) => r.blockNumber === 123n));
  assert.deepEqual(discoveryRadii(2), [2]);
  assert.deepEqual(discoveryRadii(8), [2, 4, 8]);
  assert.throws(() => discoveryRadii(9));
});

test("coarser-grid weekly ticks remain discoverable within a 100-tick window", async () => {
  const { client, reads } = mockClient();
  const quote = {
    ...reference(),
    amountIn: "1000000000000000000",
    estimatedAmountOut: ((10n ** 18n * priceAtTick(1500)) / Q128).toString(),
  };
  for await (const _window of ticks(client, A, market, quote, 123n, 8)) {
    /* read the bounded window */
  }
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
  for await (const _window of ticks(
    client,
    A,
    market,
    { ...reference(), quotedAt: 0 },
    123n,
  ))
    assert.fail("stale window");
  assert.equal(reads.length, 0);
});

test("market identities need no configured baseTick and ignore cached centers", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.pathname, "/api/markets");
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
      ],
    });
  });
  assert.deepEqual(await markets("https://yld.cx", 8453), [market]);
});
