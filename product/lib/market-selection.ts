import {
  MAX_TICK,
  MIN_TICK,
  PRODUCT_MARKET,
  type Direction,
} from "@yld-cx/sdk";

export type BookSide = "bid" | "ask";
export type OrderAction = "limit" | "swap" | "rent";
export type Selection =
  | { kind: "none" }
  | { kind: "market" }
  | { kind: "tick"; canonicalTick: number };
export interface OrderSelection {
  action: OrderAction;
  side: BookSide;
  inverted: boolean;
  selection: Selection;
  lastTick?: number;
}
export type SelectionEvent =
  | { type: "tick"; canonicalTick: number }
  | { type: "market" }
  | { type: "action"; action: OrderAction }
  | { type: "side"; side: BookSide }
  | { type: "invert" };

export function orderSelection(
  state: OrderSelection,
  event: SelectionEvent,
): OrderSelection {
  switch (event.type) {
    case "tick":
      return {
        ...state,
        lastTick: event.canonicalTick,
        selection: { kind: "tick", canonicalTick: event.canonicalTick },
      };
    case "market":
      return { ...state, action: "swap", selection: { kind: "market" } };
    case "action":
      return {
        ...state,
        action: event.action,
        selection:
          event.action !== "swap" && state.selection.kind === "market"
            ? state.lastTick === undefined
              ? { kind: "none" }
              : { kind: "tick", canonicalTick: state.lastTick }
            : state.selection,
      };
    case "side":
      return { ...state, side: event.side };
    // Inversion swaps the displayed side while retaining the underlying asset and economic price.
    case "invert":
      return {
        ...state,
        inverted: !state.inverted,
        side: state.side === "bid" ? "ask" : "bid",
      };
  }
}

const { stepTicks, visibleRows } = PRODUCT_MARKET;
const minLevel = Math.ceil(MIN_TICK / stepTicks);
const maxLevel = Math.floor(MAX_TICK / stepTicks);
export function nearestProductTick(tick: number) {
  return (
    Math.min(maxLevel, Math.max(minLevel, Math.round(tick / stepTicks))) *
    stepTicks
  );
}
/** First canonical tick of an ascending, ten-level page. */
export function initialBookWindow(tick: number) {
  return (
    Math.min(
      maxLevel - visibleRows + 1,
      Math.max(
        minLevel,
        nearestProductTick(tick) / stepTicks - Math.floor(visibleRows / 2),
      ),
    ) * stepTicks
  );
}
export function bookWindow(start: number) {
  return Array.from(
    { length: visibleRows },
    (_, index) => start + index * stepTicks,
  );
}
export function moveBookWindow(
  start: number,
  direction: "higher" | "lower",
  displayInverse: boolean,
) {
  const sign = (direction === "higher" ? 1 : -1) * (displayInverse ? -1 : 1);
  const next = start + sign * stepTicks * visibleRows;
  // Keep complete pages and never introduce overlapping boundary pages.
  return next < minLevel * stepTicks ||
    next + (visibleRows - 1) * stepTicks > maxLevel * stepTicks
    ? start
    : next;
}
export function bookDirection(
  side: BookSide,
  displayInverse: boolean,
): Direction {
  return (side === "bid") !== displayInverse ? 1 : 0;
}
