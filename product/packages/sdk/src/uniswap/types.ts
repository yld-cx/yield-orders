import { isAddress, zeroAddress, type Address, type Hex } from "viem";

export type SwapChain = 1 | 8453 | 4663;
export type SwapMode = "wallet-router" | "resolver-router";
export interface SwapInput {
  chainId: SwapChain;
  mode: SwapMode;
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
  swapper: Address;
  slippage: number;
  deadline?: number;
}
export interface SwapTransaction {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
}
export interface SwapQuoteResult {
  chainId: SwapChain;
  mode: SwapMode;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  estimatedAmountOut: string;
  minimumAmountOut: string;
  routing: "CLASSIC";
  routeVersion: string;
  quotedAt: number;
  expiresAt: number;
  routeId: string;
  transaction: SwapTransaction;
  permitTransaction?: SwapTransaction;
}
/** Non-executable AMM quote for discovery and valuation. */
export interface SwapPriceResult {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  estimatedAmountOut: string;
  minimumAmountOut: string;
  quotedAt: number;
  priceImpact?: number;
  blockNumber?: string;
}
export class SwapError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "SwapError";
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SwapError("Invalid swap response", 502);
  return value as Record<string, unknown>;
}
export function address(value: unknown): Address {
  if (
    typeof value !== "string" ||
    !isAddress(value, { strict: false }) ||
    value.toLowerCase() === zeroAddress ||
    value.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  )
    throw new SwapError("An ERC-20 address is required");
  return value.toLowerCase() as Address;
}
export function rawAmount(value: unknown, allowZero = false): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,77})$/.test(value) ||
    BigInt(value) >= 2n ** 256n ||
    (!allowZero && BigInt(value) === 0n)
  )
    throw new SwapError("Invalid raw token amount");
  return value;
}
export function same(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
export function parseSwapInput(value: unknown, now = Date.now()): SwapInput {
  const v = record(value);
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "chainId",
          "mode",
          "tokenIn",
          "tokenOut",
          "amount",
          "swapper",
          "slippage",
          "deadline",
        ].includes(k),
    )
  )
    throw new SwapError("Unknown swap field");
  if (
    ![1, 8453, 4663].includes(v.chainId as number) ||
    !["wallet-router", "resolver-router"].includes(v.mode as string)
  )
    throw new SwapError("Unsupported swap mode or chain");
  const tokenIn = address(v.tokenIn),
    tokenOut = address(v.tokenOut);
  if (
    tokenIn === tokenOut ||
    typeof v.slippage !== "number" ||
    !Number.isFinite(v.slippage) ||
    v.slippage <= 0 ||
    v.slippage > 1
  )
    throw new SwapError("Invalid tokens or slippage (maximum 1%)");
  if (
    v.deadline !== undefined &&
    (!Number.isSafeInteger(v.deadline) ||
      Number(v.deadline) < now / 1000 + 30 ||
      Number(v.deadline) > now / 1000 + 1800)
  )
    throw new SwapError("Invalid swap deadline");
  return {
    chainId: v.chainId as SwapChain,
    mode: v.mode as SwapMode,
    tokenIn,
    tokenOut,
    amount: rawAmount(v.amount),
    swapper: address(v.swapper),
    slippage: v.slippage,
    ...(v.deadline === undefined ? {} : { deadline: Number(v.deadline) }),
  };
}
