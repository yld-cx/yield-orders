import { decimalFraction, formatRatio } from "@yld-cx/sdk/ethereum";
import { MAX_AMOUNT, type Token } from "@yld-cx/sdk";

export interface MarketReference {
  price: {
    amm?: string;
    meta?: string;
    configured?: string;
  };
  baseTick?: number;
  timestamp: number;
}

export function referenceAmount(token: Pick<Token, "decimals" | "priceUsd">) {
  const unit = 10n ** BigInt(token.decimals);
  let amount = unit / 1000n || 1n;
  if (token.priceUsd) {
    const [n, d] = decimalFraction(token.priceUsd);
    if (n > 0n) amount = (10n * unit * d) / n || 1n;
  }
  return amount < MAX_AMOUNT ? amount : MAX_AMOUNT;
}
export function displayReference(
  reference: MarketReference,
  inverse: boolean,
  field?: keyof MarketReference["price"],
) {
  const price = field
    ? reference.price[field]
    : (reference.price.amm ??
      reference.price.meta ??
      reference.price.configured);
  if (!price) return;
  if (!inverse) return price;
  const [n, d] = decimalFraction(price);
  return n > 0n ? formatRatio(d, n, 256) : undefined;
}
