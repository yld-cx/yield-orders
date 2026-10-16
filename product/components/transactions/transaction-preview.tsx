import {
  humanPrice,
  marginalYieldPercent,
  type Preview,
} from "@yld-cx/sdk/ethereum";
import type { Token } from "@yld-cx/sdk";
import { Metric } from "@/components/forms/financial-fields";
import { amountText, timestampText, shortAddress } from "@/lib/utils";
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
  return (
    <div className="space-y-3 border-t pt-3 [&_p]:text-sm [&_p]:text-muted-foreground">
      <Metric label="Network">{preview.chainId}</Metric>
      <Metric label="Account">{shortAddress(preview.account)}</Metric>
      {preview.tick && ["supply", "use", "swap"].includes(action.kind) && (
        <>
          <Metric label="Price">
            {humanPrice(
              preview.tick.priceX128,
              asset?.decimals ?? 0,
              quote?.decimals ?? 0,
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
          <p>Creates an empty market. Supply liquidity separately.</p>
        </>
      )}
      {action.kind === "createTick" && (
        <>
          <Metric label="Price tick">{action.priceTick}</Metric>
          <Metric label="Duration">{action.durationDays}D</Metric>
          <p>Creates this price level. Supply liquidity after confirmation.</p>
        </>
      )}
      {action.kind === "supply" && (
        <>
          <Metric label="You supply">{a(action.amount)}</Metric>
          <Metric label="Current Yield">
            {preview.tick
              ? `${marginalYieldPercent(preview.tick) ?? "—"}% / term`
              : "—"}
          </Metric>
          <Metric label="Your Active liquidity after">
            {a(preview.provider!.activePrincipal)}
          </Metric>
          <Metric label="Market Available after">
            {a(preview.tick!.availableSupply)}
          </Metric>
          <Metric label="Market In Use after">
            {a(preview.tick!.activeWorking)}
          </Metric>
          <p>
            Yield when used and returned. Supply restarts vesting of all your
            outstanding Yield.
          </p>
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
          <Metric label="Yield paid now">0</Metric>
          <Metric label="Close fee at maturity">
            {q(preview.position.closeFee)}
          </Metric>
          <Metric label="Maturity">
            {timestampText(preview.position.maturity)}
          </Metric>
          <Metric label="Maximum accepted Yield">
            {action.kind === "use" ? a(action.maxFullTermYieldAsset) : "—"}
          </Metric>
          <p>
            Return earlier, pay less Yield. Close settles locked Quote at
            maturity.
          </p>
        </>
      )}
      {preview.swap && (
        <>
          <Metric label="Receive Asset">{a(preview.swap.assetAmount)}</Metric>
          <Metric label="Pay Quote">{q(preview.swap.quotePrincipal)}</Metric>
          <Metric label="Quote fee">{q(preview.swap.swapFee)}</Metric>
          <Metric label="Provider proceeds">
            {q(preview.swap.providerSwapProceeds)}
          </Metric>
          <Metric label="Maximum Quote payment">
            {action.kind === "swap" ? q(action.maxQuoteIn) : "—"}
          </Metric>
          <p>Immediate execution. No term, locked principal, or Asset Yield.</p>
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
          <p>
            In Use principal moves to Resolving. Unvested Yield attributable to
            this withdrawal becomes a protocol fee.
          </p>
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
          <p>
            Collect charges no protocol fee and restarts vesting of remaining
            Yield.
          </p>
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
          <p>
            Yield continues accruing until inclusion, within your cap. The
            resolved Use disappears from current Orders.
          </p>
        </>
      )}
      {preview.close && (
        <>
          <Metric label="Provider proceeds">
            {q(preview.close.providerSwapProceeds)}
          </Metric>
          <Metric label="Quote fee">{q(preview.close.closeFee)}</Metric>
          <Metric label="Asset Yield due">0</Metric>
          <p>
            Asset remains with the Use user. Locked Quote settles and the active
            Use is removed.
          </p>
        </>
      )}
      {action.kind === "settle" && (
        <p>
          Process expired market activity. This may settle one matured rental.
        </p>
      )}
      {"deadline" in action && (
        <Metric label="Execution deadline">
          {timestampText(action.deadline)}
        </Metric>
      )}
      <details className="text-xs text-muted-foreground">
        <summary>Transaction details</summary>
        <Metric label="Estimated gas units">{preview.gas.toString()}</Metric>
        <Metric label="Preview block">{preview.blockNumber.toString()}</Metric>
      </details>
    </div>
  );
}
