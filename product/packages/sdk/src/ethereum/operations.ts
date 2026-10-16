import type { Address, Hex } from "viem";
import type { EconomicAction } from "../types/index.ts";
export interface WalletCall {
  to: Address;
  data: Hex;
}
export type BatchSender = (calls: readonly WalletCall[]) => Promise<string>;
export interface PendingOperation {
  account: Address;
  chainId: number;
  action: EconomicAction;
  phase: "approval-reset" | "approval" | "action" | "batch";
  identifier: "transaction" | "calls";
  id?: string;
  status: "submitted" | "pending" | "confirmed" | "reverted" | "unknown";
  approvalAmount?: bigint;
  approvalToken?: Address;
  blockNumber?: bigint;
}
const encode = (value: unknown) =>
  JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? { bigint: v.toString() } : v,
  );
const decode = (value: string) =>
  JSON.parse(value, (_, v) =>
    v &&
    typeof v === "object" &&
    Object.keys(v).length === 1 &&
    typeof v.bigint === "string"
      ? BigInt(v.bigint)
      : v,
  );
export class OperationStore {
  private readonly memory = new Map<string, PendingOperation>();
  constructor(
    private readonly scope: string,
    private readonly storage?: Storage,
  ) {}
  private key(account: Address) {
    return `yld/operation/v1/${this.scope}/${account.toLowerCase()}`;
  }
  private backend() {
    return (
      this.storage ??
      (typeof window !== "undefined" ? window.localStorage : undefined)
    );
  }
  get(account: Address): PendingOperation | undefined {
    const raw = this.backend()?.getItem(this.key(account));
    return raw ? decode(raw) : this.memory.get(this.key(account));
  }
  put(op: PendingOperation) {
    this.backend()?.setItem(this.key(op.account), encode(op));
    this.memory.set(this.key(op.account), op);
  }
  remove(account: Address) {
    this.backend()?.removeItem(this.key(account));
    this.memory.delete(this.key(account));
  }
}
export function supportsAtomic(
  capabilities:
    | { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }
    | undefined,
) {
  return capabilities?.atomic
    ? capabilities.atomic.status === "supported"
    : capabilities?.atomicBatch?.supported === true;
}
