"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import type { Address } from "viem";
import { Droplets } from "lucide-react";
import {
  QUERY_TIMING,
  PRODUCT_MARKET,
  Q128,
  type Market,
  type Token,
} from "@yld-cx/sdk";
import { getNetwork, tokenAmount, explainError } from "@yld-cx/sdk/ethereum";
import {
  AmountInput,
  Metric,
  Message,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Button } from "@yld-cx/ui/components/ui/button";
import { priceText, tickPrice } from "@/lib/market-values";
import { ApyLabel } from "@/components/forms/yield-display";
import { DEFAULT_YIELD_MODE, tickYieldText } from "@/lib/yield";
import { queryKeys } from "@/lib/query-keys";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import type { BookLevel } from "@/hooks/use-yield-book";
export function SupplyForm({
  market,
  display,
  duration,
  selectedTick,
  assetAddress,
  isPending = false,
}: {
  market: Market;
  display: readonly [Token, Token];
  duration: typeof PRODUCT_MARKET.duration;
  selectedTick?: BookLevel;
  assetAddress: string;
  isPending?: boolean;
}) {
  const [amount, setAmount] = useState("");
  const side =
    assetAddress.toLowerCase() === display[0].address.toLowerCase()
      ? "ask"
      : "bid";
  const [asset, quote] = side === "ask" ? display : [display[1], display[0]];
  const network = getNetwork(market.network).slug;
  const account = useConnection();
  const connected = account.isConnected && !!account.address;
  const balance = useQuery({
    queryKey: queryKeys.balance(network, asset.address, account.address),
    queryFn: () =>
      getSdk(network).balance(asset.address as Address, account.address!),
    enabled: connected,
    refetchInterval: QUERY_TIMING.liveRefresh,
  });
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
      ? tickYieldText(selected.state, DEFAULT_YIELD_MODE.provide)
      : "—";
  return (
    <div className="space-y-4" aria-label="Limit order">
      <AmountInput
        label="Amount"
        symbol={asset.symbol}
        value={amount}
        onChange={setAmount}
        balance={
          connected
            ? {
                value: balance.data,
                decimals: asset.decimals,
                isPending: balance.isPending,
                isError: balance.isError,
              }
            : undefined
        }
      />
      <Metric label="Price">
        {selected
          ? `${priceText(tickPrice(selected, display))} ${display[1].symbol} / ${display[0].symbol}`
          : "Not selected"}
      </Metric>
      <Metric label="Term">{duration}D</Metric>
      {selected && (
        <div className="my-4 space-y-4">
          <Metric label="You provide">
            {amountText(rawAmount, asset.decimals)} {asset.symbol}
          </Metric>
          <Metric label="You receive">
            ~{" "}
            {amountText(
              (rawAmount * selected.priceX128 + Q128 - 1n) / Q128,
              quote.decimals,
            )}{" "}
            {quote.symbol}
          </Metric>
          <Metric label={<ApyLabel>Estimated APY</ApyLabel>}>
            {estimatedYield}
          </Metric>
        </div>
      )}
      {validation && <Message error>{validation}</Message>}
      {selected?.status === "failed" && !isPending && (
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
          triggerLabel={side === "ask" ? "Sell and Earn" : "Buy and Earn"}
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
        <Button
          className="w-full"
          aria-label={side === "ask" ? "Sell and Earn" : "Buy and Earn"}
          disabled
        >
          <Droplets aria-hidden="true" data-icon="inline-start" />{" "}
          {side === "ask" ? "Sell and Earn" : "Buy and Earn"}
        </Button>
      )}
    </div>
  );
}
