import type { Metadata } from "next";
import { YieldExplorer } from "@/components/play/yield-explorer";
import { ORIGIN } from "@/lib/registry";
import { readPlaySelection, playTokens } from "@/lib/play-market";
import { playSnapshotParams, readPlayValues, playFormat } from "@/lib/play";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const input = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") params.set(key, value);
  }
  const selection = readPlaySelection(params);
  const values = readPlayValues(params);
  const tokens = selection ? await playTokens(selection.market) : undefined;
  const title = selection && tokens ? `${selection.strategy.title} ${tokens.asset.symbol} · Yield Explorer` : "Yield Explorer";
  const description = selection && tokens && values
    ? `What if ${tokens.asset.symbol} reaches ${playFormat(values.target)} ${tokens.quote.symbol}? Explore a hypothetical scenario.`
    : "Explore and share hypothetical liquidity rental strategies.";
  const query = selection ? playSnapshotParams({ network: selection.network, market: selection.market.key, strategy: selection.strategy.id }, values).toString() : "";
  const url = `${ORIGIN}/play${query ? "?" + query : ""}`;
  const image = `${ORIGIN}/play/og${query ? "?" + query : ""}`;
  return {
    title, description,
    alternates: { canonical: "/play" },
    openGraph: { type: "website", siteName: "yld.cx", title, description, url, images: [{ url: image, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function Page() {
  return <YieldExplorer />;
}
