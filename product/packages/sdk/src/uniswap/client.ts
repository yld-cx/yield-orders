import {
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
} from "viem";
import {
  parseSwapInput,
  rawAmount,
  record,
  same,
  SwapError,
  type SwapInput,
  type SwapQuoteResult,
  type SwapTransaction,
  type SwapPriceResult,
} from "./types.ts";
import { PERMIT2, ROUTE_VERSION, permit2Abi, swapNetwork } from "./config.ts";
import { boundedJson } from "./json.ts";

export interface UniswapOptions {
  apiKey: string;
  router?: Address;
  fetch?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  beforeRequest?: () => void;
}
export class UniswapClient {
  private readonly options: UniswapOptions;

  constructor(options: UniswapOptions) {
    this.options = options;
  }
  private async post(
    endpoint: "quote" | "swap",
    input: SwapInput,
    body: unknown,
  ) {
    if (!this.options.apiKey)
      throw new SwapError("Swap service unavailable", 503);
    this.options.beforeRequest?.();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `https://trade-api.gateway.uniswap.org/v1/${endpoint}`,
        {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal: this.options.signal
            ? AbortSignal.any([this.options.signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.options.apiKey,
            "x-universal-router-version": ROUTE_VERSION,
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new SwapError("Swap provider timed out or is unavailable", 504);
    }
    if (!response.ok)
      throw new SwapError(
        response.status === 422 || response.status === 404
          ? "No compatible route for these tokens"
          : response.status === 429
            ? "Swap provider rate limit; retry later"
            : "Swap provider unavailable",
        [422, 429, 404].includes(response.status) ? response.status : 502,
      );
    return record(await boundedJson(response));
  }
  private router(input: SwapInput) {
    const router = this.options.router ?? swapNetwork(input.chainId)?.router;
    if (!router) throw new SwapError("Unsupported swap chain");
    return router;
  }
  private transaction(
    value: unknown,
    input: SwapInput,
    target = this.router(input),
  ): SwapTransaction {
    const tx = record(value);
    if (
      !same(tx.to, target) ||
      tx.chainId !== input.chainId ||
      (tx.from !== undefined && !same(tx.from, input.swapper)) ||
      typeof tx.data !== "string" ||
      !/^0x[0-9a-fA-F]{8,32768}$/.test(tx.data) ||
      tx.data.length % 2 !== 0 ||
      typeof tx.value !== "string" ||
      !/^(0|0x0+)$/.test(tx.value)
    )
      throw new SwapError("Unsafe swap transaction", 502);
    return {
      to: target,
      data: tx.data as `0x${string}`,
      value: "0",
      chainId: input.chainId,
    };
  }
  private permit(value: unknown, input: SwapInput, now: number) {
    if (value === null || value === undefined) return undefined;
    const tx = this.transaction(value, input, PERMIT2);
    const decoded = decodeFunctionData({ abi: permit2Abi, data: tx.data });
    if (
      decoded.functionName !== "approve" ||
      !same(decoded.args[0], input.tokenIn) ||
      !same(decoded.args[1], this.router(input)) ||
      decoded.args[2] !== BigInt(input.amount) ||
      decoded.args[3] < Math.floor(now / 1000) + 45 ||
      tx.data.toLowerCase() !==
        `0x87517c45${encodeAbiParameters(parseAbiParameters("address,address,uint160,uint48"), decoded.args).slice(2)}`.toLowerCase()
    )
      throw new SwapError("Unsafe Permit2 authorization", 502);
    return tx;
  }
  private async requestQuote(value: SwapInput) {
    const now = (this.options.now ?? Date.now)();
    const input = parseSwapInput(value, now);
    const source = { generatePermitAsTransaction: true, permitAmount: "EXACT" };
    const response = await this.post("quote", input, {
      type: "EXACT_INPUT",
      tokenInChainId: input.chainId,
      tokenOutChainId: input.chainId,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amount: input.amount,
      swapper: input.swapper,
      recipient: input.swapper,
      slippageTolerance: input.slippage,
      // Search all supported AMM versions, excluding signature-based UniswapX.
      routingPreference: "BEST_PRICE",
      protocols: ["V2", "V3", "V4"],
      ...source,
    });
    if (response.routing !== "CLASSIC" || response.permitData !== null)
      throw new SwapError("Unsupported swap route or authorization", 422);
    const quote = record(response.quote),
      from = record(quote.input),
      to = record(quote.output);
    if (
      quote.chainId !== input.chainId ||
      quote.tradeType !== "EXACT_INPUT" ||
      !same(quote.swapper, input.swapper) ||
      !same(from.token, input.tokenIn) ||
      from.amount !== input.amount ||
      !same(to.token, input.tokenOut) ||
      !same(to.recipient, input.swapper) ||
      quote.slippage !== input.slippage
    )
      throw new SwapError("Mismatched quote", 502);
    const amountOut = rawAmount(to.amount);
    // The API's aggregated output floor is authoritative, not an invented schema.
    if (
      !Array.isArray(quote.aggregatedOutputs) ||
      quote.aggregatedOutputs.length !== 1
    )
      throw new SwapError("Unsupported output recipients", 422);
    const output = record(quote.aggregatedOutputs[0]);
    if (
      !same(output.token, input.tokenOut) ||
      !same(output.recipient, input.swapper) ||
      output.fee ||
      output.bps !== 10000 ||
      output.amount !== amountOut
    )
      throw new SwapError("Unsafe output recipient", 502);
    const minimum = rawAmount(output.minAmount);
    const slippageBps = BigInt(Math.ceil(input.slippage * 100));
    if (
      BigInt(minimum) > BigInt(amountOut) ||
      BigInt(minimum) < (BigInt(amountOut) * (10000n - slippageBps)) / 10000n
    )
      throw new SwapError("Invalid output minimum", 502);
    return { now, input, response, quote, amountOut, minimum };
  }

  async price(value: SwapInput): Promise<SwapPriceResult> {
    const { now, input, quote, amountOut, minimum } =
      await this.requestQuote(value);
    const impact = quote.priceImpact;
    if (
      impact !== undefined &&
      (typeof impact !== "number" ||
        !Number.isFinite(impact) ||
        impact < 0 ||
        impact > 100)
    )
      throw new SwapError("Invalid reference price impact", 502);
    return {
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amount,
      estimatedAmountOut: amountOut,
      minimumAmountOut: minimum,
      quotedAt: now,
      ...(impact === undefined ? {} : { priceImpact: impact as number }),
      ...(typeof quote.blockNumber === "number" &&
      Number.isSafeInteger(quote.blockNumber) &&
      quote.blockNumber > 0
        ? { blockNumber: String(quote.blockNumber) }
        : typeof quote.blockNumber === "string" &&
            /^[1-9]\d{0,19}$/.test(quote.blockNumber)
          ? { blockNumber: quote.blockNumber }
          : {}),
    };
  }

  async quote(value: SwapInput): Promise<SwapQuoteResult> {
    const { now, input, response, quote, amountOut, minimum } =
      await this.requestQuote(value);
    const permitTransaction = this.permit(
      response.permitTransaction,
      input,
      now,
    );
    let transaction = response.swapTransaction;
    if (!transaction || input.deadline !== undefined) {
      const built = await this.post("swap", input, {
        quote,
        ...(input.deadline ? { deadline: input.deadline } : {}),
        safetyMode: "SAFE",
      });
      transaction = built.swap;
    }
    const validated = this.transaction(transaction, input);
    return {
      chainId: input.chainId,
      mode: input.mode,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      amountIn: input.amount,
      estimatedAmountOut: amountOut,
      minimumAmountOut: minimum,
      routing: "CLASSIC",
      routeVersion: ROUTE_VERSION,
      quotedAt: now,
      expiresAt: Math.min(
        now + 45000,
        input.deadline ? input.deadline * 1000 : Infinity,
      ),
      routeId:
        typeof quote.quoteId === "string"
          ? quote.quoteId.slice(0, 128)
          : "unknown",
      transaction: validated,
      ...(input.mode === "wallet-router" && permitTransaction
        ? { permitTransaction }
        : {}),
    };
  }
}
