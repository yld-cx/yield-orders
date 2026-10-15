import { FORMAT_PRECISION, LARGE_PRICE_THRESHOLD } from "@yld-cx/sdk";
import type { Token, TickState } from "@yld-cx/sdk";
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
