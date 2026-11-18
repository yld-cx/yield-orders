"use client";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@yld-cx/ui/components/ui/tabs";
import {
  ArrowDown,
  ArrowUp,
  ListSortAscending,
  ListSortDescending,
  RefreshCw,
} from "lucide-react";
import type { Token } from "@yld-cx/sdk";
import { tickYieldText } from "@/lib/yield";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText } from "@/lib/market-values";
import type { BookSide, Selection } from "@/lib/market-selection";
import type { useYieldBook, BookLevel } from "@/hooks/use-yield-book";

const rowClass =
  "relative isolate grid w-full grid-cols-[1.3fr_1fr_0.8fr_0.8fr] gap-2 overflow-hidden px-2 text-right text-xs h-10 aria-pressed:border-primary aria-pressed:bg-secondary";
function Radio({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-3 shrink-0 rounded-full border ${selected ? "border-primary bg-primary" : "border-muted-foreground"}`}
    />
  );
}
export function YieldBook({
  display,
  side,
  onSideChange,
  selection,
  onSelect,
  onMarket,
  marketAvailable,
  referencePrice,
  book,
  onNavigate,
  canHigher,
  canLower,
}: {
  display: readonly [Token, Token];
  side: BookSide;
  onSideChange: (side: BookSide) => void;
  selection: Selection;
  onSelect: (level: BookLevel) => void;
  onMarket: () => void;
  marketAvailable: boolean;
  referencePrice?: string;
  book: ReturnType<typeof useYieldBook>;
  onNavigate: (direction: "higher" | "lower") => void;
  canHigher: boolean;
  canLower: boolean;
}) {
  const asset = side === "bid" ? display[1] : display[0];
  const previousDirection = side === "bid" ? "higher" : "lower";
  const nextDirection = side === "bid" ? "lower" : "higher";
  const levels = [...book.levels].sort((a, b) => {
    const canonicalA = a.direction === 0 ? a.priceTick : -a.priceTick;
    const canonicalB = b.direction === 0 ? b.priceTick : -b.priceTick;
    const inverse =
      display[0].address.toLowerCase() > display[1].address.toLowerCase();
    return (
      (canonicalA - canonicalB) * (inverse ? -1 : 1) * (side === "bid" ? -1 : 1)
    );
  });
  return (
    <Card className="min-w-0" aria-label="Yield Book">
      <CardContent className="space-y-4">
        <div className="flex h-8 items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Yield Book</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant="outline"
              className="otc-badge cursor-pointer"
              title="Onchain ticks"
            >
              OTC
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh discovery"
              title="Refresh discovery"
              onClick={() => void book.discovery.refetch()}
              disabled={book.discovery.isFetching}
            >
              <RefreshCw
                aria-hidden="true"
                className={
                  book.discovery.isFetching
                    ? "animate-spin motion-reduce:animate-none"
                    : undefined
                }
              />
            </Button>
          </div>
        </div>
        <Tabs
          value={side}
          onValueChange={(value) => onSideChange(value as BookSide)}
        >
          <TabsList className="grid w-full grid-cols-2" aria-label="Book side">
            <TabsTrigger value="bid" data-intent="bid">
              BID
            </TabsTrigger>
            <TabsTrigger value="ask" data-intent="ask">
              ASK
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div>
          <Button
            variant="ghost"
            className={rowClass}
            onClick={onMarket}
            disabled={!marketAvailable}
            aria-pressed={selection.kind === "market"}
          >
            <span className="flex items-center gap-2 text-left">
              <Radio selected={selection.kind === "market"} />
              <span>Market · AMM</span>
            </span>
            <span className="col-span-3 text-muted-foreground">
              {marketAvailable && referencePrice
                ? `~ ${referencePrice} ${display[1].symbol}`
                : "Unavailable"}
            </span>
          </Button>
          <div className="grid grid-cols-[1.3fr_1fr_0.8fr_0.8fr] items-center gap-2 border-y px-2 py-3 my-2 text-right text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-left">
              <span
                className="relative whitespace-nowrap pl-5 text-left"
                title={
                  side === "bid" ? "Highest to lowest" : "Lowest to highest"
                }
              >
                {side === "bid" ? (
                  <ListSortDescending
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 size-3 -translate-y-1/2"
                  />
                ) : (
                  <ListSortAscending
                    aria-hidden="true"
                    className="absolute left-0 top-1/2 size-3 -translate-y-1/2"
                  />
                )}
                Price · {display[1].symbol}
              </span>
              <div
                className="flex gap-1"
                role="group"
                aria-label="Price level navigation"
              >
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Previous price levels"
                  title="Previous price levels"
                  disabled={side === "bid" ? !canHigher : !canLower}
                  onClick={() => onNavigate(previousDirection)}
                >
                  <ArrowUp aria-hidden="true" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Next price levels"
                  title="Next price levels"
                  disabled={side === "bid" ? !canLower : !canHigher}
                  onClick={() => onNavigate(nextDirection)}
                >
                  <ArrowDown aria-hidden="true" />
                </Button>
              </div>
            </div>
            <span>Available</span>
            <span>In use</span>
            <span>Yield</span>
          </div>
          <div aria-busy={book.discovery.isPending}>
            {levels.map((level) => {
              const canonicalTick =
                level.direction === 0 ? level.priceTick : -level.priceTick;
              const selected =
                selection.kind === "tick" &&
                selection.canonicalTick === canonicalTick;
              const available = level.state?.availableSupply ?? 0n,
                inUse = level.state?.activeWorking ?? 0n;
              const utilization =
                available + inUse > 0n
                  ? Number((inUse * 10000n) / (available + inUse)) / 100
                  : 0;
              return (
                <Button
                  key={level.id.toString()}
                  variant="ghost"
                  className={rowClass}
                  onClick={() => onSelect(level)}
                  aria-pressed={selected}
                  disabled={level.status === "failed"}
                  data-status={level.status}
                  data-tick-id={level.id.toString()}
                >
                  <span
                    className={`flex items-center gap-2 text-left ${side === "bid" ? "text-bid" : "text-ask"}`}
                  >
                    <Radio selected={selected} />
                    {priceText(tickPrice(level, display))}
                  </span>
                  <span>
                    {level.status === "failed" ? (
                      book.discovery.isPending ? (
                        "…"
                      ) : (
                        "Read failed"
                      )
                    ) : (
                      <>
                        {amountText(available, asset.decimals)}{" "}
                        <small>{asset.symbol}</small>
                      </>
                    )}
                  </span>
                  <span>
                    {level.status === "failed"
                      ? "—"
                      : amountText(inUse, asset.decimals)}
                  </span>
                  <span className={side === "bid" ? "text-bid" : "text-ask"}>
                    {level.status === "exists"
                      ? tickYieldText(level.state, "term")
                      : "—"}
                  </span>
                  {utilization > 0 && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 right-0 -z-10 bg-secondary/50"
                      style={{ width: `${utilization}%` }}
                    />
                  )}
                </Button>
              );
            })}
          </div>
        </div>
        {book.failed > 0 && !book.discovery.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            Some prices could not be read. Refresh to retry.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
