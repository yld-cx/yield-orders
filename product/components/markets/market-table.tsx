"use client";
import { Category, type Token } from "@yld-cx/sdk";
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
import { Fragment, useEffect, useState } from "react";
import {
  ArrowRight,
  Search,
  Layers,
  MoveUpRight,
  ArrowLeftRight,
  RotateCcw,
  LayersPlus,
} from "lucide-react";
import { displayTokens } from "@yld-cx/sdk/registry";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import { type Duration, type Tick } from "@yld-cx/sdk";
import { useMarketLiquidity } from "@/hooks/use-market-liquidity";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { fallbackToken } from "@/lib/token-metadata";
import { marketPath } from "@/lib/registry";
import { amountText } from "@/lib/utils";
import { useMarketFilters } from "@/hooks/use-market-filters";
import { useMarketList } from "@/hooks/use-market-list";
import {
  DEFAULT_MARKET_SORT,
  MARKET_TAGS,
  MarketSort,
  MarketTab,
} from "@/lib/market-filters";
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
import { YieldModeSwitch } from "@/components/forms/yield-display";
import { DEFAULT_YIELD_MODE, tickYieldText, type YieldMode } from "@/lib/yield";

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
  row: { config, result, query },
  duration,
  yieldMode,
}: {
  row: ReturnType<typeof useMarketLiquidity>[number];
  duration: Duration;
  yieldMode: YieldMode;
}) {
  const network = getNetwork(config.network).slug;
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
              yieldMode={yieldMode}
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
  yieldMode,
}: {
  duration: Duration;
  ticks: Tick[];
  pending: boolean;
  yieldMode: YieldMode;
}) {
  const tick = ticks.find((t) => t.state.availableSupply > 0n);
  const estimatedYield = tick ? tickYieldText(tick.state, yieldMode) : "—";
  return (
    <>
      <div className="text-primary">
        {pending ? (
          <Skeleton
            className="ml-auto h-5 w-12 motion-reduce:animate-none"
            aria-label="Loading yield…"
          />
        ) : (
          estimatedYield
        )}
      </div>
      <small className={pending ? "invisible" : undefined}>
        {tick || pending
          ? yieldMode === "apy"
            ? "Annualized"
            : `${duration}D reference`
          : "No liquidity yet"}
      </small>
    </>
  );
}
export function MarketTable() {
  const [yieldMode, setYieldMode] = useState<YieldMode>(
    DEFAULT_YIELD_MODE.markets,
  );
  const {
    network,
    search,
    tag: category,
    duration,
    page,
    updateFilters,
  } = useMarketFilters();
  const {
    markets,
    marketCount,
    tokenCount,
    loading: listLoading,
    loadingLabel,
    error,
    empty,
  } = useMarketList({ network, tag: category, search });
  const sortBy = DEFAULT_MARKET_SORT[category] ?? MarketSort.BidLiquidity;
  const sortByBidLiquidity = sortBy === MarketSort.BidLiquidity;
  const failed = !!error;
  const pageCount = Math.max(1, Math.ceil(markets.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const rows = useMarketLiquidity(
    network,
    sortByBidLiquidity ? markets : markets.slice(start, start + PAGE_SIZE),
    duration,
    sortBy,
  );
  const loading =
    listLoading ||
    (sortByBidLiquidity &&
      rows.some(
        ({ result, query }) =>
          !result.error && (result.isPending || query.isPending),
      ));
  const visibleMarkets = sortByBidLiquidity
    ? rows.slice(start, start + PAGE_SIZE)
    : rows;
  useEffect(() => {
    if (!loading && !failed && page !== currentPage)
      updateFilters({ page: currentPage }, true);
  }, [currentPage, failed, loading, page, updateFilters]);
  return (
    <>
      <section className="flex flex-wrap items-end justify-between gap-6 py-10">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Open liquidity markets
          </p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Tokens, on your terms<span className="text-brand">.</span>
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Place Yield Orders to trade and earn at your price.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-1">
            <div className="text-2xl font-semibold tabular-nums">
              {marketCount.toString().padStart(2, "0")}
            </div>
            <div className="text-xs text-muted-foreground">Markets</div>
          </div>
          <div className="space-y-1">
            <div className="text-2xl font-semibold tabular-nums">
              {tokenCount.toString().padStart(2, "0")}
            </div>
            <div className="text-xs text-muted-foreground">Tokens</div>
          </div>
        </div>
      </section>
      <section aria-label="Markets">
        <div className="my-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2>Yield Markets</h2>
            <p className="text-muted-foreground text-xs">
              Choose a market to put your tokens to work.
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-3 sm:w-auto">
            <Button render={<Link href="/market/open" />} nativeButton={false}>
              <LayersPlus size={16} />
              Launch Market
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
            <div className="w-full sm:w-auto">
              <YieldModeSwitch
                label="Markets yield display"
                termLabel="Term"
                value={yieldMode}
                onChange={setYieldMode}
              />
            </div>
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
                    <TableHead
                      className="w-[15%] px-4 text-right first:text-left"
                      aria-label={yieldMode === "apy" ? "Ask APY" : "Ask Yield"}
                    >
                      {yieldMode === "apy" ? "Ask APY" : "Ask Yield"}
                    </TableHead>
                    <TableHead
                      className="w-[15%] px-4 text-right first:text-left"
                      aria-sort={sortByBidLiquidity ? "descending" : undefined}
                    >
                      Bid liquidity
                    </TableHead>
                    <TableHead
                      className="w-[15%] px-4 text-right first:text-left"
                      aria-label={yieldMode === "apy" ? "Bid APY" : "Bid Yield"}
                    >
                      {yieldMode === "apy" ? "Bid APY" : "Bid Yield"}
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
                          key={`${m.config.network}/${m.config.key}`}
                          row={m}
                          duration={duration}
                          yieldMode={yieldMode}
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
                className="flex flex-wrap items-center justify-between gap-3 border-t p-4 text-sm"
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
          </CardContent>
        </Card>
      </section>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: MoveUpRight,
            color: "text-primary",
            title: "Launch a market",
            text: "Open a Yield market for your favorite token.",
          },
          {
            icon: RotateCcw,
            color: "text-brand",
            title: "Trade and Earn",
            text: "Earn Yield while trading tokens at your price.",
          },
          {
            icon: ArrowLeftRight,
            color: "text-rent",
            title: "Rent or swap",
            text: "Use tokens at your price to go long or short.",
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
