"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DURATIONS, type Market, type Token, type Duration } from "@yld-cx/sdk";
import {
  getNetwork,
  marginalYieldPercent,
  explainError,
} from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText } from "@/lib/market-values";
import { useYieldBook, type BookTick } from "@/hooks/use-yield-book";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Input } from "@yld-cx/ui/components/ui/input";
import { Message } from "@/components/forms/financial-fields";
function BookRow({
  tick,
  asset,
  onSelect,
  selected,
  display,
  side,
}: {
  tick: BookTick;
  asset: Token;
  onSelect: () => void;
  selected: boolean;
  display: readonly [Token, Token];
  side: "ask" | "bid";
}) {
  const estimatedYield = marginalYieldPercent(tick.state);
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      className="grid h-auto min-h-10 w-full grid-cols-[1.05fr_1.2fr_1fr_1fr] gap-2 px-2 text-right text-xs [&>span:first-child]:text-left"
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className={side === "ask" ? "text-ask" : "text-bid"}>
        {priceText(tickPrice(tick, display))}
      </span>
      <span>
        {amountText(tick.state.availableSupply, asset.decimals)}{" "}
        <small>{asset.symbol}</small>
      </span>
      <span>{amountText(tick.state.activeWorking, asset.decimals)}</span>
      <span className={side === "ask" ? "text-ask" : "text-bid"}>
        {estimatedYield !== undefined ? `${estimatedYield}%` : "—"}
      </span>
    </Button>
  );
}
import { Field, FieldLabel } from "@yld-cx/ui/components/ui/field";
export function YieldBook({
  market,
  display,
  duration,
  selected,
  onSelect,
  onDurationChange,
  book,
}: {
  market: Market;
  display: readonly [Token, Token];
  duration: Duration;
  selected?: BookTick;
  onSelect: (tick: BookTick) => void;
  onDurationChange: (duration: Duration) => void;
  book: ReturnType<typeof useYieldBook>;
}) {
  const { discovery, live, ticks, checked, missing, failed, radius } = book;
  const [directId, setDirectId] = useState("");
  const network = getNetwork(market.network).slug;
  const reference =
    selected ??
    ticks.find(
      (t) =>
        t.state.durationDays === BigInt(duration) &&
        t.state.availableSupply > 0n,
    );
  const direct = useQuery({
    queryKey: ["tick", network, "exact", directId],
    enabled: /^[1-9]\d{0,77}$/.test(directId),
    queryFn: async () => {
      const id = BigInt(directId);
      if (id >= 1n << 256n) throw new Error("Tick ID outside uint256");
      const state = await getSdk(network).getTick(id);
      const addresses = [state.asset.toLowerCase(), state.quote.toLowerCase()]
        .sort()
        .join(":");
      if (addresses !== market.key)
        throw new Error("This Tick belongs to another market");
      return { id, state };
    },
  });
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
        {discovery.isFetching && !discovery.data && (
          <Message>Checking supported price levels…</Message>
        )}
        {discovery.isError && (
          <Message error>{explainError(discovery.error)}</Message>
        )}
        {live.isError && (
          <Message error>
            Known Tick refresh failed. Displayed balances may be stale.{" "}
            {explainError(live.error)}
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
            {ticks
              .filter(
                (t) =>
                  t.state.asset.toLowerCase() === asset.address.toLowerCase() &&
                  t.state.durationDays === BigInt(duration),
              )
              .sort((a, b) => {
                const comparison =
                  a.state.priceX128 < b.state.priceX128
                    ? -1
                    : a.state.priceX128 > b.state.priceX128
                      ? 1
                      : 0;
                return index === 0 ? -comparison : comparison;
              })
              .map((t) => (
                <BookRow
                  key={t.id.toString()}
                  tick={t}
                  asset={asset}
                  display={display}
                  side={index === 0 ? "ask" : "bid"}
                  selected={selected?.id === t.id}
                  onSelect={() => onSelect(t)}
                />
              ))}
            {!discovery.isFetching &&
              !ticks.some(
                (t) =>
                  t.state.asset.toLowerCase() === asset.address.toLowerCase() &&
                  t.state.durationDays === BigInt(duration),
              ) && (
                <p className="p-4 text-sm text-muted-foreground">
                  {failed > 0 || discovery.isError || live.isError
                    ? "Read failed"
                    : `No ${index === 0 ? "Ask" : "Bid"} liquidity yet`}
                </p>
              )}
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
        <details className="my-3 space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
          <summary>More price levels</summary>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {checked} identities checked · {missing} do not exist · {failed}{" "}
            failed. Radius ±{radius} grid steps.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={discovery.isFetchingNextPage || !discovery.hasNextPage}
              onClick={() => void discovery.fetchNextPage()}
            >
              Load more price levels
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={discovery.isFetching}
              onClick={() => void discovery.refetch()}
            >
              Retry discovery
            </Button>
          </div>
          <Field className="my-4">
            <FieldLabel htmlFor="exact-tick">Open an exact Tick ID</FieldLabel>
            <Input
              id="exact-tick"
              aria-label="Exact Tick ID"
              value={directId}
              onChange={(e) => setDirectId(e.target.value.trim())}
              placeholder="uint256 Tick ID"
              inputMode="numeric"
            />
          </Field>
          {direct.isFetching && directId && (
            <Message>Reading exact Tick…</Message>
          )}
          {direct.isError && (
            <Message error>{explainError(direct.error)}</Message>
          )}
          {direct.data && (
            <Button variant="outline" onClick={() => onSelect(direct.data)}>
              Select exact Tick · {direct.data.state.durationDays.toString()}D
            </Button>
          )}
        </details>
        <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          Available is executable liquidity. In Use excludes liquidity already
          moved to Resolving. A concrete transaction preview is authoritative.
        </p>
      </CardContent>
    </Card>
  );
}
