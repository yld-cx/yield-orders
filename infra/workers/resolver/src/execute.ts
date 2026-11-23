import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  http,
  keccak256,
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
  swapNetwork,
  type SwapChain,
  type SwapPriceResult,
} from "@yld-cx/sdk/uniswap";

import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import core from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { chainConfig, LIMITS } from "./config.ts";
import {
  rpcUrls,
  rpcFallbackOptions,
  rpcHttpOptions,
  type NetworkName,
} from "../../rpc.ts";
import {
  activeTicks,
  estimatedSurplus,
  fundedSizes,
  referenceAmount,
  quotePrincipal,
  sizes,
  type Tick,
} from "./ticks.ts";
import { availableNonce, observePending, reservePending } from "./pending.ts";
import { Subrequests } from "./subrequests.ts";
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
export function netPositive(gross: bigint, gas: bigint, threshold = 0n) {
  return gross - gas > threshold;
}
export async function resolveChain(
  env: Env,
  slug: NetworkName,
  dependencies: {
    client?: PublicClient;
    deadline?: number;
    subrequests?: Subrequests;
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
  const deadline = dependencies.deadline ?? Date.now() + LIMITS.durationMs;
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const subrequests =
    dependencies.subrequests ?? new Subrequests(LIMITS.externalRequests);
  const withinBudget = () =>
    subrequests.remaining > 0 && Date.now() < deadline - 5000;
  const canTryCandidate = () =>
    withinBudget() &&
    subrequests.remaining >=
      LIMITS.finalizationRequests + LIMITS.candidateRequests;
  const urls = rpcUrls(env, slug, chainId);
  const rpcTransport = (fetchRpc: typeof fetch) =>
    fallback(
      urls.map((url) =>
        http(url, rpcHttpOptions(5000, urls.length, signal, fetchRpc)),
      ),
      rpcFallbackOptions,
    );
  const client = (dependencies.client ??
    createPublicClient({
      chain: network.chain,
      transport: rpcTransport(subrequests.fetch),
    })) as PublicClient;
  stage("rpc_chain_check");
  if ((await client.getChainId()) !== chainId)
    throw new Error("RPC chain mismatch");
  let initialNonce: number | undefined;
  if (signer) {
    stage("pending_transaction");
    if (await observePending(client, env.DB, chainId, bot)) return;
    if (!dryRun) {
      initialNonce = await availableNonce(client, bot);
      if (initialNonce === undefined) {
        log({ type: "external_pending_nonce", chainId });
        return;
      }
    }
  }
  stage("tick_index");
  const indexed = await activeTicks(env.DB, chainId);
  if (!indexed.length || !withinBudget()) return;
  const minNet = parseUnits(
    String(setting(env.MIN_EXPECTED_NET_USD, 0, 0, 10000)),
    decimals,
  );
  const quotes: Quotes = new Quotes(
    new UniswapClient({
      apiKey: env.UNISWAP_API_KEY ?? "",
      signal,
      fetch: subrequests.fetch,
      beforeRequest: () => quotes.chargeRequest(),
    }),
    chainId,
    config.resolver,
    LIMITS.slippage,
    LIMITS.quoteRequests,
  );
  const pairs = new Map<string, Tick[]>();
  for (const tick of indexed) {
    if (
      tick.asset === tick.quote ||
      tick.priceX128 <= 0n ||
      tick.availableSupply <= 0n
    )
      continue;
    const key = `${tick.asset}:${tick.quote}`;
    const pair = pairs.get(key);
    if (pair) pair.push(tick);
    else if (pairs.size < LIMITS.pairs) pairs.set(key, [tick]);
  }
  if (!pairs.size || !withinBudget()) return;
  const tokens = [
    ...new Set(
      [...pairs.values()]
        .flatMap(([tick]) => [tick.asset, tick.quote])
        .concat(bridges),
    ),
  ];
  stage("deployment_checks");
  const yld = deploymentFor(network.id).address;
  const addresses = [
    config.resolver,
    config.morpho,
    config.router,
    config.permit2,
    yld,
  ];
  const immutables = [
    ["YLD", yld],
    ["MORPHO", config.morpho],
    ["UNIVERSAL_ROUTER", config.router],
    ["PERMIT2", config.permit2],
  ] as const;
  const [codes, metadata] = await Promise.all([
    Promise.all(addresses.map((address) => client.getCode({ address }))),
    client.multicall({
      allowFailure: true,
      batchSize: 0,
      contracts: [
        ...immutables.map(([functionName]) => ({
          address: config.resolver!,
          abi,
          functionName,
        })),
        ...tokens.map((token) => ({
          address: token,
          abi: erc20Abi,
          functionName: "decimals" as const,
        })),
      ],
    }),
  ]);
  if (!codes[0] || keccak256(codes[0]) !== config.resolverCodeHash)
    throw new Error("Resolver identity mismatch");
  if (codes.some((code) => !code || code === "0x"))
    throw new Error("Dependency deployment missing");
  if (
    immutables.some(([, expected], index) => {
      const read = metadata[index];
      return (
        read?.status !== "success" ||
        String(read.result).toLowerCase() !== expected.toLowerCase()
      );
    })
  )
    throw new Error("Resolver immutable mismatch");

  stage("candidate_discovery");
  const tokenDecimals = new Map(
    tokens.flatMap((token, i) => {
      const read = metadata[immutables.length + i];
      return read?.status === "success"
        ? [[token, Number(read.result)] as const]
        : [];
    }),
  );
  const references = new Map<string, Promise<SwapPriceResult>>();
  const reference = (input: Address, output: Address) => {
    const key = `${input}:${output}`;
    let cached = references.get(key);
    if (!cached) {
      cached = quotes
        .reference(
          input,
          output,
          referenceAmount(tokenDecimals.get(input) ?? NaN),
          LIMITS.referencePriceImpact,
        )
        .then((price) => {
          if (
            price.priceImpact !== undefined &&
            (price.priceImpact < 0 ||
              price.priceImpact > LIMITS.referencePriceImpact)
          )
            throw new Error("Unreliable reference price");
          return price;
        });
      references.set(key, cached);
    }
    return cached;
  };
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
  const maxQuoteValue = parseUnits(String(LIMITS.quoteValueUsd), decimals);
  const caps = new Map<Address, bigint>([[accounting, maxQuoteValue]]);
  const prices = new Map<Address, { amount: bigint; value: bigint }>([
    [accounting, { amount: 1n, value: 1n }],
  ]);
  const quoteCap = async (token: Address) => {
    token = address(token);
    const cached = caps.get(token);
    if (cached !== undefined) return cached;
    const price = await reference(token, accounting);
    const amount = BigInt(price.amountIn);
    // Use a higher unit value to keep quotes conservatively below the ceiling.
    const unitValue = (BigInt(price.estimatedAmountOut) * 105n + 99n) / 100n;
    if (unitValue <= 0n) throw new Error("Invalid sizing price");
    const cap = (maxQuoteValue * amount) / unitValue;
    prices.set(token, { amount, value: BigInt(price.estimatedAmountOut) });
    caps.set(token, cap);
    return cap;
  };
  const ranked: {
    tick: Tick;
    price: SwapPriceResult;
    score: bigint;
    cap: bigint;
    costCap: bigint;
  }[] = [];
  for (const pair of pairs.values()) {
    // Reserve quote requests for executable routes, gas and final valuation.
    if (!canTryCandidate() || quotes.remaining <= LIMITS.quoteRequests / 2)
      break;
    const { asset, quote } = pair[0];
    try {
      const price = await reference(asset, quote);
      const promising = pair.filter(
        (tick) => estimatedSurplus(tick, price, tick.availableSupply) > 0n,
      );
      if (!promising.length) continue;
      const assetCap = await quoteCap(asset);
      const costCap = await quoteCap(quote);
      const quotePrice = prices.get(quote)!;
      for (const tick of promising) {
        const costBound = (costCap << 128n) / tick.priceX128;
        const cap = assetCap < costBound ? assetCap : costBound;
        const [amount] = sizes(tick.availableSupply, cap);
        if (!amount) continue;
        const gain = estimatedSurplus(tick, price, amount);
        const score = (gain * quotePrice.value) / quotePrice.amount;
        if (score > 0n) ranked.push({ tick, price, score, cap, costCap });
      }
    } catch (e) {
      log({ type: "pair_skipped", chainId, asset, quote, error: errorKind(e) });
    }
  }
  ranked.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0));
  const selected = ranked.slice(0, LIMITS.candidates);
  if (!selected.length || !withinBudget()) return;

  const fundingTokens = [
    ...new Set(
      selected.flatMap(({ tick }) => [tick.asset, tick.quote]).concat(bridges),
    ),
  ];
  stage("tick_revalidation");
  const fresh = await client.multicall({
    allowFailure: true,
    batchSize: 0,
    contracts: [
      ...selected.map(({ tick }) => ({
        address: yld,
        abi: protocolAbi,
        functionName: "getTick" as const,
        args: [tick.id] as const,
      })),
      ...fundingTokens.map((token) => ({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [config.morpho] as const,
      })),
    ],
  });
  const verified = selected.flatMap(
    ({ tick: cached, price, cap, costCap }, i) => {
      const read = fresh[i];
      if (read?.status !== "success" || typeof read.result === "bigint")
        return [];
      const state = read.result;
      const tick = {
        id: cached.id,
        ...state,
        asset: address(state.asset),
        quote: address(state.quote),
      };
      if (
        tick.asset !== cached.asset ||
        tick.quote !== cached.quote ||
        tick.priceX128 !== cached.priceX128 ||
        estimatedSurplus(tick, price, tick.availableSupply) <= 0n
      )
        return [];
      return [{ tick, cap, costCap }];
    },
  );
  log({
    type: "ticks_discovered",
    chainId,
    indexed: indexed.length,
    ranked: ranked.length,
    verified: verified.length,
  });
  if (!verified.length || !withinBudget()) return;

  const flashBalances = new Map(
    fundingTokens.map((token, i) => {
      const read = fresh[selected.length + i];
      return [
        token,
        read?.status === "success" && typeof read.result === "bigint"
          ? read.result
          : 0n,
      ] as const;
    }),
  );
  const flashBalance = (token: Address) => flashBalances.get(token) ?? 0n;
  const sizingFees = await client.estimateFeesPerGas();
  const sizingNative = 10n ** 16n;
  const sizingGasUsd = await valueInAccounting(
    wrappedNative,
    sizingNative,
    true,
  );
  stage("candidate_quotes");
  const batch: Candidate[] = [];
  let attempts = 0;
  for (const { tick, cap, costCap } of verified) {
    if (
      !canTryCandidate() ||
      quotes.remaining < 10 ||
      attempts >= LIMITS.candidates ||
      batch.length >= LIMITS.batch
    )
      break;
    try {
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
      let best: { candidate: Candidate; net: bigint } | undefined;
      for (const amount of fundedSizes(
        tick,
        flashBalance(tick.asset),
        flashBalance(tick.quote),
        cap,
        bridgeQuoteLiquidity,
      )) {
        if (
          attempts >= LIMITS.candidates ||
          !canTryCandidate() ||
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
        const funding: (readonly [Address, bigint])[] = direct ? [direct] : [];
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
              const denominator = quotePrice.amount * bridgePrice.value * 100n;
              const principal = (numerator + denominator - 1n) / denominator;
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
          if (
            !canTryCandidate() ||
            quotes.remaining < 10 ||
            attempts >= LIMITS.candidates
          )
            break;
          attempts++;
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
              (nativeCost * sizingGasUsd + sizingNative - 1n) / sizingNative;
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
    } catch (e) {
      log({
        type: "tick_skipped",
        chainId,
        tickId: tick.id,
        error: errorKind(e),
      });
    }
  }
  const orders = batch;
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
  const submission = await simulate(
    client,
    config.resolver,
    bot,
    beneficiary,
    orders,
  );
  if (submission.gas > gas || dryRun || !signer || !withinBudget()) return;
  stage("nonce_check");
  const [gasBalance, nonce] = await Promise.all([
    client.getBalance({ address: bot }),
    availableNonce(client, bot),
  ]);
  if (gasBalance < gas * fees.maxFeePerGas + l1 * 2n) {
    log({ type: "insufficient_gas_balance", chainId });
    return;
  }
  if (nonce === undefined || nonce !== initialNonce) {
    log({ type: "nonce_changed", chainId });
    return;
  }
  if (!withinBudget()) return;
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
  // Hold one slot per possible broadcast endpoint before creating the journal entry.
  const broadcast = subrequests.reserve(urls.length);
  if (!broadcast) return;
  try {
    const wallet = createWalletClient({
      account: signer,
      chain: network.chain,
      transport: rpcTransport(broadcast.fetch),
    });
    stage("pending_write");
    if (
      !(await reservePending(env.DB, chainId, bot, {
        hash,
        nonce,
        createdAt: Date.now(),
        resolver: config.resolver,
        expectedBitmap: final.bitmap.toString(),
        expectedGross: gross.toString(),
        expectedGasCost: gasUsd.toString(),
      }))
    )
      return;
    stage("broadcast");
    const sent = await wallet.sendRawTransaction({
      serializedTransaction: signed,
    });
    if (sent.toLowerCase() !== hash.toLowerCase())
      throw new Error("Unexpected transaction hash");
    log({
      type: "resolver_submitted",
      chainId,
      hash,
      nonce,
      bitmap: final.bitmap,
    });
  } finally {
    broadcast.release();
  }
}
