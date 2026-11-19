import type { Address, Hex } from "viem";
import { SwapError } from "@yld-cx/sdk/uniswap";
export interface Env {
  CHAINS: DurableObjectNamespace;
  RESOLVER_ENABLED?: string;
  DRY_RUN?: string;
  NETWORKS?: string;
  MARKETS_API_ORIGIN?: string;
  RPC_URLS?: string;
  BENEFICIARY_ADDRESS?: string;
  BOT_ADDRESS?: string;
  RESOLVER_SIGNING_KEY?: Hex;
  UNISWAP_API_KEY?: string;
  // Explicit per-chain token compatibility/cap configuration, never a protocol allowlist.
  TOKEN_LIMITS?: string;
  BRIDGE_TOKENS?: string;
  MAX_MARKETS_PER_RUN?: string;
  MAX_CANDIDATES_PER_MARKET?: string;
  MAX_BATCH?: string;
  MAX_RUN_DURATION_MS?: string;
  MAX_QUOTE_REQUESTS?: string;
  MAX_DISCOVERY_RADIUS?: string;
  MAX_REFERENCE_PRICE_IMPACT_PERCENT?: string;
  MIN_EXPECTED_NET_USD?: string;
  MAX_SLIPPAGE_PERCENT?: string;
}
export interface Execution {
  tickId: bigint;
  amount: bigint;
  flashToken: Address;
  flashAmount: bigint;
  deadline: bigint;
  preSwapData: Hex;
  postSwapData: Hex;
}
export interface Candidate {
  order: Execution;
  mode: number;
  surplusToken: Address;
  surplus: bigint;
  quotedAt: number;
  routeIds: string[];
}
export function setting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new Error("Invalid worker setting");
  return n;
}
export function log(value: Record<string, unknown>) {
  console.log(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
export function errorKind(e: unknown) {
  return e instanceof SwapError
    ? `Uniswap${e.status}`
    : e instanceof Error
      ? e.name
      : "UnknownError";
}
