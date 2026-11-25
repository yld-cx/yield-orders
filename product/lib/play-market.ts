import {
  getNetwork,
  humanPrice,
  priceAtTick,
  snappedPrice,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import {
  MAX_TICK,
  MIN_TICK,
  PRODUCT_MARKET,
  type MarketConfiguration,
  type Token,
} from "@yld-cx/sdk";
import { isAddress, zeroAddress } from "viem";
import { isNetworkSlug } from "@/lib/registry";
import { nearestProductTick } from "@/lib/market-selection";
import { trendingMarkets, USD_ADDRESSES } from "@/lib/trending-markets";
import {
  decodePlayStrategy,
  playDecimal,
  playSlider,
  playStrategy,
  PlayStrategy,
  rentsStablecoin,
  scenarioNumber,
  type PlaySettings,
} from "@/lib/play";
import { fetchTokenMetadata } from "@/lib/token-metadata";

type PriceToken = Pick<Token, "address" | "decimals">;

export function playTickSlider(
  settings: Pick<PlaySettings, "id" | "target" | "targetTick">,
  entry: number,
  asset: PriceToken,
  quote: PriceToken,
) {
  const bounds = playSlider(settings.id);
  if (!bounds) return;

  const step = PRODUCT_MARKET.stepTicks;
  const bid =
    settings.id === PlayStrategy.BuyTheDip ||
    settings.id === PlayStrategy.Short;
  const [provided, received] = bid ? [quote, asset] : [asset, quote];
  const canonicalTick = (tick: number) =>
    asset.address.toLowerCase() < quote.address.toLowerCase() ? tick : -tick;
  // Slider ticks increase with the displayed price. The bid book displays its reciprocal.
  const priceAt = (tick: number) =>
    humanPrice(
      priceAtTick(bid ? -tick : tick),
      provided.decimals,
      received.decimals,
      bid,
    );
  const firstTick = nearestProductTick(MIN_TICK);
  const lastTick = nearestProductTick(MAX_TICK);
  const firstPrice = Number(priceAt(firstTick));
  const lastPrice = Number(priceAt(lastTick));
  const tickAt = (price: number) => {
    if (price <= firstPrice) return firstTick;
    if (price >= lastPrice) return lastTick;
    try {
      const { priceTick } = snappedPrice(
        playDecimal(price),
        provided.decimals,
        received.decimals,
        step,
        bid,
      );
      return bid ? -priceTick : priceTick;
    } catch {
      // A rounded display price can fall just outside the exact protocol bounds.
      return price - firstPrice < lastPrice - price ? firstTick : lastTick;
    }
  };

  const lowerPrice = entry * (1 + bounds.min / 100);
  const upperPrice = entry * (1 + bounds.max / 100);
  const lowerTick = tickAt(lowerPrice);
  const upperTick = tickAt(upperPrice);
  const min =
    Number(priceAt(lowerTick)) < lowerPrice ? lowerTick + step : lowerTick;
  const max =
    Number(priceAt(upperTick)) > upperPrice ? upperTick - step : upperTick;
  if (min > max) return;

  const position = (bounds.initial - bounds.min) / (bounds.max - bounds.min);
  const initial = nearestProductTick(min + (max - min) * position);
  const savedPrice = scenarioNumber(settings.target ?? "");
  const tick =
    settings.targetTick !== undefined
      ? canonicalTick(settings.targetTick)
      : savedPrice === undefined
        ? initial
        : tickAt(savedPrice);
  const value = Math.max(min, Math.min(max, tick));
  return {
    min,
    max,
    step,
    value,
    price: priceAt(value),
    priceAt,
    canonicalTick,
  };
}

export function playMarket(
  network: NetworkSlug,
  token?: string,
): MarketConfiguration | undefined {
  if (!token || !isAddress(token, { strict: false }) || token === zeroAddress)
    return undefined;
  return trendingMarkets(getNetwork(network).id, [token])[0];
}

export function playAddresses(
  market: MarketConfiguration,
  settings: PlaySettings,
): readonly [string, string] {
  const usd = USD_ADDRESSES[market.network]?.toLowerCase();
  const a = market.token0.address;
  const b = market.token1.address;
  const [token, stable] = a === usd ? [b, a] : [a, b];
  return rentsStablecoin(settings) ? [stable, token] : [token, stable];
}

export function readPlayNetwork(params: Pick<URLSearchParams, "get">) {
  const network = params.get("network");
  return network && isNetworkSlug(network) ? network : undefined;
}

export function playPreviewSubtitle(network?: NetworkSlug) {
  return network
    ? `Play yld.cx way on ${getNetwork(network).name}`
    : "Play yld.cx way";
}

export function readPlaySelection(params: Pick<URLSearchParams, "get">) {
  const network = readPlayNetwork(params);
  if (!network) return undefined;
  const settings = decodePlayStrategy(params.get("strategy"));
  const strategy = playStrategy(settings?.id ?? null);
  const market = playMarket(network, settings?.token);
  if (!settings || !strategy || !market) return undefined;
  return { network, market, strategy, settings };
}

export async function playTokens(
  market: MarketConfiguration,
  settings: PlaySettings,
) {
  const addresses = playAddresses(market, settings);
  const [asset, quote] = await fetchTokenMetadata(market.network, addresses);
  return { asset, quote };
}
