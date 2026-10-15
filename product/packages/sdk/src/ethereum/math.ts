import { encodeAbiParameters, keccak256, type Address } from "viem";
import { canonicalPair } from "../registry/addresses.ts";
import type { Direction, TickIdentity, TickState } from "../types/index.ts";
import { DURATIONS } from "../constants.ts";
import { TICK_MULTIPLIERS } from "./tick-constants.ts";
export const MIN_TICK = -887272,
  MAX_TICK = 887272,
  Q128 = 1n << 128n,
  MAX_AMOUNT = 10n ** 30n;
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK)
    throw new Error("Price tick outside protocol bounds");
  const abs = Math.abs(tick);
  let ratio = 1n << 128n;
  for (let i = 0; i < TICK_MULTIPLIERS.length; i++)
    if ((abs & (1 << i)) !== 0) ratio = (ratio * TICK_MULTIPLIERS[i]) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}
export function priceAtTick(tick: number): bigint {
  const s = sqrtRatioAtTick(tick);
  return (s * s) >> 64n;
}
export function decimalFraction(value: string): readonly [bigint, bigint] {
  // Covers uint8 token decimals and prices across the full TickMath range.
  if (value.length > 512 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
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
export function formatRatio(n: bigint, d: bigint, precision = 12): string {
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
  const principalCubed = (availableSupply + activeWorking) ** 3n;
  return formatRatio(
    durationDays * (principalCubed + 99n * activeWorking ** 3n),
    100n * principalCubed,
    4,
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
  // Keep 12 significant digits for readability without displaying tiny positive prices as zero.
  const precision =
    numerator >= denominator
      ? Math.max(0, 12 - (numerator / denominator).toString().length)
      : Math.max(
          12,
          denominator.toString().length - numerator.toString().length + 12,
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
  if (days <= 0n || days > 106751991167300n)
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
  baseTick = 0,
  stepTicks = 1000,
  radius = 8,
  startRadius = 0,
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
  if (
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > 128 ||
    !Number.isInteger(startRadius) ||
    startRadius < 0 ||
    startRadius > radius
  )
    throw new Error("Discovery radius must be between 0 and 128");
  const result: number[] = [];
  for (let r = startRadius; r <= radius; r++)
    for (const t of r === 0
      ? [baseTick]
      : [baseTick - r * stepTicks, baseTick + r * stepTicks])
      if (t >= MIN_TICK && t <= MAX_TICK) result.push(t);
  return result;
}
export function tickCandidates(
  pairId: bigint,
  baseTick = 0,
  stepTicks = 1000,
  radius = 8,
  startRadius = 0,
): TickIdentity[] {
  const out: TickIdentity[] = [];
  for (const canonicalTick of candidateLevels(
    baseTick,
    stepTicks,
    radius,
    startRadius,
  ))
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
