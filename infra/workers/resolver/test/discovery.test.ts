import test from "node:test";
import assert from "node:assert/strict";
import { Q128 } from "@yld-cx/sdk/ethereum";
import { LIMITS } from "../src/config.ts";
import { discoverTicks, estimatedSurplus } from "../src/ticks.ts";
import { testDatabase } from "./database.ts";

const A = "0x1111111111111111111111111111111111111111" as const;
const Q = "0x2222222222222222222222222222222222222222" as const;
const B = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
const tick = {
  id: 1n,
  asset: A,
  quote: Q,
  priceX128: 2n * Q128,
  availableSupply: 10n ** 40n,
};

test("D1 ranks active, funded ticks independently in both directions and one-sided markets", async () => {
  const { db, putTick } = testDatabase();
  const ask = { ...tick, priceX128: 9n };
  const bid = { ...tick, id: 2n, asset: Q, quote: A, priceX128: 10n };
  const oneSided = { ...tick, id: 3n, asset: B, priceX128: 5n };
  for (const best of [ask, bid, oneSided]) putTick(8453, best);
  putTick(8453, { ...ask, id: 4n, priceX128: 1n }, false);
  putTick(8453, { ...ask, id: 5n, priceX128: 1n, availableSupply: 0n }, true);
  const deeperBid = { ...bid, id: 6n, priceX128: 11n };
  const deeperOneSided = { ...oneSided, id: 7n, priceX128: 6n };
  putTick(8453, deeperBid);
  putTick(8453, { ...deeperOneSided, asset: `0x${B.slice(2).toUpperCase()}` });
  const deeperAsks = Array.from({ length: 260 }, (_, i) => ({
    ...ask,
    id: BigInt(100 + i),
    priceX128: 10n,
  }));
  for (const [i, deeperAsk] of deeperAsks.entries())
    putTick(8453, deeperAsk, true, i + 1);
  assert.deepEqual(
    await discoverTicks(db, [8453], 0),
    [
      ask,
      bid,
      oneSided,
      deeperAsks[0],
      deeperBid,
      deeperOneSided,
      ...deeperAsks.slice(1),
    ]
      .slice(0, LIMITS.batch)
      .map((tick) => ({ chainId: 8453, tick })),
  );
});

test("D1 compares uint256 decimal strings exactly and breaks ties by row ID", async () => {
  const { db, putTick } = testDatabase();
  const max = (1n << 256n) - 1n;
  const best = { ...tick, id: 10n, priceX128: max - 1n };
  const tied = { ...best, id: 2n };
  const worst = { ...tick, priceX128: max };
  putTick(8453, worst);
  putTick(8453, tied, true, 1000);
  putTick(8453, best);
  assert.deepEqual(
    await discoverTicks(db, [8453], 0),
    [best, tied, worst].map((tick) => ({ chainId: 8453, tick })),
  );
});

test("a selected tick with an unsupported token leaves other directions eligible", async (t) => {
  const { db, putTick } = testDatabase();
  t.mock.method(console, "log", () => {});
  putTick(1, { ...tick, quote: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
  putTick(8453, tick);
  assert.deepEqual(await discoverTicks(db, [1, 8453], 0), [
    { chainId: 8453, tick },
  ]);
});

test("D1 rotates global pages across price ranks and chains even when rank one is dust", async () => {
  const { db, putTick } = testDatabase();
  assert.deepEqual(await discoverTicks(db, [1, 8453], 20), []);
  const directions = Array.from({ length: 23 }, (_, i) => ({
    chainId: i < 6 ? 1 : 8453,
    tick: {
      ...tick,
      id: BigInt(23 - i),
      asset: `0x${(i + 1).toString(16).padStart(40, "0")}` as const,
      priceX128: i === 0 ? Q128 / 2n : tick.priceX128,
      availableSupply: i === 0 ? 1n : tick.availableSupply,
    },
  }));
  for (const { chainId, tick } of directions.toReversed())
    putTick(chainId, tick);
  const dust = directions[0].tick;
  const deeper = { ...dust, id: 101n, priceX128: Q128, availableSupply: 1000n };
  const deepest = { ...deeper, id: 103n, priceX128: Q128 + 1n };
  const deeperOnBase = {
    ...directions[22].tick,
    id: 102n,
    priceX128: 3n * Q128,
  };
  putTick(1, deepest);
  putTick(1, deeper);
  putTick(8453, deeperOnBase);
  putTick(4663, tick);
  const page = (slot: number) => discoverTicks(db, [8453, 1], slot);
  const pageSize = LIMITS.batch;
  assert.deepEqual(await page(0), directions.slice(0, pageSize));
  assert.deepEqual(await page(1), directions.slice(pageSize, 2 * pageSize));
  assert.deepEqual(await page(2), [
    ...directions.slice(2 * pageSize),
    { chainId: 1, tick: deeper },
  ]);
  assert.deepEqual(await page(3), [
    { chainId: 8453, tick: deeperOnBase },
    { chainId: 1, tick: deepest },
  ]);
  assert.deepEqual(await page(4), await page(0));
  assert.deepEqual(await discoverTicks(db, [1], 0), [
    ...directions.slice(0, 6),
    { chainId: 1, tick: deeper },
    { chainId: 1, tick: deepest },
  ]);
  assert.deepEqual(await discoverTicks(db, [], 0), []);

  const previous = directions[pageSize];
  const next = {
    ...previous.tick,
    id: 999n,
    priceX128: previous.tick.priceX128 - 1n,
  };
  putTick(previous.chainId, next, true, 2000);
  assert.deepEqual(await page(5), [
    { chainId: previous.chainId, tick: next },
    ...directions.slice(pageSize + 1, 2 * pageSize),
  ]);
  assert.deepEqual(await page(7), [
    previous,
    { chainId: 8453, tick: deeperOnBase },
    { chainId: 1, tick: deepest },
  ]);
});

test("each tick compares its book cost with actual AMM proceeds in its own selling direction", () => {
  const forward = {
    tokenIn: A,
    tokenOut: Q,
    amountIn: "10",
    estimatedAmountOut: "30",
    minimumAmountOut: "29",
    quotedAt: Date.now(),
  };
  const reverse = {
    ...forward,
    tokenIn: Q,
    tokenOut: A,
    amountIn: "100",
    estimatedAmountOut: "31",
  };
  const reversed = { ...tick, asset: Q, quote: A, priceX128: Q128 / 4n };
  assert.equal(estimatedSurplus(tick, forward, 10n), 10n);
  assert.equal(estimatedSurplus(reversed, reverse, 100n), 6n);
  assert.equal(estimatedSurplus(reversed, forward, 100n), 0n);
  assert.equal(
    estimatedSurplus(tick, { ...forward, estimatedAmountOut: "19" }, 10n),
    -1n,
  );
  assert.equal(estimatedSurplus(tick, { ...forward, quotedAt: 0 }, 10n), 0n);
});
