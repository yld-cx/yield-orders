"use client";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { useState } from "react";
import { Droplets } from "lucide-react";
import type { Duration, Market, Token } from "@yld-cx/sdk";
import {
  getNetwork,
  tokenAmount,
  explainError,
  marginalYieldPercent,
} from "@yld-cx/sdk/ethereum";
import {
  AmountInput,
  DurationSelect,
  Metric,
  Message,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Button } from "@yld-cx/ui/components/ui/button";
import { tickPrice } from "@/lib/market-values";
import type { BookLevel } from "@/hooks/use-yield-book";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@yld-cx/ui/components/ui/tabs";

export function SupplyForm({
  market,
  display,
  duration,
  selectedTick,
  assetAddress,
  onAssetChange,
  onDurationChange,
}: {
  market: Market;
  display: readonly [Token, Token];
  duration: Duration;
  selectedTick?: BookLevel;
  assetAddress: string;
  onAssetChange: (address: string) => void;
  onDurationChange: (duration: Duration) => void;
}) {
  const [amount, setAmount] = useState("");
  const side = assetAddress === display[0].address ? "ask" : "bid";
  const [asset, quote] = side === "ask" ? display : [display[1], display[0]];
  const network = getNetwork(market.network).slug;
  const selected =
    selectedTick?.asset.toLowerCase() === asset.address.toLowerCase() &&
    selectedTick.durationDays === duration
      ? selectedTick
      : undefined;
  let validation = "",
    rawAmount = 0n;
  try {
    if (amount) rawAmount = tokenAmount(amount, asset.decimals);
  } catch (e) {
    validation = explainError(e);
  }
  const estimatedYield =
    selected?.status === "exists"
      ? marginalYieldPercent(selected.state)
      : undefined;
  return (
    <Card className="min-w-0" aria-label="Provide liquidity">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold">
          <div>
            <h2>Provide liquidity</h2>
            <p className="text-xs text-muted-foreground">
              Choose a Yield Book price. Earn or{" "}
              {side === "ask" ? "Sell" : "Buy"}.
            </p>
          </div>
          <Badge variant="outline" data-intent="term">
            Provide
          </Badge>
        </div>
        <Tabs
          value={side}
          onValueChange={(next) =>
            onAssetChange(
              next === "ask" ? display[0].address : display[1].address,
            )
          }
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
            <Metric label="Price">
              {selected
                ? `${tickPrice(selected, display)} ${display[1].symbol} / ${display[0].symbol}`
                : "Not selected"}
            </Metric>
            <DurationSelect
              label="Term"
              value={duration}
              onChange={onDurationChange}
            />
            {selected && (
              <Card className="mb-4">
                <CardContent className="space-y-4">
                  <Metric label="You provide">
                    {amount || "0"} {asset.symbol}
                  </Metric>
                  <Metric label="Estimated Yield">
                    {estimatedYield !== undefined
                      ? `${estimatedYield}% / ${selected.durationDays}D`
                      : "—"}
                  </Metric>
                  <details className="space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
                    <summary>Price details</summary>
                    <Metric label="Price tick">{selected.priceTick}</Metric>
                    <code>{selected.id.toString()}</code>
                  </details>
                </CardContent>
              </Card>
            )}
            {validation && <Message error>{validation}</Message>}
            {selected?.status === "failed" && (
              <Message error>
                Selected price level could not be read. Refresh discovery.{" "}
                {selected.error}
              </Message>
            )}
            {selected && !validation ? (
              <TransactionFlow
                key={`supply/${selected.id}/${rawAmount}`}
                network={network}
                label="Preview Provide"
                asset={asset}
                quote={quote}
                disabled={rawAmount === 0n || selected.status === "failed"}
                prepare={async () => ({
                  kind: "supply",
                  tickId: selected.id,
                  amount: rawAmount,
                  initialize: {
                    tokenA: market.token0.address as `0x${string}`,
                    tokenB: market.token1.address as `0x${string}`,
                    direction: selected.direction,
                    priceTick: selected.priceTick,
                    durationDays: selected.durationDays,
                  },
                })}
              />
            ) : (
              <Button className="w-full" aria-label="Preview Provide" disabled>
                <Droplets aria-hidden="true" data-icon="inline-start" /> Provide
              </Button>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
