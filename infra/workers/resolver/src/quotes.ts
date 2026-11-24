import {
  SwapError,
  type UniswapClient,
  type SwapChain,
} from "@yld-cx/sdk/uniswap";
import type { Address } from "viem";
import type { Candidate } from "./shared.ts";
import { quotePrincipal, type Tick } from "./ticks.ts";
export class Quotes {
  remaining: number;
  readonly api: UniswapClient;
  readonly chainId: SwapChain;
  readonly resolver: Address;
  readonly slippage: number;
  constructor(
    api: UniswapClient,
    chainId: SwapChain,
    resolver: Address,
    slippage: number,
    budget: number,
  ) {
    this.api = api;
    this.chainId = chainId;
    this.resolver = resolver;
    this.slippage = slippage;
    this.remaining = budget;
  }
  chargeRequest() {
    if (this.remaining <= 0) throw new Error("QuoteBudgetExceeded");
    this.remaining--;
  }
  async leg(input: Address, output: Address, amount: bigint, deadline: number) {
    if (this.remaining <= 0) throw new Error("QuoteBudgetExceeded");
    try {
      return await this.api.quote({
        chainId: this.chainId,
        mode: "resolver-router",
        tokenIn: input,
        tokenOut: output,
        amount: amount.toString(),
        swapper: this.resolver,
        slippage: this.slippage,
        deadline,
      });
    } catch (error) {
      // Stop this pass after 429; the next cron invocation supplies backoff.
      if (error instanceof SwapError && error.status === 429)
        this.remaining = 0;
      throw error;
    }
  }
  async price(input: Address, output: Address, amount: bigint) {
    if (this.remaining <= 0) throw new Error("QuoteBudgetExceeded");
    try {
      return await this.api.price({
        chainId: this.chainId,
        mode: "resolver-router",
        tokenIn: input,
        tokenOut: output,
        amount: amount.toString(),
        swapper: this.resolver,
        slippage: this.slippage,
      });
    } catch (error) {
      if (error instanceof SwapError && error.status === 429)
        this.remaining = 0;
      throw error;
    }
  }
  async reference(
    input: Address,
    output: Address,
    amount: bigint,
    maximumImpact: number,
  ) {
    let reference = await this.price(input, output, amount);
    for (
      let attempt = 0;
      attempt < 2 &&
      amount > 1n &&
      reference.priceImpact !== undefined &&
      reference.priceImpact > maximumImpact;
      attempt++
    ) {
      amount = amount / 10n || 1n;
      reference = await this.price(input, output, amount);
    }
    return reference;
  }
  async candidate(
    tick: Tick,
    amount: bigint,
    flashToken: Address,
    flashAmount: bigint,
  ): Promise<Candidate | undefined> {
    const cost = quotePrincipal(amount, tick.priceX128);
    if (cost <= 0n || cost > 10n ** 30n) return;
    const mode =
      flashToken.toLowerCase() === tick.quote.toLowerCase()
        ? 0
        : flashToken.toLowerCase() === tick.asset.toLowerCase()
          ? 1
          : 2;
    if (mode === 0) flashAmount = cost;
    if (mode === 1) flashAmount = amount;
    const deadline = Math.floor(Date.now() / 1000) + 180;
    const pre =
      mode !== 0
        ? await this.leg(flashToken, tick.quote, flashAmount, deadline)
        : undefined;
    if (pre && BigInt(pre.minimumAmountOut) < cost) return;
    const post =
      mode !== 1
        ? await this.leg(tick.asset, flashToken, amount, deadline)
        : undefined;
    const surplus =
      mode === 1
        ? BigInt(pre!.minimumAmountOut) - cost
        : BigInt(post!.minimumAmountOut) - flashAmount;
    if (surplus <= 0n) return;
    return {
      mode,
      surplusToken: mode === 1 ? tick.quote : flashToken,
      surplus,
      quotedAt: Math.min(pre?.quotedAt ?? Infinity, post?.quotedAt ?? Infinity),
      routeIds: [pre?.routeId, post?.routeId].filter((x): x is string => !!x),
      order: {
        tickId: tick.id,
        amount,
        flashToken,
        flashAmount,
        deadline: BigInt(deadline),
        preSwapData: pre?.transaction.data ?? "0x",
        postSwapData: post?.transaction.data ?? "0x",
      },
    };
  }
}
