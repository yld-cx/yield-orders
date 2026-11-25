import type { Metadata } from "next";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";
import { ORIGIN } from "@/lib/registry";
import {
  playPreviewSubtitle,
  playTokens,
  readPlaySelection,
} from "@/lib/play-market";
import {
  playOutcome,
  playOutcomeText,
  playPageTitle,
  playPath,
  readPlayValues,
} from "@/lib/play";

export async function playMetadata(
  network?: NetworkSlug,
  strategy?: string,
): Promise<Metadata> {
  const selection = readPlaySelection({ network, strategy });
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
  const url = `${ORIGIN}${playPath(network, strategy)}`;
  const image = `${url}/og`;
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
