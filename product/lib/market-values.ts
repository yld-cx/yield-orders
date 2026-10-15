import type { Token } from "@yld-cx/sdk";
import { decimalFraction, formatRatio, humanPrice } from "@yld-cx/sdk/ethereum";
import type { BookTick } from "@/hooks/use-yield-book";

export function tickPrice(
  tick: { state: Pick<BookTick["state"], "priceX128" | "asset"> },
  display: readonly [Token, Token],
) {
  const inverted =
    tick.state.asset.toLowerCase() !== display[0].address.toLowerCase();
  const [asset, quote] = inverted ? [display[1], display[0]] : display;
  return humanPrice(
    tick.state.priceX128,
    asset.decimals,
    quote.decimals,
    inverted,
  );
}

export function reciprocalPrice(value: string) {
  if (!value) return "";
  try {
    const [n, d] = decimalFraction(value);
    return n > 0n ? formatRatio(d, n, 48) : value;
  } catch {
    return value;
  }
}

// Presentation only; transaction amounts and price snapping use the original rationals.
export function priceText(value: string) {
  const [n, d] = decimalFraction(value);
  const [whole, fraction = ""] = value.split(".");
  const precision =
    BigInt(whole) >= 1000n
      ? 2
      : BigInt(whole) >= 1n
        ? 4
        : Math.max(8, (fraction.match(/^0*/)?.[0].length ?? 0) + 6);
  const scale = 10n ** BigInt(precision);
  const rounded = (n * scale + d / 2n) / d;
  const result = formatRatio(rounded, scale, precision);
  const [integer, tail] = result.split(".");
  return (
    integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (tail ? `.${tail}` : "")
  );
}
