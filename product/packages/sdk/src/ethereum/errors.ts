import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hex,
} from "viem";
import { protocolAbi } from "./abi.ts";
const messages: Record<string, string> = {
  NotFound: "This market, Tick, or active position no longer exists.",
  AlreadyExists: "This market or Tick already exists. Refresh and review.",
  InsufficientLiquidity: "Liquidity changed. Reduce the amount or refresh.",
  Slippage: "The execution limits were exceeded. Review an updated preview.",
  Expired: "The transaction deadline expired. Review a new preview.",
  Cooldown:
    "Supply or Collect restarts your timestamp. Wait for blockchain time to advance before Withdraw.",
  InvalidState:
    "Refresh the position. Repay is available before maturity; Close is available at or after maturity.",
  Unauthorized: "Use the position owner’s wallet to Repay.",
  UnsupportedToken:
    "The token does not support the exact transfers required by this protocol.",
  InvalidInput: "Check the amount, duration, and price bounds.",
};
export function protocolErrorName(error: unknown): string | undefined {
  if (error instanceof BaseError) {
    const revert = error.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    );
    if (revert instanceof ContractFunctionRevertedError)
      return revert.data?.errorName;
  }
  return undefined;
}
export function decodeProtocolError(data: Hex): string {
  try {
    const name = decodeErrorResult({ abi: protocolAbi, data }).errorName;
    return messages[name] ?? name;
  } catch {
    return "The contract rejected this transaction.";
  }
}
export function explainError(error: unknown): string {
  const name = protocolErrorName(error);
  if (name && messages[name]) return messages[name];
  if (error instanceof BaseError) {
    if (
      error.walk(
        (e) =>
          typeof e === "object" && e !== null && "code" in e && e.code === 4001,
      ) !== null ||
      /rejected|denied/i.test(error.message)
    )
      return "Wallet request declined. You can try again.";
    return error.shortMessage;
  }
  return error instanceof Error
    ? error.message
    : "The request failed. Please try again.";
}
