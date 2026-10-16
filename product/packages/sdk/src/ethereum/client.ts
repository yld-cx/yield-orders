import {
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
      "Market initialization changed. The preview has been refreshed. Confirm to submit the updated operation.",
    );
  }
}
export class TransactionPendingError extends Error {
  constructor(
    readonly hash: Hex,
    options?: ErrorOptions,
  ) {
    super(
      "Confirmation is still unknown. Check the submitted transaction before continuing.",
      options,
    );
  }
}
class TransactionTerminalError extends Error {}
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
  private readonly pendingWrites = new Map<string, Hex>();
  // Only verified identities are cached. Liquidity is always freshly read.
  readonly knownTicks = new Map<bigint, TickIdentity>();
  constructor(
    readonly publicClient: PublicClient,
    readonly network: EvmNetwork,
    verification?: { address: Address; runtimeCodeHash: Hex },
  ) {
    const config = verification ?? deploymentFor(network);
    this.address = config.address;
    this.runtimeCodeHash = config.runtimeCodeHash;
    this.chainId = getNetwork(network).chain.id;
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
  allowance(token: Address, owner: Address) {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, this.address],
    });
  }
  async tokenMetadata(token: Address) {
    const [symbol, name, decimals, code] = await Promise.all([
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
      this.publicClient.getCode({ address: token }),
    ]);
    if (!code || code === "0x")
      throw new Error("No token contract at this address");
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
    } = {},
  ): Promise<DiscoveryResult> {
    const radius = config.radius ?? DISCOVERY_DEFAULTS.radius;
    const identities = tickCandidates(
      pairId,
      config.baseTick,
      config.stepTicks,
      radius,
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
    const [providers, uses] = await Promise.all([
      Promise.all(
        earnIds.slice(0, limit).map(async (tickId) => {
          const [position, tick] = await Promise.all([
            this.getEarnPosition(owner, tickId, blockNumber),
            this.getTick(tickId, blockNumber),
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
            tick: await this.getTick(position.tickId, blockNumber),
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
  async preview(action: EconomicAction, account: Address): Promise<Preview> {
    try {
      return await this.simulatePreview(action, account);
    } catch (error) {
      // Gas estimation can observe a creator after the pinned simulation block.
      if (
        action.kind === "supply" &&
        action.initialize &&
        protocolErrorName(error) === "AlreadyExists"
      )
        return this.simulatePreview(action, account);
      throw error;
    }
  }
  private async simulatePreview(
    action: EconomicAction,
    account: Address,
  ): Promise<Preview> {
    await this.verifyDeployment();
    const block = await this.publicClient.getBlock();
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
    const { result } = await this.publicClient.simulateContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "multicall",
      args: [calls],
      account,
      blockNumber,
    });
    const gas = await this.publicClient.estimateContractGas({
      address: this.address,
      abi: protocolAbi,
      functionName: "multicall",
      args: [plan.calls],
      account,
    });
    const preview: Preview = {
      action,
      plan,
      account,
      chainId: this.chainId,
      blockNumber,
      timestamp: block.timestamp,
      gas,
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
  private async receipt(
    wallet: WalletClient,
    hash: Hex,
    onStatus?: StatusCallback,
  ): Promise<TransactionReceipt> {
    onStatus?.("pending", hash);
    const receipt = await waitForTransactionReceipt(wallet, {
      hash,
      timeout: RECEIPT_TIMEOUT_MS,
      confirmations: TRANSACTION_CONFIRMATIONS,
      onReplaced: (replacement) => {
        if (replacement.reason === "cancelled")
          throw new TransactionTerminalError("Transaction cancelled");
        if (replacement.reason === "replaced")
          throw new TransactionTerminalError(
            "Transaction replaced with different data. Refresh the current state before retrying.",
          );
        onStatus?.("pending", replacement.transaction.hash);
      },
    });
    if (receipt.status !== "success")
      throw new TransactionTerminalError(
        "Transaction reverted. Refresh and review the current state.",
      );
    return receipt;
  }
  private async waitSubmitted(
    key: string,
    wallet: WalletClient,
    onStatus?: StatusCallback,
  ) {
    const hash = this.pendingWrites.get(key)!;
    try {
      const receipt = await this.receipt(wallet, hash, (stage, nextHash) => {
        if (nextHash) this.pendingWrites.set(key, nextHash);
        onStatus?.(stage, nextHash);
      });
      this.pendingWrites.delete(key);
      return receipt;
    } catch (error) {
      if (error instanceof TransactionTerminalError) {
        this.pendingWrites.delete(key);
        throw error;
      }
      throw new TransactionPendingError(this.pendingWrites.get(key)!, {
        cause: error,
      });
    }
  }
  async approve(
    action: EconomicAction,
    wallet: WalletClient,
    account: Address,
    onStatus?: StatusCallback,
  ): Promise<void> {
    return this.exclusive(account, async () => {
      onStatus?.("verifying");
      await this.verifyDeployment();
      await this.assertWallet(wallet, account);
      const key = `approval/${account.toLowerCase()}/${actionData(action)}`;
      if (this.pendingWrites.has(key))
        await this.waitSubmitted(key, wallet, onStatus);
      const input = await this.requiredInput(action);
      if (!input) return;
      const [balance, allowance] = await Promise.all([
        this.balance(input.token, account),
        this.allowance(input.token, account),
      ]);
      if (balance < input.amount)
        throw new Error("Insufficient token balance for this action");
      if (allowance >= input.allowanceAmount) return;
      const approve = async (
        amount: bigint,
        stage: "approving" | "approving-reset",
      ) => {
        await this.assertWallet(wallet, account);
        onStatus?.(stage);
        const { request } = await this.publicClient.simulateContract({
          address: input.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [this.address, amount],
          account,
        });
        await this.assertWallet(wallet, account);
        this.pendingWrites.set(key, await wallet.writeContract(request));
        await this.waitSubmitted(key, wallet, onStatus);
      };
      // Exact allowance, with explicit reset for zero-first tokens.
      if (allowance > 0n) await approve(0n, "approving-reset");
      await approve(input.allowanceAmount, "approving");
    });
  }
  async execute(
    preview: Preview,
    wallet: WalletClient,
    onStatus?: StatusCallback,
  ): Promise<TransactionResult> {
    return this.exclusive(preview.account, async () => {
      if (preview.chainId !== this.chainId)
        throw new Error("Preview belongs to another network");
      onStatus?.("verifying");
      await this.verifyDeployment();
      await this.assertWallet(wallet, preview.account);
      const key = `execute/${preview.account.toLowerCase()}/${actionData(preview.action)}`;
      let receipt: TransactionReceipt;
      if (this.pendingWrites.has(key)) {
        receipt = await this.waitSubmitted(key, wallet, onStatus);
      } else {
        onStatus?.("simulating");
        const block = await this.publicClient.getBlock();
        const plan = await this.transactionPlan(preview.action, block.number);
        const changed = (next: TransactionPlan) =>
          next.calls.length !== preview.plan.calls.length ||
          next.calls.some((call, i) => call !== preview.plan.calls[i]);
        if (changed(plan))
          throw new PreviewChangedError(
            await this.preview(preview.action, preview.account),
          );
        const input = await this.requiredInput(preview.action, block);
        if (input) {
          const [balance, allowance] = await Promise.all([
            this.balance(input.token, preview.account),
            this.allowance(input.token, preview.account),
          ]);
          if (balance < input.amount)
            throw new Error("Insufficient token balance for this action");
          if (allowance < input.allowanceAmount)
            throw new Error("Token approval required");
        }
        let request;
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
          // A creator can race even the initialization reads above. Rebuild for review only.
          if (preview.action.kind === "supply" && preview.action.initialize) {
            const fresh = await this.transactionPlan(preview.action);
            if (changed(fresh))
              throw new PreviewChangedError(
                await this.preview(preview.action, preview.account),
              );
          }
          throw error;
        }
        await this.assertWallet(wallet, preview.account);
        onStatus?.("signing");
        this.pendingWrites.set(key, await wallet.writeContract(request));
        receipt = await this.waitSubmitted(key, wallet, onStatus);
      }
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
      onStatus?.("confirmed", receipt.transactionHash);
      return result;
    });
  }
}
