import { describe, expect, it } from "vitest";
import {
  marginalTermYieldRatio,
  marginalYieldPercent,
} from "@yld-cx/sdk/ethereum";
import {
  formatYieldPercent,
  marginalTermYield,
  termYieldFromAmounts,
  termYieldToApy,
  tickYieldText,
  yieldText,
} from "@/lib/yield";

const tick = {
  availableSupply: 500n,
  activeWorking: 500n,
  durationDays: 7n,
};

describe("shared yield calculations", () => {
  it.each([7, 30, 365])(
    "compounds a fractional return over %s days",
    (days) => {
      expect(termYieldToApy(0.01, days)).toBeCloseTo(
        1.01 ** (365 / days) - 1,
        12,
      );
    },
  );

  it("annualizes the SDK's unrounded ratio instead of its display percentage", () => {
    const ratio = marginalTermYieldRatio(tick)!;
    expect(Number(ratio[0]) / Number(ratio[1])).toBe(0.0093625);
    expect(marginalTermYield(tick)).toBe(0.0093625);
    expect(marginalYieldPercent(tick)).toBe("0.9362");
    expect(tickYieldText(tick, "apy")).toBe("62.5664%");
    expect(tickYieldText(tick, "apy")).not.toBe(
      yieldText(Number(marginalYieldPercent(tick)) / 100, 7, "apy"),
    );
    expect(tickYieldText(tick, "term")).toBe("0.9363%");
  });

  it.each([
    [7, "0.07%", "3.7161%"],
    [30, "0.3%", "3.7118%"],
  ])("uses the selected %sD term for both displays", (days, term, apy) => {
    const state = { ...tick, activeWorking: 0n, durationDays: BigInt(days) };
    expect(tickYieldText(state, "term")).toBe(term);
    expect(tickYieldText(state, "apy")).toBe(apy);
  });

  it.each([7, 30])("preserves zero yield over %s days", (days) => {
    expect(termYieldFromAmounts(0n, 1000n)).toBe(0);
    expect(termYieldToApy(0, days)).toBe(0);
    for (const mode of ["apy", "term"] as const)
      expect(yieldText(0, days, mode)).toBe("0%");
  });

  it.each([7, 30])(
    "keeps Ask and Bid consistent across token decimals for %sD",
    (days) => {
      const side = (decimals: number) => ({
        availableSupply: 500n * 10n ** BigInt(decimals),
        activeWorking: 500n * 10n ** BigInt(decimals),
        durationDays: BigInt(days),
      });
      for (const mode of ["apy", "term"] as const)
        expect(tickYieldText(side(18), mode)).toBe(
          tickYieldText(side(6), mode),
        );
      expect(termYieldFromAmounts(10n ** 16n, 10n ** 18n)).toBe(
        termYieldFromAmounts(10n ** 4n, 10n ** 6n),
      );
    },
  );

  it("distinguishes unavailable liquidity and invalid amounts from zero yield", () => {
    for (const mode of ["apy", "term"] as const) {
      expect(tickYieldText({ ...tick, availableSupply: 0n }, mode)).toBe("—");
      expect(yieldText(undefined, 7, mode)).toBe("—");
    }
    expect(termYieldFromAmounts(1n, 0n)).toBeUndefined();
    expect(termYieldFromAmounts(-1n, 100n)).toBeUndefined();
    expect(marginalTermYield({ ...tick, durationDays: 0n })).toBeUndefined();
    expect(marginalTermYield({ ...tick, activeWorking: -1n })).toBeUndefined();
  });

  it.each([
    [0.01, 0],
    [0.01, -7],
    [0.01, Infinity],
    [0.01, NaN],
    [-0.01, 7],
    [Infinity, 7],
    [NaN, 7],
    [Number.MAX_VALUE, 1],
  ])("rejects invalid APY inputs (%s, %s)", (value, days) => {
    expect(termYieldToApy(value, days)).toBeUndefined();
  });

  it("formats fractional returns as percentages once, including tiny APYs", () => {
    expect(formatYieldPercent(0.01)).toBe("1%");
    expect(formatYieldPercent(NaN)).toBe("—");
    expect(formatYieldPercent(Infinity)).toBe("—");
    expect(termYieldToApy(1e-20, 7)).toBeGreaterThan(0);
  });
});
