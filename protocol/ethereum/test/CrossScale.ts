import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { F, P0, X } from "./reference.js";

const U256 = (1n << 256n) - 1n;
const U512 = (1n << 512n) - 1n;

// The reference is a single rational floor, independent of the bounded carry recurrence.
function rational(A: bigint, B: bigint, deltas: bigint[]): bigint {
  const span = deltas.length - 1;
  const numerator = deltas.reduce((sum, delta, i) => sum + delta * F ** BigInt(span - i), 0n);
  return (A * numerator) / (B * F ** BigInt(span));
}

// Test-only transcription of §9, including the two-limb intermediate bound.
function boundedCarry(A: bigint, B: bigint, deltas: bigint[]) {
  let gain = (A * deltas[0]) / B;
  let remainder = (A * deltas[0]) % B;
  const carries: bigint[] = [];
  let pow = 1n;
  for (let i = 1; i < deltas.length; i++) {
    pow *= F;
    const whole = deltas[i] / pow;
    const fraction = deltas[i] % pow;
    const wholeProduct = A * whole;
    const numerator = remainder * F + (wholeProduct % B) * pow + A * fraction;
    const denominator = B * pow;
    assert.ok(numerator <= U512 && denominator <= U512, "bounded uint512 intermediate");
    const carry = numerator / denominator;
    assert.ok(carry <= 2n, "bounded two-step carry");
    gain += wholeProduct / B + carry;
    remainder = numerator % denominator;
    carries.push(carry);
  }
  return { gain, carries, remainder };
}

describe("canonical cross-scale gain carry", () => {
  const B = P0 * X;
  for (const span of [0, 1, 8]) {
    it(`matches one rational floor with span ${span}`, () => {
      const deltas = Array.from({ length: span + 1 }, (_, i) =>
        i === span ? U256 - BigInt(span) : i % 2 === 0 ? 0n : BigInt(i),
      );
      assert.equal(boundedCarry(B - 1n, B, deltas).gain, rational(B - 1n, B, deltas));
      const finalOnly = Array(span).fill(0n).concat([U256]);
      assert.equal(boundedCarry(B - 1n, B, finalOnly).gain, rational(B - 1n, B, finalOnly));
    });
  }

  it("preserves zero, one, and two units of carry", () => {
    const cases = [
      { deltas: [1n, 0n], carry: 0n },
      { deltas: [1n, 1n], carry: 1n },
      { deltas: [1n, 2n * F - 1n], carry: 2n },
    ];
    for (const { deltas, carry } of cases) {
      const result = boundedCarry(B - 1n, B, deltas);
      assert.equal(result.carries[0], carry);
      assert.equal(result.gain, rational(B - 1n, B, deltas));
    }
  });

  it("matches maximum and near-uint256 scale sums across eight scales", () => {
    for (const A of [1n, X - 1n, 10n ** 66n - 1n, B - 1n]) {
      const deltas = [U256, ...Array.from({ length: 8 }, (_, i) => (i % 2 ? U256 - BigInt(i) : 0n))];
      assert.equal(boundedCarry(A, B, deltas).gain, rational(A, B, deltas));
    }
  });

  it("matches 2,048 seeded rational vectors, including skipped scales", () => {
    let seed = 0xdecafbadn;
    const draw = () => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & U256;
      return seed;
    };
    for (let vector = 0; vector < 2048; vector++) {
      const span = Number(draw() % 9n);
      const A = 1n + (draw() % B);
      const deltas = Array.from({ length: span + 1 }, (_, i) =>
        i !== span && draw() % 4n === 0n ? 0n : draw(),
      );
      assert.equal(boundedCarry(A, B, deltas).gain, rational(A, B, deltas), `vector ${vector}`);
    }
  });
});
