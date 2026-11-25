import { describe, expect, it } from "vitest";
import { playScenario, playStrategy, scenarioNumber, playSlider, playTarget, playOutcome, playSnapshotParams, readPlayValues } from "@/lib/play";

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

describe("Slider and shareable scenario", () => {
  const selection = { network: "base", market: "pair", strategy: "long" as const };
  it("derives absolute target prices, including small token prices", () => {
    expect(playTarget(1700, 10)).toBe("1870");
    expect(playTarget(0.00000000001, 10)).toBe("0.000000000011");
    expect(playSlider("buy-the-dip").max).toBe(0);
    expect(playSlider("hold-and-earn").max).toBeGreaterThan(playSlider("take-profit").max);
  });
  it("round trips the scenario and reproduces its outcome", () => {
    const values = { amount: 1000, entry: 1700, target: 1870, rate: 0.5 };
    const params = playSnapshotParams(selection, values, -196000);
    expect(params.get("tick")).toBe("-196000");
    expect(readPlayValues(params)).toEqual(values);
    expect(playOutcome("long", readPlayValues(params)!)?.value).toBeCloseTo(95);
    expect(playSnapshotParams(selection, { ...values, target: 1800 }).toString()).not.toBe(params.toString());
  });
  it("retains an explicit unavailable rate instead of inventing yield", () => {
    const params = playSnapshotParams(selection, { amount: 1000, entry: 100, target: 110 });
    expect(params.get("rate")).toBe("none");
    expect(playOutcome("long", readPlayValues(params)!)?.label).toBe("Potential PnL before rental cost");
    expect(playOutcome("hold-and-earn", readPlayValues(params)!)?.value).toBeUndefined();
  });
  it("returns conditional fill amounts or conditional rental income", () => {
    expect(playOutcome("buy-the-dip", { amount: 1000, entry: 100, target: 80 })?.value).toBe(12.5);
    expect(playOutcome("take-profit", { amount: 1000, entry: 100, target: 120 })?.value).toBe(1200);
    expect(playOutcome("hold-and-earn", { amount: 1000, entry: 100, target: 200, rate: 1 })?.value).toBe(0.1);
  });
  it("rejects invalid snapshots", () => {
    expect(readPlayValues(new URLSearchParams("amount=1000&entry=100&target=0"))).toBeUndefined();
    expect(readPlayValues(new URLSearchParams("amount=1000&entry=100&target=110&rate=NaN"))).toBeUndefined();
  });
});
