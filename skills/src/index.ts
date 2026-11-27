import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  getContract,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import {
  BASIS_POINTS,
  DISCOVERY_DEFAULTS,
  MAX_AMOUNT,
  TRANSACTION_DEFAULTS,
} from "@yld-cx/sdk";
import {
  EthereumClient,
  decimalFraction,
  deploymentFor,
  explainError,
  getNetwork,
  humanPrice,
  marginalYieldPercent,
  networks,
  pairIdFor,
  priceAtTick,
  protocolAbi,
  protocolErrorName,
  snappedPrice,
  tickIdFor,
  tokenAmount,
} from "@yld-cx/sdk/ethereum";
import { Registry, canonicalPair, displayTokens } from "@yld-cx/sdk/registry";
import type { EconomicAction, ProviderPosition, TickState } from "@yld-cx/sdk";
import yieldList from "../../product/public/yieldlist.json" with { type: "json" };
import {
  commandInputs,
  type Command,
  type CommandInput,
  type ParsedInput,
} from "./inputs.ts";
import { createSkillsClient } from "./rpc.ts";

export {
  commandInputs,
  descriptions,
  type Command,
  type CommandInput,
} from "./inputs.ts";
export const yieldOrdersAbi: Abi = protocolAbi;
export type { Address, Hex } from "viem";

export interface TransactionPlan {
  chainId: number;
  account: Address;
  calls: { to: Address; value: string; data: Hex }[];
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  listed: boolean;
}

export interface TokenAmount {
  token: TokenInfo;
  raw: string;
  amount: string;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export interface PreparedTransaction {
  plan: TransactionPlan;
  operation: ParsedInput<"prepare">["operation"];
  blockNumber: string;
  timestamp: string;
  execution: {
    atomicBatchRecommended: boolean;
    approvalCalls: number;
    protocolCallsAtomic: true;
    steps: string[];
  };
  inputs?: { required: TokenAmount; approvalCap: TokenAmount };
  market: { asset: TokenInfo; quote: TokenInfo };
  details: Json;
}

export interface SkillsOptions {
  /** Supply a read-only client for custom RPCs, forks, or fetch implementations. */
  client?: (chain: Chain) => PublicClient | undefined;
  /** Prefer this endpoint when using the built-in read-only client. */
  rpcUrl?: string;
  account?: Address;
}

const registry = new Registry(yieldList);

export const protocolInfo = {
  name: "Yield Orders",
  url: "https://yld.cx",
  assetAndQuote:
    "Asset is the token a provider supplies and a taker receives. Quote is the other token. Tick price is Quote per Asset. Bid/Ask are relative to the market display order, so the Tick Asset changes sides.",
  operations: {
    provide:
      "A Limit supplies the Tick Asset at a fixed price and rental term. Existing or new ticks are supported. Exposure converts to Quote if taken by Swap or a rental expires.",
    swap: "Buy an exact Asset amount immediately. Pay Quote, including the protocol's deduction from provider proceeds.",
    rent: "Receive Asset and lock Quote principal. Repay the Asset principal plus accrued Asset yield before maturity to unlock Quote. Full-term Asset yield is fixed at opening.",
    repay:
      "Only the rental owner can repay an active rental before maturity. Yield accrues over elapsed time and is rounded up.",
    withdraw:
      "Remove provider principal. Available Asset can return immediately. Working principal can enter the Exit pool and settle as rentals resolve.",
    collect:
      "Collect available Asset and Quote proceeds, including vested yield. Supply and Collect reset the provider vesting timestamp.",
    close:
      "At or after maturity anyone can close the rental. The renter keeps the Asset already received and forfeits locked Quote. Quote net of the frozen close fee goes to providers.",
    settle:
      "Process the next expired rental at a tick in settlement order. Other operations may advance settlement as well.",
  },
  workflow: [
    "List markets and inspect book, then quote a tick and amount. For a new Limit level quote by pair, deposited Asset and price.",
    "Use balances and portfolio with the actual sender. Choose explicit transaction limits and check deadlines before preparing.",
    "Simulate with the same sender and use a compatible external wallet to authorize and submit the prepared plan. Use atomic approvals where available.",
    "Check status for a confirmed receipt and refresh portfolio and balances. Re-quote after changed liquidity or an expired deadline.",
  ],
  risks: [
    "Provider yield depends on usage, vesting and settlement. Marginal term yield is indicative.",
    "RPC quotes are snapshots. Rent and Swap can settle expired liquidity before execution, changing the result.",
    "Use supported exact-transfer ERC-20s. Check token addresses, amounts and approvals before submission.",
    "The wallet pays gas. Failed transactions can consume gas. Independent approvals may remain after a later rejection or revert.",
  ],
};

export function jsonSafe(input: unknown): Json {
  return JSON.parse(
    JSON.stringify(input, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as Json;
}

export function agentError(error: unknown): string {
  if (protocolErrorName(error)) return explainError(error);
  const message = explainError(error);
  if (/eth_simulateV1|simulate calls|method not found/i.test(message))
    return "This RPC does not support batch simulation. Use a compatible RPC or simulate after confirmed approvals with atomic=false.";
  return message.replace(/https?:\/\/\S+/gi, "[redacted URL]").slice(0, 500);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined)
    throw new Error(`Specify ${label} for this operation`);
  return value;
}

function units(amount: string, token: TokenInfo, positive = false) {
  if (!positive && decimalFraction(amount)[0] === 0n) return 0n;
  const value = tokenAmount(amount, token.decimals);
  if (positive && (value <= 0n || value > MAX_AMOUNT))
    throw new Error(
      `Amount must be positive and within the protocol bounds for ${token.symbol}`,
    );
  return value;
}

function tokenAmountInfo(token: TokenInfo, raw: bigint): TokenAmount {
  return {
    token,
    raw: raw.toString(),
    amount: formatUnits(raw, token.decimals),
  };
}

function providerAmounts(
  position: ProviderPosition,
  asset: TokenInfo,
  quote: TokenInfo,
) {
  return {
    status: "open",
    availableAsset: tokenAmountInfo(asset, position.activeAvailable),
    workingAsset: tokenAmountInfo(asset, position.activeWorking),
    resolvingAsset: tokenAmountInfo(asset, position.resolvingPrincipal),
    claimableExitAsset: tokenAmountInfo(asset, position.claimableExitAsset),
    claimableYield: tokenAmountInfo(
      asset,
      position.claimableActiveYieldAsset + position.claimableExitYieldAsset,
    ),
    claimableQuote: tokenAmountInfo(
      quote,
      position.claimableActiveQuote + position.claimableExitQuote,
    ),
    vestingElapsedSeconds: position.vestingElapsedSeconds.toString(),
    vestingDurationSeconds: position.vestingDurationSeconds.toString(),
  };
}

class MarketReader {
  readonly sdk: EthereumClient;
  readonly network: ReturnType<typeof getNetwork>;
  private readonly metadata = new Map<string, Promise<TokenInfo>>();

  constructor(chain: string, { client, rpcUrl }: SkillsOptions) {
    this.network = getNetwork(chain);
    this.sdk = new EthereumClient(
      client?.(this.network.chain) ??
        createSkillsClient(this.network.chain, rpcUrl),
      this.network.id,
    );
  }

  token(address: Address): Promise<TokenInfo> {
    const key = address.toLowerCase();
    let metadata = this.metadata.get(key);
    if (!metadata) {
      metadata = this.sdk.tokenMetadata(address).then((token) => ({
        ...token,
        address: getAddress(token.address),
        listed: !!registry.getToken(this.network.id, token.address),
      }));
      this.metadata.set(key, metadata);
    }
    return metadata;
  }

  pair(a: Address, b: Address) {
    return canonicalPair(this.network.id, a, b) as readonly [Address, Address];
  }

  async tickDetails(tick: TickState) {
    const [asset, quote] = await Promise.all([
      this.token(tick.asset),
      this.token(tick.quote),
    ]);
    const [baseToken, quoteToken] = displayTokens({
      token0:
        asset.address.toLowerCase() < quote.address.toLowerCase()
          ? asset
          : quote,
      token1:
        asset.address.toLowerCase() < quote.address.toLowerCase()
          ? quote
          : asset,
    });
    const ask = asset.address === baseToken.address;
    return {
      asset,
      quote,
      baseToken,
      quoteToken,
      side: ask ? "ask" : "bid",
      priceQuotePerAsset: humanPrice(
        tick.priceX128,
        asset.decimals,
        quote.decimals,
      ),
      marketPrice: humanPrice(
        tick.priceX128,
        asset.decimals,
        quote.decimals,
        !ask,
      ),
      durationDays: tick.durationDays.toString(),
      available: tokenAmountInfo(asset, tick.availableSupply),
      working: tokenAmountInfo(asset, tick.activeWorking),
      resolving: tokenAmountInfo(asset, tick.exitWorking),
      marginalTermYieldPercent: marginalYieldPercent(tick) ?? null,
    };
  }

  async provide(
    input: Pick<
      ParsedInput<"prepare">,
      | "tickId"
      | "tokenA"
      | "tokenB"
      | "asset"
      | "price"
      | "durationDays"
      | "amount"
    >,
    blockNumber: bigint,
  ) {
    const hasIdentity = [
      input.tokenA,
      input.tokenB,
      input.asset,
      input.price,
      input.durationDays,
    ].some((value) => value !== undefined);
    if (input.tickId !== undefined) {
      if (hasIdentity)
        throw new Error("Use tickId or specify a new Limit price and pair");
      const tickId = BigInt(input.tickId);
      const tick = await this.sdk.getTick(tickId, blockNumber);
      const details = await this.tickDetails(tick);
      const amount = units(
        required(input.amount, "amount"),
        details.asset,
        true,
      );
      return { action: { kind: "supply", tickId, amount } as const, details };
    }
    const [tokenA, tokenB] = this.pair(
      required(input.tokenA, "tokenA"),
      required(input.tokenB, "tokenB"),
    );
    const assetAddress = required(input.asset, "asset").toLowerCase();
    if (assetAddress !== tokenA && assetAddress !== tokenB)
      throw new Error("Asset must be one of the pair's two tokens");
    const direction = assetAddress === tokenA ? 0 : 1;
    const [asset, quote] = await Promise.all([
      this.token(assetAddress),
      this.token(direction === 0 ? tokenB : tokenA),
    ]);
    const pairId = pairIdFor(tokenA, tokenB);
    const { priceTick, price } = snappedPrice(
      required(input.price, "price"),
      asset.decimals,
      quote.decimals,
      1,
    );
    const durationDays = input.durationDays ?? 7;
    const tickId = tickIdFor(pairId, direction, priceTick, durationDays);
    const amount = units(required(input.amount, "amount"), asset, true);
    const action = {
      kind: "supply",
      tickId,
      amount,
      initialize: { tokenA, tokenB, direction, priceTick, durationDays },
    } as const;
    const existing = await this.sdk
      .getTick(tickId, blockNumber)
      .catch((error: unknown) => {
        if (protocolErrorName(error) !== "NotFound") throw error;
        return undefined;
      });
    return {
      action,
      details: {
        ...(existing
          ? await this.tickDetails(existing)
          : { asset, quote, marginalTermYieldPercent: null }),
        priceTick,
        durationDays: String(durationDays),
        priceQuotePerAsset: price,
        existing: !!existing,
      },
    };
  }

  async action(input: ParsedInput<"prepare">): Promise<EconomicAction> {
    const allowed: Record<typeof input.operation, readonly string[]> = {
      provide: [
        "tickId",
        "tokenA",
        "tokenB",
        "asset",
        "price",
        "durationDays",
        "amount",
      ],
      rent: ["tickId", "amount", "maxFullTermYieldAsset", "deadline"],
      swap: ["tickId", "amount", "maxQuoteIn", "deadline"],
      repay: ["positionId", "maxYieldAsset"],
      withdraw: ["tickId", "amount", "minImmediateAssetOut", "deadline"],
      close: ["positionId"],
      collect: ["tickId"],
      settle: ["tickId"],
    };
    for (const [key, value] of Object.entries(input)) {
      if (
        value !== undefined &&
        key !== "chain" &&
        key !== "account" &&
        key !== "operation" &&
        !allowed[input.operation].includes(key)
      )
        throw new Error(`${key} does not apply to ${input.operation}`);
    }
    const block = await this.sdk.publicClient.getBlock();
    if (input.operation === "provide")
      return (await this.provide(input, block.number)).action;
    if (input.operation === "repay" || input.operation === "close") {
      const positionId = BigInt(required(input.positionId, "positionId"));
      const position = await this.sdk.getUsePosition(positionId, block.number);
      if (input.operation === "close") {
        if (block.timestamp < position.maturity)
          throw new Error("The rental can be closed at or after maturity");
        return { kind: "close", positionId };
      }
      if (position.user.toLowerCase() !== input.account?.toLowerCase())
        throw new Error("Use the rental owner's address to Repay");
      const asset = await this.token(
        (await this.sdk.getTick(position.tickId, block.number)).asset,
      );
      return {
        kind: "repay",
        positionId,
        maxYieldAsset: units(
          required(input.maxYieldAsset, "maxYieldAsset"),
          asset,
        ),
      };
    }
    const tickId = BigInt(required(input.tickId, "tickId"));
    if (input.operation === "collect" || input.operation === "settle")
      return { kind: input.operation, tickId };
    const tick = await this.sdk.getTick(tickId, block.number);
    const asset = await this.token(tick.asset);
    const amount = units(required(input.amount, "amount"), asset, true);
    const expires =
      input.deadline === undefined
        ? block.timestamp + TRANSACTION_DEFAULTS.deadlineSeconds
        : BigInt(input.deadline);
    if (expires <= block.timestamp)
      throw new Error(
        "Deadline has passed. Re-quote and choose a future deadline.",
      );
    switch (input.operation) {
      case "rent":
        return {
          kind: "use",
          tickId,
          amount,
          deadline: expires,
          maxFullTermYieldAsset: units(
            required(input.maxFullTermYieldAsset, "maxFullTermYieldAsset"),
            asset,
          ),
        };
      case "swap":
        return {
          kind: "swap",
          tickId,
          amount,
          deadline: expires,
          maxQuoteIn: units(
            required(input.maxQuoteIn, "maxQuoteIn"),
            await this.token(tick.quote),
          ),
        };
      case "withdraw":
        return {
          kind: "withdraw",
          tickId,
          amount,
          deadline: expires,
          minImmediateAssetOut: units(
            required(input.minImmediateAssetOut, "minImmediateAssetOut"),
            asset,
          ),
        };
    }
  }

  async quote(input: ParsedInput<"quote">) {
    const block = await this.sdk.publicClient.getBlock();
    const snapshot = {
      operation: input.operation,
      blockNumber: block.number.toString(),
      timestamp: block.timestamp.toString(),
    };
    if (input.operation === "provide") {
      const { action, details } = await this.provide(input, block.number);
      return {
        ...snapshot,
        ...details,
        tickId: action.tickId.toString(),
        requiredInput: tokenAmountInfo(details.asset, action.amount),
        yieldNote:
          "Provider yield depends on subsequent usage, vesting and settlement.",
      };
    }
    if (input.operation === "repay") {
      const positionId = BigInt(required(input.positionId, "positionId"));
      const position = await this.sdk.getUsePosition(positionId, block.number);
      const details = await this.tickDetails(
        await this.sdk.getTick(position.tickId, block.number),
      );
      const requirement = await this.sdk.requiredInput(
        {
          kind: "repay",
          positionId,
          maxYieldAsset: position.fullTermYieldAsset,
        },
        block,
      );
      const resulting = required(requirement, "repayment requirements");
      return {
        ...snapshot,
        positionId: String(positionId),
        ...details,
        maturity: String(position.maturity),
        requiredInput: tokenAmountInfo(details.asset, resulting.amount),
        accruedYield: tokenAmountInfo(
          details.asset,
          resulting.amount - position.assetAmount,
        ),
        maximumAccrual: tokenAmountInfo(
          details.asset,
          position.fullTermYieldAsset,
        ),
        unlockedQuote: tokenAmountInfo(details.quote, position.quotePrincipal),
      };
    }
    const tickId = BigInt(required(input.tickId, "tickId"));
    const tick = await this.sdk.getTick(tickId, block.number);
    const details = await this.tickDetails(tick);
    const amount = units(required(input.amount, "amount"), details.asset, true);
    if (amount > tick.availableSupply)
      throw new Error("Amount exceeds available liquidity at this tick");
    const contract = getContract({
      address: this.sdk.address,
      abi: protocolAbi,
      client: this.sdk.publicClient,
    });
    const [[principal, fullYield], feeBps] = await Promise.all([
      this.sdk.quoteUse(tickId, amount, block.number),
      contract.read.PROTOCOL_FEE_BPS({ blockNumber: block.number }),
    ]);
    const fee = (principal * feeBps) / BASIS_POINTS;
    const result = {
      ...snapshot,
      ...details,
      tickId: String(tickId),
      requiredInput: tokenAmountInfo(details.quote, principal),
      expectedOutput: tokenAmountInfo(details.asset, amount),
    };
    return input.operation === "rent"
      ? {
          ...result,
          estimatedMaturity: String(
            block.timestamp + tick.durationDays * 86400n,
          ),
          fullTermYield: tokenAmountInfo(details.asset, fullYield),
          fullTermRepayment: tokenAmountInfo(details.asset, amount + fullYield),
          closeFee: tokenAmountInfo(details.quote, fee),
        }
      : {
          ...result,
          swapFeeIncludedInQuote: tokenAmountInfo(details.quote, fee),
        };
  }
}

export function createSkills(options: SkillsOptions = {}) {
  const reader = async (chain: string) => {
    const market = new MarketReader(chain, options);
    if ((await market.sdk.publicClient.getChainId()) !== market.sdk.chainId)
      throw new Error(
        `The RPC endpoint is not connected to ${market.network.name}`,
      );
    return market;
  };
  const sender = (account?: Address) => {
    const address = getAddress(
      required(account ?? options.account, "account").toLowerCase(),
    );
    if (address === zeroAddress) throw new Error("Specify a nonzero account");
    return address;
  };

  const api = {
    protocol: (_input: CommandInput<"protocol"> = {}) => protocolInfo,
    networks: (_input: CommandInput<"networks"> = {}) => ({
      networks: networks.map(({ id, slug, name, chain }) => ({
        id,
        slug,
        name,
        chainId: chain.id,
        deployment: deploymentFor(id),
      })),
    }),
    async markets(input: CommandInput<"markets"> = {}) {
      const { chain, token, offset, limit } =
        commandInputs.markets.parse(input);
      const r = await reader(chain);
      const list = token
        ? registry.getMarketsByToken(r.network.id, token)
        : registry.getMarkets(r.network.id);
      const markets = await Promise.all(
        list.slice(offset, offset + limit).map(async (market) => {
          const tokens = await Promise.allSettled([
            r.token(market.token0.address as Address),
            r.token(market.token1.address as Address),
          ]);
          const [a, b] = tokens;
          return {
            key: market.key,
            token0: market.token0.address,
            token1: market.token1.address,
            display:
              a.status === "fulfilled" && b.status === "fulfilled"
                ? displayTokens({ token0: a.value, token1: b.value })
                : null,
            defaultDurationDays: Number(market.defaultDuration),
            centerTick: market.baseTick ?? null,
            stepTicks: market.stepTicks,
            tags: market.tags?.map(String) ?? [],
          };
        }),
      );
      return {
        chainId: r.sdk.chainId,
        total: list.length,
        offset,
        nextOffset: offset + limit < list.length ? offset + limit : null,
        markets,
      };
    },
    async book(input: CommandInput<"book">) {
      const {
        chain,
        tokenA,
        tokenB,
        durationDays,
        centerTick,
        referencePrice,
        stepTicks,
        radius,
      } = commandInputs.book.parse(input);
      const r = await reader(chain);
      const [a, b] = r.pair(tokenA, tokenB);
      const market = registry.getMarket(r.network.id, a, b);
      const step =
        stepTicks ?? market?.stepTicks ?? DISCOVERY_DEFAULTS.stepTicks;
      const configuredCenter = market?.baseTick ?? 0;
      if (centerTick !== undefined && referencePrice !== undefined)
        throw new Error("Specify one of centerTick and referencePrice");
      let center = centerTick ?? Math.trunc(configuredCenter / step) * step;
      if (referencePrice !== undefined) {
        const [aToken, bToken] = await Promise.all([r.token(a), r.token(b)]);
        const [baseToken] = displayTokens({ token0: aToken, token1: bToken });
        center = snappedPrice(
          referencePrice,
          aToken.decimals,
          bToken.decimals,
          step,
          baseToken.address !== aToken.address,
        ).priceTick;
      }
      const pairId = pairIdFor(a, b);
      const data = await r.sdk.discover(pairId, {
        baseTick: center,
        stepTicks: step,
        radius,
        duration: durationDays,
      });
      const levels = await Promise.all(
        data.reads
          .flatMap((read) => (read.status === "exists" ? [read.tick] : []))
          .map(async (tick) => ({
            tickId: String(tick.id),
            direction: Number(tick.direction),
            priceTick: tick.priceTick,
            ...(await r.tickDetails(tick.state)),
          })),
      );
      return {
        chainId: r.sdk.chainId,
        pairId: String(pairId),
        market: `${a}:${b}`,
        blockNumber: String(data.blockNumber),
        window: {
          centerTick: center,
          stepTicks: step,
          radius,
          durationDays,
          checked: data.reads.length,
          complete: data.complete,
        },
        missing: data.reads.filter((read) => read.status === "missing").length,
        failed: data.reads
          .filter((read) => read.status === "failed")
          .map(({ identity }) => String(identity.id)),
        bids: levels.filter((level) => level.side === "bid"),
        asks: levels.filter((level) => level.side === "ask"),
        scope:
          "The window covers only the selected duration and price grid. Supply outside this window may exist.",
      };
    },
    async balances(input: CommandInput<"balances"> = {}) {
      const { chain, account, tokens } = commandInputs.balances.parse(input);
      const r = await reader(chain);
      const owner = sender(account);
      const selected = [
        ...new Set(tokens.map((token) => token.toLowerCase() as Address)),
      ];
      const [native, erc20] = await Promise.all([
        r.sdk.publicClient.getBalance({ address: owner }),
        Promise.all(
          selected.map(async (address) => {
            const [token, balance] = await Promise.all([
              r.token(address),
              r.sdk.balance(address, owner),
            ]);
            return tokenAmountInfo(token, balance);
          }),
        ),
      ]);
      return {
        chainId: r.sdk.chainId,
        account: owner,
        native: tokenAmountInfo(
          {
            address: zeroAddress,
            ...r.network.chain.nativeCurrency,
            listed: true,
          },
          native,
        ),
        tokens: erc20,
      };
    },
    async portfolio(input: CommandInput<"portfolio"> = {}) {
      const { chain, account, offset, limit, blockNumber } =
        commandInputs.portfolio.parse(input);
      const r = await reader(chain);
      const owner = sender(account);
      const page = await r.sdk.portfolio(
        owner,
        offset,
        limit,
        blockNumber === undefined ? undefined : BigInt(blockNumber),
      );
      const [provides, rentals] = await Promise.all([
        Promise.all(
          page.providers.map(async ({ tickId, position, tick }) => {
            const details = await r.tickDetails(tick);
            return {
              tickId: String(tickId),
              ...details,
              ...providerAmounts(position, details.asset, details.quote),
            };
          }),
        ),
        Promise.all(
          page.uses.map(async ({ positionId, position, tick }) => {
            const details = await r.tickDetails(tick);
            const matured = page.timestamp >= position.maturity;
            const repay = matured
              ? undefined
              : await r.sdk.requiredInput(
                  {
                    kind: "repay",
                    positionId,
                    maxYieldAsset: position.fullTermYieldAsset,
                  },
                  { number: page.blockNumber, timestamp: page.timestamp },
                );
            return {
              positionId: String(positionId),
              tickId: String(position.tickId),
              ...details,
              openedAt: String(position.openedAt),
              maturity: String(position.maturity),
              status: matured ? "matured" : "repayable",
              receivedAsset: tokenAmountInfo(
                details.asset,
                position.assetAmount,
              ),
              lockedQuote: tokenAmountInfo(
                details.quote,
                position.quotePrincipal,
              ),
              closeFee: tokenAmountInfo(details.quote, position.closeFee),
              fullTermYield: tokenAmountInfo(
                details.asset,
                position.fullTermYieldAsset,
              ),
              repaymentNow: repay
                ? tokenAmountInfo(details.asset, repay.amount)
                : null,
              nextAction: matured ? "close" : "repay",
            };
          }),
        ),
      ]);
      return {
        account: owner,
        chainId: r.sdk.chainId,
        blockNumber: String(page.blockNumber),
        timestamp: String(page.timestamp),
        nextOffset: page.hasMore ? offset + limit : null,
        provides,
        rentals,
      };
    },
    async quote(input: CommandInput<"quote">) {
      const request = commandInputs.quote.parse(input);
      return (await reader(request.chain)).quote(request);
    },
    async prepare(
      input: CommandInput<"prepare">,
    ): Promise<PreparedTransaction> {
      const request = commandInputs.prepare.parse(input);
      const r = await reader(request.chain);
      const account = sender(request.account);
      const action = await r.action({ ...request, account });
      const prepared = await r.sdk.prepareWalletCalls(action, account);
      const approvalCalls = prepared.walletCalls.length - 1;
      const token = prepared.input && (await r.token(prepared.input.token));
      let market: PreparedTransaction["market"];
      if (action.kind === "supply" && action.initialize) {
        const { tokenA, tokenB, direction } = action.initialize;
        market = {
          asset: await r.token(direction === 0 ? tokenA : tokenB),
          quote: await r.token(direction === 0 ? tokenB : tokenA),
        };
      } else {
        const tickId =
          "tickId" in action
            ? action.tickId
            : "positionId" in action
              ? (
                  await r.sdk.getUsePosition(
                    action.positionId,
                    prepared.blockNumber,
                  )
                ).tickId
              : undefined;
        const tick = await r.sdk.getTick(
          required(tickId, "tick ID"),
          prepared.blockNumber,
        );
        market = {
          asset: await r.token(tick.asset),
          quote: await r.token(tick.quote),
        };
      }
      const detail =
        action.kind === "supply" && action.initialize
          ? {
              priceQuotePerAsset: humanPrice(
                priceAtTick(action.initialize.priceTick),
                market.asset.decimals,
                market.quote.decimals,
              ),
              ...action,
            }
          : action;
      return {
        plan: {
          chainId: r.sdk.chainId,
          account,
          calls: prepared.walletCalls.map((call) => ({ ...call, value: "0" })),
        },
        operation: request.operation,
        blockNumber: String(prepared.blockNumber),
        timestamp: String(prepared.timestamp),
        market,
        execution: {
          atomicBatchRecommended: approvalCalls > 0,
          approvalCalls,
          protocolCallsAtomic: true,
          steps: approvalCalls
            ? [
                "An atomic wallet batch executes approvals and the protocol call together.",
                "Otherwise send approvals in listed order, confirm them, refresh preparation and simulate before submitting the protocol call.",
              ]
            : [
                "Submit the protocol call as one transaction. Any nested protocol initialization is atomic.",
              ],
        },
        inputs:
          prepared.input && token
            ? {
                required: tokenAmountInfo(token, prepared.input.amount),
                approvalCap: tokenAmountInfo(
                  token,
                  prepared.input.allowanceAmount,
                ),
              }
            : undefined,
        details: jsonSafe(detail),
      };
    },
    async simulate(input: CommandInput<"simulate">): Promise<Json> {
      const { atomic, ...request } = commandInputs.simulate.parse(input);
      const r = await reader(request.chain);
      const account = sender(request.account);
      const action = await r.action({ ...request, account });
      const result = await r.sdk.preview(action, account, { atomic });
      const { plan, walletCalls, ...preview } = result;
      const tick = preview.tick ? await r.tickDetails(preview.tick) : undefined;
      const output = tick && {
        market: tick,
        provider:
          preview.provider &&
          providerAmounts(preview.provider, tick.asset, tick.quote),
        swap: preview.swap && {
          input: tokenAmountInfo(tick.quote, preview.swap.quotePrincipal),
          output: tokenAmountInfo(tick.asset, preview.swap.assetAmount),
          fee: tokenAmountInfo(tick.quote, preview.swap.swapFee),
        },
        rent: preview.position && {
          receivedAsset: tokenAmountInfo(
            tick.asset,
            preview.position.assetAmount,
          ),
          lockedQuote: tokenAmountInfo(
            tick.quote,
            preview.position.quotePrincipal,
          ),
          fullTermYield: tokenAmountInfo(
            tick.asset,
            preview.position.fullTermYieldAsset,
          ),
          maturity: String(preview.position.maturity),
        },
        repay: preview.repay && {
          input: tokenAmountInfo(tick.asset, preview.repay.totalAssetIn),
          unlockedQuote: tokenAmountInfo(
            tick.quote,
            preview.repay.quotePrincipalUnlocked,
          ),
        },
        withdraw: preview.withdraw && {
          immediateAsset: tokenAmountInfo(
            tick.asset,
            preview.withdraw.availableAssetOut + preview.withdraw.yieldAssetOut,
          ),
          principalEnteringExit: tokenAmountInfo(
            tick.asset,
            preview.withdraw.workingToExit,
          ),
        },
        collect: preview.collect && {
          assetOut: tokenAmountInfo(tick.asset, preview.collect.totalAssetOut),
          quoteOut: tokenAmountInfo(tick.quote, preview.collect.totalQuoteOut),
        },
      };
      return jsonSafe({
        ...preview,
        display: output,
        status: "simulated",
        approvalsIncluded: atomic,
        plan: {
          chainId: r.sdk.chainId,
          account,
          calls: (
            walletCalls ?? [
              {
                to: r.sdk.address,
                data: encodeFunctionData({
                  abi: protocolAbi,
                  functionName: "multicall",
                  args: [plan.calls],
                }),
              },
            ]
          ).map((call) => ({ to: call.to, data: call.data, value: "0" })),
        },
      });
    },
    async status(input: CommandInput<"status">): Promise<Json> {
      const { chain, hash } = commandInputs.status.parse(input);
      const r = await reader(chain);
      const client = r.sdk.publicClient;
      const receipt = await client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.name === "TransactionReceiptNotFoundError"
          )
            return null;
          throw error;
        });
      if (!receipt) {
        try {
          const transaction = await client.getTransaction({ hash });
          return jsonSafe({
            hash,
            chainId: r.sdk.chainId,
            status:
              transaction.blockNumber === null ? "pending" : "receipt_pending",
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.name === "TransactionNotFoundError"
          )
            return jsonSafe({
              hash,
              chainId: r.sdk.chainId,
              status: "unknown",
            });
          throw error;
        }
      }
      const events = parseEventLogs({
        abi: protocolAbi,
        strict: true,
        logs: receipt.logs.filter(
          (log) => log.address.toLowerCase() === r.sdk.address.toLowerCase(),
        ),
      }).map(({ eventName, args }) => ({ eventName, args }));
      return jsonSafe({
        hash,
        chainId: r.sdk.chainId,
        status: receipt.status === "success" ? "confirmed" : "reverted",
        receipt: {
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          from: receipt.from,
          to: receipt.to,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        },
        events,
      });
    },
  };
  return api;
}
