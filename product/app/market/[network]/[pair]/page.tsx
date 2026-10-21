import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { parseMarketRoute, marketLabel, ORIGIN } from "@/lib/registry";
import { MarketScreen } from "@/components/markets/market-screen";
type Props = {
  params: Promise<{
    network: string;
    pair: string;
  }>;
};
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { network, pair } = await params;
  let route;
  try {
    route = parseMarketRoute(network, pair);
  } catch {
    return { title: "Market not found", robots: { index: false } };
  }
  const label = await marketLabel(route.network.id, route.key),
    title = `${label} · Liquidity Rental Market on ${route.network.name}`,
    description = `Provide or rent ${label} at your price on ${route.network.name}. Asset moves. Quote locks.`,
    url = `${ORIGIN}${route.canonicalPath}`,
    image = `${url}/og`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      siteName: "yld.cx",
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
export default async function Page({ params }: Props) {
  const { network, pair } = await params;
  let route;
  try {
    route = parseMarketRoute(network, pair);
  } catch {
    notFound();
  }
  if (
    decodeURIComponent(network) !== route.network.slug ||
    decodeURIComponent(pair) !== route.key
  )
    permanentRedirect(route.canonicalPath);
  return (
    <MarketScreen
      key={`${route.network.slug}/${route.key}`}
      network={route.network.slug}
      pair={route.key}
    />
  );
}
