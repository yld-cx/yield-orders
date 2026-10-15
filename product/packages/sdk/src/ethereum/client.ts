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
import { protocolAbi } from "./abi.ts";
import { deploymentFor, getNetwork } from "./networks.ts";
import { tickCandidates, tickIdFor } from "./math.ts";
import { protocolErrorName } from "./errors.ts";
type Return<N extends "withdraw" | "collect" | "repay" | "swap" | "close"> =
  ContractFunctionReturnType<typeof protocolAbi, "nonpayable", N>;
export interface InputRequirement {
  token: Address;
  amount: bigint;
  allowanceAmount: bigint;
}
export interface Preview {
  action: EconomicAction;
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
export class EthereumClient {
  readonly address: Address;
  readonly chainId: number;
  readonly runtimeCodeHash: Hex;
  // Only verified identities are cached. Liquidity is always freshly read.
  readonly knownTicks = new Map<bigint, TickIdentity>();
  private readonly checkedMissing = new Set<bigint>();
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
        .catch(() => `${token.slice(0, 6)}…${token.slice(-4)}`),
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
      symbol: symbol.slice(0, 32),
      name: name.slice(0, 100),
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
      startRadius?: number;
    } = {},
  ): Promise<DiscoveryResult> {
    const radius = config.radius ?? 8;
    const identities = tickCandidates(
      pairId,
      config.baseTick,
      config.stepTicks,
      radius,
      config.startRadius,
    );
    const blockNumber = await this.publicClient.getBlockNumber();
    const reads: DiscoveryRead[] = [];
    for (let i = 0; i < identities.length; i += 40) {
      const batch = identities.slice(i, i + 40);
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
            this.checkedMissing.delete(identity.id);
            reads.push({
              identity,
              status: "exists",
              tick: { ...identity, state: result.result },
            });
          } else if (protocolErrorName(result.error) === "NotFound") {
            this.checkedMissing.add(identity.id);
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
    offset = 0,
    limit = 24,
    atBlock?: bigint,
  ): Promise<PortfolioPage> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
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
  async requiredInput(
    action: EconomicAction,
    atBlock?: { number: bigint; timestamp: bigint },
  ): Promise<InputRequirement | undefined> {
    if (action.kind === "supply")
      return {
        token: (await this.getTick(action.tickId, atBlock?.number)).asset,
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
    await this.verifyDeployment();
    const block = await this.publicClient.getBlock();
    const blockNumber = block.number;
    const calls: Hex[] = [actionData(action)];
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
      args: [[actionData(action)]],
      account,
    });
    const preview: Preview = {
      action,
      account,
      chainId: this.chainId,
      blockNumber,
      timestamp: block.timestamp,
      gas,
      input: await this.requiredInput(action, block),
    };
    let cursor = 1;
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
          data: result[0],
        });
        break;
      case "collect":
        preview.collect = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "collect",
          data: result[0],
        });
        break;
      case "repay":
        preview.repay = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "repay",
          data: result[0],
        });
        break;
      case "swap":
        preview.swap = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "swap",
          data: result[0],
        });
        break;
      case "close":
        preview.close = decodeFunctionResult({
          abi: protocolAbi,
          functionName: "close",
          data: result[0],
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
      confirmations: 1,
      onReplaced: (replacement) => {
        if (replacement.reason === "cancelled")
          throw new Error("Transaction cancelled");
        if (replacement.reason === "replaced")
          throw new Error(
            "Transaction replaced with different data. Refresh the current state before retrying.",
          );
        onStatus?.("pending", replacement.transaction.hash);
      },
    });
    if (receipt.status !== "success")
      throw new Error(
        "Transaction reverted. Refresh and review the current state.",
      );
    return receipt;
  }
  async approve(
    action: EconomicAction,
    wallet: WalletClient,
    account: Address,
    onStatus?: StatusCallback,
  ): Promise<void> {
    onStatus?.("verifying");
    await this.verifyDeployment();
    await this.assertWallet(wallet, account);
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
      await this.receipt(wallet, await wallet.writeContract(request), onStatus);
    };
    // Exact allowance, with explicit reset for zero-first tokens.
    if (allowance > 0n) await approve(0n, "approving-reset");
    await approve(input.allowanceAmount, "approving");
  }
  async execute(
    preview: Preview,
    wallet: WalletClient,
    onStatus?: StatusCallback,
  ): Promise<TransactionResult> {
    if (preview.chainId !== this.chainId)
      throw new Error("Preview belongs to another network");
    onStatus?.("verifying");
    await this.verifyDeployment();
    await this.assertWallet(wallet, preview.account);
    onStatus?.("simulating");
    const { request } = await this.publicClient.simulateContract({
      address: this.address,
      abi: protocolAbi,
      functionName: "multicall",
      args: [[actionData(preview.action)]],
      account: preview.account,
      blockTag: "pending",
    });
    await this.assertWallet(wallet, preview.account);
    onStatus?.("signing");
    const receipt = await this.receipt(
      wallet,
      await wallet.writeContract(request),
      onStatus,
    );
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
      this.checkedMissing.delete(identity.id);
    }
    const pair = parseEventLogs({
      abi: protocolAbi,
      logs,
      eventName: "PairCreated",
    })[0];
    if (pair) result.pairId = pair.args.pairId;
    onStatus?.("confirmed", receipt.transactionHash);
    return result;
  }
}
