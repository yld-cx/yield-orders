import { decimalFraction, formatRatio } from "@yld-cx/sdk/ethereum";
import { MAX_AMOUNT, type Token } from "@yld-cx/sdk";

export interface MarketReference {
  status: "available" | "unavailable";
  source: "amm" | "metadata" | "configured" | null;
  /** Human token1 per token0; always canonical, never executable. */
  price?: string;
  baseTick?: number;
  timestamp: number;
  ammAvailable: boolean;
}
// Target $10 using trusted metadata; otherwise sample 0.001 token.
// Keep the raw amount bounded. No user-supplied quote size.
export function referenceAmount(token: Pick<Token, "decimals" | "priceUsd">) {
  const unit = 10n ** BigInt(token.decimals);
  let amount = unit / 1000n || 1n;
  if (token.priceUsd) {
    const [n, d] = decimalFraction(token.priceUsd);
    if (n > 0n) amount = (10n * unit * d) / n || 1n;
  }
  return amount < MAX_AMOUNT ? amount : MAX_AMOUNT;
}
export function displayReference(reference: MarketReference, inverse: boolean) {
  if (!reference.price) return;
  if (!inverse) return reference.price;
  const [n, d] = decimalFraction(reference.price);
  return n > 0n ? formatRatio(d, n, 256) : undefined;
}
