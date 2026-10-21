"use client";
/* eslint-disable @next/next/no-img-element -- Token icons use remote metadata with a local fallback. */
import type { Token } from "@yld-cx/sdk";
import { tokenImageUrl } from "@/lib/token-metadata";
export function tokenIconFallback(image: HTMLImageElement) {
  if (image.getAttribute("src") !== "/token.svg") image.src = "/token.svg";
}
export function TokenIcon({
  token,
  size = 34,
}: {
  token: Pick<Token, "symbol" | "imageUrl">;
  size?: number;
}) {
  return (
    <img
      key={token.imageUrl}
      className="shrink-0 rounded-full"
      src={tokenImageUrl(token.imageUrl) ?? "/token.svg"}
      onError={(event) => tokenIconFallback(event.currentTarget)}
      width={size}
      height={size}
      alt={`${token.symbol} logo`}
      loading="lazy"
      decoding="async"
    />
  );
}
export function PairIcons({
  tokens,
}: {
  tokens: readonly Pick<Token, "symbol" | "imageUrl">[];
}) {
  return (
    <span className="isolate inline-flex shrink-0 items-center [&>img:first-child]:z-10 [&>img+img]:-ml-2">
      <TokenIcon token={tokens[0]} />
      <TokenIcon token={tokens[1]} />
    </span>
  );
}
