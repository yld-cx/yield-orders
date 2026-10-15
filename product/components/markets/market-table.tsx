"use client";
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
import { type Market, type Duration, type Tick } from "@yld-cx/sdk";
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
import { PairIcons } from "./token-icon";
function MarketRow({
  market,
  duration,
}: {
  market: Market;
  duration: Duration;
}) {
  const network = getNetwork(market.network).slug,
    sdk = getSdk(network);
  const tokens = displayTokens(market);
  const router = useRouter();
  const query = useQuery({
    queryKey: ["ticks", network, market.key, "summary"],
    queryFn: async () => {
      const pair = await sdk.getPair(
        market.token0.address as Address,
        market.token1.address as Address,
      );
      if (!pair[3]) return { exists: false, ticks: [], failed: 0, checked: 0 };
      const result = await sdk.discover(pair[0], {
        baseTick: market.baseTick,
        stepTicks: market.stepTicks,
        radius: 4,
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
    refetchInterval: 30000,
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
      onClick={() => router.push(marketPath(market))}
    >
      <TableCell className="p-4 text-right first:text-left">
        <Link
          href={marketPath(market)}
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
              {tokens[0].tags?.[0]?.replace("blue-chip", "Blue chip") ??
                "Token"}{" "}
              · {getNetwork(market.network).name}
            </small>
          </span>
        </Link>
      </TableCell>
      {[ask, bid].map((s, i) => (
        <Fragment key={i}>
          <TableCell className="p-4 text-right first:text-left">
            <div className={i === 0 ? "text-ask" : "text-bid"}>
              {query.isPending
                ? "Loading…"
                : query.isError
                  ? "Read failed"
                  : query.data?.failed
                    ? "Incomplete"
                    : `${amountText(s.available, tokens[i].decimals)} ${tokens[i].symbol}`}
            </div>
            <small>
              {query.isSuccess && !query.data.failed
                ? "Available"
                : query.isPending
                  ? ""
                  : "Refresh to retry"}
            </small>
          </TableCell>
          <TableCell className="p-4 text-right first:text-left">
            <YieldReference
              duration={duration}
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
}: {
  duration: Duration;
  ticks: Tick[];
}) {
  const tick = ticks.find((t) => t.state.availableSupply > 0n);
  const estimatedYield = tick ? marginalYieldPercent(tick.state) : undefined;
  return (
    <>
      <div className="text-primary">
        {estimatedYield !== undefined ? `${estimatedYield}%` : "—"}
      </div>
      <small>{tick ? `${duration}D reference` : "No liquidity yet"}</small>
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
  const markets = registry
    .searchMarkets(id, search)
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
                : tag === "blue-chip"
                  ? "Blue chip"
                  : tag.charAt(0).toUpperCase() + tag.slice(1)}
            </Button>
          ))}
        </div>
        <Card className="gap-0 p-0">
          <CardContent className="space-y-4">
            {markets.length > 0 ? (
              <Table className="[&_tr>:nth-child(4)]:hidden [&_tr>:nth-child(5)]:hidden [&_tr>:nth-child(6)]:hidden md:[&_tr>:nth-child(4)]:table-cell md:[&_tr>:nth-child(5)]:table-cell md:[&_tr>:nth-child(6)]:table-cell">
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4 text-right first:text-left">
                      Market
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left">
                      Ask liquidity
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left">
                      Ask Yield
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left">
                      Bid liquidity
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left">
                      Bid Yield
                    </TableHead>
                    <TableHead className="px-4 text-right first:text-left">
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
              Yield is earned only when used liquidity is{" "}
              <strong>repaid</strong>. Swap or Close settles Quote instead.
              Shown rates are marginal references, not guaranteed returns.
            </div>
          </CardContent>
        </Card>
      </section>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {[
          {
            icon: MoveUpRight,
            color: "text-primary",
            title: "01 · Provide",
            text: "Choose a side, set your price and supply tokens to the market.",
          },
          {
            icon: ArrowLeftRight,
            color: "text-rent",
            title: "02 · Rent or swap",
            text: "Others can rent your tokens against locked Quote or Swap immediately.",
          },
          {
            icon: RotateCcw,
            color: "text-brand",
            title: "03 · Earn or settle",
            text: "Repay funds Asset Yield. Swap or maturity Close funds Quote proceeds.",
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
