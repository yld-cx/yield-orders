"use client";
import type { Token } from "@yld-cx/sdk";
import { useCallback, useState } from "react";
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
  const src = tokenImageUrl(token.imageUrl) ?? "/token.svg";
  const [readySrc, setReadySrc] = useState<string>();
  const imageRef = useCallback(
    (image: HTMLImageElement | null) => {
      if (image?.complete && image.naturalWidth > 0) setReadySrc(src);
    },
    [src],
  );
  return (
    <img
      key={src}
      ref={imageRef}
      className={`shrink-0 rounded-full ${readySrc === src ? "opacity-100" : "opacity-0"}`}
      src={src}
      onLoad={() => setReadySrc(src)}
      onError={(event) => {
        setReadySrc(undefined);
        tokenIconFallback(event.currentTarget);
      }}
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
