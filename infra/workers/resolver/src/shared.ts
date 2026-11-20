import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  type Address,
  type Hex,
} from "viem";
import { SwapError } from "@yld-cx/sdk/uniswap";
export interface Env {
  CHAINS: DurableObjectNamespace;
  RESOLVER_ENABLED?: string;
  DRY_RUN?: string;
  NETWORKS?: string;
  MARKETS_API?: string;
  RPC_URLS?: string;
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

export function errorDetails(e: unknown, env: Env) {
  const secrets = [
    env.RESOLVER_SIGNING_KEY,
    env.RESOLVER_SIGNING_KEY?.slice(2),
    env.UNISWAP_API_KEY,
  ]
    .filter((secret): secret is string => !!secret)
    .flatMap((secret) => [secret, encodeURIComponent(secret)]);
  const message = (error: unknown) => {
    if (!(error instanceof Error)) return undefined;
    let text =
      error instanceof BaseError
        ? `${error.shortMessage} ${error.details ?? ""}`.trim()
        : error.message;
    text = text
      .replace(/\\\//g, "/")
      .replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+/gi, "[URL REDACTED]");
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(
        /\b(?:authorization|proxy-authorization|(?:x[-_])?api[-_ ]?key|private[-_ ]?key|password|secret|token)["']?\s*[:=]\s*[^\r\n]*/gi,
        "[CREDENTIAL REDACTED]",
      )
      .replace(/\b(?:Bearer|Basic)\s+[^\s,"'}]+/gi, "[AUTH REDACTED]")
      .replace(/\b(?:0x)?[a-f\d]{64,}\b/gi, "[HEX REDACTED]")
      .slice(0, 1000);
  };
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
  return {
    error: errorKind(e),
    message: message(e),
    cause:
      cause instanceof Error
        ? { name: errorKind(cause), message: message(cause) }
        : undefined,
    status:
      e instanceof HttpRequestError || e instanceof SwapError
        ? e.status
        : cause instanceof HttpRequestError || cause instanceof SwapError
          ? cause.status
          : undefined,
    revert:
      e instanceof ContractFunctionRevertedError
        ? e.data?.errorName
        : cause instanceof ContractFunctionRevertedError
          ? cause.data?.errorName
          : undefined,
  };
}
