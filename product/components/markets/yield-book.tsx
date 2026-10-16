"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useId, useLayoutEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import {
  DURATIONS,
  MIN_TICK,
  MAX_TICK,
  YIELD_BOOK_LAYOUT,
  type Token,
  type Duration,
} from "@yld-cx/sdk";
import { marginalYieldPercent, explainError } from "@yld-cx/sdk/ethereum";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText } from "@/lib/market-values";
import type { useYieldBook, BookLevel } from "@/hooks/use-yield-book";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@yld-cx/ui/components/ui/select";

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
  const available = level.state?.availableSupply ?? 0n;
  const inUse = level.state?.activeWorking ?? 0n;
  const total = available + inUse;
  const utilization = total > 0n ? Number((inUse * 10000n) / total) / 100 : 0;
  return (
    <Button
      variant="ghost"
      className="relative isolate grid w-full grid-cols-[1.05fr_1.2fr_1fr_1fr] gap-2 overflow-hidden px-2 text-right text-xs hover:border-primary hover:bg-transparent aria-pressed:border-primary dark:hover:bg-transparent [&>span:first-child]:text-left"
      style={{ height: `${YIELD_BOOK_LAYOUT.rowHeightRem}rem` }}
      onClick={onSelect}
      aria-pressed={selected}
      data-tick-id={level.id.toString()}
      data-status={level.status}
      data-available={level.status === "exists" && available > 0n}
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
      {utilization > 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 -z-10 rounded-[inherit]"
          style={{
            width: `${utilization}%`,
            backgroundColor: `color-mix(in srgb, var(--${side}-surface) 10%, var(--card))`,
          }}
        />
      )}
    </Button>
  );
}

export function YieldBook({
  referencePrice,
  stepTicks,
  onBaseTickChange,
  display,
  duration,
  selected,
  onSelect,
  onDurationChange,
  book,
}: {
  referencePrice: string;
  stepTicks: number;
  onBaseTickChange: (baseTick: number) => void;
  display: readonly [Token, Token];
  duration: Duration;
  selected?: BookLevel;
  onSelect: (level: BookLevel) => void;
  onDurationChange: (duration: Duration) => void;
  book: ReturnType<typeof useYieldBook>;
}) {
  const { baseTick, discovery, levels, checked, failed } = book;
  const baseTickId = useId();
  const baseTickItems = [
    baseTick - stepTicks * 100,
    baseTick - stepTicks * 10,
    baseTick - stepTicks,
    baseTick,
    baseTick + stepTicks,
    baseTick + stepTicks * 10,
    baseTick + stepTicks * 100,
  ].map((tick) => ({
    value: String(tick),
    label: String(tick),
    disabled: tick < MIN_TICK || tick > MAX_TICK,
  }));
  const askScroll = useRef<HTMLDivElement>(null);
  const bidScroll = useRef<HTMLDivElement>(null);
  const firstLevelId = levels[0]?.id;
  const baseAddress = display[0].address;
  useLayoutEffect(() => {
    for (const [index, ref] of [askScroll, bidScroll].entries()) {
      const viewport = ref.current;
      if (!viewport) continue;
      const available = viewport.querySelectorAll<HTMLElement>(
        '[data-available="true"]',
      );
      const best = available.item(index === 0 ? available.length - 1 : 0);
      if (!best) {
        viewport.scrollTop = viewport.scrollHeight;
        continue;
      }
      const top =
        best.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      viewport.scrollTop =
        index === 0 ? top + best.offsetHeight - viewport.clientHeight : top;
    }
  }, [duration, baseAddress, firstLevelId]);
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
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="outline">Exact ticks</Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh discovery"
              title="Refresh discovery"
              disabled={discovery.isFetching}
              onClick={() => void discovery.refetch()}
            >
              <RefreshCw
                aria-hidden="true"
                className={
                  discovery.isFetching
                    ? "animate-spin motion-reduce:animate-none"
                    : undefined
                }
              />
            </Button>
          </div>
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
              ref={index === 0 ? askScroll : bidScroll}
              className="overflow-y-auto"
              style={{
                maxHeight: `${YIELD_BOOK_LAYOUT.visibleRows * YIELD_BOOK_LAYOUT.rowHeightRem}rem`,
              }}
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
              <div
                role="group"
                aria-label="Reference price and base tick"
                className="my-3 flex flex-wrap items-center justify-between gap-2 border-y border-dashed py-3 text-xs text-muted-foreground"
              >
                <p>
                  Reference price{" "}
                  <strong>
                    {referencePrice} {display[1].symbol}
                  </strong>
                </p>
                <div className="flex items-center gap-2">
                  <label htmlFor={baseTickId}>Base tick</label>
                  <Select
                    items={baseTickItems}
                    value={String(baseTick)}
                    onValueChange={(value) => {
                      const next = baseTickItems.find(
                        (item) => item.value === value && !item.disabled,
                      );
                      if (next) onBaseTickChange(Number(next.value));
                    }}
                  >
                    <SelectTrigger
                      id={baseTickId}
                      aria-label="Base tick"
                      size="sm"
                      className="text-xs"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {baseTickItems.map((item) => (
                        <SelectItem
                          key={item.value}
                          value={item.value}
                          disabled={item.disabled}
                        >
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        ))}
        {failed > 0 && (
          <Message error>
            Some reads failed. They are not zero liquidity.
          </Message>
        )}
        <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          {checked} ticks checked. Step: {stepTicks} ticks.
        </p>
      </CardContent>
    </Card>
  );
}
