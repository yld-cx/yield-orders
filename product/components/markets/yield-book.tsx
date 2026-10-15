"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { DURATIONS, type Token, type Duration } from "@yld-cx/sdk";
import { marginalYieldPercent, explainError } from "@yld-cx/sdk/ethereum";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText } from "@/lib/market-values";
import type { useYieldBook, BookLevel } from "@/hooks/use-yield-book";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";

function BookRow({
  level,
  asset,
  onSelect,
  selected,
  display,
  side,
}: {
  level: BookLevel;
  asset: Token;
  onSelect: () => void;
  selected: boolean;
  display: readonly [Token, Token];
  side: "ask" | "bid";
}) {
  const estimatedYield =
    level.status === "exists" ? marginalYieldPercent(level.state) : undefined;
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      className="grid h-auto min-h-10 w-full grid-cols-[1.05fr_1.2fr_1fr_1fr] gap-2 px-2 text-right text-xs [&>span:first-child]:text-left"
      onClick={onSelect}
      aria-pressed={selected}
      data-tick-id={level.id.toString()}
      data-status={level.status}
    >
      <span className={side === "ask" ? "text-ask" : "text-bid"}>
        {priceText(tickPrice(level, display))}
      </span>
      <span>
        {level.status === "failed" ? (
          "Read failed"
        ) : (
          <>
            {amountText(level.state?.availableSupply ?? 0n, asset.decimals)}{" "}
            <small>{asset.symbol}</small>
          </>
        )}
      </span>
      <span>
        {level.status === "failed"
          ? "—"
          : amountText(level.state?.activeWorking ?? 0n, asset.decimals)}
      </span>
      <span className={side === "ask" ? "text-ask" : "text-bid"}>
        {estimatedYield !== undefined ? `${estimatedYield}%` : "—"}
      </span>
    </Button>
  );
}

export function YieldBook({
  display,
  duration,
  selected,
  onSelect,
  onDurationChange,
  book,
}: {
  display: readonly [Token, Token];
  duration: Duration;
  selected?: BookLevel;
  onSelect: (level: BookLevel) => void;
  onDurationChange: (duration: Duration) => void;
  book: ReturnType<typeof useYieldBook>;
}) {
  const { discovery, levels, ticks, checked, missing, failed, radius } = book;
  const reference =
    selected ??
    ticks.find(
      (t) => t.durationDays === duration && t.state.availableSupply > 0n,
    );
  return (
    <Card className="min-w-0 yield-book">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold">
          <div>
            <h2>Yield Book</h2>
            <p className="text-xs text-muted-foreground">
              Choose a price level · current market depth
            </p>
          </div>
          <Badge variant="outline">Exact ticks</Badge>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Prices in {display[1].symbol} per {display[0].symbol}
          </span>
          <div className="flex gap-2" role="group" aria-label="Book term">
            {DURATIONS.map((d) => (
              <Button
                key={d}
                variant={duration === d ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={duration === d}
                data-intent={duration === d ? "term" : undefined}
                onClick={() => onDurationChange(d)}
              >
                {d}D
              </Button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[1.05fr_1.2fr_1fr_1fr] gap-2 px-2 text-right text-xs text-muted-foreground [&>span:first-child]:text-left">
          <span>Price</span>
          <span>Available</span>
          <span>In use</span>
          <span>Yield</span>
        </div>
        {discovery.isError && (
          <Message error>
            Discovery refresh failed. Displayed balances may be stale.{" "}
            {explainError(discovery.error)}
          </Message>
        )}
        {[display, [display[1], display[0]] as const].map(([asset], index) => (
          <div key={asset.address} className="min-w-0 space-y-2">
            <div
              className={`mt-4 flex items-center gap-2 text-xs font-medium uppercase tracking-wide ${index === 0 ? "text-ask" : "text-bid"}`}
            >
              <span
                className={`inline-block size-2 rounded-full bg-current ${index === 1 ? "bid" : ""}`}
              />
              {index === 0 ? "Ask" : "Bid"} · {asset.symbol} liquidity
            </div>
            <div
              className="max-h-80 overflow-y-auto"
              role="group"
              aria-label={`${index === 0 ? "Ask" : "Bid"} price levels`}
            >
              {levels
                .filter(
                  (level) =>
                    level.asset.toLowerCase() === asset.address.toLowerCase() &&
                    level.durationDays === duration,
                )
                .sort((a, b) => {
                  const comparison =
                    a.priceX128 < b.priceX128
                      ? -1
                      : a.priceX128 > b.priceX128
                        ? 1
                        : 0;
                  return index === 0 ? -comparison : comparison;
                })
                .map((level) => (
                  <BookRow
                    key={level.id.toString()}
                    level={level}
                    asset={asset}
                    display={display}
                    side={index === 0 ? "ask" : "bid"}
                    selected={selected?.id === level.id}
                    onSelect={() => onSelect(level)}
                  />
                ))}
            </div>
            {index === 0 && (
              <div className="my-3 flex flex-wrap justify-center gap-2 border-y border-dashed py-3 text-xs text-muted-foreground">
                Reference price{" "}
                <strong>
                  {reference
                    ? `${priceText(tickPrice(reference, display))} ${display[1].symbol}`
                    : "Not set"}
                </strong>
              </div>
            )}
          </div>
        ))}
        {failed > 0 && (
          <Message error>
            Some reads failed. They are not zero liquidity.
          </Message>
        )}
        <p className="text-xs text-muted-foreground">
          {checked} identities checked · {missing} do not exist · {failed}{" "}
          failed. Radius ±{radius} grid steps.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={discovery.isFetching}
          onClick={() => void discovery.refetch()}
        >
          Retry discovery
        </Button>
        <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          Available is executable liquidity. In Use excludes liquidity already
          moved to Resolving. A concrete transaction preview is authoritative.
        </p>
      </CardContent>
    </Card>
  );
}
