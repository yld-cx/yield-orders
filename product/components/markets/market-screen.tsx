"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import { displayTokens } from "@yld-cx/sdk/registry";
import {
  getNetwork,
  candidateLevels,
  explainError,
  marginalYieldPercent,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import type { Duration, Market, TickIdentity } from "@yld-cx/sdk";
import { useMarket } from "@/hooks/use-market";
import { useYieldBook, type BookTick } from "@/hooks/use-yield-book";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText, discoveryBaseTick } from "@/lib/market-values";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import LoadingScreen from "@/components/layout/loading-screen";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { YieldBook } from "./yield-book";
import { SupplyForm } from "./supply-form";
import { UseForm } from "./use-form";
import { TokenIcon } from "./token-icon";
import { MarketPositions } from "./market-positions";

export function MarketScreen({
  network,
  pair,
}: {
  network: NetworkSlug;
  pair: string;
}) {
  const result = useMarket(network, pair);
  if (result.isPending) return <LoadingScreen label="Loading market…" />;
  if (result.error || !result.market)
    return (
      <Message error>
        {explainError(result.error ?? new Error("Market unavailable"))}
      </Message>
    );
  return (
    <MarketContent
      key={`${network}/${pair}`}
      market={result.market}
      pairId={result.pairId}
      exists={!!result.pair.data?.[3]}
    />
  );
}

function MarketContent({
  market,
  pairId,
  exists,
}: {
  market: Market;
  pairId: bigint;
  exists: boolean;
}) {
  const [inverted, setInverted] = useState(false);
  const [duration, setDuration] = useState<Duration>(market.defaultDuration);
  const [selectedIdentity, setSelectedIdentity] = useState<TickIdentity>();
  const params = useSearchParams();
  const baseTick = discoveryBaseTick(params.get("baseTick"), market);
  const book = useYieldBook(market, pairId, baseTick);
  const network = getNetwork(market.network).slug;
  const [supplyAsset, setSupplyAsset] = useState(
    () => displayTokens(market)[0].address,
  );
  const selectionInRange =
    !selectedIdentity ||
    candidateLevels(baseTick, market.stepTicks).includes(
      selectedIdentity.direction === 0
        ? selectedIdentity.priceTick
        : -selectedIdentity.priceTick,
    );
  if (selectedIdentity && !selectionInRange) setSelectedIdentity(undefined);
  const selected = selectionInRange
    ? book.levels.find(
        (level) =>
          level.id === selectedIdentity?.id && level.durationDays === duration,
      )
    : undefined;
  const changeBaseTick = (next: number) => {
    const query = new URLSearchParams(window.location.search);
    if (next === market.baseTick) query.delete("baseTick");
    else query.set("baseTick", String(next));
    const search = query.toString();
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
    );
  };
  const natural = displayTokens(market);
  const display = inverted ? ([natural[1], natural[0]] as const) : natural;
  const ticks = book.ticks.filter(
    (t) => t.state.durationDays === BigInt(duration),
  );
  const ask = ticks.filter(
    (t) => t.state.asset.toLowerCase() === display[0].address.toLowerCase(),
  );
  const bid = ticks.filter(
    (t) => t.state.asset.toLowerCase() === display[1].address.toLowerCase(),
  );
  const reference =
    selected ??
    ask.find((t) => t.state.availableSupply > 0n) ??
    bid.find((t) => t.state.availableSupply > 0n);
  const yieldTick = ask.find((t) => t.state.availableSupply > 0n);
  const estimatedYield = yieldTick
    ? marginalYieldPercent(yieldTick.state)
    : undefined;
  const incomplete = book.failed > 0 || book.discovery.isError;
  const available = (side: BookTick[], index: 0 | 1) =>
    incomplete
      ? "Incomplete"
      : book.discovery.isPending
        ? "…"
        : `${amountText(
            side.reduce((sum, t) => sum + t.state.availableSupply, 0n),
            display[index].decimals,
          )} ${display[index].symbol}`;
  const changeDuration = (next: Duration) => {
    setDuration(next);
    setSelectedIdentity(undefined);
  };
  // Reveal the market once its initial book is ready; refetches keep it visible.
  if (book.discovery.isPending)
    return <LoadingScreen label="Loading market…" />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 py-6 text-xs text-muted-foreground">
        <Link href="/">Yield</Link>
        <span>/</span>
        <span>
          {display[0].symbol} / {display[1].symbol}
        </span>
      </div>
      <section className="market-banner" aria-label="Market overview">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Yield market · {getNetwork(network).name}
          </p>
          <div className="flex flex-wrap items-center gap-3 [&>h1]:text-3xl [&>h1]:font-semibold [&>h1]:tracking-tight">
            <h1>
              {display[0].symbol} / {display[1].symbol}
            </h1>
            <Button
              size="sm"
              variant="outline"
              title="Invert displayed pair and price denomination; onchain market stays the same"
              onClick={() => setInverted((v) => !v)}
            >
              <ArrowLeftRight size={15} />
              Invert
            </Button>
          </div>
          <p className="text-muted-foreground my-3 text-sm">
            {exists
              ? `Provide or rent ${display[0].symbol} or ${display[1].symbol} at your price.`
              : "An open market, ready for its first provider."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" data-intent="bid">
              Open market
            </Badge>
            <Badge variant="secondary" data-intent="term">
              {duration}D
            </Badge>
            {!book.discovery.isPending &&
              !incomplete &&
              !ticks.some((t) => t.state.availableSupply > 0n) && (
                <Badge variant="outline">New · No liquidity</Badge>
              )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Same onchain pair in either orientation
          </p>
        </div>
        <div
          className="crowned-token relative flex h-32 items-center justify-center"
          aria-label={`${display[0].symbol} crowned token`}
        >
          <span
            className="absolute -top-1 left-1/2 z-10 -translate-x-1/2 -rotate-6 text-4xl"
            aria-hidden="true"
          >
            👑
          </span>
          <div className={`token-orb ${display[0].symbol.toLowerCase()}`}>
            {display[0].symbol === "WETH" ? (
              <svg viewBox="0 0 60 90" aria-label="Ethereum" role="img">
                <path fill="#d4ddf2" d="M30 0 2 44l28 15 28-15L30 0Z" />
                <path fill="#93a7c8" d="M30 0v59l28-15L30 0Z" />
                <path fill="#b8c9e4" d="m2 50 28 40V65L2 50Z" />
                <path fill="#7f95ba" d="m58 50-28 40V65l28-15Z" />
              </svg>
            ) : (
              <TokenIcon token={display[0]} size={72} />
            )}
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-4 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:break-words [&_dd]:font-semibold [&_dd]:tabular-nums">
          <div>
            <dt>
              Reference price · {display[1].symbol} / {display[0].symbol}
            </dt>
            <dd>
              {reference
                ? `${priceText(tickPrice(reference, display))} ${display[1].symbol}`
                : book.discovery.isPending
                  ? "…"
                  : incomplete
                    ? "Incomplete"
                    : "Not set"}
            </dd>
          </div>
          <div>
            <dt>Available · Ask</dt>
            <dd>{available(ask, 0)}</dd>
          </div>
          <div>
            <dt>Ask Yield · {duration}D</dt>
            <dd className="text-ask">
              {incomplete
                ? "Incomplete"
                : estimatedYield !== undefined
                  ? `${estimatedYield}%`
                  : "—"}
            </dd>
          </div>
          <div>
            <dt>Available · Bid</dt>
            <dd>{available(bid, 1)}</dd>
          </div>
        </dl>
      </section>
      {display.some((t) => !t.listed) && (
        <Message>
          ⚠️ Unlisted token · Review token compatibility before interacting
        </Message>
      )}
      <div className="my-4 grid items-start gap-4 lg:grid-cols-[1fr_1.4fr_1fr]">
        <SupplyForm
          key={`supply/${supplyAsset}/${duration}/${selected?.id ?? "draft"}`}
          market={market}
          display={display}
          duration={duration}
          onDurationChange={changeDuration}
          selectedTick={selected}
          assetAddress={supplyAsset}
          onAssetChange={(address) => {
            if (address !== supplyAsset) {
              setSupplyAsset(address);
              setSelectedIdentity(undefined);
            }
          }}
          pairExists={exists}
        />
        <YieldBook
          stepTicks={market.stepTicks}
          onBaseTickChange={changeBaseTick}
          display={display}
          duration={duration}
          onDurationChange={changeDuration}
          selected={selected}
          onSelect={(level) => {
            setSelectedIdentity(level);
            setSupplyAsset(level.asset.toLowerCase());
          }}
          book={book}
        />
        <UseForm
          key={`use/${selected?.id ?? "empty"}`}
          market={market}
          display={display}
          tick={selected?.status === "exists" ? selected : undefined}
          hasLiquidity={ticks.some((t) => t.state.availableSupply > 0n)}
          isPending={book.discovery.isPending}
          isIncomplete={incomplete}
        />
      </div>
      <MarketPositions market={market} />
      {!exists && (
        <Card className="items-center text-center [&_h2]:text-xl [&_h3]:text-lg [&_p]:max-w-xl [&_p]:text-muted-foreground">
          <CardContent className="space-y-4">
            <h2>Create Market</h2>
            <p>
              Creating a pair does not supply liquidity or create a price Tick.
              The first provider chooses a side, price, amount and term on the
              market page.
            </p>
            <TransactionFlow
              network={network}
              label="Create Market"
              prepare={async () => ({
                kind: "createPair",
                tokenA: market.token0.address as `0x${string}`,
                tokenB: market.token1.address as `0x${string}`,
              })}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
