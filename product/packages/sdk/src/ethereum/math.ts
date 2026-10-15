import { encodeAbiParameters, keccak256, type Address } from "viem";
import { canonicalPair } from "../registry/addresses.ts";
import type { Direction, TickIdentity, TickState } from "../types/index.ts";
import {
  DURATIONS,
  DISCOVERY_DEFAULTS,
  MAX_DISCOVERY_RADIUS,
  MIN_TICK,
  MAX_TICK,
  Q128,
  MAX_AMOUNT,
  FIXED_POINT_BITS,
  SQRT_RATIO_SHIFT,
  PRICE_RATIO_SHIFT,
  MAX_UINT256,
  MAX_DURATION_DAYS,
  MAX_DECIMAL_INPUT_LENGTH,
  YIELD_CURVE,
  FORMAT_PRECISION,
} from "../constants.ts";
import { TICK_MULTIPLIERS } from "./tick-constants.ts";
export { MIN_TICK, MAX_TICK, Q128, MAX_AMOUNT } from "../constants.ts";
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK)
    throw new Error("Price tick outside protocol bounds");
  const abs = Math.abs(tick);
  let ratio = Q128;
  for (let i = 0; i < TICK_MULTIPLIERS.length; i++)
    if ((abs & (1 << i)) !== 0)
      ratio = (ratio * TICK_MULTIPLIERS[i]) >> FIXED_POINT_BITS;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (
    (ratio >> SQRT_RATIO_SHIFT) +
    ((ratio & ((1n << SQRT_RATIO_SHIFT) - 1n)) === 0n ? 0n : 1n)
  );
}
export function priceAtTick(tick: number): bigint {
  const s = sqrtRatioAtTick(tick);
  return (s * s) >> PRICE_RATIO_SHIFT;
}
export function decimalFraction(value: string): readonly [bigint, bigint] {
  // Covers uint8 token decimals and prices across the full TickMath range.
  if (
    value.length > MAX_DECIMAL_INPUT_LENGTH ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  )
    throw new Error("Enter a plain positive decimal");
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}
export function tokenAmount(value: string, decimals: number): bigint {
  const [n, d] = decimalFraction(value);
  const scaled = n * 10n ** BigInt(decimals);
  if (scaled % d !== 0n)
    throw new Error(`This token supports ${decimals} decimal places`);
  const result = scaled / d;
  if (result <= 0n || result > MAX_AMOUNT)
    throw new Error("Amount outside protocol bounds");
  return result;
}
export function formatRatio(
  n: bigint,
  d: bigint,
  precision: number = FORMAT_PRECISION.ratio,
): string {
  if (d <= 0n) throw new Error("Invalid ratio");
  const whole = n / d;
  const f = (((n % d) * 10n ** BigInt(precision)) / d)
    .toString()
    .padStart(precision, "0")
    .replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole.toString();
}
export function marginalYieldPercent(
  tick: Pick<TickState, "availableSupply" | "activeWorking" | "durationDays">,
): string | undefined {
  const { availableSupply, activeWorking, durationDays } = tick;
  if (availableSupply <= 0n || activeWorking < 0n || durationDays <= 0n)
    return undefined;
  const principalCubed =
    (availableSupply + activeWorking) ** YIELD_CURVE.exponent;
  return formatRatio(
    durationDays *
      (principalCubed +
        YIELD_CURVE.weight * activeWorking ** YIELD_CURVE.exponent),
    YIELD_CURVE.divisor * principalCubed,
    FORMAT_PRECISION.yieldPercent,
  );
}
export function humanPrice(
  priceX128: bigint,
  assetDecimals: number,
  quoteDecimals: number,
  inverted = false,
): string {
  const rawNumerator = priceX128 * 10n ** BigInt(assetDecimals);
  const rawDenominator = Q128 * 10n ** BigInt(quoteDecimals);
  const [numerator, denominator] = inverted
    ? [rawDenominator, rawNumerator]
    : [rawNumerator, rawDenominator];
  // Keep the configured significant digits for readability without displaying tiny positive prices as zero.
  const precision =
    numerator >= denominator
      ? Math.max(
          0,
          FORMAT_PRECISION.humanPrice -
            (numerator / denominator).toString().length,
        )
      : Math.max(
          FORMAT_PRECISION.humanPrice,
          denominator.toString().length -
            numerator.toString().length +
            FORMAT_PRECISION.humanPrice,
        );
  return formatRatio(numerator, denominator, precision);
}
export function snappedPrice(
  value: string,
  assetDecimals: number,
  quoteDecimals: number,
  stepTicks: number,
  inverted = false,
): { priceTick: number; priceX128: bigint; price: string } {
  if (!Number.isSafeInteger(stepTicks) || stepTicks <= 0)
    throw new Error("Invalid price grid");
  const fraction = decimalFraction(value);
  if (fraction[0] === 0n) throw new Error("Price must be positive");
  const [n, d] = inverted ? [fraction[1], fraction[0]] : fraction;
  const numerator = n * 10n ** BigInt(quoteDecimals) * Q128,
    denominator = d * 10n ** BigInt(assetDecimals);
  const min = Math.ceil(MIN_TICK / stepTicks),
    max = Math.floor(MAX_TICK / stepTicks);
  if (
    numerator < priceAtTick(min * stepTicks) * denominator ||
    numerator > priceAtTick(max * stepTicks) * denominator
  )
    throw new Error("Price outside supported grid");
  let lo = min,
    hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (priceAtTick(mid * stepTicks) * denominator <= numerator) lo = mid;
    else hi = mid - 1;
  }
  const lower = lo * stepTicks,
    upper = Math.min(max * stepTicks, lower + stepTicks);
  // Nearest executable price. Equal distances select the higher price.
  const tick =
    numerator - priceAtTick(lower) * denominator <
    priceAtTick(upper) * denominator - numerator
      ? lower
      : upper;
  const priceX128 = priceAtTick(tick);
  return {
    priceTick: tick,
    priceX128,
    price: humanPrice(priceX128, assetDecimals, quoteDecimals),
  };
}
export function pairIdFor(a: Address, b: Address): bigint {
  const [token0, token1] = canonicalPair("eip155:1", a, b) as readonly [
    Address,
    Address,
  ];
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }],
        [token0, token1],
      ),
    ),
  );
}
export function tickIdFor(
  pairId: bigint,
  direction: Direction,
  priceTick: number,
  durationDays: number | bigint,
): bigint {
  if (direction !== 0 && direction !== 1) throw new Error("Invalid direction");
  if (
    !Number.isInteger(priceTick) ||
    priceTick < MIN_TICK ||
    priceTick > MAX_TICK
  )
    throw new Error("Invalid price tick");
  const days = BigInt(durationDays);
  if (days <= 0n || days > MAX_DURATION_DAYS)
    throw new Error("Invalid duration");
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [
          { type: "uint256" },
          { type: "uint8" },
          { type: "int32" },
          { type: "uint64" },
        ],
        [pairId, direction, priceTick, days],
      ),
    ),
  );
}
export function candidateLevels(
  baseTick: number = DISCOVERY_DEFAULTS.baseTick,
  stepTicks: number = DISCOVERY_DEFAULTS.stepTicks,
  radius: number = DISCOVERY_DEFAULTS.radius,
): number[] {
  if (
    !Number.isSafeInteger(stepTicks) ||
    stepTicks <= 0 ||
    !Number.isInteger(baseTick) ||
    baseTick % stepTicks !== 0 ||
    baseTick < MIN_TICK ||
    baseTick > MAX_TICK
  )
    throw new Error("Invalid Tick grid");
  if (!Number.isInteger(radius) || radius < 0 || radius > MAX_DISCOVERY_RADIUS)
    throw new Error(
      `Discovery radius must be between 0 and ${MAX_DISCOVERY_RADIUS}`,
    );
  const result: number[] = [];
  for (let r = 0; r <= radius; r++)
    for (const t of r === 0
      ? [baseTick]
      : [baseTick - r * stepTicks, baseTick + r * stepTicks])
      if (t >= MIN_TICK && t <= MAX_TICK) result.push(t);
  return result;
}
export function tickCandidates(
  pairId: bigint,
  baseTick: number = DISCOVERY_DEFAULTS.baseTick,
  stepTicks: number = DISCOVERY_DEFAULTS.stepTicks,
  radius: number = DISCOVERY_DEFAULTS.radius,
): TickIdentity[] {
  const out: TickIdentity[] = [];
  for (const canonicalTick of candidateLevels(baseTick, stepTicks, radius))
    for (const direction of [0, 1] as const)
      for (const durationDays of DURATIONS) {
        const priceTick = direction === 0 ? canonicalTick : -canonicalTick;
        out.push({
          id: tickIdFor(pairId, direction, priceTick, durationDays),
          pairId,
          direction,
          priceTick,
          durationDays,
        });
      }
  return out;
}
