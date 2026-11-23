import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  type Address,
  type Hex,
} from "viem";
import { SwapError } from "@yld-cx/sdk/uniswap";
import type { RpcEnv } from "../../rpc.ts";

export interface Env extends RpcEnv {
  DB: D1Database;
  RESOLVER_ENABLED?: string;
  DRY_RUN?: string;
  NETWORKS?: string;
  RESOLVER_SIGNING_KEY?: Hex;
  UNISWAP_API_KEY?: string;
  MIN_EXPECTED_NET_USD?: string;
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

export function errorDetails(e: unknown) {
  // RPC providers can echo credentials in error messages and nested error data.
  const cause =
    e instanceof BaseError
      ? (e.walk(
          (error) =>
            error !== e &&
            (error instanceof HttpRequestError ||
              error instanceof TimeoutError ||
              error instanceof ContractFunctionRevertedError),
        ) ?? e.cause)
      : e instanceof Error
        ? e.cause
        : undefined;
  const known = (error: unknown) => ({
    error: errorKind(error),
    status:
      error instanceof HttpRequestError || error instanceof SwapError
        ? error.status
        : undefined,
    revert:
      error instanceof ContractFunctionRevertedError
        ? error.data?.errorName
        : undefined,
  });
  const outer = known(e);
  const inner = known(cause);
  return {
    error: outer.error,
    cause: cause instanceof Error ? inner.error : undefined,
    status: outer.status ?? inner.status,
    revert: outer.revert ?? inner.revert,
  };
}
