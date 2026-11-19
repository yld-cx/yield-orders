import { describe, expect, it } from "vitest";
import { MAX_TICK, MIN_TICK, PRODUCT_MARKET } from "@yld-cx/sdk";
import {
  bookDirection,
  bookWindow,
  initialBookWindow,
  moveBookWindow,
  orderSelection,
  type OrderSelection,
} from "@/lib/market-selection";
import { humanPrice, priceAtTick, tickIdFor } from "@yld-cx/sdk/ethereum";
const initial: OrderSelection = {
  action: "limit",
  side: "bid",
  inverted: false,
  lastTick: -196000,
  selection: { kind: "tick", canonicalTick: -196000 },
};
describe("bounded product grid", () => {
  it.each([false, true])(
    "moves ten levels without gaps/overlap (inverse %s)",
    (inverse) => {
      const start = initialBookWindow(-196001);
      const first = bookWindow(start);
      const next = moveBookWindow(start, "higher", inverse);
      const second = bookWindow(next);
      expect(first).toHaveLength(PRODUCT_MARKET.visibleRows);
      expect(Math.abs(next - start)).toBe(1000);
      expect(new Set([...first, ...second]).size).toBe(20);
      const ordered = [...first, ...second].sort((a, b) => a - b);
      ordered
        .slice(1)
        .forEach((value, i) => expect(value - ordered[i]).toBe(100));
      expect(moveBookWindow(next, "lower", inverse)).toBe(start);
    },
  );
  it.each([MIN_TICK, MAX_TICK])(
    "keeps ten valid levels at bound %s",
    (tick) => {
      const start = initialBookWindow(tick),
        window = bookWindow(start);
      expect(window).toHaveLength(10);
      expect(
        window.every(
          (level) =>
            level >= MIN_TICK && level <= MAX_TICK && level % 100 === 0,
        ),
      ).toBe(true);
      expect(
        moveBookWindow(start, tick === MIN_TICK ? "lower" : "higher", false),
      ).toBe(start);
    },
  );
  it("maps sides, decimals and inversion to canonical identities", () => {
    expect(bookDirection("bid", false)).toBe(1);
    expect(bookDirection("ask", false)).toBe(0);
    expect(bookDirection("bid", true)).toBe(0);
    expect(bookDirection("ask", true)).toBe(1);
    expect(humanPrice(priceAtTick(-196000), 18, 6)).not.toBe("0");
    expect(humanPrice(priceAtTick(-196000), 18, 6, true)).not.toBe("0");
    expect(tickIdFor(1n, 0, -196000, 7)).not.toBe(tickIdFor(1n, 1, 196000, 7));
  });
});
describe("shared selection", () => {
  it("never invents a price selection before the user chooses a tick", () => {
    const empty: OrderSelection = {
      ...initial,
      selection: { kind: "none" },
      lastTick: undefined,
    };
    for (const action of ["limit", "swap", "rent"] as const)
      expect(
        orderSelection(empty, { type: "action", action }).selection,
      ).toEqual({ kind: "none" });
    expect(
      orderSelection(empty, { type: "side", side: "ask" }).selection,
    ).toEqual({ kind: "none" });
    expect(orderSelection(empty, { type: "invert" }).selection).toEqual({
      kind: "none",
    });
    const market = orderSelection(empty, { type: "market" });
    for (const action of ["limit", "rent"] as const)
      expect(
        orderSelection(market, { type: "action", action }).selection,
      ).toEqual({ kind: "none" });
  });

  it.each(["limit", "swap", "rent"] as const)(
    "tick selection preserves %s",
    (action) => {
      const next = orderSelection(
        { ...initial, action },
        { type: "tick", canonicalTick: -195900 },
      );
      expect(next.action).toBe(action);
      expect(next.lastTick).toBe(-195900);
    },
  );
  it("Market activates Swap; Limit/Rent restore the last tick", () => {
    const market = orderSelection(initial, { type: "market" });
    expect(market.action).toBe("swap");
    for (const action of ["limit", "rent"] as const)
      expect(
        orderSelection(market, { type: "action", action }).selection,
      ).toEqual(initial.selection);
  });
  it("side changes preserve price and inversion preserves the economic asset", () => {
    const ask = orderSelection(initial, { type: "side", side: "ask" });
    expect(ask.selection).toEqual(initial.selection);
    const inverse = orderSelection(initial, { type: "invert" });
    expect(inverse.side).toBe("ask");
    expect(inverse.selection).toEqual(initial.selection);
    expect(bookDirection(inverse.side, inverse.inverted)).toBe(
      bookDirection(initial.side, initial.inverted),
    );
    expect(orderSelection(inverse, { type: "invert" })).toEqual(initial);
  });
});
