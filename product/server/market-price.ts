import "server-only";
import { unstable_cache } from "next/cache";
import { PRODUCT_MARKET } from "@yld-cx/sdk";
import {
  getNetwork,
  deploymentFor,
  decimalFraction,
  formatRatio,
  snappedPrice,
  humanPrice,
  priceAtTick,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { UniswapClient, same } from "@yld-cx/sdk/uniswap";
import { registry } from "@/lib/registry";
import { getSdk } from "@/lib/rpc";
import { fetchTokenMetadata } from "@/lib/token-metadata";
import { calculatedBaseTick } from "@/lib/market-values";
import { referenceAmount, type MarketReference } from "@/lib/market-reference";
import { nearestProductTick } from "@/lib/market-selection";
import { walletSwapAvailable } from "@/lib/swap-availability";
import type { Address } from "viem";

const pending = new Map<string, Promise<MarketReference>>();
function load(network: NetworkSlug, a: Address, b: Address) {
  const key = `${network}/${a}/${b}`;
  let result = pending.get(key);
  if (!result) {
    result = loadReference(network, a, b).finally(() => pending.delete(key));
    pending.set(key, result);
  }
  return result;
}
async function loadReference(
  network: NetworkSlug,
  a: Address,
  b: Address,
): Promise<MarketReference> {
  const n = getNetwork(network);
  const timestamp = Date.now();
  const fallback = registry.getMarket(n.id, a, b)?.baseTick;
  const unavailable: MarketReference = {
    status: "unavailable",
    source: null,
    timestamp,
    ammAvailable: false,
  };
  try {
    const sdk = getSdk(network);
    const [token0, token1, metadata] = await Promise.all([
      sdk.tokenMetadata(a),
      sdk.tokenMetadata(b),
      fetchTokenMetadata(n.id, [a, b]).catch(() => []),
    ]);
    const tokens = [token0, token1].map((token) => ({
      ...token,
      priceUsd: metadata.find(
        (m) =>
          m.address === token.address && m.status === "available" && !m.stale,
      )?.priceUsd,
    }));
    if (walletSwapAvailable(n.chain.id, a, b)) {
      try {
        const amount = referenceAmount(tokens[0]).toString();
        const quote = await new UniswapClient({
          apiKey: process.env.UNISWAP_API_KEY ?? "",
        }).price({
          chainId: n.chain.id,
          mode: "wallet-router",
          tokenIn: a,
          tokenOut: b,
          amount,
          swapper: deploymentFor(n.id).address,
          slippage: 0.5,
        });
        if (
          !same(quote.tokenIn, a) ||
          !same(quote.tokenOut, b) ||
          quote.amountIn !== amount ||
          BigInt(quote.estimatedAmountOut) <= 0n ||
          quote.priceImpact === undefined ||
          quote.priceImpact > 1 ||
          quote.priceImpact < 0 ||
          !Number.isFinite(quote.priceImpact)
        )
          throw new Error("Unusable AMM reference");
        const price = formatRatio(
          BigInt(quote.estimatedAmountOut) * 10n ** BigInt(token0.decimals),
          BigInt(amount) * 10n ** BigInt(token1.decimals),
          256,
        );
        const baseTick = snappedPrice(
          price,
          token0.decimals,
          token1.decimals,
          PRODUCT_MARKET.stepTicks,
        ).priceTick;
        return {
          status: "available",
          source: "amm",
          price,
          baseTick,
          timestamp: quote.quotedAt,
          ammAvailable: true,
        };
      } catch {
        /* Try trusted metadata before the configured reference. */
      }
    }
    const baseTick = calculatedBaseTick(
      tokens[0],
      tokens[1],
      PRODUCT_MARKET.stepTicks,
    );
    if (baseTick !== undefined) {
      const [n0, d0] = decimalFraction(tokens[0].priceUsd!);
      const [n1, d1] = decimalFraction(tokens[1].priceUsd!);
      return {
        status: "available",
        source: "metadata",
        price: formatRatio(n0 * d1, d0 * n1, 256),
        baseTick,
        timestamp,
        ammAvailable: false,
      };
    }
    if (fallback !== undefined)
      return {
        status: "available",
        source: "configured",
        baseTick: nearestProductTick(fallback),
        price: humanPrice(
          priceAtTick(fallback),
          token0.decimals,
          token1.decimals,
        ),
        timestamp,
        ammAvailable: false,
      };
  } catch {
    /* A configured tick remains useful when token reads fail. */
  }
  return fallback === undefined
    ? unavailable
    : {
        ...unavailable,
        status: "available",
        source: "configured",
        baseTick: nearestProductTick(fallback),
      };
}
// Next's Data Cache persists results across requests/users. In-flight promises
// only coalesce work; they are not the reference cache. Arguments are canonical.
const cachedReference = unstable_cache(
  load,
  [
    "market-reference-v1",
    JSON.stringify(registry.data),
    "max-one-token-or-10-usd",
    "max-impact-1-percent",
    "slippage-0.5",
  ],
  { revalidate: PRODUCT_MARKET.referenceCacheSeconds },
);
export async function getMarketPrice(
  network: NetworkSlug,
  a: Address,
  b: Address,
) {
  const reference = await cachedReference(network, a, b);
  // Do not serve an expired indication while Next revalidates in the background.
  return Date.now() - reference.timestamp >=
    PRODUCT_MARKET.referenceCacheSeconds * 1000
    ? load(network, a, b)
    : reference;
}
