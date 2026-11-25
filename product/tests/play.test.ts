import { describe, expect, it } from "vitest";
import { playScenario, playStrategy, scenarioNumber } from "@/lib/play";

const base = { amount: 1000, entry: 100, target: 110, order: 100, rate: 1 };

describe("Yield Explorer scenario", () => {
  it("uses quote-denominated rental cost for longs", () => {
    expect(playScenario({ ...base, strategy: "long" })?.pnl).toBeCloseTo(90);
    expect(playScenario({ ...base, strategy: "long", target: 90 })?.pnl).toBeCloseTo(-110);
  });
  it("uses asset-denominated repayment cost for shorts", () => {
    expect(playScenario({ ...base, strategy: "short", target: 90 })?.pnl).toBeCloseTo(91);
    expect(playScenario({ ...base, strategy: "short" })?.pnl).toBeCloseTo(-111);
  });
  it("separates conditional fills from rental income", () => {
    const buy = playScenario({ ...base, strategy: "buy-the-dip", order: 90 });
    expect(buy?.pnl).toBeCloseTo(222.222222);
    expect(buy?.income).toBeCloseTo(10);
    const sell = playScenario({ ...base, strategy: "take-profit", order: 120 });
    expect(sell?.pnl).toBeCloseTo(100);
    expect(sell?.income).toBeCloseTo(11);
    const hold = playScenario({ ...base, strategy: "hold-and-earn", order: 200, target: 250 });
    expect(hold?.pnl).toBeCloseTo(-500);
    expect(hold?.income).toBeCloseTo(25);
  });
  it("does not imply a rental rate when none was supplied", () => {
    expect(playScenario({ ...base, strategy: "hold-and-earn", rate: undefined })?.income).toBeUndefined();
  });
  it("validates user-supplied values and strategy names", () => {
    expect(playStrategy("long")?.id).toBe("long");
    expect(playStrategy("unknown")).toBeUndefined();
    expect(scenarioNumber("1.25")).toBe(1.25);
    expect(scenarioNumber("0", true)).toBe(0);
    for (const value of ["", "-1", "NaN", "Infinity", "1e2", "0"])
      expect(scenarioNumber(value)).toBeUndefined();
    expect(playScenario({ ...base, strategy: "long", entry: 0 })).toBeUndefined();
  });
});
