import type { Metadata } from "next";
import { YieldExplorer } from "@/components/play/yield-explorer";
import { ORIGIN } from "@/lib/registry";
import {
  playPreviewSubtitle,
  playTokens,
  readPlayNetwork,
  readPlaySelection,
} from "@/lib/play-market";
import {
  playOutcome,
  playOutcomeText,
  playPageTitle,
  playParams,
  readPlayValues,
} from "@/lib/play";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const input = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") params.set(key, value);
  }
  const network = readPlayNetwork(params);
  const selection = readPlaySelection(params);
  const values = selection ? readPlayValues(selection.settings) : undefined;
  const tokens = selection
    ? await playTokens(selection.market, selection.settings)
    : undefined;
  const outcome =
    selection && values
      ? playOutcome(selection.strategy.id, values)
      : undefined;
  const title = playPageTitle(
    selection && tokens
      ? selection.strategy.description(tokens.asset.symbol, tokens.quote.symbol)
      : undefined,
  );
  const description =
    outcome && outcome.value !== undefined && tokens
      ? `${outcome.label} · ${playOutcomeText(outcome, tokens.asset.symbol, tokens.quote.symbol)}`
      : "Simulate liquidity rental strategies";
  const socialDescription = selection
    ? description
    : playPreviewSubtitle(network);
  const query = network
    ? playParams(network, selection?.settings).toString()
    : "";
  const url = `${ORIGIN}/play${query ? "?" + query : ""}`;
  const image = `${ORIGIN}/play/og${query ? "?" + query : ""}`;
  return {
    title,
    description,
    alternates: { canonical: "/play" },
    openGraph: {
      type: "website",
      siteName: "yld.cx",
      title,
      description: socialDescription,
      url,
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: socialDescription,
      images: [image],
    },
  };
}

export default function Page() {
  return <YieldExplorer />;
}
