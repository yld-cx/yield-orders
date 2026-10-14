/* eslint-disable @next/next/no-img-element -- Local token icons need no image optimizer or inline placeholder styles. */
import type { Token } from "@yld-cx/sdk";
export function TokenIcon({
  token,
  size = 34,
}: {
  token: Pick<Token, "symbol" | "logoURI">;
  size?: number;
}) {
  return (
    <img
      className="shrink-0 rounded-full"
      src={
        token.logoURI?.replace("https://yld.cx", "") ?? "/tokens/fallback.svg"
      }
      width={size}
      height={size}
      alt={`${token.symbol} logo`}
      loading="lazy"
      decoding="async"
    />
  );
}
export function PairIcons({ tokens }: { tokens: readonly [Token, Token] }) {
  return (
    <span className="inline-flex shrink-0 items-center [&>img+img]:-ml-2">
      <TokenIcon token={tokens[0]} />
      <TokenIcon token={tokens[1]} />
    </span>
  );
}
