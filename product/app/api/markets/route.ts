import { networks } from "@yld-cx/sdk/ethereum";
import { MarketTab } from "@/lib/market-filters";
import { getTrendingMarkets } from "@/server/markets";
import { MARKET_CACHE_SECONDS, type MarketList } from "@/lib/market-list";
import { registry } from "@/lib/registry";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const network = networks.find(
    (n) => String(n.chain.id) === params.get("chainId"),
  );
  const tag = params.get("tag") ?? MarketTab.YieldList;
  if (
    !network ||
    params.has("duration") ||
    (tag !== MarketTab.YieldList && tag !== MarketTab.Trending) ||
    ["chainId", "duration", "tag"].some((key) => params.getAll(key).length > 1)
  )
    return Response.json(
      { error: "Invalid market filters" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const markets =
      tag === MarketTab.Trending
        ? await getTrendingMarkets(network.slug)
        : registry.getMarkets(network.id);
    return Response.json({ markets } satisfies MarketList, {
      headers: {
        "Cache-Control": markets.length
          ? `public, max-age=0, s-maxage=${MARKET_CACHE_SECONDS}`
          : "no-store",
      },
    });
  } catch {
    return Response.json(
      { markets: registry.getMarkets(network.id) } satisfies MarketList,
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
