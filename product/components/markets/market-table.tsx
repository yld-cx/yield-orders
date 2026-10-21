"use client";
import {
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
} from "@yld-cx/ui/components/ui/table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import {
  ArrowRight,
  Search,
  Layers,
  MoveUpRight,
  ArrowLeftRight,
  RotateCcw,
} from "lucide-react";
import { displayTokens } from "@yld-cx/sdk/registry";
import {
  marginalYieldPercent,
  getNetwork,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { type Duration, type Tick } from "@yld-cx/sdk";
import { useMarket, useTokens } from "@/hooks/use-market";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { fallbackToken } from "@/lib/token-metadata";
import { registry, marketPath } from "@/lib/registry";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import { useMarketFilters } from "@/hooks/use-market-filters";
import { MARKET_TAGS } from "@/lib/market-filters";
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
    metadata.find((t) => t.address === address) ??
    fallbackToken(config.network, address);
  const tokens = displayTokens<Pick<Token, "address" | "symbol" | "imageUrl">>(
    market ?? {
      token0: token(config.token0.address),
      token1: token(config.token1.address),
    },
  );
  const router = useRouter();
  const query = useQuery({
    queryKey: [
      "ticks",
      network,
      config.key,
      "summary",
      market?.baseTick,
      config.stepTicks,
    ],
    enabled: !!market,
    queryFn: async () => {
      if (!market) throw new Error("Token metadata unavailable");
      const pair = await sdk.getPair(
        market.token0.address as Address,
        market.token1.address as Address,
      );
      if (!pair[3]) return { exists: false, ticks: [], failed: 0, checked: 0 };
      const result = await sdk.discover(pair[0], {
        baseTick: market.baseTick,
        stepTicks: market.stepTicks,
      });
      return {
        exists: true,
        ticks: result.reads.flatMap((r) =>
          r.status === "exists" ? [r.tick] : [],
        ),
        failed: result.reads.filter((r) => r.status === "failed").length,
        checked: result.reads.length,
      };
    },
    refetchInterval: QUERY_TIMING.marketRefresh,
  });
  const ticks =
    query.data?.ticks.filter((t) => t.durationDays === duration) ?? [];
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
              {config.tags?.[0] ?? "Token"} · {getNetwork(config.network).name}
            </small>
          </span>
        </Link>
      </TableCell>
      {[ask, bid].map((s, i) => (
        <Fragment key={i}>
          <TableCell className="p-4 text-right first:text-left">
            <div className={i === 0 ? "text-ask" : "text-bid"}>
              {query.isPending && !result.error ? (
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
            <small className={query.isPending ? "invisible" : undefined}>
              {query.isPending || (query.isSuccess && !query.data.failed)
                ? "Available"
                : "Refresh to retry"}
            </small>
          </TableCell>
          <TableCell className="p-4 text-right first:text-left">
            <YieldReference
              duration={duration}
              pending={query.isPending}
              ticks={query.data?.failed || query.isError ? [] : s.side}
            />
          </TableCell>
        </Fragment>
      ))}
      <TableCell className="p-4 text-right first:text-left">
        <ArrowRight size={18} aria-hidden="true" />
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
    updateFilters,
  } = useMarketFilters();
  const id = getNetwork(network as NetworkSlug).id;
  const addresses = registry.getTokens(id).map((t) => t.address);
  const metadata = useTokenMetadata(network, addresses);
  const tokens = useTokens(network, addresses);
  const markets = registry
    .searchMarkets(id, search, [...tokens, ...metadata])
    .filter(
      (m) =>
        category === "all" ||
        registry.getMarketsByTag(id, category).includes(m),
    );
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
            Provide or rent tokens at your price. Earn yield when renters repay,
            or swap at the price you choose.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-1">
            <div className="text-2xl font-semibold tabular-nums">
              {registry
                .searchMarkets(id, "")
                .length.toString()
                .padStart(2, "0")}
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
              {tag === "all"
                ? "All"
                : tag.charAt(0).toUpperCase() + tag.slice(1)}
            </Button>
          ))}
        </div>
        <Card className="gap-0 p-0">
          <CardContent className="space-y-4">
            {markets.length > 0 ? (
              <Table className="min-w-[28rem] table-fixed md:min-w-[48rem] [&_tr>:nth-child(4)]:hidden [&_tr>:nth-child(5)]:hidden [&_tr>:nth-child(6)]:hidden md:[&_tr>:nth-child(4)]:table-cell md:[&_tr>:nth-child(5)]:table-cell md:[&_tr>:nth-child(6)]:table-cell">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[45%] px-4 text-right first:text-left md:w-[30%]">
                      Market
                    </TableHead>
                    <TableHead className="w-[30%] px-4 text-right first:text-left md:w-[15%]">
                      Ask liquidity
                    </TableHead>
                    <TableHead className="w-[25%] px-4 text-right first:text-left md:w-[15%]">
                      Ask Yield
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left md:w-[15%]">
                      Bid liquidity
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left md:w-[15%]">
                      Bid Yield
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left md:w-[10%]">
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {markets.map((m) => (
                    <MarketRow
                      key={`${id}/${m.key}`}
                      market={m}
                      duration={duration}
                    />
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No matching markets</EmptyTitle>
                  <EmptyDescription>
                    Try another token or category, or open a permissionless
                    market.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <div className="flex gap-4">
                    {(search || category !== "all") && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          updateFilters({ search: "", tag: "all" })
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
            <div className="border-t p-4 text-xs leading-relaxed text-muted-foreground">
              Estimated Yield is earned on Repay. Swap or Close settles in
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
