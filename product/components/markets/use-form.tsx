"use client";
import { queryKeys } from "@/lib/query-keys";
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
import { parseUnits } from "viem";
import type { Market, Token } from "@yld-cx/sdk";
import { getNetwork, tokenAmount, explainError } from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import { tickPrice, priceText } from "@/lib/market-values";
import {
  termYieldFromAmounts,
  yieldText,
  DEFAULT_YIELD_MODE,
} from "@/lib/yield";
import type { BookLevel } from "@/hooks/use-yield-book";
import {
  AmountInput,
  Message,
  Metric,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Field } from "@yld-cx/ui/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupText,
} from "@yld-cx/ui/components/ui/input-group";
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
const BPS_PER_PERCENT = Number(BASIS_POINTS) / PERCENT_SCALE;
export function UseForm({
  market,
  tick: level,
  display,
  isPending,
  isIncomplete,
}: {
  market: Market;
  tick?: BookLevel;
  display: readonly [Token, Token];
  isPending: boolean;
  isIncomplete: boolean;
}) {
  const tick = level?.status === "exists" ? level : undefined;
  const hasLiquidity = (tick?.state.availableSupply ?? 0n) > 0n;
  const [mode, setMode] = useState<"use" | "swap">("use"),
    [amount, setAmount] = useState(""),
    [tolerance, setTolerance] = useState(
      String(TRANSACTION_DEFAULTS.toleranceBps / BPS_PER_PERCENT),
    );
  const network = getNetwork(market.network).slug;
  const asset: Token =
      tick?.state.asset.toLowerCase() === market.token1.address
        ? market.token1
        : market.token0,
    quote = asset === market.token0 ? market.token1 : market.token0;
  let raw = 0n,
    toleranceBps = 0n,
    error = "";
  try {
    if (amount) raw = tokenAmount(amount, asset.decimals);
    if (mode === "use") {
      if (
        !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(tolerance) ||
        Number(tolerance) >
          TRANSACTION_DEFAULTS.maxToleranceBps / BPS_PER_PERCENT
      )
        throw new Error(
          `Yield slippage must be 0–${TRANSACTION_DEFAULTS.maxToleranceBps / BPS_PER_PERCENT}% with at most 2 decimal places`,
        );
      toleranceBps = parseUnits(tolerance, 2);
    }
  } catch (e) {
    error = explainError(e);
  }
  const query = useQuery({
    queryKey: queryKeys.quote(network, market.key, tick?.id, raw),
    queryFn: () => getSdk(network).quoteUse(tick!.id, raw),
    enabled: hasLiquidity && raw > 0n && !error,
    refetchInterval: QUERY_TIMING.liveRefresh,
  });
  return (
    <Card className="min-w-0">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold">
          <div>
            <h2>Rent or swap</h2>
            <p className="text-xs text-muted-foreground">
              Use liquidity at the provided price.
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
            {!tick || !hasLiquidity ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle role="heading" aria-level={3}>
                    {isIncomplete
                      ? "Liquidity unavailable"
                      : isPending
                        ? "Reading market…"
                        : !level
                          ? "Choose your price"
                          : "No liquidity yet"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {isIncomplete ? (
                      "Could not read liquidity. Retry the market reads."
                    ) : isPending ? (
                      "Checking price ticks…"
                    ) : !level ? (
                      "Select a Yield Book price to rent or swap tokens."
                    ) : (
                      <>
                        Be the first to provide tokens at your price or request
                        liquidity in the{" "}
                        <a
                          href="https://t.me/yld_group"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Telegram group
                        </a>
                      </>
                    )}
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
                  max={{
                    value: tick.state.availableSupply,
                    decimals: asset.decimals,
                  }}
                />
                <Metric label="Price">
                  {priceText(tickPrice(tick, display))} {display[1].symbol} /{" "}
                  {display[0].symbol}
                </Metric>
                <Metric label="Term">
                  {tick.state.durationDays.toString()}D
                </Metric>
                {mode === "use" && (
                  <details className="space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
                    <summary>Yield slippage</summary>
                    <Field className="my-2">
                      <InputGroup>
                        <InputGroupInput
                          id="execution-tolerance"
                          aria-label="Yield slippage"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="none"
                          spellCheck={false}
                          value={tolerance}
                          onChange={(event) => {
                            const next = event.target.value;
                            if (/^\d*(?:\.\d*)?$/.test(next))
                              setTolerance(next);
                          }}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupText>%</InputGroupText>
                        </InputGroupAddon>
                      </InputGroup>
                    </Field>
                  </details>
                )}
                <Card className="my-4">
                  <CardContent className="space-y-4">
                    <Metric label="Available">
                      {amountText(tick.state.availableSupply, asset.decimals)}{" "}
                      {asset.symbol}
                    </Metric>
                    {query.data && (
                      <>
                        <Metric
                          label={mode === "use" ? "Quote locked" : "Quote paid"}
                        >
                          {amountText(query.data[0], quote.decimals)}{" "}
                          {quote.symbol}
                        </Metric>
                        {mode === "use" && (
                          <>
                            <Metric label="Term Yield">
                              {yieldText(
                                termYieldFromAmounts(query.data[1], raw),
                                Number(tick.state.durationDays),
                                DEFAULT_YIELD_MODE.rent,
                              )}
                            </Metric>
                            <p className="text-xs text-muted-foreground">
                              Estimated borrowing cost for the{" "}
                              {tick.state.durationDays.toString()}D term.
                            </p>
                            <Metric label="Full-term Yield">
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
                      (value * (BASIS_POINTS + toleranceBps) +
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
                          maxQuoteIn: principal,
                          deadline,
                        };
                  }}
                />
              </>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
