import type { Address, Hex } from "viem";
export interface WalletCall {
  to: Address;
  data: Hex;
}
export type BatchSender = (calls: readonly WalletCall[]) => Promise<string>;
export function supportsAtomic(
  capabilities:
    | { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }
    | undefined,
) {
  return capabilities?.atomic
    ? capabilities.atomic.status === "supported"
    : capabilities?.atomicBatch?.supported === true;
}
