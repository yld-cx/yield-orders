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
  priceAtTick,
  humanPrice,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import type { Duration, Market, TickIdentity } from "@yld-cx/sdk";
import { useMarket } from "@/hooks/use-market";
import { useYieldBook, type BookTick } from "@/hooks/use-yield-book";
import { amountText } from "@/lib/utils";
import { compactPriceText, discoveryBaseTick } from "@/lib/market-values";
import { DEFAULT_YIELD_MODE, tickYieldText } from "@/lib/yield";
import { ApyLabel } from "@/components/forms/yield-display";
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
  // Capture the initial reference. Background metadata refreshes must not move
  // a user's discovery center or clear their selected price level.
  const [initialBaseTick] = useState(market.baseTick);
  const baseTick = discoveryBaseTick(params.get("baseTick"), {
    ...market,
    baseTick: initialBaseTick,
  });
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
    if (next === initialBaseTick) query.delete("baseTick");
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
  const referencePrice = compactPriceText(
    humanPrice(
      priceAtTick(baseTick),
      market.token0.decimals,
      market.token1.decimals,
      display[0].address.toLowerCase() !== market.token0.address.toLowerCase(),
    ),
  );
  const bidSelected =
    supplyAsset.toLowerCase() === display[1].address.toLowerCase();
  const yieldTick =
    selected ??
    (bidSelected ? bid : ask).find((t) => t.state.availableSupply > 0n);
  const estimatedYield =
    yieldTick?.status === "exists"
      ? tickYieldText(yieldTick.state, DEFAULT_YIELD_MODE.markets)
      : "—";
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
  if (book.discovery.isPending)
    return <LoadingScreen label="Loading market…" />;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 py-6 text-xs text-muted-foreground">
        <Link href="/">Yield</Link>
        <span>|</span>
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
            </Button>
          </div>
          <p className="text-muted-foreground my-3 text-sm">
            {exists
              ? `Provide or rent ${display[0].symbol} or ${display[1].symbol} at your price.`
              : "An open market, ready for its first provider."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" data-intent="bid">
              {exists ? "Open market" : "Preview market"}
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
            <TokenIcon token={display[0]} size={50} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-4 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:break-words [&_dd]:font-semibold [&_dd]:tabular-nums">
          <div>
            <dt>
              Reference price · {display[1].symbol} / {display[0].symbol}
            </dt>
            <dd>
              {referencePrice} {display[1].symbol}
            </dd>
          </div>
          <div>
            <dt>Available · Ask</dt>
            <dd>{available(ask, 0)}</dd>
          </div>
          <div>
            <dt>
              <ApyLabel>{`${bidSelected ? "Bid" : "Ask"} APY · ${duration}D reference`}</ApyLabel>
            </dt>
            <dd className={bidSelected ? "text-bid" : "text-ask"}>
              {incomplete ? "Incomplete" : estimatedYield}
            </dd>
            <small className="text-xs text-muted-foreground">Annualized</small>
          </div>
          <div>
            <dt>Available · Bid</dt>
            <dd>{available(bid, 1)}</dd>
          </div>
        </dl>
      </section>
      {baseTick === 0 && (
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
        />
        <YieldBook
          referencePrice={referencePrice}
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
          tick={selected}
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
              Creating a market unlocks liquidity for everyone to provide and
              use.
            </p>
            <TransactionFlow
              network={network}
              label="Preview Create Market"
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
