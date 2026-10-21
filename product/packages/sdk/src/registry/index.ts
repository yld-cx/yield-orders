import { yieldListSchema, type YieldList } from "../schemas/yieldlist.ts";
import type {
  Category,
  MarketConfiguration,
  NetworkId,
  Token,
  TokenReference,
} from "../types/index.ts";
import { normalizeAddress, pairKey } from "./addresses.ts";
export * from "./addresses.ts";
export * from "../schemas/yieldlist.ts";
export class Registry {
  readonly data: YieldList;
  private readonly tokens = new Map<string, TokenReference>();
  private readonly markets = new Map<NetworkId, MarketConfiguration[]>();
  constructor(input: unknown) {
    this.data = yieldListSchema.parse(input);
    for (const [network, items] of Object.entries(this.data.markets)) {
      const id = network as NetworkId;
      this.markets.set(
        id,
        Object.entries(items).map(([key, meta]) => {
          const [a, b] = key.split(":");
          const token = (address: string): TokenReference => {
            const ref = { network: id, address };
            this.tokens.set(`${network}/${address}`, ref);
            return ref;
          };
          return {
            ...meta,
            network: id,
            key,
            token0: token(a),
            token1: token(b),
          };
        }),
      );
    }
  }
  getToken(network: NetworkId, address: string): TokenReference | undefined {
    try {
      return this.tokens.get(
        `${network}/${normalizeAddress(network, address)}`,
      );
    } catch {
      return undefined;
    }
  }
  getTokens(network: NetworkId): TokenReference[] {
    return [...this.tokens.values()].filter(
      (token) => token.network === network,
    );
  }
  getMarket(
    network: NetworkId,
    a: string,
    b: string,
  ): MarketConfiguration | undefined {
    const key = pairKey(network, a, b);
    return this.getMarkets(network).find((market) => market.key === key);
  }
  getMarkets(network: NetworkId): MarketConfiguration[] {
    return this.markets.get(network) ?? [];
  }
  getMarketsByToken(
    network: NetworkId,
    address: string,
  ): MarketConfiguration[] {
    const normalized = normalizeAddress(network, address);
    return this.getMarkets(network).filter(
      (m) => m.token0.address === normalized || m.token1.address === normalized,
    );
  }
  getMarketsByTag(network: NetworkId, tag: Category): MarketConfiguration[] {
    return this.getMarkets(network).filter((m) => m.tags?.includes(tag));
  }
  searchMarkets(
    network: NetworkId,
    query: string,
    metadata: readonly Pick<Token, "address" | "symbol" | "name">[] = [],
  ): MarketConfiguration[] {
    const words = query
      .toLowerCase()
      .trim()
      .replace(/\s*[/|]\s*/g, "/")
      .split(/\s+/);
    return this.getMarkets(network).filter((m) => {
      const [a, b] = [m.token0, m.token1].map((ref) =>
        metadata.find((t) => t.address.toLowerCase() === ref.address),
      );
      const text =
        `${m.key} ${a?.symbol ?? ""} ${a?.name ?? ""} ${b?.symbol ?? ""} ${b?.name ?? ""} ${a?.symbol}/${b?.symbol} ${b?.symbol}/${a?.symbol}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }
}
export async function loadYieldList(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<Registry> {
  const r = await fetcher(url);
  if (!r.ok) throw new Error(`YieldList failed: ${r.status}`);
  return new Registry(await r.json());
}
const quotePreference = ["USD", "EUR", "ETH"];
export function displayTokens<T extends Pick<Token, "symbol">>(market: {
  token0: T;
  token1: T;
}): readonly [T, T] {
  const rank = (t: T) => {
    const symbol = t.symbol.toUpperCase();
    const i = quotePreference.findIndex((quote) => symbol.includes(quote));
    return i < 0 ? quotePreference.length : i;
  };
  return rank(market.token0) < rank(market.token1)
    ? [market.token1, market.token0]
    : [market.token0, market.token1];
}
