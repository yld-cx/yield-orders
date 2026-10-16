"use client";
import {
  TRANSACTION_DEFAULTS,
  BASIS_POINTS,
  PERCENT_SCALE,
  QUERY_TIMING,
} from "@yld-cx/sdk";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Market, Token } from "@yld-cx/sdk";
import { getNetwork, tokenAmount, explainError } from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText } from "@/lib/market-values";
import type { BookTick } from "@/hooks/use-yield-book";
import {
  AmountInput,
  Message,
  Metric,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import {
  Field,
  FieldLabel,
  FieldDescription,
} from "@yld-cx/ui/components/ui/field";
import { Input } from "@yld-cx/ui/components/ui/input";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@yld-cx/ui/components/ui/tabs";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@yld-cx/ui/components/ui/empty";
export function UseForm({
  market,
  tick,
  display,
  hasLiquidity,
  isPending,
  isIncomplete,
}: {
  market: Market;
  tick?: BookTick;
  display: readonly [Token, Token];
  hasLiquidity: boolean;
  isPending: boolean;
  isIncomplete: boolean;
}) {
  const [mode, setMode] = useState<"use" | "swap">("use"),
    [amount, setAmount] = useState(""),
    [tolerance, setTolerance] = useState(
      String(TRANSACTION_DEFAULTS.toleranceBps),
    );
  const network = getNetwork(market.network).slug;
  const asset: Token =
      tick?.state.asset.toLowerCase() === market.token1.address
        ? market.token1
        : market.token0,
    quote = asset === market.token0 ? market.token1 : market.token0;
  let raw = 0n,
    error = "";
  try {
    if (amount) raw = tokenAmount(amount, asset.decimals);
    if (
      !/^\d{1,4}$/.test(tolerance) ||
      Number(tolerance) > TRANSACTION_DEFAULTS.maxToleranceBps
    )
      throw new Error(
        `Tolerance must be 0–${TRANSACTION_DEFAULTS.maxToleranceBps} basis points`,
      );
  } catch (e) {
    error = explainError(e);
  }
  const query = useQuery({
    queryKey: ["quote", network, tick?.id.toString(), raw.toString()],
    queryFn: () => getSdk(network).quoteUse(tick!.id, raw),
    enabled: !!tick && raw > 0n && !error,
    refetchInterval: QUERY_TIMING.liveRefresh,
  });
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold">
          <div>
            <h2>Rent or swap</h2>
            <p className="text-xs text-muted-foreground">
              Use liquidity at the posted price.
            </p>
          </div>
          <Badge
            variant="outline"
            data-intent={mode === "use" ? "rent" : "swap"}
          >
            {mode === "use" ? "Use" : "Swap"}
          </Badge>
        </div>
        <Tabs
          value={mode}
          onValueChange={(next) => setMode(next as "use" | "swap")}
        >
          <TabsList className="w-full" aria-label="Execution mode">
            <TabsTrigger value="use" data-intent="rent">
              Rent
            </TabsTrigger>
            <TabsTrigger value="swap" data-intent="swap">
              Swap now
            </TabsTrigger>
          </TabsList>
          <TabsContent value={mode}>
            {!tick ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle role="heading" aria-level={3}>
                    {isIncomplete
                      ? "Liquidity unavailable"
                      : isPending
                        ? "Reading market…"
                        : hasLiquidity
                          ? "Choose your price"
                          : "No liquidity yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {isIncomplete
                      ? "Could not read liquidity. Retry the market reads."
                      : isPending
                        ? "Checking price levels…"
                        : hasLiquidity
                          ? "Choose a price level · current market depth"
                          : "Be the first to provide tokens at your price."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <AmountInput
                  label="You receive"
                  symbol={asset.symbol}
                  value={amount}
                  onChange={setAmount}
                />
                <Metric label="Price level">
                  {priceText(tickPrice(tick, display))} {display[1].symbol} /{" "}
                  {display[0].symbol}
                </Metric>
                <Metric label="Term">
                  {tick.state.durationDays.toString()}D
                </Metric>
                <details className="my-3 space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
                  <summary>Execution settings</summary>
                  <Field className="my-4">
                    <FieldLabel htmlFor="execution-tolerance">
                      Execution tolerance (basis points)
                    </FieldLabel>
                    <Input
                      id="execution-tolerance"
                      aria-label="Execution tolerance"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={tolerance}
                      onChange={(event) => {
                        const next = event.target.value;
                        if (/^\d*$/.test(next)) setTolerance(next);
                      }}
                    />
                    <FieldDescription className="text-xs">
                      {TRANSACTION_DEFAULTS.toleranceBps} ={" "}
                      {(TRANSACTION_DEFAULTS.toleranceBps /
                        Number(BASIS_POINTS)) *
                        PERCENT_SCALE}
                      %. Caps are set from a fresh contract quote before review.
                    </FieldDescription>
                  </Field>
                </details>
                <Card>
                  <CardContent className="space-y-4">
                    <Metric label="Available">
                      {amountText(tick.state.availableSupply, asset.decimals)}{" "}
                      {asset.symbol}
                    </Metric>
                    {query.data && (
                      <>
                        <Metric
                          label={
                            mode === "use"
                              ? "Quote locked upfront"
                              : "Quote paid"
                          }
                        >
                          {amountText(query.data[0], quote.decimals)}{" "}
                          {quote.symbol}
                        </Metric>
                        {mode === "use" && (
                          <>
                            <Metric label="Full-term Yield if repaid">
                              {amountText(query.data[1], asset.decimals)}{" "}
                              {asset.symbol}
                            </Metric>
                          </>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
                {error && <Message error>{error}</Message>}
                {query.isError && (
                  <Message error>{explainError(query.error)}</Message>
                )}
                <TransactionFlow
                  key={`${tick.id}/${mode}/${raw}/${tolerance}`}
                  network={network}
                  label={`Preview ${mode === "use" ? "Rent" : "Swap"}`}
                  asset={asset}
                  quote={quote}
                  disabled={!!error || raw === 0n || !query.data}
                  prepare={async () => {
                    const sdk = getSdk(network),
                      [principal, yieldAsset] = await sdk.quoteUse(
                        tick.id,
                        raw,
                      ),
                      deadline =
                        (await sdk.publicClient.getBlock()).timestamp +
                        TRANSACTION_DEFAULTS.deadlineSeconds;
                    const cap = (value: bigint) =>
                      (value * (BASIS_POINTS + BigInt(tolerance)) +
                        BASIS_POINTS -
                        1n) /
                      BASIS_POINTS;
                    return mode === "use"
                      ? {
                          kind: "use",
                          tickId: tick.id,
                          amount: raw,
                          maxFullTermYieldAsset: cap(yieldAsset),
                          deadline,
                        }
                      : {
                          kind: "swap",
                          tickId: tick.id,
                          amount: raw,
                          maxQuoteIn: cap(principal),
                          deadline,
                        };
                  }}
                />
                {mode === "use" ? (
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    Repay {asset.symbol} + elapsed Yield to unlock{" "}
                    {quote.symbol}. At maturity, locked {quote.symbol} settles
                    instead.
                  </p>
                ) : (
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                    Swap is immediate and final. No Asset Yield is paid on a
                    Swap.
                  </p>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
