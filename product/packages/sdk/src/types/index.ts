import type { Address, ContractFunctionReturnType, Hash } from "viem";
import type { protocolAbi } from "../ethereum/abi.ts";
import type { Duration } from "../constants.ts";
export { Duration } from "../constants.ts";
export type EvmNetwork = `eip155:${number}`;
export type SolanaNetwork = `solana:${string}`;
export type NetworkId = EvmNetwork | SolanaNetwork;
export type Direction = 0 | 1;
export const enum Category {
  BlueChip = "blue-chip",
  Stable = "stable",
  Meme = "meme",
  Defi = "defi",
  Token = "token",
  Stock = "stock",
  Rwa = "rwa",
}
export interface Token {
  network: NetworkId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string;
  priceUsd?: string;
  listed: boolean;
}
export interface Market {
  network: NetworkId;
  key: string;
  token0: Token;
  token1: Token;
  defaultDuration: Duration;
  stepTicks: number;
  baseTick: number;
  telegramPost?: string;
  tags?: Category[];
}
/** Configured identity only. Decimals and display metadata must be loaded separately. */
export type TokenReference = Pick<Token, "network" | "address">;
export type MarketConfiguration = Omit<
  Market,
  "token0" | "token1" | "baseTick"
> & {
  token0: TokenReference;
  token1: TokenReference;
  baseTick?: number;
};
export interface TickIdentity {
  id: bigint;
  pairId: bigint;
  direction: Direction;
  priceTick: number;
  durationDays: Duration;
}
export type TickState = ContractFunctionReturnType<
  typeof protocolAbi,
  "view",
  "getTick"
>;
export type ProviderPosition = ContractFunctionReturnType<
  typeof protocolAbi,
  "view",
  "getEarnPosition"
>;
export type UsePosition = ContractFunctionReturnType<
  typeof protocolAbi,
  "view",
  "getPosition"
>;
export interface Tick extends TickIdentity {
  state: TickState;
}
export interface MarketLiquidity {
  available: bigint;
  inUse: bigint;
  resolving: bigint;
}
export interface TransactionResult {
  hash: Hash;
  blockNumber: bigint;
  positionId?: bigint;
  tickId?: bigint;
  pairId?: bigint;
}
export type EconomicAction =
  | {
      kind: "supply";
      tickId: bigint;
      amount: bigint;
      referrer?: Address;
      /** Resolve and atomically initialize this identity when necessary. */
      initialize?: {
        tokenA: Address;
        tokenB: Address;
        direction: Direction;
        priceTick: number;
        durationDays: Duration;
      };
    }
  | {
      kind: "withdraw";
      tickId: bigint;
      amount: bigint;
      minImmediateAssetOut: bigint;
      deadline: bigint;
    }
  | { kind: "collect" | "settle"; tickId: bigint }
  | {
      kind: "use";
      tickId: bigint;
      amount: bigint;
      maxFullTermYieldAsset: bigint;
      deadline: bigint;
      referrer?: Address;
    }
  | {
      kind: "swap";
      tickId: bigint;
      amount: bigint;
      maxQuoteIn: bigint;
      deadline: bigint;
      referrer?: Address;
    }
  | { kind: "repay"; positionId: bigint; maxYieldAsset: bigint }
  | { kind: "close"; positionId: bigint }
  | { kind: "createPair"; tokenA: Address; tokenB: Address }
  | {
      kind: "createTick";
      pairId: bigint;
      direction: Direction;
      priceTick: number;
      durationDays: Duration;
    };
