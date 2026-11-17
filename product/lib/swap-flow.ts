import { encodeFunctionData, erc20Abi, type PublicClient } from "viem";
import {
  same,
  PERMIT2,
  swapNetwork,
  permit2Abi,
  type SwapQuoteResult,
} from "@yld-cx/sdk/uniswap";

/** Plan exact onchain approvals from fresh RPC state, without approval APIs. */
export async function swapCalls(
  client: PublicClient,
  quote: SwapQuoteResult,
  owner: `0x${string}`,
  chainId: number,
  now = Date.now(),
) {
  if (
    quote.mode !== "wallet-router" ||
    quote.chainId !== chainId ||
    quote.expiresAt <= now ||
    !same(quote.transaction.to, swapNetwork(chainId)?.router ?? "") ||
    quote.transaction.chainId !== chainId ||
    BigInt(quote.transaction.value) !== 0n
  )
    throw new Error("Swap changed or expired. Request a fresh quote.");
  const amount = BigInt(quote.amountIn);
  if (amount <= 0n || amount >= 2n ** 160n)
    throw new Error("Invalid swap amount");
  const [balance, allowance, [permitted, expiration]] = await client.multicall({
    allowFailure: false,
    contracts: [
      {
        address: quote.tokenIn,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      },
      {
        address: quote.tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, PERMIT2],
      },
      {
        address: PERMIT2,
        abi: permit2Abi,
        functionName: "allowance",
        args: [owner, quote.tokenIn, quote.transaction.to],
      },
    ],
  });
  if (balance < amount) throw new Error("Check your available token balance");
  const calls: { to: `0x${string}`; data: `0x${string}`; value: bigint }[] = [];
  const approve = (value: bigint) => ({
    to: quote.tokenIn,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2, value],
    }),
    value: 0n,
  });
  if (allowance < amount) {
    // Reset insufficient nonzero allowances for zero-first ERC-20 compatibility.
    if (allowance > 0n) calls.push(approve(0n));
    calls.push(approve(amount));
  }
  if (permitted < amount || expiration < Math.ceil(quote.expiresAt / 1000)) {
    const permit = quote.permitTransaction;
    if (!permit)
      throw new Error("Permit2 allowance changed. Request a fresh quote.");
    if (
      !same(permit.to, PERMIT2) ||
      permit.chainId !== chainId ||
      BigInt(permit.value) !== 0n
    )
      throw new Error("Unsafe Permit2 authorization");
    calls.push({ to: permit.to, data: permit.data, value: 0n });
  }
  calls.push({
    to: quote.transaction.to,
    data: quote.transaction.data,
    value: 0n,
  });
  return calls;
}
export function atomicStatus(
  capabilities:
    | { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }
    | undefined,
) {
  if (capabilities?.atomic?.status === "ready") return "ready";
  if (
    capabilities?.atomic?.status === "supported" ||
    capabilities?.atomicBatch?.supported === true
  )
    return "supported";
  return "unsupported";
}

export function atomicRequestUnsupported(error: unknown) {
  const seen = new Set<unknown>();
  for (
    let current = error;
    current && typeof current === "object" && !seen.has(current);
  ) {
    seen.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if ([-32601, 4200, 5700, 5760].includes(Number(value.code))) return true;
    current = value.cause;
  }
  return false;
}
