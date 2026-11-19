"use client";
import { queryKeys } from "@/lib/query-keys";
import {
  TRANSACTION_DEFAULTS,
  BASIS_POINTS,
  PERCENT_SCALE,
  QUERY_TIMING,
} from "@yld-cx/sdk";
import { Skeleton } from "@yld-cx/ui/components/ui/skeleton";
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
  SlippageInput,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
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
  mode,
}: {
  market: Market;
  tick?: BookLevel;
  display: readonly [Token, Token];
  isPending: boolean;
  isIncomplete: boolean;
  mode: "use" | "swap";
}) {
  const tick = level?.status === "exists" ? level : undefined;
  const hasLiquidity = (tick?.state.availableSupply ?? 0n) > 0n;
  const [amount, setAmount] = useState(""),
    [tolerance, setTolerance] = useState(
      String(TRANSACTION_DEFAULTS.toleranceBps / BPS_PER_PERCENT),
    );
  const network = getNetwork(market.network).slug;
  const asset: Token =
      level?.asset.toLowerCase() === market.token1.address.toLowerCase()
        ? market.token1
        : market.token0,
    quote = asset === market.token0 ? market.token1 : market.token0;
  let raw = 0n,
    toleranceBps = 0n,
    error = "";
  try {
    if (amount) raw = tokenAmount(amount, asset.decimals);
    if (raw > (tick?.state.availableSupply ?? 0n))
      throw new Error("Amount exceeds available liquidity");
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
    <div className="space-y-4">
      {!tick || !hasLiquidity ? (
        <Empty aria-busy={isPending} className="min-h-28">
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={3}>
              {isIncomplete || (!isPending && level?.status === "failed") ? (
                "Liquidity unavailable"
              ) : isPending ? (
                <Skeleton className="h-5 w-32 motion-reduce:animate-none" />
              ) : !level ? (
                "Choose your price"
              ) : (
                "No liquidity yet"
              )}
            </EmptyTitle>
            <EmptyDescription>
              {isIncomplete || (!isPending && level?.status === "failed") ? (
                "Could not read liquidity. Retry the market reads."
              ) : isPending ? (
                <Skeleton className="h-4 w-56 max-w-full motion-reduce:animate-none" />
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
            label="Amount"
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
          <Metric label="Term">{tick.state.durationDays.toString()}D</Metric>
          <div className="my-4 space-y-4">
            <Metric label="You provide">
              {query.data
                ? `${amountText(query.data[0], quote.decimals)} ${quote.symbol}`
                : raw > 0n
                  ? "…"
                  : `0 ${quote.symbol}`}
            </Metric>
            <Metric label="You receive">
              {amountText(raw, asset.decimals)} {asset.symbol}
            </Metric>
            {query.data && (
              <>
                {mode === "use" && (
                  <>
                    <Metric label="Estimated Yield">
                      {yieldText(
                        termYieldFromAmounts(query.data[1], raw),
                        Number(tick.state.durationDays),
                        DEFAULT_YIELD_MODE.rent,
                      )}
                    </Metric>
                    <Metric label="Full-term Yield">
                      {amountText(query.data[1], asset.decimals)} {asset.symbol}
                    </Metric>
                  </>
                )}
              </>
            )}
          </div>
          {mode === "use" && (
            <SlippageInput
              label="Yield slippage"
              value={tolerance}
              onChange={setTolerance}
            />
          )}
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
            disabled={
              !!error ||
              raw === 0n ||
              !query.data ||
              query.isError ||
              raw > tick.state.availableSupply
            }
            prepare={async () => {
              const sdk = getSdk(network),
                [principal, yieldAsset] = await sdk.quoteUse(tick.id, raw),
                deadline =
                  (await sdk.publicClient.getBlock()).timestamp +
                  TRANSACTION_DEFAULTS.deadlineSeconds;
              const cap = (value: bigint) =>
                (value * (BASIS_POINTS + toleranceBps) + BASIS_POINTS - 1n) /
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
    </div>
  );
}
