"use client";
import { useReducer, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@yld-cx/ui/components/ui/tabs";
import { displayTokens } from "@yld-cx/sdk/registry";
import {
  getNetwork,
  explainError,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { PRODUCT_MARKET, type Market } from "@yld-cx/sdk";
import { useMarket } from "@/hooks/use-market";
import { useYieldBook } from "@/hooks/use-yield-book";
import { compactPriceText, discoveryBaseTick } from "@/lib/market-values";
import { displayReference, type MarketReference } from "@/lib/market-reference";
import {
  bookDirection,
  bookWindow,
  initialBookWindow,
  moveBookWindow,
  nearestProductTick,
  orderSelection,
  type BookSide,
  type OrderAction,
} from "@/lib/market-selection";
import { queryKeys } from "@/lib/query-keys";
import { ApyLabel } from "@/components/forms/yield-display";
import { tickYieldText } from "@/lib/yield";
import { Message } from "@/components/forms/financial-fields";
import LoadingScreen from "@/components/layout/loading-screen";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { YieldBook } from "./yield-book";
import { SupplyForm } from "./supply-form";
import { UseForm } from "./use-form";
import { TokenIcon } from "./token-icon";
import { MarketPositions } from "./market-positions";
import { SwapForm } from "./swap-form";

export function MarketScreen({
  network,
  pair,
}: {
  network: NetworkSlug;
  pair: string;
}) {
  const result = useMarket(network, pair);
  const reference = useQuery({
    queryKey: queryKeys.reference(network, pair),
    queryFn: async (): Promise<MarketReference> => {
      const [a, b] = pair.split(":");
      const params = new URLSearchParams({
        chainId: String(getNetwork(network).chain.id),
        tokenA: a,
        tokenB: b,
      });
      const response = await fetch(`/api/market-price?${params}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error("Reference unavailable");
      return response.json();
    },
    staleTime: PRODUCT_MARKET.referenceCacheSeconds * 1000,
  });
  if (result.isPending || reference.isPending)
    return <LoadingScreen label="Loading market…" />;
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
      reference={reference.data}
    />
  );
}

function MarketContent({
  market,
  pairId,
  exists,
  reference,
}: {
  market: Market;
  pairId: bigint;
  exists: boolean;
  reference?: MarketReference;
}) {
  const params = useSearchParams();
  const [initialTick] = useState(() =>
    nearestProductTick(
      discoveryBaseTick(params.get("baseTick"), {
        baseTick: reference?.baseTick ?? market.baseTick,
        stepTicks: PRODUCT_MARKET.stepTicks,
      }),
    ),
  );
  const [state, dispatch] = useReducer(orderSelection, {
    action: "limit",
    side: "bid",
    inverted: false,
    selection: { kind: "none" },
  });
  const [windowStart, setWindowStart] = useState(() =>
    initialBookWindow(initialTick),
  );
  const natural = displayTokens(market);
  const display = state.inverted
    ? ([natural[1], natural[0]] as const)
    : natural;
  const displayInverse =
    display[0].address.toLowerCase() !== market.token0.address.toLowerCase();
  const direction = bookDirection(state.side, displayInverse);
  const window = bookWindow(windowStart);
  const book = useYieldBook(market, pairId, window, direction);
  const selectedTick =
    state.selection.kind === "tick" ? state.selection.canonicalTick : undefined;
  const selectedInWindow =
    selectedTick !== undefined && window.includes(selectedTick);
  // Keep the selected off-page tick live without scanning intervening levels.
  const outside = useYieldBook(
    market,
    pairId,
    selectedTick === undefined ? [] : [selectedTick],
    direction,
    state.selection.kind === "tick" && !selectedInWindow,
  );
  const selected = (selectedInWindow ? book : outside).levels.find(
    (level) =>
      (level.direction === 0 ? level.priceTick : -level.priceTick) ===
      selectedTick,
  );
  const asset = direction === 0 ? market.token0 : market.token1;
  const network = getNetwork(market.network).slug;
  const indicative = reference
    ? displayReference(reference, displayInverse)
    : undefined;
  const referencePrice = indicative ? compactPriceText(indicative) : undefined;
  const selectedApy =
    state.selection.kind !== "tick"
      ? "—"
      : selected?.status === "exists"
        ? tickYieldText(selected.state, "apy")
        : selected?.status === "failed" &&
            !(selectedInWindow ? book : outside).discovery.isPending
          ? "Read failed"
          : "—";
  const formKey = `${market.network}/${market.key}/${direction}/${selected?.id}/${state.action}/${state.selection.kind}/${state.inverted}`;
  function navigate(target: "higher" | "lower") {
    setWindowStart(moveBookWindow(windowStart, target, displayInverse));
  }
  function selectMarket() {
    setWindowStart(initialBookWindow(reference?.baseTick ?? initialTick));
    dispatch({ type: "market" });
  }
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
              onClick={() => dispatch({ type: "invert" })}
            >
              <ArrowLeftRight size={15} />
            </Button>
          </div>
          <p className="my-3 text-sm text-muted-foreground">
            Trade and use {display[0].symbol} or {display[1].symbol} at your
            price.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" data-intent="bid">
              {exists ? "Open market" : "Preview market"}
            </Badge>
            <Badge variant="secondary" data-intent="term">
              {PRODUCT_MARKET.duration}D
            </Badge>
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
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">
              <ApyLabel>{`${state.side.toUpperCase()} APY`}</ApyLabel>
            </dt>
            <dd className="mt-1 font-semibold text-primary">{selectedApy}</dd>
          </div>
        </dl>
      </section>
      <div className="my-4 grid items-start gap-4 lg:grid-cols-2">
        <YieldBook
          display={display}
          side={state.side}
          onSideChange={(side: BookSide) => dispatch({ type: "side", side })}
          selection={state.selection}
          onSelect={(level) =>
            dispatch({
              type: "tick",
              canonicalTick:
                level.direction === 0 ? level.priceTick : -level.priceTick,
            })
          }
          onMarket={selectMarket}
          marketAvailable={!!reference?.ammAvailable}
          referencePrice={referencePrice}
          book={book}
          onNavigate={navigate}
          canHigher={
            moveBookWindow(windowStart, "higher", displayInverse) !==
            windowStart
          }
          canLower={
            moveBookWindow(windowStart, "lower", displayInverse) !== windowStart
          }
        />
        <Card className="min-w-0" aria-label="Yield Order">
          <CardContent className="space-y-4">
            <div className="flex h-8 items-center justify-between">
              <h2 className="font-semibold">Yield Order</h2>
              <Badge
                variant="outline"
                data-intent={
                  state.action === "limit"
                    ? "term"
                    : state.action === "rent"
                      ? "rent"
                      : "swap"
                }
              >
                {state.action === "limit" ? "Provide" : "Use"}
              </Badge>
            </div>
            <Tabs
              value={state.action}
              onValueChange={(action) =>
                dispatch({ type: "action", action: action as OrderAction })
              }
            >
              <TabsList
                className="grid w-full grid-cols-3"
                aria-label="Order action"
              >
                <TabsTrigger
                  className="text-foreground dark:text-foreground"
                  value="limit"
                  data-intent="term"
                >
                  Limit
                </TabsTrigger>
                <TabsTrigger
                  className="text-foreground dark:text-foreground"
                  value="swap"
                  data-intent="swap"
                >
                  Swap
                </TabsTrigger>
                <TabsTrigger
                  className="text-foreground dark:text-foreground"
                  value="rent"
                  data-intent="rent"
                >
                  Rent
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {state.action === "limit" ? (
              <SupplyForm
                key={formKey}
                market={market}
                display={display}
                duration={PRODUCT_MARKET.duration}
                selectedTick={selected}
                assetAddress={asset.address}
                isPending={
                  (selectedInWindow ? book : outside).discovery.isPending
                }
              />
            ) : state.action === "swap" && state.selection.kind === "market" ? (
              <SwapForm key={formKey} market={market} asset={asset} />
            ) : (
              <UseForm
                key={formKey}
                market={market}
                display={display}
                tick={selected}
                mode={state.action === "rent" ? "use" : "swap"}
                isPending={
                  selectedTick !== undefined &&
                  (selectedInWindow ? book : outside).discovery.isPending
                }
                isIncomplete={
                  selected?.status === "failed" &&
                  !(selectedInWindow ? book : outside).discovery.isPending
                }
              />
            )}
          </CardContent>
        </Card>
      </div>
      <MarketPositions market={market} />
      {!exists && (
        <Card className="items-center text-center [&_h2]:text-xl [&_p]:max-w-xl [&_p]:text-muted-foreground">
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
