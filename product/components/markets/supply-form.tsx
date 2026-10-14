"use client";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Duration, Market, Token } from "@yld-cx/sdk";
import {
  getNetwork,
  snappedPrice,
  tickIdFor,
  tokenAmount,
  protocolErrorName,
  explainError,
  humanPrice,
  formatRatio,
} from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
import {
  AmountInput,
  DurationSelect,
  Metric,
  Message,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Button } from "@yld-cx/ui/components/ui/button";
import { reciprocalPrice, tickPrice } from "@/lib/market-values";
import { displayTokens } from "@yld-cx/sdk/registry";
import type { BookTick } from "@/hooks/use-yield-book";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@yld-cx/ui/components/ui/tabs";

export function SupplyForm({
  market,
  pairId,
  display,
  duration,
  selectedTick,
  onDurationChange,
  pairExists,
}: {
  market: Market;
  pairId: bigint;
  display: readonly [Token, Token];
  duration: Duration;
  selectedTick?: BookTick;
  onDurationChange: (duration: Duration) => void;
  pairExists: boolean;
}) {
  const [exact, setExact] = useState(!!selectedTick);
  const [assetAddress, setAssetAddress] = useState(
    selectedTick?.state.asset.toLowerCase() ?? displayTokens(market)[0].address,
  );
  const [price, setPrice] = useState({
    value: selectedTick ? tickPrice(selectedTick, display) : "",
    base: display[0].address,
  });
  const [amount, setAmount] = useState("");
  const side = assetAddress === display[0].address ? "ask" : "bid";
  const [asset, quote] = side === "ask" ? display : [display[1], display[0]];
  const network = getNetwork(market.network).slug;
  const selected = exact ? selectedTick : undefined;
  const shownPrice = selected
    ? tickPrice(selected, display)
    : price.base === display[0].address
      ? price.value
      : reciprocalPrice(price.value);
  let snap: ReturnType<typeof snappedPrice> | undefined,
    validation = "",
    rawAmount = 0n;
  try {
    if (!selected && price.value)
      snap = snappedPrice(
        price.value,
        asset.decimals,
        quote.decimals,
        market.stepTicks,
        price.base !== asset.address,
      );
    if (amount) rawAmount = tokenAmount(amount, asset.decimals);
  } catch (e) {
    validation = explainError(e);
  }
  const direction = asset.address === market.token0.address ? 0 : 1;
  const id =
    selected?.id ??
    (snap ? tickIdFor(pairId, direction, snap.priceTick, duration) : undefined);
  const tick = useQuery({
    queryKey: ["tick", network, "supply", id?.toString()],
    queryFn: async () => {
      try {
        return { exists: true, state: await getSdk(network).getTick(id!) };
      } catch (e) {
        if (protocolErrorName(e) === "NotFound") return { exists: false };
        throw e;
      }
    },
    enabled: pairExists && !selected && id !== undefined,
    refetchInterval: 15000,
  });
  const exists = !!selected || tick.data?.exists;
  const state = selected?.state ?? tick.data?.state;
  const sample = state ? state.availableSupply / 1000000n || 1n : 0n;
  const estimatedYield = useQuery({
    queryKey: ["quote", network, id?.toString(), sample.toString()],
    queryFn: () => getSdk(network).quoteUse(id!, sample),
    enabled: !!state && state.availableSupply > 0n,
    refetchInterval: 15000,
  });
  const postedPrice = selected
    ? tickPrice(selected, display)
    : snap
      ? tickPrice(
          {
            state: {
              priceX128: snap.priceX128,
              asset: asset.address as `0x${string}`,
            },
          },
          display,
        )
      : "";
  return (
    <Card className="min-w-0" aria-label="Provide liquidity">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold">
          <div>
            <h2>Provide liquidity</h2>
            <p className="text-xs text-muted-foreground">
              Set your price. Earn or {side === "ask" ? "Sell" : "Buy"}.
            </p>
          </div>
          <Badge variant="outline" data-intent="term">
            Provide
          </Badge>
        </div>
        <Tabs
          value={side}
          onValueChange={(next) => {
            setAssetAddress(
              next === "ask" ? display[0].address : display[1].address,
            );
            setExact(false);
            setAmount("");
          }}
        >
          <TabsList className="w-full" aria-label="Supply side">
            <TabsTrigger value="ask" data-intent="ask">
              Ask · {display[0].symbol}
            </TabsTrigger>
            <TabsTrigger value="bid" data-intent="bid">
              Bid · {display[1].symbol}
            </TabsTrigger>
          </TabsList>
          <TabsContent value={side}>
            <AmountInput
              label="Amount"
              symbol={asset.symbol}
              value={amount}
              onChange={setAmount}
            />
            <AmountInput
              label="Posted price"
              symbol={`${display[1].symbol} / ${display[0].symbol}`}
              value={shownPrice}
              onChange={(value) => {
                setExact(false);
                setPrice({ value, base: display[0].address });
              }}
              labelAddon={
                selectedTick && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setAssetAddress(selectedTick.state.asset.toLowerCase());
                      setExact(true);
                    }}
                  >
                    Use selected price
                  </Button>
                )
              }
            />
            {selected ? (
              <Metric label="Term">
                {selected.state.durationDays.toString()}D
              </Metric>
            ) : (
              <DurationSelect
                label="Term"
                value={duration}
                onChange={onDurationChange}
              />
            )}
            {!!postedPrice && (
              <Card>
                <CardContent className="space-y-4">
                  <Metric label="You provide">
                    {amount || "0"} {asset.symbol}
                  </Metric>
                  <Metric label="Your posted price">
                    {postedPrice} {display[1].symbol} / {display[0].symbol}
                  </Metric>
                  <Metric label="Estimated Yield">
                    {estimatedYield.data
                      ? `${formatRatio(estimatedYield.data[1] * 100n, sample, 4)}% / ${selected?.state.durationDays ?? duration}D`
                      : estimatedYield.isError
                        ? "Read failed"
                        : "Yield when used and returned"}
                  </Metric>
                  <details className="my-3 space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
                    <summary>Price details</summary>
                    {selected ? (
                      <>
                        <p>
                          Supply to the selected existing Tick. Its price and
                          duration stay exact; no grid snapping is applied.
                        </p>
                        <p>
                          {humanPrice(
                            selected.state.priceX128,
                            asset.decimals,
                            quote.decimals,
                          )}{" "}
                          {quote.symbol} per {asset.symbol}
                        </p>
                        <code>{selected.id.toString()}</code>
                      </>
                    ) : (
                      <>
                        <Metric label="Price tick">{snap!.priceTick}</Metric>
                        <Metric label="Grid spacing">
                          {market.stepTicks} ticks
                        </Metric>
                      </>
                    )}
                  </details>
                </CardContent>
              </Card>
            )}
            {validation && <Message error>{validation}</Message>}
            {!selected && tick.isError && (
              <Message error>{explainError(tick.error)}</Message>
            )}
            {pairExists &&
            id !== undefined &&
            !validation &&
            (selected || tick.data) ? (
              exists ? (
                <TransactionFlow
                  key={`supply/${id}/${rawAmount}`}
                  network={network}
                  label="Preview Provide"
                  asset={asset}
                  quote={quote}
                  disabled={rawAmount === 0n}
                  prepare={async () => ({
                    kind: "supply",
                    tickId: id,
                    amount: rawAmount,
                  })}
                />
              ) : (
                <>
                  <Message>
                    👑 First liquidity sets the market price. This action will
                    need a new price Tick before Supply. No liquidity is
                    provided by market creation alone.
                  </Message>
                  <TransactionFlow
                    key={`create/${id}`}
                    network={network}
                    label="Create Tick"
                    asset={asset}
                    quote={quote}
                    prepare={async () => ({
                      kind: "createTick",
                      pairId,
                      direction,
                      priceTick: snap!.priceTick,
                      durationDays: duration,
                    })}
                  />
                </>
              )
            ) : (
              <Button className="w-full" disabled>
                Preview Provide
              </Button>
            )}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              No guaranteed Yield. Top-ups restart vesting of uncollected Yield
              for this position.
            </p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
