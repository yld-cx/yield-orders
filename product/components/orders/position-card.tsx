"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "wagmi";
import type {
  ProviderPosition,
  TickState,
  UsePosition,
  Token,
} from "@yld-cx/sdk";
import {
  getNetwork,
  humanPrice,
  explainError,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { canonicalPair, displayTokens } from "@yld-cx/sdk/registry";
import { getSdk } from "@/lib/rpc";
import { useToken } from "@/hooks/use-market";
import { amountText, timestampText } from "@/lib/utils";
import { Metric, Message } from "@/components/forms/financial-fields";
import LoadingScreen from "@/components/layout/loading-screen";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Field, FieldLabel } from "@yld-cx/ui/components/ui/field";
import { Checkbox } from "@yld-cx/ui/components/ui/checkbox";
import { Progress } from "@yld-cx/ui/components/ui/progress";
import { Button } from "@yld-cx/ui/components/ui/button";
function OrderHeader({
  network,
  tick,
  asset,
  quote,
}: {
  network: NetworkSlug;
  tick: TickState;
  asset: Token;
  quote: Token;
}) {
  const pair = canonicalPair(
      getNetwork(network).id,
      tick.asset,
      tick.quote,
    ).join(":"),
    natural = displayTokens({ token0: asset, token1: quote });
  return (
    <>
      <div className="flex items-center justify-between gap-3 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-semibold">
        <Link href={`/market/${network}/${pair}`}>
          <h3>
            {asset.symbol} / {quote.symbol} ↗
          </h3>
        </Link>
        <Badge>
          {tick.durationDays.toString()}D · {getNetwork(network).name}
        </Badge>
      </div>
      <p
        className={
          natural[0].address === asset.address ? "text-ask" : "text-bid"
        }
      >
        {natural[0].address === asset.address ? "Ask" : "Bid"} ·{" "}
        {humanPrice(tick.priceX128, asset.decimals, quote.decimals)}{" "}
        {quote.symbol} per {asset.symbol}
      </p>
      <details className="my-3 space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
        <summary>Token identities</summary>
        <code>{asset.address}</code>
        <code>{quote.address}</code>
        {(!asset.listed || !quote.listed) && (
          <p className="text-primary">Unlisted token — verify the address.</p>
        )}
      </details>
    </>
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
  const [percent, setPercent] = useState(100),
    [unrestricted, setUnrestricted] = useState(false);
  if (assetQuery.isError || quoteQuery.isError)
    return (
      <Message error>
        {explainError(assetQuery.error ?? quoteQuery.error)}
      </Message>
    );
  if (!assetQuery.data || !quoteQuery.data)
    return (
      <Card className="min-w-0">
        <CardContent className="space-y-4">
          <LoadingScreen className="min-h-64" label="Loading position…" />
        </CardContent>
      </Card>
    );
  const asset = assetQuery.data,
    quote = quoteQuery.data,
    a = (n: bigint) => `${amountText(n, asset.decimals)} ${asset.symbol}`,
    q = (n: bigint) => `${amountText(n, quote.decimals)} ${quote.symbol}`;
  const totalYield =
      position.outstandingActiveYieldAsset + position.outstandingExitYieldAsset,
    collectibleYield =
      position.claimableActiveYieldAsset + position.claimableExitYieldAsset;
  return (
    <Card className="min-w-0 [&_h4]:font-medium">
      <CardContent className="space-y-4">
        <OrderHeader
          network={network}
          tick={tick}
          asset={asset}
          quote={quote}
        />
        <h4>Remaining liquidity</h4>
        <Metric label="Remaining liquidity">
          {a(position.activePrincipal)}
        </Metric>
        <Metric label="Available">{a(position.activeAvailable)}</Metric>
        <Metric label="In Use">{a(position.activeWorking)}</Metric>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Withdraw percentage"
        >
          {[25, 50, 75, 100].map((p) => (
            <Button
              variant={percent === p ? "secondary" : "outline"}
              size="sm"
              key={p}
              aria-pressed={percent === p}
              onClick={() => setPercent(p)}
            >
              {p === 100 ? "Max" : `${p}%`}
            </Button>
          ))}
        </div>
        <Field className="my-4" orientation="horizontal">
          <Checkbox
            id={`withdraw-unrestricted-${tickId}`}
            checked={unrestricted}
            onCheckedChange={setUnrestricted}
          />
          <FieldLabel
            htmlFor={`withdraw-unrestricted-${tickId}`}
            className="font-normal leading-normal"
          >
            Allow any immediate principal, including zero
          </FieldLabel>
        </Field>
        <TransactionFlow
          key={`withdraw/${tickId}/${percent}/${unrestricted}`}
          network={network}
          label={`Withdraw ${percent === 100 ? "Max" : `${percent}%`}`}
          asset={asset}
          quote={quote}
          disabled={position.activePrincipal === 0n}
          prepare={async () => {
            const sdk = getSdk(network),
              current = await sdk.getEarnPosition(account.address!, tickId),
              amount = (current.activePrincipal * BigInt(percent)) / 100n;
            if (amount === 0n)
              throw new Error("No transferable principal for this percentage");
            const deadline =
              (await sdk.publicClient.getBlock()).timestamp + 300n;
            const initial = {
              kind: "withdraw" as const,
              tickId,
              amount,
              minImmediateAssetOut: 0n,
              deadline,
            };
            const preview = await sdk.preview(initial, account.address!);
            return {
              ...initial,
              minImmediateAssetOut: unrestricted
                ? 0n
                : (preview.withdraw!.availableAssetOut * 9950n) / 10000n,
            };
          }}
        />
        <h4>Resolving</h4>
        <Metric label="In Use principal">
          {a(position.resolvingPrincipal)}
        </Metric>
        <h4>Claimable</h4>
        <Metric label="Exit Asset">{a(position.claimableExitAsset)}</Metric>
        <Metric label="Claimable now">{a(collectibleYield)}</Metric>
        <Metric label="Quote proceeds">
          {q(position.claimableActiveQuote + position.claimableExitQuote)}
        </Metric>
        <Metric label="Earned Yield">{a(totalYield)}</Metric>
        <Metric label="Vesting">{a(totalYield - collectibleYield)}</Metric>
        <Metric label="Fully collectible at">
          {timestampText(position.timestamp + position.vestingDurationSeconds)}
        </Metric>
        <Progress
          aria-label="Yield vesting progress"
          max={Number(position.vestingDurationSeconds) || 1}
          value={Number(position.vestingElapsedSeconds)}
        />
        <TransactionFlow
          network={network}
          label="Collect"
          asset={asset}
          quote={quote}
          prepare={async () => ({ kind: "collect", tickId })}
        />
        <details className="my-3 space-y-2 text-xs text-muted-foreground [&_code]:block [&_code]:break-all">
          <summary>More actions</summary>
          <TransactionFlow
            network={network}
            label="Review Settle"
            asset={asset}
            quote={quote}
            prepare={async () => ({ kind: "settle", tickId })}
          />
        </details>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {position.activePrincipal > 0n
            ? "Collect proceeds or withdraw remaining liquidity."
            : "Still resolving · Collect already settled assets."}
        </p>
      </CardContent>
    </Card>
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
    account = useConnection(),
    mature = timestamp >= position.maturity;
  const due = useQuery({
    queryKey: [
      "quote",
      network,
      "repay",
      positionId.toString(),
      account.address,
    ],
    enabled: !mature && !!account.address,
    queryFn: () =>
      getSdk(network).preview(
        {
          kind: "repay",
          positionId,
          maxYieldAsset: position.fullTermYieldAsset,
        },
        account.address!,
      ),
    refetchInterval: 15000,
    retry: false,
  });
  if (assetQuery.isError || quoteQuery.isError)
    return (
      <Message error>
        {explainError(assetQuery.error ?? quoteQuery.error)}
      </Message>
    );
  if (!assetQuery.data || !quoteQuery.data)
    return (
      <Card className="min-w-0">
        <CardContent className="space-y-4">
          <LoadingScreen className="min-h-64" label="Loading position…" />
        </CardContent>
      </Card>
    );
  const asset = assetQuery.data,
    quote = quoteQuery.data,
    a = (n: bigint) => `${amountText(n, asset.decimals)} ${asset.symbol}`;
  return (
    <Card className="min-w-0 [&_h4]:font-medium">
      <CardContent className="space-y-4">
        <OrderHeader
          network={network}
          tick={tick}
          asset={asset}
          quote={quote}
        />
        <Badge variant="secondary" data-intent={mature ? "term" : "rent"}>
          {mature ? "Matured · Closeable" : "Active Use"}
        </Badge>
        <Metric label="Asset received">{a(position.assetAmount)}</Metric>
        <Metric label="Quote locked">
          {amountText(position.quotePrincipal, quote.decimals)} {quote.symbol}
        </Metric>
        <Metric label="Current Yield due">
          {mature
            ? "0 · Close"
            : due.data?.repay
              ? a(due.data.repay.grossYieldAsset)
              : due.isFetching
                ? "Simulating…"
                : "Requires approval and preview"}
        </Metric>
        <Metric label="Max full-term Yield">
          {a(position.fullTermYieldAsset)}
        </Metric>
        <Metric label="Opened">{timestampText(position.openedAt)}</Metric>
        <Metric label="Maturity">{timestampText(position.maturity)}</Metric>
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
        {due.isError && !mature && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Live Repay simulation requires sufficient Asset and allowance.
            Preview Repay handles the approval and displays the actual Yield
            due. {explainError(due.error)}
          </p>
        )}
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Return Asset + accrued Yield to unlock Quote.
        </p>
      </CardContent>
    </Card>
  );
}
