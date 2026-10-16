"use client";
import {
  PERCENT_SCALE,
  WITHDRAW_PERCENTAGES,
  TRANSACTION_DEFAULTS,
} from "@yld-cx/sdk";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useConnection } from "wagmi";
import type {
  ProviderPosition,
  TickState,
  UsePosition,
  Token,
} from "@yld-cx/sdk";
import {
  getNetwork,
  explainError,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { canonicalPair, displayTokens } from "@yld-cx/sdk/registry";
import { getSdk } from "@/lib/rpc";
import { useToken } from "@/hooks/use-market";
import { amountText, timestampText } from "@/lib/utils";
import { priceText, tickPrice } from "@/lib/market-values";
import { Metric, Message } from "@/components/forms/financial-fields";
import LoadingScreen from "@/components/layout/loading-screen";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Progress } from "@yld-cx/ui/components/ui/progress";
import { Button } from "@yld-cx/ui/components/ui/button";

function PositionCardLayout({
  network,
  tick,
  asset,
  quote,
  metrics,
  actions,
  children,
}: {
  network: NetworkSlug;
  tick: TickState;
  asset: Token;
  quote: Token;
  metrics: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  const pair = canonicalPair(
      getNetwork(network).id,
      tick.asset,
      tick.quote,
    ).join(":"),
    natural = displayTokens({ token0: asset, token1: quote }),
    ask = natural[0].address.toLowerCase() === asset.address.toLowerCase();
  return (
    <Card className="min-w-0" data-slot="position-card">
      <CardContent className="space-y-3">
        <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            className="min-w-0 break-words font-semibold hover:underline"
            href={`/market/${network}/${pair}`}
            aria-label={`View ${natural[0].symbol} / ${natural[1].symbol} market`}
          >
            <h3>
              {natural[0].symbol} / {natural[1].symbol} ↗
            </h3>
          </Link>
          <p
            className={`min-w-0 break-words text-xs ${ask ? "text-ask" : "text-bid"}`}
          >
            {ask ? "Ask" : "Bid"} · {priceText(tickPrice(tick, natural))}{" "}
            {natural[1].symbol} per {natural[0].symbol}
          </p>
          <Badge className="sm:ml-auto">
            {tick.durationDays.toString()}D · {getNetwork(network).name}
          </Badge>
        </header>
        {(!asset.listed || !quote.listed) && (
          <p role="note" className="break-words text-xs text-primary">
            Unlisted token — verify the address in Details before transacting.
          </p>
        )}
        <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 [&_dl]:my-0 [&_dl]:block [&_dl]:min-w-0 [&_dd]:mt-1 [&_dd]:max-w-none [&_dd]:text-left [&_dd]:break-all">
          {metrics}
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Position actions"
        >
          {actions}
        </div>
        <details className="border-t pt-2 text-xs">
          <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Details
          </summary>
          <div className="mt-3 grid min-w-0 gap-x-6 sm:grid-cols-2 [&_dl]:min-w-0 [&_dd]:break-all">
            {children}
          </div>
          <dl className="mt-3 grid min-w-0 gap-x-6 gap-y-2 break-all text-muted-foreground sm:grid-cols-2">
            <div className="min-w-0">
              <dt>Asset · {asset.symbol}</dt>
              <dd>
                <code>{asset.address}</code>
              </dd>
            </div>
            <div className="min-w-0">
              <dt>Quote · {quote.symbol}</dt>
              <dd>
                <code>{quote.address}</code>
              </dd>
            </div>
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}

function PositionLoading() {
  return (
    <Card className="min-w-0">
      <CardContent>
        <LoadingScreen className="min-h-32" label="Loading position…" />
      </CardContent>
    </Card>
  );
}

export function ProviderCard({
  network,
  tickId,
  position,
  tick,
}: {
  network: NetworkSlug;
  tickId: bigint;
  position: ProviderPosition;
  tick: TickState;
}) {
  const assetQuery = useToken(network, tick.asset),
    quoteQuery = useToken(network, tick.quote),
    account = useConnection();
  const [percent, setPercent] = useState<number>(PERCENT_SCALE);
  if (assetQuery.isError || quoteQuery.isError)
    return (
      <Message error>
        {explainError(assetQuery.error ?? quoteQuery.error)}
      </Message>
    );
  if (!assetQuery.data || !quoteQuery.data) return <PositionLoading />;
  const asset = assetQuery.data,
    quote = quoteQuery.data,
    a = (n: bigint) => `${amountText(n, asset.decimals)} ${asset.symbol}`,
    q = (n: bigint) => `${amountText(n, quote.decimals)} ${quote.symbol}`,
    exactAsset = (n: bigint) =>
      `${amountText(n, asset.decimals, asset.decimals)} ${asset.symbol}`,
    exactQuote = (n: bigint) =>
      `${amountText(n, quote.decimals, quote.decimals)} ${quote.symbol}`;
  const totalYield =
      position.outstandingActiveYieldAsset + position.outstandingExitYieldAsset,
    collectibleYield =
      position.claimableActiveYieldAsset + position.claimableExitYieldAsset,
    collectibleQuote =
      position.claimableActiveQuote + position.claimableExitQuote,
    selectedAmount =
      (position.activePrincipal * BigInt(percent)) / BigInt(PERCENT_SCALE),
    hasCollectible =
      collectibleYield + position.claimableExitAsset + collectibleQuote > 0n,
    // Collect also advances automatic settlement, including fractional positions.
    canResolve =
      tick.workingSupply > 0n &&
      (position.activePrincipalX36 > 0n || position.exitPrincipalX36 > 0n);
  return (
    <PositionCardLayout
      network={network}
      tick={tick}
      asset={asset}
      quote={quote}
      metrics={
        <>
          <Metric label="Available">{a(position.activeAvailable)}</Metric>
          <Metric label="In Use">{a(position.activeWorking)}</Metric>
          <Metric label="Resolving">{a(position.resolvingPrincipal)}</Metric>
          <Metric label="Collectible">
            <span className="block">{a(collectibleYield)} Yield</span>
            <span className="block">{q(collectibleQuote)} proceeds</span>
            {position.claimableExitAsset > 0n && (
              <span className="block">
                {a(position.claimableExitAsset)} principal
              </span>
            )}
          </Metric>
        </>
      }
      actions={
        <>
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Withdraw percentage"
          >
            {WITHDRAW_PERCENTAGES.map((p) => (
              <Button
                variant={percent === p ? "secondary" : "outline"}
                size="sm"
                key={p}
                aria-pressed={percent === p}
                onClick={() => setPercent(p)}
              >
                {p === PERCENT_SCALE ? "Max" : `${p}%`}
              </Button>
            ))}
          </div>
          <TransactionFlow
            key={`withdraw/${tickId}/${percent}`}
            network={network}
            label="Preview Withdraw"
            asset={asset}
            quote={quote}
            disabled={selectedAmount === 0n}
            prepare={async () => {
              const sdk = getSdk(network),
                current = await sdk.getEarnPosition(account.address!, tickId),
                amount =
                  (current.activePrincipal * BigInt(percent)) /
                  BigInt(PERCENT_SCALE);
              if (amount === 0n)
                throw new Error(
                  "No transferable principal for this percentage",
                );
              const deadline =
                (await sdk.publicClient.getBlock()).timestamp +
                TRANSACTION_DEFAULTS.deadlineSeconds;
              return {
                kind: "withdraw",
                tickId,
                amount,
                minImmediateAssetOut: 0n,
                deadline,
              };
            }}
          />
          <TransactionFlow
            network={network}
            label="Preview Collect"
            asset={asset}
            quote={quote}
            disabled={!hasCollectible && !canResolve}
            prepare={async () => ({ kind: "collect", tickId })}
            validatePreview={async (preview) => {
              if (
                !preview.collect ||
                preview.collect.totalAssetOut > 0n ||
                preview.collect.totalQuoteOut > 0n
              )
                return;
              // A zero-output Collect is useful only if it advances the settlement cursor.
              const before = await getSdk(network).getTick(
                tickId,
                preview.blockNumber,
              );
              if (
                !preview.tick ||
                preview.tick.settleCursor === before.settleCursor
              )
                throw new Error(
                  "Nothing to collect yet. Wait for Yield to vest or liquidity to resolve.",
                );
            }}
          />
        </>
      }
    >
      <Metric label="Total Active principal">
        {exactAsset(position.activePrincipal)}
      </Metric>
      <Metric label="Available Asset">
        {exactAsset(position.activeAvailable)}
      </Metric>
      <Metric label="In Use Asset">{exactAsset(position.activeWorking)}</Metric>
      <Metric label="Resolving Asset">
        {exactAsset(position.resolvingPrincipal)}
      </Metric>
      {totalYield > 0n && (
        <>
          <Metric label="Outstanding Yield">{exactAsset(totalYield)}</Metric>
          <Metric label="Collectible Yield">
            {exactAsset(collectibleYield)}
          </Metric>
          <Metric label="Unvested Yield">
            {exactAsset(totalYield - collectibleYield)}
          </Metric>
          <Metric label="Fully collectible at">
            {timestampText(
              position.timestamp + position.vestingDurationSeconds,
            )}
          </Metric>
          <div className="py-2 sm:col-span-2">
            <Progress
              aria-label="Yield vesting progress"
              max={Number(position.vestingDurationSeconds) || 1}
              value={Number(position.vestingElapsedSeconds)}
            />
          </div>
        </>
      )}
      {position.claimableExitAsset > 0n && (
        <Metric label="Collectible principal">
          {exactAsset(position.claimableExitAsset)}
        </Metric>
      )}
      {collectibleQuote > 0n && (
        <Metric label="Quote proceeds">{exactQuote(collectibleQuote)}</Metric>
      )}
    </PositionCardLayout>
  );
}

export function UseCard({
  network,
  positionId,
  position,
  tick,
  timestamp,
}: {
  network: NetworkSlug;
  positionId: bigint;
  position: UsePosition;
  tick: TickState;
  timestamp: bigint;
}) {
  const assetQuery = useToken(network, tick.asset),
    quoteQuery = useToken(network, tick.quote),
    mature = timestamp >= position.maturity;
  if (assetQuery.isError || quoteQuery.isError)
    return (
      <Message error>
        {explainError(assetQuery.error ?? quoteQuery.error)}
      </Message>
    );
  if (!assetQuery.data || !quoteQuery.data) return <PositionLoading />;
  const asset = assetQuery.data,
    quote = quoteQuery.data,
    a = (n: bigint) => `${amountText(n, asset.decimals)} ${asset.symbol}`,
    term = position.maturity - position.openedAt,
    elapsed =
      timestamp > position.openedAt ? timestamp - position.openedAt : 1n,
    // YieldMath.accruedRepayYield: ceil(fullTermYield * max(1, elapsed) / term).
    accrued = mature
      ? position.fullTermYieldAsset
      : (position.fullTermYieldAsset * elapsed + term - 1n) / term,
    remaining = position.maturity - timestamp;
  return (
    <PositionCardLayout
      network={network}
      tick={tick}
      asset={asset}
      quote={quote}
      metrics={
        <>
          <Metric label="Rented Asset">{a(position.assetAmount)}</Metric>
          <Metric label="Locked Quote">
            {amountText(position.quotePrincipal, quote.decimals)} {quote.symbol}
          </Metric>
          <Metric label="Accrued Yield (estimated)">{a(accrued)}</Metric>
          <Metric label="Maturity">
            {mature
              ? "Matured"
              : remaining >= 86400n
                ? `${remaining / 86400n}d ${(remaining % 86400n) / 3600n}h remaining`
                : remaining >= 3600n
                  ? `${remaining / 3600n}h ${(remaining % 3600n) / 60n}m remaining`
                  : `${(remaining + 59n) / 60n}m remaining`}
          </Metric>
        </>
      }
      actions={
        <TransactionFlow
          key={`${positionId}/${mature}`}
          network={network}
          label={mature ? "Preview Close" : "Preview Repay"}
          asset={asset}
          quote={quote}
          prepare={async () =>
            mature
              ? { kind: "close", positionId }
              : {
                  kind: "repay",
                  positionId,
                  maxYieldAsset: position.fullTermYieldAsset,
                }
          }
        />
      }
    >
      <Metric label="Full-term Yield">{a(position.fullTermYieldAsset)}</Metric>
      <Metric label="Opened">{timestampText(position.openedAt)}</Metric>
      <Metric label="Exact maturity">{timestampText(position.maturity)}</Metric>
      <Metric label="Position ID">{positionId.toString()}</Metric>
    </PositionCardLayout>
  );
}
