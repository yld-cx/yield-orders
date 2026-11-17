import resolverAbi from "../../../../protocol/ethereum/abi/YieldResolver.json" with { type: "json" };
import type { Abi, Address, PublicClient } from "viem";
import type { Candidate } from "./shared.ts";
export const abi = resolverAbi as Abi;
export function expectedBitmap(length: number) {
  return (1n << BigInt(length)) - 1n;
}
export async function simulate(
  client: PublicClient,
  resolver: Address,
  account: Address,
  to: Address,
  candidates: Candidate[],
) {
  if (
    !candidates.length ||
    candidates.some(
      (c) =>
        Date.now() - c.quotedAt > 40000 ||
        c.order.deadline * 1000n <= BigInt(Date.now() + 15000),
    )
  )
    throw new Error("StaleBatch");
  const args = [candidates.map((c) => c.order), to] as const;
  // Stay below the EVM transaction gas cap; every order still has its own
  // bounded self-call inside the resolver.
  const ceiling = 16_000_000n;
  const result = await client.simulateContract({
    address: resolver,
    abi,
    functionName: "execute",
    args,
    account,
    gas: ceiling,
  });
  const bitmap = result.result as bigint;
  if (bitmap !== expectedBitmap(candidates.length))
    throw new Error("PartialSimulation");
  const estimate = await client.estimateContractGas({
    address: resolver,
    abi,
    functionName: "execute",
    args,
    account,
    gas: ceiling,
  });
  if (estimate <= 0n) throw new Error("InvalidGasEstimate");
  let gas = (estimate * 120n + 99n) / 100n;
  if (gas > ceiling) gas = ceiling;
  // eth_estimateGas only requires a successful transaction. A batch that skips
  // later orders for low gas also succeeds, so verify the intended bitmap at
  // the actual submission limit. Each simulation stays an independent eth_call.
  while (candidates.length > 1 && gas < ceiling) {
    const check = await client.simulateContract({
      address: resolver,
      abi,
      functionName: "execute",
      args,
      account,
      gas,
    });
    if (check.result === bitmap) break;
    gas = gas * 2n > ceiling ? ceiling : gas * 2n;
  }
  return { args, bitmap, gas };
}
