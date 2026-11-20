import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  http,
  keccak256,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { estimateL1Fee } from "viem/op-stack";
import { deploymentFor, getNetwork, protocolAbi } from "@yld-cx/sdk/ethereum";
import {
  UniswapClient,
  address,
  record,
  swapNetwork,
  type SwapChain,
} from "@yld-cx/sdk/uniswap";

import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import core from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { chainConfig, LIMITS } from "./config.ts";
import { markets, roundRobin } from "./markets.ts";
import {
  ticks,
  fundedSizes,
  referenceAmount,
  quotePrincipal,
} from "./ticks.ts";
import { Quotes } from "./quotes.ts";
import { abi, simulate } from "./simulate.ts";
import { errorKind, log, setting, type Candidate, type Env } from "./shared.ts";

interface Deployment {
  morpho: Address;
  permit2: Address;
  router: Address;
  resolver: Address | null;
  resolverCodeHash: Hex | null;
}
export interface Pending {
  hash: Hex;
  nonce: number;
  createdAt: number;
  resolver: Address;
  expectedBitmap: string;
  expectedGross: string;
  expectedGasCost: string;
}
export interface State {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export function netPositive(gross: bigint, gas: bigint, threshold = 0n) {
  return gross - gas > threshold;
}
export async function observePending(
  client: PublicClient,
  state: State,
  chainId: number,
) {
  const pending = await state.get<Pending>("pending");
  if (!pending) return false;
  try {
    const receipt = await client.getTransactionReceipt({ hash: pending.hash });
    // Keep the nonce reserved until confirmation beyond the inclusion block.
    if ((await client.getBlockNumber()) < receipt.blockNumber + 3n) return true;
    const events = parseEventLogs({
      abi,
      logs: receipt.logs.filter(
        (entry) =>
          entry.address.toLowerCase() === pending.resolver.toLowerCase(),
      ),
    });
    let bitmap = 0n;
    for (const event of events)
      if (event.eventName === "ExecutionSucceeded")
        bitmap |= 1n << BigInt((event.args as { index: bigint }).index);
    log({
      type: "resolver_receipt",
      chainId,
      hash: pending.hash,
      status: receipt.status,
      gasUsed: receipt.gasUsed,
      bitmap,
      expectedBitmap: pending.expectedBitmap,
      partial: bitmap.toString() !== pending.expectedBitmap,
      expectedGross: pending.expectedGross,
      expectedGasCost: pending.expectedGasCost,
      events: events.map((e) => ({ event: e.eventName, args: e.args })),
    });
    await state.delete("pending");
    return false;
  } catch {
    // Ambiguous send, dropped transaction or crash-before-broadcast: never blindly
    // reuse a nonce. Reconcile this hash/nonce operationally before clearing it.
    log({
      type: "resolver_pending",
      chainId,
      hash: pending.hash,
      ageMs: Date.now() - pending.createdAt,
    });
    return true;
  }
}

export async function resolveChain(
  env: Env,
  slug: string,
  state: State,
  dependencies: {
    client?: PublicClient;
    onStage?: (stage: string) => void;
  } = {},
): Promise<void> {
  const stage = (value: string) => dependencies.onStage?.(value);
  stage("configuration");
  const network = getNetwork(slug),
    chainId = network.chain.id as SwapChain;
  const config = manifest.chains[
    String(chainId) as keyof typeof manifest.chains
  ] as Deployment;
  if (
    config.router.toLowerCase() !== swapNetwork(chainId).router.toLowerCase() ||
    config.permit2.toLowerCase() !== swapNetwork(chainId).permit2.toLowerCase()
  )
    throw new Error("Uniswap configuration mismatch");
  const dryRun = env.DRY_RUN !== "false";
  if (!config.resolver) {
    log({ type: "resolver_gated", chainId });
    return;
  }
  if (!config.resolverCodeHash) throw new Error("Resolver code hash missing");
  const signer = env.RESOLVER_SIGNING_KEY
    ? privateKeyToAccount(env.RESOLVER_SIGNING_KEY)
    : undefined;
  if (!dryRun && !signer) throw new Error("Resolver signing key missing");
  const bot = signer?.address ?? "0x000000000000000000000000000000000000dEaD";
  const beneficiary = address(core.feeTo);
  const assets = chainConfig[chainId];
  const {
    accountingToken: accounting,
    wrappedNative,
    accountingDecimals: decimals,
  } = assets;
  const bridges = [...new Set([wrappedNative, accounting])];
  const started = Date.now(),
    duration = LIMITS.durationMs;
  const withinBudget = () => Date.now() - started < duration - 15000;
  const rpcValues = record(JSON.parse(env.RPC_URLS ?? "{}"))[slug];
  const urls = Array.isArray(rpcValues) ? rpcValues : assets.rpcUrls;
  if (
    !urls.length ||
    urls.length > 3 ||
    urls.some((u) => typeof u !== "string" || new URL(u).protocol !== "https:")
  )
    throw new Error("Invalid RPC configuration");
  const transport = fallback(
    urls.map((u) =>
      http(String(u), {
        timeout: 5000,
        retryCount: 0,
        batch: { batchSize: 25, wait: 0 },
      }),
    ),
    { retryCount: 1, retryDelay: 300 },
  );
  const client = (dependencies.client ??
    createPublicClient({
      chain: network.chain,
      transport,
      batch: { multicall: true },
    })) as PublicClient;
  stage("rpc_chain_check");
  if ((await client.getChainId()) !== chainId)
    throw new Error("RPC chain mismatch");
  stage("pending_transaction");
  if (await observePending(client, state, chainId)) return;
  stage("deployment_checks");
  const addresses = [
    config.resolver,
    config.morpho,
    config.router,
    config.permit2,
    deploymentFor(network.id).address,
  ];
  const codes = await Promise.all(
    addresses.map((address) => client.getCode({ address })),
  );
  if (!codes[0] || keccak256(codes[0]) !== config.resolverCodeHash)
    throw new Error("Resolver identity mismatch");
  if (codes.some((code) => !code || code === "0x"))
    throw new Error("Dependency deployment missing");
  const immutables = [
    ["YLD", deploymentFor(network.id).address],
    ["MORPHO", config.morpho],
    ["UNIVERSAL_ROUTER", config.router],
    ["PERMIT2", config.permit2],
  ] as const;
  const identities = await client.multicall({
    allowFailure: false,
    contracts: immutables.map(([functionName]) => ({
      address: config.resolver!,
      abi,
      functionName,
    })),
  });
  if (
    identities.some(
      (actual, index) =>
        String(actual).toLowerCase() !== immutables[index][1].toLowerCase(),
    )
  )
    throw new Error("Resolver immutable mismatch");
  const minNet = parseUnits(
    String(setting(env.MIN_EXPECTED_NET_USD, 0, 0, 10000)),
    decimals,
  );
  const quotes: Quotes = new Quotes(
    new UniswapClient({
      apiKey: env.UNISWAP_API_KEY ?? "",
      signal: AbortSignal.timeout(Math.max(1, started + duration - Date.now())),
      beforeRequest: () => quotes.chargeRequest(),
    }),
    chainId,
    config.resolver,
    LIMITS.slippage,
    LIMITS.quoteRequests,
  );
  stage("market_discovery");
  const marketList = await markets(
    env.MARKETS_API ?? "https://yld.cx/api/markets",
    chainId,
  );
  const cursor = (await state.get<number>("marketCursor")) ?? 0;
  const selected = roundRobin(marketList, cursor, LIMITS.markets);
  if (!selected.length) {
    await state.put(
      "marketCursor",
      marketList.length ? (cursor + selected.length) % marketList.length : 0,
    );
    return;
  }
  stage("market_snapshot");
  const [blockNumber, sizingFees] = await Promise.all([
    client.getBlockNumber(),
    client.estimateFeesPerGas(),
  ]);
  const fundingTokens = [
    ...new Set([...selected.flatMap((m) => [m.token0, m.token1]), ...bridges]),
  ];
  // Pair existence and all relevant flash liquidity share one block and one call.
  const snapshot = await client.multicall({
    blockNumber,
    allowFailure: true,
    contracts: [
      ...selected.map((m) => ({
        address: deploymentFor(network.id).address,
        abi: protocolAbi,
        functionName: "getPair" as const,
        args: [m.token0, m.token1] as const,
      })),
      ...fundingTokens.map((token) => ({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [config.morpho] as const,
      })),
    ],
  });
  const existing = new Set(
    selected
      .filter((market, i) => {
        const read = snapshot[i];
        return (
          read.status === "success" &&
          Array.isArray(read.result) &&
          read.result[3] === true &&
          read.result[0] === market.pairId
        );
      })
      .map((m) => m.pairId),
  );
  const flashBalances = new Map(
    fundingTokens.map((token, i) => {
      const read = snapshot[selected.length + i];
      return [
        token,
        read.status === "success" && typeof read.result === "bigint"
          ? read.result
          : 0n,
      ] as const;
    }),
  );
  const flashBalance = (token: Address) =>
    flashBalances.get(address(token)) ?? 0n;
  const metadata = await client.multicall({
    blockNumber,
    allowFailure: true,
    contracts: fundingTokens.map((token) => ({
      address: token,
      abi: erc20Abi,
      functionName: "decimals" as const,
    })),
  });
  const tokenDecimals = new Map(
    fundingTokens.flatMap((token, i) => {
      const read = metadata[i];
      return read.status === "success"
        ? [[token, Number(read.result)] as const]
        : [];
    }),
  );
  const valueInAccounting = async (
    token: Address,
    amount: bigint,
    gas = false,
  ) => {
    if (token.toLowerCase() === accounting.toLowerCase()) return amount;
    const route = await quotes.price(token, accounting, amount);
    // Conservative surplus floor and a 5% buffer above quoted gas conversion.
    return gas
      ? (BigInt(route.estimatedAmountOut) * 105n + 99n) / 100n
      : BigInt(route.minimumAmountOut);
  };
  const sizingNative = 10n ** 16n;
  stage("pricing");
  const sizingGasUsd = await valueInAccounting(
    wrappedNative,
    sizingNative,
    true,
  );
  const maxQuoteValue = parseUnits(String(LIMITS.quoteValueUsd), decimals);
  const caps = new Map<Address, bigint>([[accounting, maxQuoteValue]]);
  const prices = new Map<Address, { amount: bigint; value: bigint }>([
    [accounting, { amount: 1n, value: 1n }],
  ]);
  const quoteCap = async (token: Address) => {
    token = address(token);
    const cached = caps.get(token);
    if (cached !== undefined) return cached;
    const price = await quotes.reference(
      token,
      accounting,
      referenceAmount(tokenDecimals.get(token) ?? NaN),
      LIMITS.referencePriceImpact,
    );
    const amount = BigInt(price.amountIn);
    if (
      price.priceImpact !== undefined &&
      (price.priceImpact < 0 || price.priceImpact > LIMITS.referencePriceImpact)
    )
      throw new Error("Unreliable sizing price");
    // Use a higher unit value to keep quotes conservatively below the ceiling.
    const unitValue = (BigInt(price.estimatedAmountOut) * 105n + 99n) / 100n;
    if (unitValue <= 0n) throw new Error("Invalid sizing price");
    const cap = (maxQuoteValue * amount) / unitValue;
    prices.set(token, { amount, value: BigInt(price.estimatedAmountOut) });
    caps.set(token, cap);
    return cap;
  };
  stage("candidate_discovery");
  const batch: Candidate[] = [];
  let visited = 0;
  try {
    for (const market of selected) {
      if (
        !withinBudget() ||
        quotes.remaining < 10 ||
        batch.length >= LIMITS.batch
      )
        break;
      visited++;
      let attempts = 0;
      try {
        const yld = deploymentFor(network.id).address;
        if (!existing.has(market.pairId)) continue;
        const reference = await quotes.reference(
          market.token0,
          market.token1,
          referenceAmount(tokenDecimals.get(market.token0) ?? NaN),
          LIMITS.referencePriceImpact,
        );
        if (
          reference.priceImpact !== undefined &&
          (reference.priceImpact < 0 ||
            reference.priceImpact > LIMITS.referencePriceImpact)
        ) {
          log({
            type: "reference_price_impact_skip",
            chainId,
            pairId: market.pairId,
          });
          continue;
        }
        const marketBlock = reference.blockNumber
          ? BigInt(reference.blockNumber)
          : await client.getBlockNumber({ cacheTime: 0 });
        const window = await ticks(client, yld, market, reference, marketBlock);
        log({
          type: "ticks_discovered",
          chainId,
          pairId: market.pairId,
          baseTick: window.baseTick,
          radius: window.radius,
          checked: window.checked,
          promising: window.ticks.length,
          referenceAgeMs: Date.now() - reference.quotedAt,
        });
        for (const tick of window.ticks) {
          if (
            !withinBudget() ||
            quotes.remaining < 10 ||
            batch.length >= LIMITS.batch
          )
            break;
          const assetCap = await quoteCap(tick.asset),
            costCap = await quoteCap(tick.quote);
          const quotePrice = prices.get(address(tick.quote))!;
          let bridgeQuoteLiquidity = 0n;
          const availableBridges: Address[] = [];
          for (const bridge of bridges) {
            const balance = flashBalance(bridge);
            if (
              bridge === address(tick.asset) ||
              bridge === address(tick.quote) ||
              balance <= 0n
            )
              continue;
            try {
              const bridgeCap = await quoteCap(bridge);
              const bridgePrice = prices.get(bridge)!;
              const liquidity = balance < bridgeCap ? balance : bridgeCap;
              // Estimate usable Quote principal after a conservative swap buffer.
              const supported =
                (liquidity * bridgePrice.value * quotePrice.amount * 100n) /
                (bridgePrice.amount * quotePrice.value * 105n);
              if (supported > bridgeQuoteLiquidity)
                bridgeQuoteLiquidity = supported;
              availableBridges.push(bridge);
            } catch (e) {
              log({
                type: "bridge_skipped",
                chainId,
                token: bridge,
                error: errorKind(e),
              });
            }
          }
          const costBound = (costCap << 128n) / tick.priceX128;
          const cap = assetCap < costBound ? assetCap : costBound;
          let best: { candidate: Candidate; net: bigint } | undefined;
          for (const amount of fundedSizes(
            tick,
            flashBalance(tick.asset),
            flashBalance(tick.quote),
            cap,
            bridgeQuoteLiquidity,
          )) {
            if (
              ++attempts > LIMITS.candidates ||
              !withinBudget() ||
              quotes.remaining < 10
            )
              break;
            const cost = quotePrincipal(amount, tick.priceX128);
            if (cost <= 0n || cost > costCap) continue;
            const direct =
              flashBalance(tick.quote) >= cost
                ? ([tick.quote, cost] as const)
                : flashBalance(tick.asset) >= amount
                  ? ([tick.asset, amount] as const)
                  : undefined;
            const funding: (readonly [Address, bigint])[] = direct
              ? [direct]
              : [];
            if (!direct)
              for (const bridge of availableBridges) {
                const balance = flashBalance(bridge);
                const bridgeCap = caps.get(bridge)!;
                const bridgePrice = prices.get(bridge)!;
                // Price only the required principal, with two small buffers.
                // The actual pre-leg minimum must still cover exact Quote cost.
                for (const buffer of [101n, 105n]) {
                  const numerator =
                    cost * quotePrice.value * bridgePrice.amount * buffer;
                  const denominator =
                    quotePrice.amount * bridgePrice.value * 100n;
                  const principal =
                    (numerator + denominator - 1n) / denominator;
                  if (
                    principal > 0n &&
                    principal <= balance &&
                    principal <= bridgeCap &&
                    principal <= 10n ** 30n
                  )
                    funding.push([bridge, principal]);
                }
              }
            for (const [token, principal] of funding) {
              if (!withinBudget() || quotes.remaining < 10) break;
              try {
                const candidate = await quotes.candidate(
                  tick,
                  amount,
                  token,
                  principal,
                );
                if (!candidate) continue;
                const simulation = await simulate(
                  client,
                  config.resolver,
                  bot,
                  beneficiary,
                  [candidate],
                );
                const candidateData = encodeFunctionData({
                  abi,
                  functionName: "execute",
                  args: simulation.args,
                });
                const candidateL1 =
                  chainId === 8453
                    ? await estimateL1Fee(client, {
                        chain: network.chain,
                        account: bot,
                        to: config.resolver,
                        data: candidateData,
                      })
                    : 0n;
                const nativeCost =
                  simulation.gas * sizingFees.maxFeePerGas + candidateL1 * 2n;
                const estimatedNet =
                  (await valueInAccounting(
                    candidate.surplusToken,
                    candidate.surplus,
                  )) -
                  (nativeCost * sizingGasUsd + sizingNative - 1n) /
                    sizingNative;
                log({
                  type: "candidate_simulated",
                  chainId,
                  tickId: tick.id,
                  mode: candidate.mode,
                  flashToken: token,
                  flashAmount: principal,
                  quoteAgeMs: Date.now() - candidate.quotedAt,
                  routeIds: candidate.routeIds,
                  gas: simulation.gas,
                  estimatedNet,
                });
                if (!best || estimatedNet > best.net)
                  best = { candidate, net: estimatedNet };
              } catch (e) {
                log({
                  type: "candidate_skipped",
                  chainId,
                  tickId: tick.id,
                  error: errorKind(e),
                });
              }
            }
          }
          if (best && best.net > 0n) batch.push(best.candidate);
        }
      } catch (e) {
        log({
          type: "market_failed",
          chainId,
          pairId: market.pairId,
          error: errorKind(e),
        });
      }
    }
  } finally {
    await state.put(
      "marketCursor",
      marketList.length ? (cursor + visited) % marketList.length : 0,
    );
  }
  const orders = batch.slice(0, LIMITS.batch);
  if (!orders.length || !withinBudget()) return;
  stage("final_simulation");
  const final = await simulate(
    client,
    config.resolver,
    bot,
    beneficiary,
    orders,
  );
  const data = encodeFunctionData({
    abi,
    functionName: "execute",
    args: final.args,
  });
  stage("profitability");
  const fees = await client.estimateFeesPerGas();
  const gas = final.gas;
  const l1 =
    chainId === 8453
      ? await estimateL1Fee(client, {
          chain: network.chain,
          account: bot,
          to: config.resolver,
          data,
        })
      : 0n;
  const gasUsd = await valueInAccounting(
    wrappedNative,
    gas * fees.maxFeePerGas + l1 * 2n,
    true,
  );
  let gross = 0n;
  const surplusByToken = new Map<Address, bigint>();
  for (const candidate of orders)
    surplusByToken.set(
      candidate.surplusToken,
      (surplusByToken.get(candidate.surplusToken) ?? 0n) + candidate.surplus,
    );
  for (const [token, surplus] of surplusByToken)
    gross += await valueInAccounting(token, surplus);
  log({
    type: "batch_valued",
    chainId,
    bitmap: final.bitmap,
    gas,
    gross,
    gasUsd,
    accounting,
    net: gross - gasUsd,
    dryRun,
  });
  if (!netPositive(gross, gasUsd, minNet) || !withinBudget()) return;
  // Refresh balances and the exact ordered batch after all conversion/API calls.
  const finalTokens = [
    ...new Set(orders.map((candidate) => candidate.order.flashToken)),
  ];
  stage("liquidity_check");
  const freshLiquidity = await client.multicall({
    allowFailure: false,
    contracts: finalTokens.map((token) => ({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [config.morpho] as const,
    })),
  });
  const freshBalances = new Map(
    finalTokens.map((token, i) => [token, freshLiquidity[i]]),
  );
  if (
    orders.some(
      (candidate) =>
        freshBalances.get(candidate.order.flashToken)! <
        candidate.order.flashAmount,
    )
  )
    return;
  stage("submission_simulation");
  await simulate(client, config.resolver, bot, beneficiary, orders);
  if (dryRun || !signer) return;
  stage("nonce_check");
  const [gasBalance, confirmedNonce, nonce] = await Promise.all([
    client.getBalance({ address: bot }),
    client.getTransactionCount({ address: bot }),
    client.getTransactionCount({ address: bot, blockTag: "pending" }),
  ]);
  if (gasBalance < gas * fees.maxFeePerGas + l1 * 2n) {
    log({ type: "insufficient_gas_balance", chainId });
    return;
  }
  if (confirmedNonce !== nonce) {
    log({ type: "external_pending_nonce", chainId });
    return;
  }
  const wallet = createWalletClient({
    account: signer,
    chain: network.chain,
    transport,
  });
  stage("signing");
  const signed = await signer.signTransaction({
    chainId,
    type: "eip1559",
    to: config.resolver,
    data,
    gas,
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const hash = keccak256(signed);
  // Durable write before broadcast avoids duplicate submissions after a crash.
  stage("pending_write");
  await state.put<Pending>("pending", {
    hash,
    nonce,
    createdAt: Date.now(),
    resolver: config.resolver,
    expectedBitmap: final.bitmap.toString(),
    expectedGross: gross.toString(),
    expectedGasCost: gasUsd.toString(),
  });
  stage("broadcast");
  await wallet.sendRawTransaction({ serializedTransaction: signed });
  log({
    type: "resolver_submitted",
    chainId,
    hash,
    nonce,
    bitmap: final.bitmap,
  });
}
