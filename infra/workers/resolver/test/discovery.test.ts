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

test("D1 selects the lowest active, funded price in each direction, including one-sided markets", async () => {
  const { db, putTick } = testDatabase();
  const ask = { ...tick, priceX128: 9n };
  const bid = { ...tick, id: 2n, asset: Q, quote: A, priceX128: 10n };
  const oneSided = { ...tick, id: 3n, asset: B, priceX128: 5n };
  for (const best of [ask, bid, oneSided]) putTick(8453, best);
  putTick(8453, { ...ask, id: 4n, priceX128: 1n }, false);
  putTick(8453, { ...ask, id: 5n, priceX128: 1n, availableSupply: 0n }, true);
  putTick(8453, { ...bid, id: 6n, priceX128: 11n });
  putTick(8453, {
    ...oneSided,
    id: 7n,
    asset: `0x${B.slice(2).toUpperCase()}`,
    priceX128: 6n,
  });
  for (let i = 0; i < 260; i++)
    putTick(
      8453,
      { ...ask, id: 100n + BigInt(i), priceX128: 10n },
      true,
      i + 1,
    );
  assert.deepEqual(
    await discoverTicks(db, [8453], 0),
    [ask, bid, oneSided].map((tick) => ({ chainId: 8453, tick })),
  );
});

test("D1 compares uint256 decimal strings exactly and breaks ties by row ID", async () => {
  const { db, putTick } = testDatabase();
  const max = (1n << 256n) - 1n;
  const best = { ...tick, id: 10n, priceX128: max - 1n };
  putTick(8453, { ...tick, priceX128: max });
  putTick(8453, { ...best, id: 2n }, true, 1000);
  putTick(8453, best);
  assert.deepEqual(await discoverTicks(db, [8453], 0), [
    { chainId: 8453, tick: best },
  ]);
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

test("D1 rotates stable global pages over enabled chains and wraps after a partial page", async () => {
  const { db, putTick } = testDatabase();
  assert.deepEqual(await discoverTicks(db, [1, 8453], 20), []);
  const directions = Array.from({ length: 23 }, (_, i) => ({
    chainId: i < 6 ? 1 : 8453,
    tick: {
      ...tick,
      id: BigInt(23 - i),
      asset: `0x${(i + 1).toString(16).padStart(40, "0")}` as const,
    },
  }));
  for (const { chainId, tick } of directions.toReversed())
    putTick(chainId, tick);
  putTick(4663, tick);
  const page = (slot: number) => discoverTicks(db, [8453, 1], slot);
  const pageSize = LIMITS.batch;
  assert.deepEqual(await page(0), directions.slice(0, pageSize));
  assert.deepEqual(await page(1), directions.slice(pageSize, 2 * pageSize));
  assert.deepEqual(await page(2), directions.slice(2 * pageSize));
  assert.deepEqual(await page(3), await page(0));
  assert.deepEqual(await discoverTicks(db, [1], 0), directions.slice(0, 6));
  assert.deepEqual(await discoverTicks(db, [], 0), []);

  const previous = directions[pageSize];
  const next = {
    ...previous.tick,
    id: 999n,
    priceX128: previous.tick.priceX128 - 1n,
  };
  putTick(previous.chainId, next, true, 2000);
  assert.deepEqual(await page(4), [
    { chainId: previous.chainId, tick: next },
    ...directions.slice(pageSize + 1, 2 * pageSize),
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
