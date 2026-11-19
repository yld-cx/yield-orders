"use client";
import { useEffect, useState } from "react";
import { useConnection } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Market, Token } from "@yld-cx/sdk";
import { QUERY_TIMING } from "@yld-cx/sdk";
import { getNetwork, explainError, tokenAmount } from "@yld-cx/sdk/ethereum";
import type { SwapInput } from "@yld-cx/sdk/uniswap";
import {
  AmountInput,
  Message,
  Metric,
  SlippageInput,
} from "@/components/forms/financial-fields";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { getSdk } from "@/lib/rpc";
import { amountText } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { swapRequest, SwapRateLimitError } from "@/lib/swap-flow";
import { walletSwapAvailable } from "@/lib/swap-availability";

export function SwapForm({ market, asset }: { market: Market; asset: Token }) {
  const account = useConnection();
  if (
    !walletSwapAvailable(
      getNetwork(market.network).chain.id,
      market.token0.address,
      market.token1.address,
    )
  )
    return <Message>Market swaps are not available for this pair yet.</Message>;
  return (
    <SwapSession
      key={`${market.network}/${market.key}/${account.address}/${account.chainId}/${asset.address}`}
      market={market}
      asset={asset}
    />
  );
}
function SwapSession({
  market,
  asset: input,
}: {
  market: Market;
  asset: Token;
}) {
  const account = useConnection();
  const network = getNetwork(market.network);
  const output =
    input.address.toLowerCase() === market.token0.address.toLowerCase()
      ? market.token1
      : market.token0;
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const balance = useQuery({
    queryKey: queryKeys.balance(network.slug, input.address, account.address),
    queryFn: () =>
      getSdk(network.slug).balance(
        input.address as `0x${string}`,
        account.address!,
      ),
    enabled: !!account.address,
    refetchInterval: QUERY_TIMING.liveRefresh,
  });
  let raw = 0n,
    error = "";
  try {
    if (amount) raw = tokenAmount(amount, input.decimals);
    if (balance.data !== undefined && raw > balance.data)
      throw new Error("Check your available token balance");
    if (
      !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(slippage) ||
      Number(slippage) <= 0 ||
      Number(slippage) > 1
    )
      throw new Error("Swap slippage must be greater than 0 and at most 1%");
  } catch (e) {
    error = explainError(e);
  }
  const rawAmount = raw.toString();
  const [quoteAmount, setQuoteAmount] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuoteAmount(rawAmount), 1234);
    return () => clearTimeout(timer);
  }, [rawAmount]);
  const request: SwapInput | undefined =
    account.address && !error && raw > 0n
      ? {
          chainId: network.chain.id,
          mode: "wallet-router",
          tokenIn: input.address as `0x${string}`,
          tokenOut: output.address as `0x${string}`,
          amount: rawAmount,
          swapper: account.address,
          slippage: Number(slippage),
        }
      : undefined;
  const quote = useQuery({
    queryKey: [
      "amm-quote",
      network.id,
      input.address,
      output.address,
      account.address,
      rawAmount,
      slippage,
    ],
    queryFn: ({ signal }) => swapRequest(request!, signal),
    enabled:
      !!request &&
      account.chainId === network.chain.id &&
      quoteAmount === rawAmount,
    staleTime: QUERY_TIMING.liveRefresh,
    refetchInterval: QUERY_TIMING.liveRefresh,
    retry: (failureCount, error) =>
      failureCount < 1 && error instanceof SwapRateLimitError,
    retryDelay: (_failureCount, error) =>
      error instanceof SwapRateLimitError ? error.retryAfter : 0,
  });
  const [expiredAt, setExpiredAt] = useState<number>();
  useEffect(() => {
    if (!quote.data) return;
    const expiresAt = quote.data.expiresAt;
    const timer = setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [quote.data]);
  const ready =
    !!request &&
    !!quote.data &&
    !quote.isError &&
    !quote.isFetching &&
    quoteAmount === rawAmount &&
    quote.data.expiresAt !== expiredAt;
  const quoteError = quote.error ?? quote.failureReason;
  return (
    <div className="space-y-4" aria-label="Market swap">
      <AmountInput
        label="Amount"
        value={amount}
        onChange={setAmount}
        symbol={input.symbol}
        balance={
          account.address
            ? {
                value: balance.data,
                decimals: input.decimals,
                isPending: balance.isPending,
                isError: balance.isError,
              }
            : undefined
        }
      />
      <div aria-live="polite" aria-busy={quote.isFetching}>
        <Metric label="You provide">
          {amountText(raw, input.decimals)} {input.symbol}
        </Metric>
        <Metric label="You receive">
          {ready
            ? `~ ${amountText(BigInt(quote.data!.estimatedAmountOut), output.decimals)} ${output.symbol}`
            : raw > 0n && !error && !quote.isError
              ? "…"
              : "—"}
        </Metric>
      </div>
      <SlippageInput
        label="Swap slippage"
        value={slippage}
        onChange={setSlippage}
      />
      {error && <Message error>{error}</Message>}
      {quoteError && !error && (
        <Message error>{explainError(quoteError)}</Message>
      )}
      <TransactionFlow
        key={`${rawAmount}/${slippage}`}
        network={network.slug}
        label="Preview Swap"
        triggerLabel="Swap"
        asset={input}
        quote={output}
        disabled={!ready}
        prepare={async () => {
          if (!request) throw new Error("Enter an amount first");
          return { kind: "market-swap", input: request };
        }}
      />
    </div>
  );
}
