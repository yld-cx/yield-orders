import { describe, it, expect } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import {
  candidateLevels,
  tickCandidates,
  tickIdFor,
  pairIdFor,
  sqrtRatioAtTick,
  priceAtTick,
  Q128,
  tokenAmount,
  snappedPrice,
  humanPrice,
  marginalYieldPercent,
  MAX_AMOUNT,
} from "@yld-cx/sdk/ethereum";
import { priceText } from "@/lib/market-values";
describe("protocol price and Tick identity", () => {
  it("accepts supported high-decimal amounts and generated extreme prices", () => {
    expect(tokenAmount(`0.${"0".repeat(254)}1`, 255)).toBe(1n);
    expect(tokenAmount(`0.${"0".repeat(224)}1`, 255)).toBe(MAX_AMOUNT);
    for (const price of [1n, Q128, priceAtTick(887272)])
      for (const inverted of [false, true])
        for (const [assetDecimals, quoteDecimals] of [
          [0, 255],
          [255, 0],
        ]) {
          const value = humanPrice(
            price,
            assetDecimals,
            quoteDecimals,
            inverted,
          );
          expect(value).not.toBe("0");
          expect(() => priceText(value)).not.toThrow();
        }
    expect(() => tokenAmount("1".repeat(513), 0)).toThrow();
  });
  it("uses the marginal curve without inflating Yield for small raw supplies", () => {
    for (const availableSupply of [1n, 1000000n, 10n ** 30n]) {
      expect(
        marginalYieldPercent({
          availableSupply,
          activeWorking: 0n,
          durationDays: 7n,
        }),
      ).toBe("0.07");
      expect(
        marginalYieldPercent({
          availableSupply,
          activeWorking: 0n,
          durationDays: 30n,
        }),
      ).toBe("0.3");
    }
    // At 50% utilization: 7 * (1 + 99 * 0.5^3) / 100 = 0.93625%.
    expect(
      marginalYieldPercent({
        availableSupply: 500n,
        activeWorking: 500n,
        durationDays: 7n,
      }),
    ).toBe("0.9362");
    expect(
      marginalYieldPercent({
        availableSupply: 0n,
        activeWorking: 500n,
        durationDays: 7n,
      }),
    ).toBeUndefined();
  });
  it("matches exact TickMath endpoints and identity", () => {
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n);
    expect(sqrtRatioAtTick(887272)).toBe(
      1461446703485210103287273052203988822378723970342n,
    );
    expect(priceAtTick(0)).toBe(Q128);
    expect(() => priceAtTick(887273)).toThrow();
  });
  it("computes ABI-encoded nonsequential IDs with the canonical widths", () => {
    const args = [42n, 1, -196000, 7n] as const;
    expect(tickIdFor(...args)).toBe(
      BigInt(
        keccak256(
          encodeAbiParameters(
            [
              { type: "uint256" },
              { type: "uint8" },
              { type: "int32" },
              { type: "uint64" },
            ],
            args,
          ),
        ),
      ),
    );
    expect(tickIdFor(42n, 1, -196000, 7)).not.toBe(
      tickIdFor(42n, 1, -195000, 7) + 1n,
    );
    expect(
      pairIdFor(
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ),
    ).toBe(
      pairIdFor(
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000001",
      ),
    );
  });
  it("scans both sides symmetrically without shifting the grid", () => {
    expect(candidateLevels(-196000, 1000, 2)).toEqual([
      -196000, -197000, -195000, -198000, -194000,
    ]);
    expect(candidateLevels()).toEqual([
      0, -1000, 1000, -2000, 2000, -3000, 3000, -4000, 4000, -5000, 5000, -6000,
      6000, -7000, 7000, -8000, 8000, -9000, 9000, -10000, 10000,
    ]);
    const ticks = tickCandidates(42n, -196000, 1000, 1);
    expect(
      ticks.map((t) => [t.direction, t.priceTick, t.durationDays]),
    ).toEqual([
      [0, -196000, 7],
      [0, -196000, 30],
      [1, 196000, 7],
      [1, 196000, 30],
      [0, -197000, 7],
      [0, -197000, 30],
      [1, 197000, 7],
      [1, 197000, 30],
      [0, -195000, 7],
      [0, -195000, 30],
      [1, 195000, 7],
      [1, 195000, 30],
    ]);
    expect(new Set(ticks.map((t) => t.id)).size).toBe(ticks.length);
  });
  it("supports configurable radii and enforces radius and TickMath bounds", () => {
    expect(candidateLevels(887000, 1000, 2)).toEqual([887000, 886000, 885000]);
    expect(candidateLevels(-196000, 1000, 0)).toEqual([-196000]);
    expect(candidateLevels(-196000, 1000, 1)).toEqual([
      -196000, -197000, -195000,
    ]);
    expect(() => candidateLevels(0, 0)).toThrow();
    expect(() => candidateLevels(1, 1000)).toThrow();
    expect(() => candidateLevels(0, 1000, 129)).toThrow();
    expect(() => tickIdFor(1n, 0, 0, 0)).toThrow();
  });
  it("converts token amounts without floating point or silently rounding", () => {
    expect(tokenAmount("1.000001", 6)).toBe(1000001n);
    expect(tokenAmount("9007199254.740993", 6)).toBe(9007199254740993n);
    expect(tokenAmount("0.000000000000000001", 18)).toBe(1n);
    expect(() => tokenAmount("0.0000001", 6)).toThrow();
    for (const input of ["-1", "1e3", "NaN", "0", "01", "1,000"])
      expect(() => tokenAmount(input, 18)).toThrow();
  });
  it("adjusts both decimals and snaps the exact executable price", () => {
    expect(humanPrice(Q128, 18, 6)).toBe("1000000000000");
    expect(humanPrice(Q128, 6, 18)).toBe("0.000000000001");
    const snap = snappedPrice("3000", 18, 6, 1000);
    expect(snap.priceTick).toBe(-196000);
    expect(snap.priceX128).toBe(priceAtTick(-196000));
    expect(snappedPrice(snap.price, 18, 6, 1000).priceTick).toBe(
      snap.priceTick,
    );
    expect(snappedPrice("1", 18, 18, 1000).priceTick).toBe(0);
    expect(snappedPrice("0.0003", 6, 18, 1000).priceTick % 1000).toBe(0);
  });
  it("snaps reciprocal Bid input as an exact rational, with both token decimals", () => {
    const bid = snappedPrice("3000", 6, 18, 1000, true);
    expect(bid.priceTick).toBe(196000);
    expect(bid.priceX128).toBe(priceAtTick(196000));
    expect(() => snappedPrice("0", 6, 18, 1000, true)).toThrow(
      "Price must be positive",
    );
    // Equal raw-decimal prices give opposite displayed orientations, even at the extremes.
    expect(humanPrice(Q128, 18, 6, true)).toBe("0.000000000001");
    expect(humanPrice(Q128, 6, 18, true)).toBe("1000000000000");
    expect(humanPrice(1n, 255, 0, true)).not.toBe("0");
  });
});
