import { ImageResponse } from "next/og";
import { parseMarketRoute, registry, marketLabel } from "@/lib/registry";
import { displayTokens } from "@yld-cx/sdk/registry";
import { SocialImage, tokenLogoData } from "@/components/layout/social-image";
export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{
      network: string;
      pair: string;
    }>;
  },
) {
  const { network, pair } = await params;
  let route;
  try {
    route = parseMarketRoute(network, pair);
  } catch {
    return new Response("Invalid market", { status: 404 });
  }
  const [a, b] = route.key.split(":"),
    market = registry.getMarket(route.network.id, a, b),
    tokens = market ? displayTokens(market) : undefined;
  const logos = tokens
    ? ((await Promise.all(tokens.map(tokenLogoData))) as [string, string])
    : ((await Promise.all([tokenLogoData({}), tokenLogoData({})])) as [
        string,
        string,
      ]);
  return new ImageResponse(
    <SocialImage
      label={marketLabel(route.network.id, route.key)}
      network={route.network.name}
      logos={logos}
    />,
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control":
          "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    },
  );
}
