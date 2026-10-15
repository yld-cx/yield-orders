import { yieldListSchema, type YieldList } from "../schemas/yieldlist.ts";
import type { Category, Market, NetworkId, Token } from "../types/index.ts";
import { normalizeAddress, pairKey } from "./addresses.ts";
export * from "./addresses.ts";
export * from "../schemas/yieldlist.ts";
export class Registry {
  readonly data: YieldList;
  private readonly tokens = new Map<string, Token>();
  private readonly markets = new Map<NetworkId, Market[]>();
  private readonly byPair = new Map<string, Market>();
  private readonly byToken = new Map<string, Market[]>();
  private readonly byTag = new Map<string, Market[]>();
  private readonly search = new Map<Market, string>();
  constructor(input: unknown) {
    this.data = yieldListSchema.parse(input);
    for (const [network, items] of Object.entries(this.data.tokens))
      for (const [address, meta] of Object.entries(items))
        this.tokens.set(`${network}/${address}`, {
          ...meta,
          network: network as NetworkId,
          address,
          listed: true,
        });
    for (const [network, items] of Object.entries(this.data.markets)) {
      const list: Market[] = [];
      for (const [key, meta] of Object.entries(items)) {
        const [a, b] = key.split(":");
        const token0 = this.getToken(network as NetworkId, a)!,
          token1 = this.getToken(network as NetworkId, b)!;
        const market: Market = {
          ...meta,
          network: network as NetworkId,
          key,
          token0,
          token1,
        };
        list.push(market);
        this.byPair.set(`${network}/${key}`, market);
        this.search.set(
          market,
          `${token0.symbol} ${token0.name} ${a} ${token1.symbol} ${token1.name} ${b} ${token0.symbol}/${token1.symbol} ${token1.symbol}/${token0.symbol}`.toLowerCase(),
        );
        for (const token of [token0, token1]) {
          const id = `${network}/${token.address}`;
          this.byToken.set(id, [...(this.byToken.get(id) ?? []), market]);
        }
        const tags = new Set([...(token0.tags ?? []), ...(token1.tags ?? [])]);
        for (const tag of tags) {
          const id = `${network}/${tag}`;
          this.byTag.set(id, [...(this.byTag.get(id) ?? []), market]);
        }
      }
      this.markets.set(network as NetworkId, list);
    }
  }
  getToken(network: NetworkId, address: string): Token | undefined {
    try {
      return this.tokens.get(
        `${network}/${normalizeAddress(network, address)}`,
      );
    } catch {
      return undefined;
    }
  }
  getTokens(network: NetworkId): Token[] {
    return [...this.tokens.values()].filter((t) => t.network === network);
  }
  getMarket(network: NetworkId, a: string, b: string): Market | undefined {
    return this.byPair.get(`${network}/${pairKey(network, a, b)}`);
  }
  getMarkets(network: NetworkId): Market[] {
    return this.markets.get(network) ?? [];
  }
  getMarketsByToken(network: NetworkId, address: string): Market[] {
    return (
      this.byToken.get(`${network}/${normalizeAddress(network, address)}`) ?? []
    );
  }
  getMarketsByTag(network: NetworkId, tag: Category): Market[] {
    return this.byTag.get(`${network}/${tag}`) ?? [];
  }
  searchMarkets(network: NetworkId, query: string): Market[] {
    const words = query
      .toLowerCase()
      .trim()
      .replace(/\s*[/|]\s*/g, "/")
      .split(/\s+/);
    return this.getMarkets(network).filter((m) =>
      words.every((w) => this.search.get(m)!.includes(w)),
    );
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
const quotePreference = ["USDC", "USDT", "DAI", "EURC", "WETH"];
export function displayTokens(
  market: Pick<Market, "token0" | "token1">,
): readonly [Token, Token] {
  const rank = (t: Token) => {
    const i = quotePreference.indexOf(t.symbol);
    return i < 0 ? 100 : i;
  };
  return rank(market.token0) < rank(market.token1)
    ? [market.token1, market.token0]
    : [market.token0, market.token1];
}
