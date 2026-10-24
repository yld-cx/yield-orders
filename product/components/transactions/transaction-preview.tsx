import { getNetwork, humanPrice, type Preview } from "@yld-cx/sdk/ethereum";
import { Q128, type Token } from "@yld-cx/sdk";
import { Message, Metric } from "@/components/forms/financial-fields";
import { amountText, timestampText, shortAddress } from "@/lib/utils";
import { priceText } from "@/lib/market-values";
import {
  DEFAULT_YIELD_MODE,
  formatYieldPercent,
  termYieldFromAmounts,
  tickYieldText,
} from "@/lib/yield";
import { ApyLabel } from "@/components/forms/yield-display";
export function TransactionPreview({
  preview,
  asset,
  quote,
}: {
  preview: Preview;
  asset?: Token;
  quote?: Token;
}) {
  const a = (value: bigint) =>
    asset
      ? `${amountText(value, asset.decimals)} ${asset.symbol}`
      : `${value} raw Asset units`;
  const q = (value: bigint) =>
    quote
      ? `${amountText(value, quote.decimals)} ${quote.symbol}`
      : `${value} raw Quote units`;
  const { action } = preview;
  const estimatedSupplyQuote =
    action.kind === "supply" && preview.tick
      ? (action.amount * preview.tick.priceX128 + Q128 - 1n) / Q128
      : undefined;
  return (
    <div className="space-y-3 border-t pt-3 [&_p]:text-muted-foreground">
      {preview.tick && ["supply", "use", "swap"].includes(action.kind) && (
        <>
          <Metric label="Price">
            {priceText(
              humanPrice(
                preview.tick.priceX128,
                asset?.decimals ?? 0,
                quote?.decimals ?? 0,
              ),
            )}{" "}
            {quote?.symbol ?? "Quote"} / {asset?.symbol ?? "Asset"}
          </Metric>
          {action.kind !== "swap" && (
            <Metric label="Duration">
              {preview.tick.durationDays.toString()}D
            </Metric>
          )}
        </>
      )}
      {action.kind === "createPair" && (
        <>
          <Metric label="Token A">{shortAddress(action.tokenA)}</Metric>
          <Metric label="Token B">{shortAddress(action.tokenB)}</Metric>
          <Message info className="text-xs">
            Creates new market for the token pair.
          </Message>
        </>
      )}
      {action.kind === "createTick" && (
        <>
          <Metric label="Price tick">{action.priceTick}</Metric>
          <Metric label="Duration">{action.durationDays}D</Metric>
          <Message info className="text-xs">
            Creates the price level. Supply liquidity after confirmation.
          </Message>
        </>
      )}
      {action.kind === "supply" && (
        <>
          <Metric label="You supply">{a(action.amount)}</Metric>
          <Metric label="Estimated Quote">
            {estimatedSupplyQuote === undefined ? "—" : q(estimatedSupplyQuote)}
          </Metric>
          <Metric label={<ApyLabel>Estimated APY</ApyLabel>}>
            {preview.tick
              ? tickYieldText(preview.tick, DEFAULT_YIELD_MODE.provide)
              : "—"}
          </Metric>
          {preview.provider &&
            preview.provider.activePrincipal !== action.amount && (
              <Metric label="Your Active liquidity after">
                {a(preview.provider.activePrincipal)}
              </Metric>
            )}
          <Message info className="text-xs">
            Estimates depend on future Use and are shown before the 1% fee.
            {preview.provider &&
              (preview.provider.outstandingActiveYieldAsset > 0n ||
                preview.provider.outstandingExitYieldAsset > 0n) && (
                <p>Supply restarts vesting of uncollected Yield.</p>
              )}
          </Message>
        </>
      )}
      {preview.position && (
        <>
          <Metric label="Receive Asset">
            {a(preview.position.assetAmount)}
          </Metric>
          <Metric label="Lock Quote">
            {q(preview.position.quotePrincipal)}
          </Metric>
          <Metric label="Maximum term Yield">
            {a(preview.position.fullTermYieldAsset)}
          </Metric>
          <Metric label="Term Yield">
            {formatYieldPercent(
              termYieldFromAmounts(
                preview.position.fullTermYieldAsset,
                preview.position.assetAmount,
              ),
            )}
          </Metric>
          <Metric label="Term end">
            {timestampText(preview.position.maturity)}
          </Metric>
          <Message info className="text-xs">
            Repay {asset?.symbol ?? "Asset"} + Yield to unlock{" "}
            {quote?.symbol ?? "Quote"}, or it will be swapped at term end.
          </Message>
        </>
      )}
      {preview.swap && (
        <>
          <Metric label="Receive Asset">{a(preview.swap.assetAmount)}</Metric>
          <Metric label="Pay Quote">{q(preview.swap.quotePrincipal)}</Metric>
          <Metric label="Maximum Quote payment">
            {action.kind === "swap" ? q(action.maxQuoteIn) : "—"}
          </Metric>
          <Message info className="text-xs">
            Swaps are instant and final.
          </Message>
        </>
      )}
      {preview.withdraw && (
        <>
          <Metric label="Withdraw principal">
            {a(preview.withdraw.principalAmount)}
          </Metric>
          <Metric label="Receive principal now">
            {a(preview.withdraw.availableAssetOut)}
          </Metric>
          <Metric label="Move to Resolving">
            {a(preview.withdraw.workingToExit)}
          </Metric>
          <Metric label="Collectible Yield out">
            {a(preview.withdraw.yieldAssetOut)}
          </Metric>
          <Metric label="Unvested Yield forfeited">
            {a(preview.withdraw.unvestedYield)}
          </Metric>
          <Metric label="Minimum principal now">
            {action.kind === "withdraw" ? a(action.minImmediateAssetOut) : "—"}
          </Metric>
          <Message info className="text-xs">
            In-use liquidity moves to Resolving without unvested Yield.
          </Message>
        </>
      )}
      {preview.collect && (
        <>
          <Metric label="Asset received">
            {a(preview.collect.totalAssetOut)}
          </Metric>
          <Metric label="Quote received">
            {q(preview.collect.totalQuoteOut)}
          </Metric>
          <Metric label="Resolving after">
            {a(preview.collect.resolvingPrincipal)}
          </Metric>
          <Metric label="Yield outstanding after">
            {a(
              preview.collect.outstandingActiveYieldAsset +
                preview.collect.outstandingExitYieldAsset,
            )}
          </Metric>
          <Message info className="text-xs">
            Collect restarts vesting of remaining Yield.
          </Message>
        </>
      )}
      {preview.repay && (
        <>
          <Metric label="Return principal">
            {a(preview.repay.assetPrincipal)}
          </Metric>
          <Metric label="Current Yield due">
            {a(preview.repay.grossYieldAsset)}
          </Metric>
          <Metric label="Yield fee (included)">
            {a(preview.repay.yieldFeeAsset)}
          </Metric>
          <Metric label="Total Asset to return">
            {a(preview.repay.totalAssetIn)}
          </Metric>
          <Metric label="Unlock Quote">
            {q(preview.repay.quotePrincipalUnlocked)}
          </Metric>
          <Metric label="Maximum accepted Yield">
            {action.kind === "repay" ? a(action.maxYieldAsset) : "—"}
          </Metric>
          <Message info className="text-xs">
            Yield accrues until repayment.
          </Message>
        </>
      )}
      {preview.close && (
        <>
          <Metric label="Provider proceeds">
            {q(preview.close.providerSwapProceeds)}
          </Metric>
          <Metric label="Quote fee">{q(preview.close.closeFee)}</Metric>
          <Metric label="Asset Yield due">0</Metric>
          <Message info className="text-xs">
            Renter keeps Asset. Provider gets Quote.
          </Message>
        </>
      )}
      {action.kind === "settle" && (
        <Message info className="text-xs">
          Process matured positions.
        </Message>
      )}
      <details className="text-xs text-muted-foreground">
        <summary>Transaction details</summary>
        <Metric label="Network">
          {getNetwork(`eip155:${preview.chainId}`).name} · {preview.chainId}
        </Metric>
        <Metric label="Account">{shortAddress(preview.account)}</Metric>
        {"deadline" in action && (
          <Metric label="Execution deadline">
            {timestampText(action.deadline)}
          </Metric>
        )}
        {action.kind === "use" && (
          <Metric label="Maximum accepted Yield">
            {a(action.maxFullTermYieldAsset)}
          </Metric>
        )}
        <Metric label="Estimated gas units">{preview.gas.toString()}</Metric>
        <Metric label="Preview block">{preview.blockNumber.toString()}</Metric>
      </details>
    </div>
  );
}
