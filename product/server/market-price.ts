import "server-only";
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
export function getMarketPrice(network: NetworkSlug, a: Address, b: Address) {
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
  const fallback = registry.getMarket(n.id, a, b)?.baseTick;
  const reference: MarketReference = {
    price: {},
    timestamp: Date.now(),
    ...(fallback === undefined
      ? {}
      : { baseTick: nearestProductTick(fallback) }),
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
    if (fallback !== undefined)
      reference.price.configured = humanPrice(
        priceAtTick(fallback),
        token0.decimals,
        token1.decimals,
      );
    const baseTick = calculatedBaseTick(
      tokens[0],
      tokens[1],
      PRODUCT_MARKET.stepTicks,
    );
    if (baseTick !== undefined) {
      const [n0, d0] = decimalFraction(tokens[0].priceUsd!);
      const [n1, d1] = decimalFraction(tokens[1].priceUsd!);
      reference.price.meta = formatRatio(n0 * d1, d0 * n1, 256);
      reference.baseTick = baseTick;
    }
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
          BigInt(quote.estimatedAmountOut) <= 0n
        )
          throw new Error("Unusable AMM reference");
        const price = formatRatio(
          BigInt(quote.estimatedAmountOut) * 10n ** BigInt(token0.decimals),
          BigInt(amount) * 10n ** BigInt(token1.decimals),
          256,
        );
        reference.price.amm = price;
        reference.timestamp = quote.quotedAt;
        reference.baseTick = snappedPrice(
          price,
          token0.decimals,
          token1.decimals,
          PRODUCT_MARKET.stepTicks,
        ).priceTick;
      } catch {
        /* Metadata and configured prices remain available if quoting fails. */
      }
    }
  } catch {
    /* A configured tick remains useful when token reads fail. */
  }
  return reference;
}
