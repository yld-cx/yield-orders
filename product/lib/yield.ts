import { FORMAT_PRECISION, type TickState } from "@yld-cx/sdk";
import { marginalTermYieldRatio } from "@yld-cx/sdk/ethereum";

export type YieldMode = "apy" | "term";

export const DEFAULT_YIELD_MODE = {
  markets: "apy",
  provide: "apy",
  rent: "term",
} as const satisfies Record<string, YieldMode>;

export const APY_DESCRIPTION =
  "APY is indicative and assumes reinvestment at the same rate.";

/** Fractional return from raw amounts; no token decimals or display rounding. */
export function termYieldFromAmounts(
  yieldAmount: bigint,
  principal: bigint,
): number | undefined {
  if (yieldAmount < 0n || principal <= 0n) return undefined;
  const value = Number(yieldAmount) / Number(principal);
  return Number.isFinite(value) ? value : undefined;
}

export function marginalTermYield(
  tick: Pick<TickState, "availableSupply" | "activeWorking" | "durationDays">,
): number | undefined {
  const ratio = marginalTermYieldRatio(tick);
  return ratio ? termYieldFromAmounts(...ratio) : undefined;
}

/** (1 + termYield) ** (365 / termDays) - 1, stable for small returns. */
export function termYieldToApy(
  termYield: number,
  termDays: number,
): number | undefined {
  if (
    !Number.isFinite(termYield) ||
    termYield < 0 ||
    !Number.isFinite(termDays) ||
    termDays <= 0
  )
    return undefined;
  const apy = Math.expm1(Math.log1p(termYield) * (365 / termDays));
  return Number.isFinite(apy) ? apy : undefined;
}

const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: FORMAT_PRECISION.yieldPercent,
});

export function formatYieldPercent(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? percentFormatter.format(value)
    : "—";
}

export function yieldText(
  termYield: number | undefined,
  termDays: number,
  mode: YieldMode,
): string {
  return formatYieldPercent(
    mode === "apy" && termYield !== undefined
      ? termYieldToApy(termYield, termDays)
      : termYield,
  );
}

export function tickYieldText(
  tick: Pick<TickState, "availableSupply" | "activeWorking" | "durationDays">,
  mode: YieldMode,
): string {
  return yieldText(marginalTermYield(tick), Number(tick.durationDays), mode);
}
