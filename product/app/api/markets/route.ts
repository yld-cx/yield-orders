import { DEFAULT_DURATION, DURATIONS } from "@yld-cx/sdk";
import { networks } from "@yld-cx/sdk/ethereum";
import { MarketTab } from "@/lib/market-filters";
import { getSortedMarkets, getTrendingMarkets } from "@/lib/server/markets";
import type { MarketList } from "@/lib/market-list";
import { registry } from "@/lib/registry";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const network = networks.find(
    (n) => String(n.chain.id) === params.get("chainId"),
  );
  const duration = params.has("duration")
    ? DURATIONS.find((d) => String(d) === params.get("duration"))
    : DEFAULT_DURATION;
  const tag = params.get("tag") ?? MarketTab.YieldList;
  if (
    !network ||
    !duration ||
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
        : await getSortedMarkets(network.slug, duration);
    return Response.json({ markets } satisfies MarketList, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Keep markets accessible during upstream failures without another RPC scan.
    // The fallback is not stored in the daily ranking cache.
    return Response.json(
      { markets: registry.getMarkets(network.id) } satisfies MarketList,
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
