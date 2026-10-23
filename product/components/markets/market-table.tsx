"use client";
import {
  Category,
  QUERY_TIMING,
  type MarketConfiguration,
  type Token,
} from "@yld-cx/sdk";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import {
  TableCell,
  TableRow,
  TableHead,
  TableHeader,
  TableBody,
  Table,
  TableCaption,
} from "@yld-cx/ui/components/ui/table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Search,
  Layers,
  MoveUpRight,
  ArrowLeftRight,
  RotateCcw,
} from "lucide-react";
import { displayTokens } from "@yld-cx/sdk/registry";
import { marginalYieldPercent, getNetwork } from "@yld-cx/sdk/ethereum";
import { type Duration, type Tick } from "@yld-cx/sdk";
import { useMarket } from "@/hooks/use-market";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { fallbackToken } from "@/lib/token-metadata";
import { marketPath } from "@/lib/registry";
import { getSdk } from "@/lib/rpc";
import { queryKeys } from "@/lib/query-keys";
import { amountText } from "@/lib/utils";
import { useMarketFilters } from "@/hooks/use-market-filters";
import { useMarketList } from "@/hooks/use-market-list";
import { MARKET_TAGS, MarketTab } from "@/lib/market-filters";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@yld-cx/ui/components/ui/empty";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Input } from "@yld-cx/ui/components/ui/input";
import { DurationSelect } from "@/components/forms/financial-fields";
import { Skeleton } from "@yld-cx/ui/components/ui/skeleton";
import { PairIcons } from "./token-icon";

const PAGE_SIZE = 10;

function MarketRowSkeleton() {
  return (
    <TableRow aria-hidden="true">
      <TableCell className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex -space-x-2">
            <Skeleton className="size-8 rounded-full motion-reduce:animate-none" />
            <Skeleton className="size-8 rounded-full motion-reduce:animate-none" />
          </div>
          <div className="space-y-1">
            <Skeleton className="h-5 w-28 motion-reduce:animate-none" />
            <Skeleton className="h-4 w-20 motion-reduce:animate-none" />
          </div>
        </div>
      </TableCell>
      {Array.from({ length: 4 }, (_, i) => (
        <TableCell key={i} className="p-4">
          <Skeleton
            className={`ml-auto h-5 ${i % 2 === 0 ? "w-20" : "w-12"} motion-reduce:animate-none`}
          />
          <Skeleton className="ml-auto mt-1 h-4 w-16 motion-reduce:animate-none" />
        </TableCell>
      ))}
      <TableCell className="p-4">
        <Skeleton className="mx-auto size-4 motion-reduce:animate-none" />
      </TableCell>
    </TableRow>
  );
}

function MarketRow({
  market: config,
  duration,
}: {
  market: MarketConfiguration;
  duration: Duration;
}) {
  const network = getNetwork(config.network).slug,
    sdk = getSdk(network);
  const result = useMarket(network, config.key);
  const market = result.market;
  const metadata = useTokenMetadata(network, [
    config.token0.address,
    config.token1.address,
  ]);
  const token = (address: string) =>
    metadata.find((token) => token.address === address) ??
    fallbackToken(config.network, address);
  const tokens = displayTokens<Pick<Token, "address" | "symbol" | "imageUrl">>(
    market ?? {
      token0: token(config.token0.address),
      token1: token(config.token1.address),
    },
  );
  const router = useRouter();
  const query = useQuery({
    queryKey: queryKeys.ticks(
      network,
      config.key,
      market?.baseTick,
      config.stepTicks,
      duration,
    ),
    enabled: !!market && !!result.pair.data,
    queryFn: async () => {
      if (!market) throw new Error("Token metadata unavailable");
      const pair = result.pair.data!;
      if (!pair[3])
        return { reads: [], complete: true, radius: 0, blockNumber: 0n };
      return sdk.discover(pair[0], {
        baseTick: market.baseTick,
        stepTicks: market.stepTicks,
        duration,
      });
    },
    select: (result) => ({
      ticks: result.reads.flatMap((r) =>
        r.status === "exists" ? [r.tick] : [],
      ),
      failed: result.reads.filter((r) => r.status === "failed").length,
      checked: result.reads.length,
    }),
    refetchInterval: QUERY_TIMING.marketRefresh,
  });
  const ticks =
    query.data?.ticks.filter((t) => t.durationDays === duration) ?? [];
  const pending = query.isPending && !result.error;
  function summary(asset: string) {
    const side = ticks.filter(
      (t) => t.state.asset.toLowerCase() === asset.toLowerCase(),
    );
    return {
      available: side.reduce((sum, t) => sum + t.state.availableSupply, 0n),
      working: side.reduce((sum, t) => sum + t.state.activeWorking, 0n),
      side,
    };
  }
  const ask = summary(tokens[0].address),
    bid = summary(tokens[1].address);
  const tag = config.tags?.[0] ?? Category.Token;
  return (
    <TableRow
      className="cursor-pointer"
      onClick={() => router.push(marketPath(config))}
    >
      <TableCell className="p-4 text-right first:text-left">
        <Link
          href={marketPath(config)}
          className="flex items-center gap-3"
          aria-label={`Open ${tokens[0].symbol} / ${tokens[1].symbol}`}
        >
          <PairIcons tokens={tokens} />
          <span className="flex flex-col gap-1">
            <strong>
              {tokens[0].symbol}{" "}
              <span className="text-muted-foreground">/</span>{" "}
              {tokens[1].symbol}
            </strong>
            <small className="text-muted-foreground">
              {tag.charAt(0).toUpperCase() + tag.slice(1)} ·{" "}
              {getNetwork(config.network).name}
            </small>
          </span>
        </Link>
      </TableCell>
      {[ask, bid].map((s, i) => (
        <Fragment key={i}>
          <TableCell className="p-4 text-right first:text-left">
            <div className={i === 0 ? "text-ask" : "text-bid"}>
              {pending ? (
                <Skeleton
                  className="ml-auto h-5 w-20 motion-reduce:animate-none"
                  aria-label="Loading liquidity…"
                />
              ) : query.isError || result.error ? (
                "Read failed"
              ) : query.data?.failed ? (
                "Incomplete"
              ) : (
                `${amountText(s.available, tokens[i].address === market?.token0.address ? market.token0.decimals : market!.token1.decimals)} ${tokens[i].symbol}`
              )}
            </div>
            <small className={pending ? "invisible" : undefined}>
              {pending || (query.isSuccess && !query.data.failed)
                ? "Available"
                : "Refresh to retry"}
            </small>
          </TableCell>
          <TableCell className="p-4 text-right first:text-left">
            <YieldReference
              duration={duration}
              pending={pending}
              ticks={query.data?.failed || query.isError ? [] : s.side}
            />
          </TableCell>
        </Fragment>
      ))}
      <TableCell className="p-4 text-center align-middle">
        <ArrowRight className="mx-auto" size={18} aria-hidden="true" />
      </TableCell>
    </TableRow>
  );
}
function YieldReference({
  duration,
  ticks,
  pending,
}: {
  duration: Duration;
  ticks: Tick[];
  pending: boolean;
}) {
  const tick = ticks.find((t) => t.state.availableSupply > 0n);
  const estimatedYield = tick ? marginalYieldPercent(tick.state) : undefined;
  return (
    <>
      <div className="text-primary">
        {pending ? (
          <Skeleton
            className="ml-auto h-5 w-12 motion-reduce:animate-none"
            aria-label="Loading yield…"
          />
        ) : estimatedYield !== undefined ? (
          `${estimatedYield}%`
        ) : (
          "—"
        )}
      </div>
      <small className={pending ? "invisible" : undefined}>
        {tick || pending ? `${duration}D reference` : "No liquidity yet"}
      </small>
    </>
  );
}
export function MarketTable() {
  const {
    network,
    search,
    tag: category,
    duration,
    page,
    updateFilters,
  } = useMarketFilters();
  const { markets, marketCount, loading, loadingLabel, error, empty } =
    useMarketList({ network, tag: category, search });
  const failed = !!error;
  const pageCount = Math.max(1, Math.ceil(markets.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const visibleMarkets = markets.slice(start, start + PAGE_SIZE);
  useEffect(() => {
    if (!loading && !failed && page !== currentPage)
      updateFilters({ page: currentPage }, true);
  }, [currentPage, failed, loading, page, updateFilters]);
  return (
    <>
      <section className="flex flex-wrap items-end justify-between gap-6 py-10">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Open liquidity rental markets
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Liquidity, on your terms<span className="text-brand">.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Provide and rent tokens. Earn yield or swap at the price you choose.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-1">
            <div className="text-2xl font-semibold tabular-nums">
              {marketCount.toString().padStart(2, "0")}
            </div>
            <div className="text-xs text-muted-foreground">Markets</div>
          </div>
        </div>
      </section>
      <section aria-label="Markets">
        <div className="my-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2>Yield Markets</h2>
            <p className="text-muted-foreground text-xs">
              Choose a market to provide liquidity or rent tokens.
            </p>
          </div>
          <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto">
            <Button render={<Link href="/market/open" />} nativeButton={false}>
              <Layers size={16} />
              Open Market
            </Button>
            <div className="relative min-w-0 flex-1 sm:w-48 sm:flex-none [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-3 [&>svg]:top-2 [&>svg]:size-4 [&>svg]:text-muted-foreground [&>input]:pl-9">
              <Search size={16} />
              <Input
                aria-label="Search markets"
                placeholder="Search markets…"
                value={search}
                onChange={(e) =>
                  updateFilters({ search: e.target.value }, true)
                }
              />
            </div>
            <DurationSelect
              inline
              label="Market duration"
              value={duration}
              onChange={(duration) => updateFilters({ duration })}
            />
          </div>
        </div>
        <div
          className="mb-4 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Token categories"
        >
          {MARKET_TAGS.map((tag) => (
            <Button
              key={tag}
              variant={category === tag ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={category === tag}
              onClick={() => updateFilters({ tag })}
            >
              {tag === MarketTab.YieldList
                ? "YieldList"
                : tag.charAt(0).toUpperCase() + tag.slice(1)}
            </Button>
          ))}
        </div>
        <Card className="gap-0 p-0">
          <CardContent className="space-y-4">
            {error ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{error.title}</EmptyTitle>
                  <EmptyDescription>{error.description}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => error.retry()}>
                    Retry
                  </Button>
                </EmptyContent>
              </Empty>
            ) : loading || markets.length > 0 ? (
              <Table className="min-w-[48rem] table-fixed">
                {loading && (
                  <TableCaption className="sr-only" role="status">
                    {loadingLabel}
                  </TableCaption>
                )}
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%] px-4 text-right first:text-left">
                      Market
                    </TableHead>
                    <TableHead className="w-[15%] px-4 text-right first:text-left">
                      Ask liquidity
                    </TableHead>
                    <TableHead className="w-[15%] px-4 text-right first:text-left">
                      Ask Yield
                    </TableHead>
                    <TableHead className="w-[15%] px-4 text-right first:text-left">
                      Bid liquidity
                    </TableHead>
                    <TableHead className="w-[15%] px-4 text-right first:text-left">
                      Bid Yield
                    </TableHead>
                    <TableHead className="w-[10%] px-4 text-center">
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody aria-busy={loading}>
                  {loading
                    ? Array.from({ length: PAGE_SIZE }, (_, i) => (
                        <MarketRowSkeleton key={i} />
                      ))
                    : visibleMarkets.map((m) => (
                        <MarketRow
                          key={`${m.network}/${m.key}`}
                          market={m}
                          duration={duration}
                        />
                      ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{empty.title}</EmptyTitle>
                  <EmptyDescription>{empty.description}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <div className="flex gap-4">
                    {(search || category !== MarketTab.YieldList) && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          updateFilters({
                            search: "",
                            tag: MarketTab.YieldList,
                          })
                        }
                      >
                        Clear filters
                      </Button>
                    )}
                    <Button
                      render={<Link href="/market/open" />}
                      nativeButton={false}
                    >
                      <Layers size={16} />
                      Open Market
                    </Button>
                  </div>
                </EmptyContent>
              </Empty>
            )}
            {markets.length > 0 && (
              <nav
                aria-label="Market pagination"
                className="flex flex-wrap items-center justify-between gap-3 border-t px-4 pt-4 text-sm"
              >
                <p className="text-muted-foreground" aria-live="polite">
                  {start + 1}–{Math.min(start + PAGE_SIZE, markets.length)} of{" "}
                  {markets.length} markets
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage === 1}
                    onClick={() => updateFilters({ page: currentPage - 1 })}
                  >
                    Previous
                  </Button>
                  <span>
                    Page {currentPage} of {pageCount}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage === pageCount}
                    onClick={() => updateFilters({ page: currentPage + 1 })}
                  >
                    Next
                  </Button>
                </div>
              </nav>
            )}
            <div className="border-t p-4 text-xs leading-relaxed text-muted-foreground">
              Estimated Yield is earned on Repay. Swap closes the position in
              Quote.
            </div>
          </CardContent>
        </Card>
      </section>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: MoveUpRight,
            color: "text-primary",
            title: "01 · Provide liquidity",
            text: "Open your Yield market and supply tokens.",
          },
          {
            icon: ArrowLeftRight,
            color: "text-rent",
            title: "02 · Rent or swap",
            text: "Use tokens at your price against locked Quote.",
          },
          {
            icon: RotateCcw,
            color: "text-brand",
            title: "03 · Earn or trade",
            text: "Earn Yield on Repay or exchange tokens at your price.",
          },
        ].map(({ icon: Icon, color, title, text }) => (
          <Card key={title}>
            <CardContent className="space-y-4">
              <Icon size={24} className={color} aria-hidden="true" />
              <h3>{title}</h3>
              <p className="text-sm text-muted-foreground">{text}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
