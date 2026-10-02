import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

const F = 10n ** 9n;
const X = 10n ** 36n;
const U256 = (1n << 256n) - 1n;

// A single rational floor, independent of the Solidity carry recurrence.
function oracle(initial: bigint, product: bigint, span: number, deltas: bigint[]): bigint {
  const denominator = product * F ** BigInt(span);
  const numerator = deltas.slice(0, span + 1).reduce((sum, delta, i) => sum + delta * F ** BigInt(span - i), 0n);
  return (initial * numerator) / denominator;
}

function carries(initial: bigint, product: bigint, span: number, deltas: bigint[]): number[] {
  let remainder = (initial * deltas[0]) % product;
  const result: number[] = [];
  for (let i = 1; i <= span; i++) {
    const power = F ** BigInt(i);
    const whole = deltas[i] / power;
    const fraction = deltas[i] % power;
    const principalWhole = initial / product;
    const numerator =
      remainder * F +
      ((initial * whole) % product) * power +
      product * ((principalWhole * fraction) % power) +
      (initial % product) * fraction;
    result.push(Number(numerator / (product * power)));
    remainder = numerator % (product * power);
  }
  return result;
}

describe("compiled Solidity Product-Sum differential", async () => {
  const { viem } = await network.create();
  it("propagates high-limb carries and borrows at Uint512 boundaries", async () => {
    const harness = await viem.deployContract("ProductSumHarness");
    assert.deepEqual(await harness.read.add512([5n, U256, 0n, 1n]), [6n, 0n]);
    assert.deepEqual(await harness.read.sub512([5n, 0n, 4n, 1n]), [0n, U256]);
    assert.deepEqual(await harness.read.sub512([U256, 0n, 0n, U256]), [U256 - 1n, 1n]);
    await assert.rejects(harness.read.add512([U256, U256, 0n, 1n]));
    await assert.rejects(harness.read.sub512([0n, 0n, 0n, 1n]));
  });
  it("matches 1,152 deterministic rational vectors across spans, limbs, and carries", async () => {
    const harness = await viem.deployContract("ProductSumHarness");
    let seed = 0x8873a7d4n;
    const draw = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & U256;
      return seed;
    };
    const seen = new Set<number>();
    let highLimb = false;
    let skipped = false;
    for (let vector = 0; vector < 1152; vector++) {
      const span = vector % 9;
      const product = [10n ** 30n, 10n ** 36n, 10n ** 39n][vector % 3];
      const initial = 1n + (draw() % (product * X));
      const deltas = Array.from({ length: 9 }, (_, i) => {
        if (i > span || (i < span && vector % 4 === 0 && i % 2 === 1)) return 0n;
        return draw() % 10n ** 39n;
      });
      if (vector % 7 === 0 && span > 0) deltas[span] = F ** BigInt(span) - 1n;
      const expected = oracle(initial, product, span, deltas);
      assert.ok(expected <= U256, `oracle result fits uint256: ${vector}`);
      const actual = await harness.read.accruedGainX36([initial, product, BigInt(span), deltas]);
      assert.equal(actual, expected, `vector ${vector}, span ${span}`);
      for (const carry of carries(initial, product, span, deltas)) seen.add(carry);
      highLimb ||= product * F ** BigInt(span) > U256;
      skipped ||= span > 1 && deltas.slice(1, span).some((delta) => delta === 0n);
    }
    assert.ok(highLimb && skipped);
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
  });
});
