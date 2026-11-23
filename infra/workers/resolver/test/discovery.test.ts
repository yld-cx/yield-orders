import test from "node:test";
import assert from "node:assert/strict";
import { Q128 } from "@yld-cx/sdk/ethereum";
import { activeTicks, estimatedSurplus } from "../src/ticks.ts";
import { LIMITS } from "../src/config.ts";
import { testDatabase } from "./database.ts";

const A = "0x1111111111111111111111111111111111111111" as const;
const Q = "0x2222222222222222222222222222222222222222" as const;
const tick = {
  id: 1n,
  asset: A,
  quote: Q,
  priceX128: 2n * Q128,
  availableSupply: 10n ** 40n,
};

test("D1 discovery selects a bounded set of recent active ticks on the requested chain", async () => {
  const { db, putTick } = testDatabase();
  assert.deepEqual(await activeTicks(db, 8453), []);
  putTick(1, tick, true, 1000);
  putTick(8453, { ...tick, id: 2n, availableSupply: 0n }, false, 1000);
  for (let i = 0; i < LIMITS.indexedTicks + 1; i++)
    putTick(8453, { ...tick, id: (1n << 255n) + BigInt(i) }, true, i);
  const results = await activeTicks(db, 8453);
  assert.equal(results.length, LIMITS.indexedTicks);
  assert.deepEqual(results[0], {
    ...tick,
    id: (1n << 255n) + BigInt(LIMITS.indexedTicks),
  });
  assert.equal(results.at(-1)?.id, (1n << 255n) + 1n);
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
