"use client";
import { Category, type Token, type MarketConfiguration } from "@yld-cx/sdk";
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
import { useEffect, useState } from "react";
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
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { fallbackToken, tokenImageUrl } from "@/lib/token-metadata";
import { marketPath } from "@/lib/registry";
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
import { Skeleton } from "@yld-cx/ui/components/ui/skeleton";
import { PairIcons } from "./token-icon";
import { MARKET_PAGE_SIZE as PAGE_SIZE } from "@/lib/market-list";

function MarketRowSkeleton({ marketKey }: { marketKey?: string }) {
  return (
    <TableRow aria-hidden="true" data-market-key={marketKey}>
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
      <TableCell className="p-4">
        <Skeleton className="mx-auto size-4 motion-reduce:animate-none" />
      </TableCell>
    </TableRow>
  );
}

function MarketRow({ config }: { config: MarketConfiguration }) {
  const network = getNetwork(config.network).slug;
  const metadata = useTokenMetadata(network, [
    config.token0.address,
    config.token1.address,
  ]);
  const token = (address: string) =>
    metadata.find((token) => token.address === address) ??
    fallbackToken(config.network, address);
  const tokens = displayTokens<Pick<Token, "address" | "symbol" | "imageUrl">>({
    token0: token(config.token0.address),
    token1: token(config.token1.address),
  });
  const pending = tokens.map(
    (token) => !metadata.some((item) => item.address === token.address),
  );
  const [loadedImages, setLoadedImages] = useState<Record<string, string>>({});
  const sources = tokens.map(
    (token) => tokenImageUrl(token.imageUrl) ?? "/token.svg",
  );
  const sourceKey = JSON.stringify(
    pending.some(Boolean) ? [] : [...new Set(sources)],
  );
  useEffect(() => {
    const images = (JSON.parse(sourceKey) as string[]).map((source) => {
      const image = new Image();
      const done = () =>
        setLoadedImages((loaded) => ({
          ...loaded,
          [source]: image.getAttribute("src") ?? source,
        }));
      image.onload = done;
      image.onerror = () => {
        if (image.getAttribute("src") !== "/token.svg")
          image.src = "/token.svg";
        else done();
      };
      image.src = source;
      return image;
    });
    return () => {
      for (const image of images) image.onload = image.onerror = null;
    };
  }, [sourceKey]);
  const router = useRouter();
  const tag = config.tags?.[0] ?? Category.Token;
  const marketKey = `${config.network}/${config.key}`;
  if (pending.some(Boolean) || sources.some((source) => !loadedImages[source]))
    return <MarketRowSkeleton marketKey={marketKey} />;
  const readyTokens = tokens.map((token, i) => ({
    ...token,
    imageUrl:
      loadedImages[sources[i]] === "/token.svg" ? undefined : token.imageUrl,
  }));
  return (
    <TableRow
      data-market-key={marketKey}
      className="cursor-pointer"
      onClick={() => router.push(marketPath(config))}
    >
      <TableCell className="p-4 text-right first:text-left">
        <Link
          href={marketPath(config)}
          className="flex min-h-10 items-center gap-3"
          aria-label={`Open ${tokens[0].symbol} / ${tokens[1].symbol}`}
        >
          <PairIcons tokens={readyTokens} />
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
      <TableCell className="p-4 text-center align-middle">
        <ArrowRight className="mx-auto" size={18} aria-hidden="true" />
      </TableCell>
    </TableRow>
  );
}
export function MarketTable() {
  const {
    network,
    search,
    tag: category,
    page,
    updateFilters,
  } = useMarketFilters();
  const {
    markets,
    total,
    currentPage,
    marketCount,
    tokenCount,
    loading: listLoading,
    loadingLabel,
    error,
    empty,
  } = useMarketList({ network, tag: category, search, page });
  const failed = !!error;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = (currentPage - 1) * PAGE_SIZE;
  const loading = listLoading;
  const visibleMarkets = markets;
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
          <CardContent className="space-y-2 py-2">
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
              <Table className="table-fixed">
                {loading && (
                  <TableCaption className="sr-only" role="status">
                    {loadingLabel}
                  </TableCaption>
                )}
                <colgroup>
                  <col className="w-[90%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <TableHeader className="sr-only">
                  <TableRow>
                    <TableHead className="w-[90%] px-4 text-right first:text-left">
                      Market
                    </TableHead>
                    <TableHead className="w-[10%] px-4 text-center">
                      Open
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody aria-busy={loading}>
                  {loading
                    ? Array.from({ length: PAGE_SIZE }, (_, i) => (
                        <MarketRowSkeleton key={i} />
                      ))
                    : visibleMarkets.map((m) => (
                        <MarketRow key={`${m.network}/${m.key}`} config={m} />
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
                  {start + 1}–{Math.min(start + PAGE_SIZE, total)} of {total}{" "}
                  markets
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
