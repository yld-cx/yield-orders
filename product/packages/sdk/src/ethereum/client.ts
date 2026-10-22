import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
  type ContractFunctionReturnType,
  type GetCallsStatusReturnType,
} from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import type {
  Duration,
  EconomicAction,
  EvmNetwork,
  ProviderPosition,
  Tick,
  TickIdentity,
  TickState,
  TransactionResult,
  UsePosition,
} from "../types/index.ts";
import {
  DISCOVERY_DEFAULTS,
  DISCOVERY_BATCH_SIZE,
  PORTFOLIO_DEFAULTS,
  MAX_PORTFOLIO_PAGE_SIZE,
  TOKEN_METADATA_LIMITS,
  SHORT_ADDRESS,
  RECEIPT_TIMEOUT_MS,
  TRANSACTION_CONFIRMATIONS,
} from "../constants.ts";
import { canonicalPair } from "../registry/addresses.ts";
import { protocolAbi } from "./abi.ts";
import { deploymentFor, getNetwork } from "./networks.ts";
import { pairIdFor, tickCandidates, tickIdFor } from "./math.ts";
import { protocolErrorName } from "./errors.ts";
import {
  OperationStore,
  type PendingOperation,
  type WalletCall,
  type BatchSender,
} from "./operations.ts";
type Return<N extends "withdraw" | "collect" | "repay" | "swap" | "close"> =
  ContractFunctionReturnType<typeof protocolAbi, "nonpayable", N>;
export interface InputRequirement {
  token: Address;
  amount: bigint;
  allowanceAmount: bigint;
}
/** Economic calls only. Preview getters are appended separately. */
export interface TransactionPlan {
  readonly calls: readonly Hex[];
}
export class PreviewChangedError extends Error {
  constructor(readonly preview: Preview) {
    super(
      "Execution plan changed. The preview has been refreshed. Confirm to submit the updated operation.",
    );
  }
}
export class TransactionPendingError extends Error {
  constructor(
    readonly hash: string,
    options?: ErrorOptions,
    readonly outcome: "pending" | "unknown" = "unknown",
  ) {
    super(
      outcome === "pending"
        ? "Wallet batch is pending onchain execution. Additional wallet signatures may be needed."
        : "Confirmation is still unknown. Check the submitted transaction before continuing.",
      options,
    );
  }
}
export class TransactionTerminalError extends Error {}
export class AtomicUnavailableError extends Error {}
export class AllowanceSyncError extends Error {
  constructor() {
    super(
      "Approval confirmed. Waiting for RPC allowance synchronization; no new approval is needed.",
    );
  }
}
export interface Preview {
  action: EconomicAction;
  plan: TransactionPlan;
  account: Address;
  chainId: number;
  blockNumber: bigint;
  timestamp: bigint;
  tick?: TickState;
  provider?: ProviderPosition;
  position?: UsePosition;
  withdraw?: Return<"withdraw">;
  collect?: Return<"collect">;
  repay?: Return<"repay">;
  swap?: Return<"swap">;
  close?: Return<"close">;
  input?: InputRequirement;
  gas: bigint;
  walletCalls?: readonly WalletCall[];
}
export type DiscoveryRead =
  | { identity: TickIdentity; status: "exists"; tick: Tick }
  | { identity: TickIdentity; status: "missing" }
  | { identity: TickIdentity; status: "failed"; error: string };
export interface DiscoveryResult {
  reads: DiscoveryRead[];
  blockNumber: bigint;
  radius: number;
  complete: boolean;
}
export interface PortfolioPage {
  providers: { tickId: bigint; position: ProviderPosition; tick: TickState }[];
  uses: { positionId: bigint; position: UsePosition; tick: TickState }[];
  blockNumber: bigint;
  timestamp: bigint;
  offset: number;
  hasMore: boolean;
}
export type TransactionStage =
  | "verifying"
  | "approving-reset"
  | "approving"
  | "simulating"
  | "signing"
  | "submitted"
  | "synchronizing"
  | "pending"
  | "confirmed";
export type StatusCallback = (stage: TransactionStage, hash?: Hex) => void;
export function actionData(action: EconomicAction): Hex {
  switch (action.kind) {
    case "createPair":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "createPair",
        args: [action.tokenA, action.tokenB],
      });
    case "createTick":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "createTick",
        args: [
          action.pairId,
          action.direction,
          action.priceTick,
          BigInt(action.durationDays),
        ],
      });
    case "supply":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "supply",
        args: [action.tickId, action.amount, action.referrer ?? zeroAddress],
      });
    case "withdraw":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "withdraw",
        args: [
          action.tickId,
          action.amount,
          action.minImmediateAssetOut,
          action.deadline,
        ],
      });
    case "collect":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "collect",
        args: [action.tickId],
      });
    case "settle":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "settle",
        args: [action.tickId],
      });
    case "use":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "use",
        args: [
          action.tickId,
          action.amount,
          action.maxFullTermYieldAsset,
          action.deadline,
          action.referrer ?? zeroAddress,
        ],
      });
    case "swap":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "swap",
        args: [
          action.tickId,
          action.amount,
          action.maxQuoteIn,
          action.deadline,
          action.referrer ?? zeroAddress,
        ],
      });
    case "repay":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "repay",
        args: [action.positionId, action.maxYieldAsset],
      });
    case "close":
      return encodeFunctionData({
        abi: protocolAbi,
        functionName: "close",
        args: [action.positionId],
      });
  }
}
function supplyIdentity(
  action: Extract<EconomicAction, { kind: "supply" }>,
  network: EvmNetwork,
) {
  if (!action.initialize) return undefined;
  const identity = action.initialize;
  const tokens = canonicalPair(network, identity.tokenA, identity.tokenB);
  const pairId = pairIdFor(identity.tokenA, identity.tokenB);
  if (
    tickIdFor(
      pairId,
      identity.direction,
      identity.priceTick,
      identity.durationDays,
    ) !== action.tickId
  )
    throw new Error("Supply identity does not match the selected price level");
  return { pairId, asset: tokens[identity.direction] as Address };
}
export class EthereumClient {
  readonly address: Address;
  readonly chainId: number;
  readonly runtimeCodeHash: Hex;
  private readonly activeWallets = new Set<string>();
  readonly operations: OperationStore;
  // Only verified identities are cached. Liquidity is always freshly read.
  readonly knownTicks = new Map<bigint, TickIdentity>();
  constructor(
    readonly publicClient: PublicClient,
    readonly network: EvmNetwork,
    verification?: { address: Address; runtimeCodeHash: Hex },
    storage?: Storage,
  ) {
    const config = verification ?? deploymentFor(network);
    this.address = config.address;
    this.runtimeCodeHash = config.runtimeCodeHash;
    this.chainId = getNetwork(network).chain.id;
    this.operations = new OperationStore(
      `${this.chainId}/${this.address.toLowerCase()}`,
      storage,
    );
  }
  async verifyDeployment(): Promise<void> {
    const [chainId, code] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.getCode({ address: this.address }),
    ]);
    if (chainId !== this.chainId)
      throw new Error("RPC is connected to the wrong network");
    if (!code || code === "0x")
      throw new Error(
        "Protocol deployment is unavailable on this network. Writes are disabled.",
      );
    if (keccak256(code) !== this.runtimeCodeHash)
      throw new Error(
        "Protocol runtime does not match the deployment manifest. Writes are disabled.",
      );
  }
  getPair(a: Address, b: Address, blockNumber?: bigint) {
    return this.publicClient.readContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "getPair",
      args: [a, b],
      blockNumber,
    });
  }
  getTick(id: bigint, blockNumber?: bigint) {
    return this.publicClient.readContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "getTick",
      args: [id],
      blockNumber,
    });
  }
  getEarnPosition(owner: Address, id: bigint, blockNumber?: bigint) {
    return this.publicClient.readContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "getEarnPosition",
      args: [owner, id],
      blockNumber,
    });
  }
  getUsePosition(id: bigint, blockNumber?: bigint) {
    return this.publicClient.readContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "getPosition",
      args: [id],
      blockNumber,
    });
  }
  quoteUse(id: bigint, amount: bigint, blockNumber?: bigint) {
    return this.publicClient.readContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "quoteUse",
      args: [id, amount],
      blockNumber,
    });
  }
  balance(token: Address, owner: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
  }
  allowance(token: Address, owner: Address, blockNumber?: bigint) {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, this.address],
      blockNumber,
    });
  }
  async tokenMetadata(token: Address) {
    const [symbol, name, decimals] = await Promise.all([
      this.publicClient
        .readContract({ address: token, abi: erc20Abi, functionName: "symbol" })
        .catch(
          () =>
            `${token.slice(0, SHORT_ADDRESS.prefix)}…${token.slice(-SHORT_ADDRESS.suffix)}`,
        ),
      this.publicClient
        .readContract({ address: token, abi: erc20Abi, functionName: "name" })
        .catch(() => "Unlisted token"),
      this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);
    return {
      address: token.toLowerCase(),
      network: this.network,
      symbol: symbol.slice(0, TOKEN_METADATA_LIMITS.symbol),
      name: name.slice(0, TOKEN_METADATA_LIMITS.name),
      decimals,
      listed: false,
    };
  }
  async discover(
    pairId: bigint,
    config: {
      baseTick?: number;
      stepTicks?: number;
      radius?: number;
      /** Omit to discover both supported durations (Yield Book). */
      duration?: Duration;
    } = {},
  ): Promise<DiscoveryResult> {
    const radius = config.radius ?? DISCOVERY_DEFAULTS.radius;
    const identities = tickCandidates(
      pairId,
      config.baseTick,
      config.stepTicks,
      radius,
    ).filter(
      (tick) =>
        config.duration === undefined || tick.durationDays === config.duration,
    );
    const blockNumber = await this.publicClient.getBlockNumber();
    const reads: DiscoveryRead[] = [];
    for (let i = 0; i < identities.length; i += DISCOVERY_BATCH_SIZE) {
      const batch = identities.slice(i, i + DISCOVERY_BATCH_SIZE);
      try {
        const results = await this.publicClient.multicall({
          contracts: batch.map((t) => ({
            address: this.address,
            abi: protocolAbi,
            functionName: "getTick" as const,
            args: [t.id] as const,
          })),
          allowFailure: true,
          blockNumber,
          batchSize: 0,
        });
        for (let j = 0; j < batch.length; j++) {
          const identity = batch[j],
            result = results[j];
          if (result.status === "success") {
            this.knownTicks.set(identity.id, identity);
            reads.push({
              identity,
              status: "exists",
              tick: { ...identity, state: result.result },
            });
          } else if (protocolErrorName(result.error) === "NotFound") {
            reads.push({ identity, status: "missing" });
          } else
            reads.push({
              identity,
              status: "failed",
              error: result.error.message,
            });
        }
      } catch (error) {
        for (const identity of batch)
          reads.push({ identity, status: "failed", error: String(error) });
      }
    }
    return {
      reads,
      blockNumber,
      radius,
      complete: reads.every((r) => r.status !== "failed"),
    };
  }
  async refreshKnownTicks(pairId: bigint): Promise<Tick[]> {
    const identities = [...this.knownTicks.values()].filter(
      (t) => t.pairId === pairId,
    );
    const blockNumber = await this.publicClient.getBlockNumber();
    return Promise.all(
      identities.map(async (t) => ({
        ...t,
        state: await this.getTick(t.id, blockNumber),
      })),
    );
  }
  async portfolio(
    owner: Address,
    offset: number = PORTFOLIO_DEFAULTS.offset,
    limit: number = PORTFOLIO_DEFAULTS.limit,
    atBlock?: bigint,
  ): Promise<PortfolioPage> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PORTFOLIO_PAGE_SIZE
    )
      throw new Error("Invalid portfolio page");
    const block = await this.publicClient.getBlock(
      atBlock ? { blockNumber: atBlock } : {},
    );
    const blockNumber = block.number;
    const [earnIds, useIds] = await Promise.all([
      this.publicClient.readContract({
        address: this.address,
        abi: protocolAbi,
        functionName: "getEarnPositions",
        args: [owner, BigInt(offset), BigInt(limit + 1)],
        blockNumber,
      }),
      this.publicClient.readContract({
        address: this.address,
        abi: protocolAbi,
        functionName: "getUsePositions",
        args: [owner, BigInt(offset), BigInt(limit + 1)],
        blockNumber,
      }),
    ]);
    // Share tick reads within this block-pinned page; viem batches the RPC calls.
    const ticks = new Map<bigint, ReturnType<EthereumClient["getTick"]>>();
    const readTick = (id: bigint) => {
      let tick = ticks.get(id);
      if (!tick) {
        tick = this.getTick(id, blockNumber);
        ticks.set(id, tick);
      }
      return tick;
    };
    const [providers, uses] = await Promise.all([
      Promise.all(
        earnIds.slice(0, limit).map(async (tickId) => {
          const [position, tick] = await Promise.all([
            this.getEarnPosition(owner, tickId, blockNumber),
            readTick(tickId),
          ]);
          return { tickId, position, tick };
        }),
      ),
      Promise.all(
        useIds.slice(0, limit).map(async (positionId) => {
          const position = await this.getUsePosition(positionId, blockNumber);
          return {
            positionId,
            position,
            tick: await readTick(position.tickId),
          };
        }),
      ),
    ]);
    // Enumeration is authoritative, including positions with only hidden fractional claims.
    return {
      providers,
      uses,
      blockNumber,
      timestamp: block.timestamp,
      offset,
      hasMore: earnIds.length > limit || useIds.length > limit,
    };
  }
  /** Only an explicit protocol NotFound proves absence; transport errors propagate. */
  async transactionPlan(
    action: EconomicAction,
    blockNumber?: bigint,
  ): Promise<TransactionPlan> {
    const calls: Hex[] = [];
    if (action.kind === "supply" && action.initialize) {
      const identity = action.initialize;
      const { pairId } = supplyIdentity(action, this.network)!;
      const pair = await this.getPair(
        identity.tokenA,
        identity.tokenB,
        blockNumber,
      );
      if (!pair[3]) {
        calls.push(
          actionData({
            kind: "createPair",
            tokenA: identity.tokenA,
            tokenB: identity.tokenB,
          }),
        );
      }
      let exists = false;
      if (pair[3]) {
        try {
          await this.getTick(action.tickId, blockNumber);
          exists = true;
        } catch (error) {
          if (protocolErrorName(error) !== "NotFound") throw error;
        }
      }
      if (!exists)
        calls.push(
          actionData({
            kind: "createTick",
            pairId,
            direction: identity.direction,
            priceTick: identity.priceTick,
            durationDays: identity.durationDays,
          }),
        );
    }
    calls.push(actionData(action));
    return { calls };
  }
  private async exclusive<T>(
    account: Address,
    run: () => Promise<T>,
  ): Promise<T> {
    const key = account.toLowerCase();
    if (this.activeWallets.has(key))
      throw new Error("A transaction is already in progress");
    this.activeWallets.add(key);
    try {
      if (typeof navigator !== "undefined" && navigator.locks)
        return await navigator.locks.request(
          `yld/write/${this.chainId}/${this.address.toLowerCase()}/${key}`,
          { ifAvailable: true },
          (lock) => {
            if (!lock)
              throw new Error(
                "A transaction is already in progress in another tab",
              );
            return run();
          },
        );
      return await run();
    } finally {
      this.activeWallets.delete(key);
    }
  }
  async requiredInput(
    action: EconomicAction,
    atBlock?: { number: bigint; timestamp: bigint },
  ): Promise<InputRequirement | undefined> {
    if (action.kind === "supply")
      return {
        token:
          supplyIdentity(action, this.network)?.asset ??
          (await this.getTick(action.tickId, atBlock?.number)).asset,
        amount: action.amount,
        allowanceAmount: action.amount,
      };
    if (action.kind === "use" || action.kind === "swap") {
      const tick = await this.getTick(action.tickId, atBlock?.number);
      const [quote] = await this.quoteUse(
        action.tickId,
        action.amount,
        atBlock?.number,
      );
      return {
        token: tick.quote,
        amount: quote,
        allowanceAmount: action.kind === "swap" ? action.maxQuoteIn : quote,
      };
    }
    if (action.kind === "repay") {
      const block = atBlock ?? (await this.publicClient.getBlock());
      const p = await this.getUsePosition(action.positionId, block.number);
      if (block.timestamp >= p.maturity)
        throw new Error("Position has matured. Refresh and review Close.");
      const elapsed =
        block.timestamp > p.openedAt ? block.timestamp - p.openedAt : 1n;
      const term = p.maturity - p.openedAt;
      const accruedYield = (p.fullTermYieldAsset * elapsed + term - 1n) / term;
      return {
        token: (await this.getTick(p.tickId, block.number)).asset,
        amount: p.assetAmount + accruedYield,
        allowanceAmount: p.assetAmount + action.maxYieldAsset,
      };
    }
    return undefined;
  }
  async preview(
    action: EconomicAction,
    account: Address,
    options: { atomic?: boolean; minBlock?: bigint } = {},
  ): Promise<Preview> {
    try {
      return await this.simulatePreview(action, account, options);
    } catch (error) {
      // Gas estimation can observe a creator after the pinned simulation block.
      if (
        action.kind === "supply" &&
        action.initialize &&
        protocolErrorName(error) === "AlreadyExists"
      )
        return this.simulatePreview(action, account, options);
      throw error;
    }
  }
  private async simulatePreview(
    action: EconomicAction,
    account: Address,
    options: { atomic?: boolean; minBlock?: bigint },
  ): Promise<Preview> {
    await this.verifyDeployment();
    let block = await this.publicClient.getBlock();
    if (options.minBlock !== undefined && block.number < options.minBlock)
      block = await this.publicClient.getBlock({
        blockNumber: options.minBlock,
      });
    const blockNumber = block.number;
    const plan = await this.transactionPlan(action, blockNumber);
    const calls: Hex[] = [...plan.calls];
    let tickId: bigint | undefined;
    let includeProvider = false,
      includePosition = false;
    if ("tickId" in action) tickId = action.tickId;
    if (action.kind === "repay" || action.kind === "close")
      tickId = (await this.getUsePosition(action.positionId, blockNumber))
        .tickId;
    if (action.kind === "createTick")
      tickId = tickIdFor(
        action.pairId,
        action.direction,
        action.priceTick,
        action.durationDays,
      );
    if (
      action.kind === "supply" ||
      action.kind === "withdraw" ||
      action.kind === "collect"
    ) {
      includeProvider = true;
      calls.push(
        encodeFunctionData({
          abi: protocolAbi,
          functionName: "getEarnPosition",
          args: [account, action.tickId],
        }),
      );
    }
    if (action.kind === "use") {
      const id = await this.publicClient.readContract({
        address: this.address,
        abi: protocolAbi,
        functionName: "nextPositionId",
        blockNumber,
      });
      includePosition = true;
      calls.push(
        encodeFunctionData({
          abi: protocolAbi,
          functionName: "getPosition",
          args: [id],
        }),
      );
    }
    if (tickId !== undefined)
      calls.push(
        encodeFunctionData({
          abi: protocolAbi,
          functionName: "getTick",
          args: [tickId],
        }),
      );
    let result: readonly Hex[], gas: bigint;
    let walletCalls: readonly WalletCall[] | undefined;
    if (options.atomic) {
      walletCalls = await this.walletCalls(action, account, plan, block);
      const simulation = await this.publicClient.simulateCalls({
        account,
        blockNumber,
        calls: [
          ...walletCalls.slice(0, -1),
          {
            to: this.address,
            abi: protocolAbi,
            functionName: "multicall",
            args: [calls],
            data: encodeFunctionData({
              abi: protocolAbi,
              functionName: "multicall",
              args: [calls],
            }),
          },
        ],
      });
      for (const call of simulation.results) {
        if (call.status === "failure") throw call.error;
      }
      result = decodeFunctionResult({
        abi: protocolAbi,
        functionName: "multicall",
        data: simulation.results.at(-1)!.data,
      });
      gas = simulation.results.reduce((sum, call) => sum + call.gasUsed, 0n);
    } else {
      ({ result } = await this.publicClient.simulateContract({
        address: this.address,
        abi: protocolAbi,
        functionName: "multicall",
        args: [calls],
        account,
        blockNumber,
      }));
      gas = await this.publicClient.estimateContractGas({
        address: this.address,
        abi: protocolAbi,
        functionName: "multicall",
        args: [plan.calls],
        account,
        blockNumber,
      });
    }
    const preview: Preview = {
      action,
      plan,
      account,
      chainId: this.chainId,
      blockNumber,
      timestamp: block.timestamp,
      gas,
      walletCalls,
      input: await this.requiredInput(action, block),
    };
    let cursor = plan.calls.length;
    if (includeProvider)
      preview.provider = decodeFunctionResult({
        abi: protocolAbi,
        functionName: "getEarnPosition",
        data: result[cursor++],
      });
    if (includePosition)
      preview.position = decodeFunctionResult({
        abi: protocolAbi,
        functionName: "getPosition",
        data: result[cursor++],
      });
    if (tickId !== undefined)
      preview.tick = decodeFunctionResult({
        abi: protocolAbi,
        functionName: "getTick",
        data: result[cursor],
      });
    switch (action.kind) {
      case "withdraw":
        preview.withdraw = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "withdraw",
          data: result[plan.calls.length - 1],
        });
        break;
      case "collect":
        preview.collect = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "collect",
          data: result[plan.calls.length - 1],
        });
        break;
      case "repay":
        preview.repay = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "repay",
          data: result[plan.calls.length - 1],
        });
        break;
      case "swap":
        preview.swap = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "swap",
          data: result[plan.calls.length - 1],
        });
        break;
      case "close":
        preview.close = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "close",
          data: result[plan.calls.length - 1],
        });
        break;
    }
    if (preview.repay && preview.input)
      preview.input.amount = preview.repay.totalAssetIn;
    return preview;
  }
  async assertWallet(wallet: WalletClient, account: Address) {
    const [chain, addresses] = await Promise.all([
      wallet.getChainId(),
      wallet.getAddresses(),
    ]);
    if (chain !== this.chainId)
      throw new Error("Switch the wallet to the selected network");
    if (addresses[0]?.toLowerCase() !== account.toLowerCase())
      throw new Error("Wallet account changed. Review a new preview.");
  }
  pending(account: Address) {
    return this.operations.get(account);
  }
  clearTerminal(account: Address) {
    const op = this.pending(account);
    if (
      op &&
      ["confirmed", "reverted"].includes(op.status) &&
      (op.status === "reverted" ||
        (op.phase !== "approval" && op.phase !== "approval-reset"))
    )
      this.operations.remove(account);
  }
  private async needsReset(
    token: Address,
    account: Address,
    allowance: bigint,
    amount: bigint,
  ) {
    if (allowance === 0n) return false;
    try {
      const { result } = await this.publicClient.simulateContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [this.address, amount],
        account,
      });
      return result === false;
    } catch (error) {
      if (
        error instanceof BaseError &&
        error.walk((e) => e instanceof ContractFunctionRevertedError) instanceof
          ContractFunctionRevertedError
      )
        return true;
      throw error;
    }
  }
  private async walletCalls(
    action: EconomicAction,
    account: Address,
    plan: TransactionPlan,
    block: { number: bigint; timestamp: bigint },
  ): Promise<WalletCall[]> {
    const input = await this.requiredInput(action, block);
    const calls: WalletCall[] = [];
    if (input) {
      const allowance = await this.allowance(
        input.token,
        account,
        block.number,
      );
      if (allowance < input.allowanceAmount) {
        const approve = (amount: bigint) => ({
          to: input.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [this.address, amount],
          }),
        });
        if (
          await this.needsReset(
            input.token,
            account,
            allowance,
            input.allowanceAmount,
          )
        )
          calls.push(approve(0n));
        calls.push(approve(input.allowanceAmount));
      }
      if ((await this.balance(input.token, account)) < input.amount)
        throw new Error("Insufficient token balance for this action");
    }
    calls.push({
      to: this.address,
      data: encodeFunctionData({
        abi: protocolAbi,
        functionName: "multicall",
        args: [plan.calls],
      }),
    });
    return calls;
  }
  private async synchronize(op: PendingOperation, onStatus?: StatusCallback) {
    onStatus?.("synchronizing");
    if (!op.approvalToken)
      throw new Error("Approval token is missing from the submitted operation");
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const allowance = await this.allowance(
          op.approvalToken,
          op.account,
          op.blockNumber,
        );
        if (
          op.phase === "approval-reset"
            ? allowance === 0n
            : allowance >= op.approvalAmount!
        )
          return;
      } catch {}
      if (attempt < 11)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new AllowanceSyncError();
  }
  private async submit(
    op: PendingOperation,
    send: () => Promise<string>,
    onStatus?: StatusCallback,
  ) {
    if (this.pending(op.account))
      throw new Error("A submitted operation must be resolved first");
    this.operations.put(op);
    try {
      op.id = await send();
      op.status = "submitted";
      this.operations.put(op);
      onStatus?.(
        "submitted",
        op.identifier === "transaction" ? (op.id as Hex) : undefined,
      );
    } catch (error) {
      const unsupported = (e: unknown): boolean =>
        !!e &&
        typeof e === "object" &&
        (("code" in e && [-32601, 4200, 5700, 5760].includes(Number(e.code))) ||
          ("cause" in e && unsupported(e.cause)));
      if (
        op.identifier === "calls" &&
        (error instanceof AtomicUnavailableError || unsupported(error))
      ) {
        this.operations.remove(op.account);
        throw new AtomicUnavailableError(
          "Wallet atomic execution is unavailable. Approve separately and review the action.",
          { cause: error },
        );
      }
      const rejected = (e: unknown): boolean =>
        !!e &&
        typeof e === "object" &&
        (("code" in e && e.code === 4001) ||
          ("message" in e &&
            /user rejected|user denied/i.test(String(e.message))) ||
          ("cause" in e && rejected(e.cause)));
      if (!op.id && (rejected(error) || unsupported(error)))
        this.operations.remove(op.account);
      else {
        op.status = "unknown";
        this.operations.put(op);
      }
      throw error;
    }
  }
  private async track(
    op: PendingOperation,
    wallet: WalletClient,
    onStatus?: StatusCallback,
    batchStatus?: GetCallsStatusReturnType,
  ): Promise<TransactionReceipt> {
    if (!op.id) {
      op.status = "unknown";
      this.operations.put(op);
      throw new Error(
        "Wallet submission outcome is unknown. The transaction may have been submitted. Check your wallet before clearing pending state; it might still execute. Automatic resubmission is disabled.",
      );
    }
    if (op.status === "reverted")
      throw new TransactionTerminalError(
        "Transaction reverted or replaced. Review current state before retrying.",
      );
    op.status = "pending";
    this.operations.put(op);
    onStatus?.(
      "pending",
      op.identifier === "transaction" ? (op.id as Hex) : undefined,
    );
    try {
      let hash: Hex;
      if (op.identifier === "calls") {
        if (!batchStatus) throw new Error("Batch is awaiting wallet execution");
        if (batchStatus.chainId !== this.chainId)
          throw new Error("Batch belongs to another network");
        if (batchStatus.status === "pending")
          throw new TransactionPendingError(op.id, undefined, "pending");
        if (batchStatus.status === "failure")
          throw new TransactionTerminalError(
            "Wallet batch failed or reverted. Review current state.",
          );
        if (
          batchStatus.status !== "success" ||
          (!batchStatus.atomic &&
            !["1.0", "1.0.0"].includes(batchStatus.version)) ||
          !batchStatus.receipts?.length
        )
          throw new Error("Atomic execution is not yet verified");
        if (batchStatus.receipts.some((r) => r.status !== "success"))
          throw new TransactionTerminalError("Wallet batch reverted");
        const hashes = new Set(
          batchStatus.receipts.map((r) => r.transactionHash),
        );
        if (hashes.size !== 1)
          throw new Error("Wallet did not provide one atomic transaction");
        hash = batchStatus.receipts[0].transactionHash;
      } else hash = op.id as Hex;
      const receipt = await waitForTransactionReceipt(wallet, {
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
        confirmations: TRANSACTION_CONFIRMATIONS,
        onReplaced: (replacement) => {
          if (replacement.reason !== "repriced")
            throw new TransactionTerminalError(
              "Transaction cancelled or replaced with different data. Review current state.",
            );
          if (op.identifier === "transaction")
            op.id = replacement.transaction.hash;
          this.operations.put(op);
          onStatus?.("pending", replacement.transaction.hash);
        },
      });
      if (receipt.status !== "success")
        throw new TransactionTerminalError(
          "Transaction reverted. Review current state.",
        );
      let verified: TransactionReceipt;
      try {
        verified = await this.publicClient.getTransactionReceipt({
          hash: receipt.transactionHash,
        });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        const block = await this.publicClient.getBlock({
          blockHash: receipt.blockHash,
        });
        const executionHash = block.transactions[receipt.transactionIndex];
        if (typeof executionHash !== "string") throw error;
        verified = await this.publicClient.getTransactionReceipt({
          hash: executionHash,
        });
      }
      if (
        verified.blockHash !== receipt.blockHash ||
        verified.transactionIndex !== receipt.transactionIndex
      )
        throw new Error(
          "Wallet receipt is not synchronized with the canonical onchain receipt",
        );
      if (verified.status !== "success")
        throw new TransactionTerminalError(
          "Transaction reverted. Review current state.",
        );
      op.status = "confirmed";
      op.blockNumber = verified.blockNumber;
      this.operations.put(op);
      return verified;
    } catch (error) {
      op.status =
        error instanceof TransactionTerminalError
          ? "reverted"
          : error instanceof TransactionPendingError &&
              error.outcome === "pending"
            ? "pending"
            : "unknown";
      this.operations.put(op);
      if (error instanceof TransactionTerminalError) throw error;
      if (error instanceof TransactionPendingError) throw error;
      throw new TransactionPendingError(op.id as Hex, { cause: error });
    }
  }
  async recover(
    wallet: WalletClient,
    account: Address,
    onStatus?: StatusCallback,
    batchStatus?: GetCallsStatusReturnType,
  ): Promise<TransactionResult | { approvalBlock: bigint }> {
    return this.exclusive(account, async () => {
      await this.assertWallet(wallet, account);
      await this.verifyDeployment();
      const op = this.pending(account);
      if (!op) throw new Error("No submitted operation to recover");
      const receipt = await this.track(op, wallet, onStatus, batchStatus);
      if (op.phase === "approval" || op.phase === "approval-reset") {
        await this.synchronize(op, onStatus);
        this.operations.remove(account);
        return { approvalBlock: receipt.blockNumber };
      }
      onStatus?.("confirmed", receipt.transactionHash);
      return this.result(receipt);
    });
  }
  async approve(
    action: EconomicAction,
    wallet: WalletClient,
    account: Address,
    onStatus?: StatusCallback,
  ): Promise<bigint | undefined> {
    return this.exclusive(account, async () => {
      onStatus?.("verifying");
      await this.verifyDeployment();
      await this.assertWallet(wallet, account);
      let minBlock: bigint | undefined;
      const pending = this.pending(account);
      if (pending) {
        if (pending.phase !== "approval" && pending.phase !== "approval-reset")
          throw new Error("A submitted operation must be resolved first");
        const receipt = await this.track(pending, wallet, onStatus);
        await this.synchronize(pending, onStatus);
        minBlock = receipt.blockNumber;
        this.operations.remove(account);
        if (pending.phase === "approval") return minBlock;
      }
      const input = await this.requiredInput(action);
      if (!input) return minBlock;
      const [balance, allowance] = await Promise.all([
        this.balance(input.token, account),
        this.allowance(input.token, account, minBlock),
      ]);
      if (balance < input.amount)
        throw new Error("Insufficient token balance for this action");
      if (allowance >= input.allowanceAmount) return minBlock;
      const approve = async (amount: bigint, reset: boolean) => {
        await this.assertWallet(wallet, account);
        onStatus?.(reset ? "approving-reset" : "approving");
        const { request } = await this.publicClient.simulateContract({
          address: input.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.address, amount],
          account,
        });
        await this.assertWallet(wallet, account);
        const op: PendingOperation = {
          account,
          chainId: this.chainId,
          action,
          phase: reset ? "approval-reset" : "approval",
          identifier: "transaction",
          status: "submitted",
          approvalAmount: amount,
          approvalToken: input.token,
        };
        await this.submit(op, () => wallet.writeContract(request), onStatus);
        const receipt = await this.track(op, wallet, onStatus);
        await this.synchronize(op, onStatus);
        minBlock = receipt.blockNumber;
        this.operations.remove(account);
      };
      if (
        await this.needsReset(
          input.token,
          account,
          allowance,
          input.allowanceAmount,
        )
      )
        await approve(0n, true);
      await approve(input.allowanceAmount, false);
      return minBlock;
    });
  }
  async execute(
    preview: Preview,
    wallet: WalletClient,
    onStatus?: StatusCallback,
    sendBatch?: BatchSender,
  ): Promise<TransactionResult> {
    return this.exclusive(preview.account, async () => {
      if (preview.chainId !== this.chainId)
        throw new Error("Preview belongs to another network");
      onStatus?.("verifying");
      await this.verifyDeployment();
      await this.assertWallet(wallet, preview.account);
      const pending = this.pending(preview.account);
      if (pending) {
        if (actionData(pending.action) !== actionData(preview.action))
          throw new Error("Another submitted action must be resolved first");
        if (pending.phase !== "action")
          throw new Error("A submitted operation must be resolved first");
        const receipt = await this.track(pending, wallet, onStatus);
        onStatus?.("confirmed", receipt.transactionHash);
        return this.result(receipt);
      }
      onStatus?.("simulating");
      let block = await this.publicClient.getBlock();
      if (block.number < preview.blockNumber)
        block = await this.publicClient.getBlock({
          blockNumber: preview.blockNumber,
        });
      const plan = await this.transactionPlan(preview.action, block.number);
      const changed = (next: TransactionPlan) =>
        next.calls.length !== preview.plan.calls.length ||
        next.calls.some((call, i) => call !== preview.plan.calls[i]);
      if (changed(plan))
        throw new PreviewChangedError(
          await this.preview(preview.action, preview.account, {
            atomic: !!preview.walletCalls,
          }),
        );
      let request;
      if (preview.walletCalls) {
        if (!sendBatch)
          throw new Error(
            "Atomic wallet execution is unavailable. Refresh the preview.",
          );
        const fresh = await this.preview(preview.action, preview.account, {
          atomic: true,
        });
        if (
          JSON.stringify(fresh.walletCalls) !==
          JSON.stringify(preview.walletCalls)
        )
          throw new PreviewChangedError(fresh);
      } else {
        const input = await this.requiredInput(preview.action, block);
        if (input) {
          const [balance, allowance] = await Promise.all([
            this.balance(input.token, preview.account),
            this.allowance(input.token, preview.account, block.number),
          ]);
          if (balance < input.amount)
            throw new Error("Insufficient token balance for this action");
          if (allowance < input.allowanceAmount)
            throw new Error("Token approval required");
        }
        try {
          ({ request } = await this.publicClient.simulateContract({
            address: this.address,
            abi: protocolAbi,
            functionName: "multicall",
            args: [plan.calls],
            account: preview.account,
            blockTag: "pending",
          }));
        } catch (error) {
          if (
            preview.action.kind === "supply" &&
            preview.action.initialize &&
            changed(await this.transactionPlan(preview.action))
          )
            throw new PreviewChangedError(
              await this.preview(preview.action, preview.account),
            );
          throw error;
        }
      }
      await this.assertWallet(wallet, preview.account);
      onStatus?.("signing");
      const op: PendingOperation = {
        account: preview.account,
        chainId: this.chainId,
        action: preview.action,
        phase: preview.walletCalls ? "batch" : "action",
        identifier: preview.walletCalls ? "calls" : "transaction",
        status: "submitted",
      };
      await this.submit(
        op,
        () =>
          preview.walletCalls
            ? sendBatch!(preview.walletCalls)
            : wallet.writeContract(request!),
        onStatus,
      );
      if (preview.walletCalls)
        return this.track(op, wallet, onStatus).then((r) => this.result(r));
      const receipt = await this.track(op, wallet, onStatus);
      onStatus?.("confirmed", receipt.transactionHash);
      return this.result(receipt);
    });
  }
  private result(receipt: TransactionReceipt): TransactionResult {
    const result: TransactionResult = {
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
    };
    const logs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === this.address.toLowerCase(),
    );
    const opened = parseEventLogs({
      abi: protocolAbi,
      logs,
      eventName: "UseOpened",
    })[0];
    if (opened) result.positionId = opened.args.positionId;
    const created = parseEventLogs({
      abi: protocolAbi,
      logs,
      eventName: "TickCreated",
    })[0];
    if (created) {
      result.tickId = created.args.tickId;
      const identity = {
        id: created.args.tickId,
        pairId: created.args.pairId,
        direction: created.args.direction as 0 | 1,
        priceTick: created.args.priceTick,
        durationDays: Number(created.args.durationDays) as Duration,
      };
      this.knownTicks.set(identity.id, identity);
    }
    const pair = parseEventLogs({
      abi: protocolAbi,
      logs,
      eventName: "PairCreated",
    })[0];
    if (pair) result.pairId = pair.args.pairId;
    return result;
  }
}
