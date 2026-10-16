import {
  FORMAT_PRECISION,
  LARGE_PRICE_THRESHOLD,
  MIN_TICK,
  MAX_TICK,
} from "@yld-cx/sdk";
import type { Token, TickState, Market } from "@yld-cx/sdk";
import { decimalFraction, formatRatio, humanPrice } from "@yld-cx/sdk/ethereum";

export function tickPrice(
  tick:
    | Pick<TickState, "priceX128" | "asset">
    | { state: Pick<TickState, "priceX128" | "asset"> },
  display: readonly [Token, Token],
) {
  const state = "state" in tick ? tick.state : tick;
  const inverted =
    state.asset.toLowerCase() !== display[0].address.toLowerCase();
  const [asset, quote] = inverted ? [display[1], display[0]] : display;
  return humanPrice(state.priceX128, asset.decimals, quote.decimals, inverted);
}

// Presentation only; transaction amounts use the original rationals.
export function priceText(value: string) {
  const [n, d] = decimalFraction(value);
  const [whole, fraction = ""] = value.split(".");
  const precision =
    BigInt(whole) >= LARGE_PRICE_THRESHOLD
      ? FORMAT_PRECISION.largePrice
      : BigInt(whole) >= 1n
        ? FORMAT_PRECISION.price
        : Math.max(
            FORMAT_PRECISION.smallPrice,
            (fraction.match(/^0*/)?.[0].length ?? 0) +
              FORMAT_PRECISION.smallPriceSignificant,
          );
  const scale = 10n ** BigInt(precision);
  const rounded = (n * scale + d / 2n) / d;
  const result = formatRatio(rounded, scale, precision);
  const [integer, tail] = result.split(".");
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (tail ? `.${tail}` : "")
  );
}

export function compactPriceText(value: string) {
  if (BigInt(value.split(".")[0]) < LARGE_PRICE_THRESHOLD)
    return priceText(value);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function discoveryBaseTick(
  value: string | null,
  market: Pick<Market, "baseTick" | "stepTicks">,
): number {
  if (value === null || !/^-?\d+$/.test(value)) return market.baseTick;
  const tick = Number(value);
  return Number.isSafeInteger(tick) &&
    tick % market.stepTicks === 0 &&
    tick >= MIN_TICK &&
    tick <= MAX_TICK
    ? tick
    : market.baseTick;
}
