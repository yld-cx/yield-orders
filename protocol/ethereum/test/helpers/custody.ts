import type { Address } from "viem";

// Live surplus, read independently. Negative values describe an insolvent mock.
export async function surplus(
  market: { address: Address; read: { tokenLiability: (args: readonly [Address]) => Promise<bigint> } },
  token: { address: Address; read: object },
): Promise<bigint> {
  const read = token.read as { balanceOf: (args: readonly [Address]) => Promise<bigint> };
  return (await read.balanceOf([market.address])) - (await market.read.tokenLiability([token.address]));
}
