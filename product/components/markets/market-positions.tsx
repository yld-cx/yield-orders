"use client";
import { useConnection } from "wagmi";
import type { Market } from "@yld-cx/sdk";
import { getNetwork, explainError } from "@yld-cx/sdk/ethereum";
import { usePortfolio } from "@/hooks/use-portfolio";
import { ProviderCard, UseCard } from "@/components/orders/position-card";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import { NetworkGuard } from "@/components/wallet/wallet-connect";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@yld-cx/ui/components/ui/tabs";

export function MarketPositions({ market }: { market: Market }) {
  const account = useConnection();
  const network = getNetwork(market.network).slug;
  const portfolio = usePortfolio(network);
  if (!account.address) return null;
  const pages = portfolio.data?.pages ?? [];
  const matchesMarket = ({
    tick,
  }: {
    tick: { asset: string; quote: string };
  }) =>
    [tick.asset.toLowerCase(), tick.quote.toLowerCase()].sort().join(":") ===
    market.key;
  const providers = pages
    .flatMap((page) => page.providers)
    .filter(matchesMarket);
  const uses = pages.flatMap((page) => page.uses).filter(matchesMarket);
  const timestamp = pages[0]?.timestamp ?? 0n;
  if (
    !providers.length &&
    !uses.length &&
    !portfolio.isError &&
    !portfolio.hasNextPage
  )
    return null;
  return (
    <section className="my-6" aria-label="Your positions">
      <div className="my-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2>Your positions</h2>
          <p className="text-xs text-muted-foreground">
            Provided liquidity and active rentals in this market.
          </p>
        </div>
      </div>
      <NetworkGuard chainId={getNetwork(network).chain.id} />
      {portfolio.isError && (
        <Message error>{explainError(portfolio.error)}</Message>
      )}
      <Tabs defaultValue="provide" className="mt-4">
        <TabsList
          aria-label="Market positions tab"
          data-intent="term"
          variant="line"
        >
          <TabsTrigger value="provide">
            Provide ({providers.length})
          </TabsTrigger>
          <TabsTrigger value="use">Use ({uses.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="provide" keepMounted>
          <div className="mt-2 grid grid-cols-1 gap-4">
            {providers.map((position) => (
              <ProviderCard
                key={position.tickId.toString()}
                network={network}
                {...position}
              />
            ))}
          </div>
          {!providers.length && (
            <p className="py-4 text-sm text-muted-foreground">
              No Provide positions in this market.
            </p>
          )}
        </TabsContent>
        <TabsContent value="use" keepMounted>
          <div className="mt-2 grid grid-cols-1 gap-4">
            {uses.map((position) => (
              <UseCard
                key={position.positionId.toString()}
                network={network}
                {...position}
                timestamp={timestamp}
              />
            ))}
          </div>
          {!uses.length && (
            <p className="py-4 text-sm text-muted-foreground">
              No active Use rentals in this market.
            </p>
          )}
        </TabsContent>
      </Tabs>
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
