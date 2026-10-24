"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { useState } from "react";
import { useConnection } from "wagmi";
import { usePortfolio } from "@/hooks/use-portfolio";
import {
  explainError,
  getNetwork,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { useNetwork } from "@/components/layout/providers";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Input } from "@yld-cx/ui/components/ui/input";
import { Message } from "@/components/forms/financial-fields";
import LoadingScreen from "@/components/layout/loading-screen";
import {
  NetworkGuard,
  WalletConnect,
} from "@/components/wallet/wallet-connect";
import { ProviderCard, UseCard } from "./position-card";
import { useTokens } from "@/hooks/use-market";
import { displayTokens } from "@yld-cx/sdk/registry";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@yld-cx/ui/components/ui/tabs";
import { RefreshCw } from "lucide-react";

const enum OrderTab {
  Provide = "provide",
  Use = "use",
}

const enum OrderFilter {
  All = "all",
  Active = "active",
  Ask = "ask",
  Bid = "bid",
}

const ORDER_FILTERS = [
  OrderFilter.All,
  OrderFilter.Active,
  OrderFilter.Ask,
  OrderFilter.Bid,
] as const;

export function OrdersScreen() {
  const { network } = useNetwork(),
    account = useConnection();
  return (
    <OrdersForWallet key={`${network}/${account.address}`} network={network} />
  );
}
function OrdersForWallet({ network }: { network: NetworkSlug }) {
  const account = useConnection(),
    [tab, setTab] = useState<OrderTab>(OrderTab.Provide),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState<OrderFilter>(OrderFilter.All);
  const query = usePortfolio(network);
  const pages = query.data?.pages ?? [],
    providers = pages.flatMap((p) => p.providers),
    uses = pages.flatMap((p) => p.uses),
    timestamp = pages[0]?.timestamp ?? 0n;
  const metadata = useTokens(
    network,
    [...providers, ...uses].flatMap((p) => [p.tick.asset, p.tick.quote]),
  );
  const matches = (tick: { asset: string; quote: string }) => {
    const asset = metadata.find((t) => t.address === tick.asset.toLowerCase()),
      quote = metadata.find((t) => t.address === tick.quote.toLowerCase());
    const searchable =
      `${tick.asset} ${tick.quote} ${asset?.symbol ?? ""} ${asset?.name ?? ""} ${quote?.symbol ?? ""} ${quote?.name ?? ""}`.toLowerCase();
    if (search && !searchable.includes(search.toLowerCase())) return false;
    const askAsset =
      asset && quote
        ? displayTokens({ token0: asset, token1: quote })[0].address
        : [tick.asset.toLowerCase(), tick.quote.toLowerCase()].sort()[0];
    return (
      (filter !== OrderFilter.Ask && filter !== OrderFilter.Bid) ||
      (tick.asset.toLowerCase() === askAsset) === (filter === OrderFilter.Ask)
    );
  };
  const filteredProviders = providers.filter(
    (p) =>
      matches(p.tick) &&
      (filter !== OrderFilter.Active || p.position.activePrincipalX36 > 0n),
  );
  const filteredUses = uses.filter((p) => matches(p.tick));
  return (
    <>
      <section className="flex flex-wrap items-end justify-between gap-6 py-10">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            All your positions
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Yield Orders<span className="text-brand">.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Manage provided liquidity and active rentals in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          {account.address && (
            <>
              <div className="space-y-1">
                <div className="text-2xl font-semibold tabular-nums">
                  {providers.length}
                </div>
                <div className="text-xs text-muted-foreground">
                  Provide positions
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-2xl font-semibold tabular-nums">
                  {uses.length}
                </div>
                <div className="text-xs text-muted-foreground">Active Uses</div>
              </div>
            </>
          )}
        </div>
      </section>
      {!account.address ? (
        <Card className="items-center text-center [&_h2]:text-xl [&_h3]:text-lg [&_p]:max-w-xl [&_p]:text-muted-foreground">
          <CardContent className="space-y-4">
            <p>Connect to see your Orders</p>
            <WalletConnect />
          </CardContent>
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={(next) => setTab(next as OrderTab)}>
          <div className="my-4 flex flex-wrap items-center justify-between gap-4">
            <TabsList aria-label="Orders tab" data-intent="term" variant="line">
              <TabsTrigger value={OrderTab.Provide}>
                Provide ({providers.length})
              </TabsTrigger>
              <TabsTrigger value={OrderTab.Use}>
                Use ({uses.length})
              </TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-3">
              <Input
                aria-label="Filter Orders by token or address"
                placeholder="Token, market or address"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button
                variant="ghost"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              >
                <RefreshCw
                  className={
                    query.isFetching
                      ? "animate-spin motion-reduce:animate-none"
                      : undefined
                  }
                />
              </Button>
            </div>
          </div>
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Order filters"
          >
            {ORDER_FILTERS.map((value) => (
              <Button
                variant={filter === value ? "secondary" : "ghost"}
                size="sm"
                key={value}
                aria-pressed={filter === value}
                data-intent={
                  value === OrderFilter.Ask || value === OrderFilter.Bid
                    ? value
                    : undefined
                }
                onClick={() => setFilter(value)}
              >
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </div>
          <NetworkGuard chainId={getNetwork(network).chain.id} />
          <TabsContent value={tab}>
            <div className="mt-2 min-h-64" aria-busy={query.isPending}>
              {query.isPending && (
                <LoadingScreen className="min-h-64" label="Loading Orders…" />
              )}
              {query.isError && (
                <Message error>
                  Portfolio could not be read. {explainError(query.error)}
                </Message>
              )}
              <div className="grid grid-cols-1 gap-4">
                {tab === OrderTab.Provide
                  ? filteredProviders.map((p) => (
                      <ProviderCard
                        key={p.tickId.toString()}
                        network={network}
                        {...p}
                      />
                    ))
                  : filteredUses.map((p) => (
                      <UseCard
                        key={p.positionId.toString()}
                        network={network}
                        {...p}
                        timestamp={timestamp}
                      />
                    ))}
              </div>
              {query.isSuccess &&
                (tab === OrderTab.Provide ? filteredProviders : filteredUses)
                  .length === 0 && (
                  <Card className="items-center text-center [&_h2]:text-xl [&_h3]:text-lg [&_p]:max-w-xl [&_p]:text-muted-foreground">
                    <CardContent className="space-y-4">
                      No{" "}
                      {tab === OrderTab.Provide
                        ? "Provide positions"
                        : "active Uses"}{" "}
                      match these filters.
                    </CardContent>
                  </Card>
                )}
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Load more Orders
                </Button>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
