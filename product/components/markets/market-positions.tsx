"use client";
import { useConnection } from "wagmi";
import type { Market } from "@yld-cx/sdk";
import { getNetwork, explainError } from "@yld-cx/sdk/ethereum";
import { usePortfolio } from "@/hooks/use-portfolio";
import { ProviderCard } from "@/components/orders/position-card";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import { NetworkGuard } from "@/components/wallet/wallet-connect";

export function MarketPositions({ market }: { market: Market }) {
  const account = useConnection();
  const network = getNetwork(market.network).slug;
  const portfolio = usePortfolio(network);
  if (!account.address) return null;
  const positions =
    portfolio.data?.pages
      .flatMap((page) => page.providers)
      .filter(
        (position) =>
          [position.tick.asset.toLowerCase(), position.tick.quote.toLowerCase()]
            .sort()
            .join(":") === market.key,
      ) ?? [];
  if (!positions.length && !portfolio.isError && !portfolio.hasNextPage)
    return null;
  return (
    <section className="my-6" aria-label="Your liquidity">
      <div className="my-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2>Your liquidity</h2>
          <p className="text-xs text-muted-foreground">
            Provided positions for this market.
          </p>
        </div>
      </div>
      <NetworkGuard chainId={getNetwork(network).chain.id} />
      {portfolio.isError && (
        <Message error>{explainError(portfolio.error)}</Message>
      )}
      <div className="mt-4 grid grid-cols-1 gap-4">
        {positions.map((position) => (
          <ProviderCard
            key={position.tickId.toString()}
            network={network}
            {...position}
          />
        ))}
      </div>
      {portfolio.hasNextPage && (
        <Button
          variant="outline"
          disabled={portfolio.isFetchingNextPage}
          onClick={() => void portfolio.fetchNextPage()}
        >
          Load more positions
        </Button>
      )}
    </section>
  );
}
