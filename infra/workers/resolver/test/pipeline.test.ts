import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type PublicClient,
} from "viem";
import {
  deploymentFor,
  pairIdFor,
  priceAtTick,
  tickCandidates,
} from "@yld-cx/sdk/ethereum";
import { privateKeyToAccount } from "viem/accounts";
import core from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { chainConfig, LIMITS } from "../src/config.ts";
import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import { resolveChain, type State } from "../src/execute.ts";
import type { Env } from "../src/shared.ts";

const A = "0x1111111111111111111111111111111111111111",
  Q = "0x2222222222222222222222222222222222222222";
const RESOLVER = "0x3333333333333333333333333333333333333333",
  BOT = "0x000000000000000000000000000000000000dEaD";
const TEST_KEY = `0x${"01".repeat(32)}` as const;
const assets = chainConfig[1];
const pairId = pairIdFor(A, Q);
const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

for (const dryRun of ["true", "false"])
  test(`resolver address controls chain enablement with DRY_RUN=${dryRun}`, async (t) => {
    const config = manifest.chains["1"];
    const saved = structuredClone(config);
    t.after(() => Object.assign(config, saved));
    t.mock.method(console, "log", () => {});
    const env = { DRY_RUN: dryRun, RESOLVER_SIGNING_KEY: TEST_KEY } as Env;
    const state = {} as State;
    let rpcCalls = 0;
    const client = {
      getChainId: async () => {
        rpcCalls++;
        return 8453;
      },
    } as unknown as PublicClient;

    Object.assign(config, {
      resolver: null,
      resolverCodeHash: keccak256("0x6000"),
    });
    await resolveChain(env, "ethereum", state, { client });
    assert.equal(
      rpcCalls,
      0,
      "a null address skips execution before RPC access",
    );

    Object.assign(config, { resolver: RESOLVER, resolverCodeHash: null });
    await assert.rejects(
      resolveChain(env, "ethereum", state, { client }),
      /Resolver code hash missing/,
    );

    Object.assign(config, { resolverCodeHash: keccak256("0x6000") });
    await assert.rejects(
      resolveChain(env, "ethereum", state, { client }),
      /RPC chain mismatch/,
    );
    assert.equal(
      rpcCalls,
      1,
      "a configured address reaches chain verification",
    );
  });

for (const [
  promising,
  priceImpact,
  mode,
  threshold,
  withKey,
  initialCursor = 0,
] of [
  [true, 0.01, 0, undefined, false],
  [false, 0.01, 0, undefined, false],
  [true, -100, 0, undefined, false],
  [true, 0.01, 1, undefined, false],
  [true, 0.01, 2, undefined, false],
  [true, 0.01, 0, "1", false],
  [true, 0.01, 0, "0.001", true],
  [true, 0.01, 0, undefined, false, 2],
] as const)
  test(`complete resolver dry-run: promising=${promising}, impact=${priceImpact}, mode=${mode}, minimum=${threshold ?? 0}, signer=${withKey}, cursor=${initialCursor}`, async (t) => {
    const config = manifest.chains["1"];
    const saved = structuredClone(config);
    Object.assign(config, {
      resolver: RESOLVER,
      resolverCodeHash: keccak256("0x6000"),
    });
    t.after(() => Object.assign(config, saved));
    const metrics: Record<string, unknown>[] = [];
    t.mock.method(console, "log", (line: string) =>
      metrics.push(JSON.parse(line)),
    );
    const requests: { endpoint: string; body: Record<string, unknown> }[] = [];
    const marketsApi = new URL(
      withKey
        ? "https://preview.yld.cx/custom/yield-list"
        : "https://yld.cx/api/markets",
    );
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL, options?: RequestInit) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (new URL(String(url)).pathname === marketsApi.pathname) {
          assert.equal(new URL(String(url)).origin, marketsApi.origin);
          assert.equal(new URL(String(url)).searchParams.get("tag"), "all");
          const markets = [assets.accountingToken, assets.wrappedNative].map(
            (token) => ({
              network: "eip155:1",
              token0: { address: A },
              token1: { address: token },
              assetTVL: "1",
            }),
          );
          markets.splice(initialCursor, 0, {
            network: "eip155:1",
            token0: { address: A },
            token1: { address: Q },
            assetTVL: "1",
          });
          return Response.json({
            markets: [
              {
                network: "eip155:1",
                token0: { address: A },
                token1: {
                  address: "0x4444444444444444444444444444444444444444",
                },
              },
              ...markets,
            ],
          });
        }
        assert.equal(
          new URL(String(url)).origin,
          "https://trade-api.gateway.uniswap.org",
        );
        const body = JSON.parse(String(options?.body)) as Record<
          string,
          unknown
        >;
        requests.push({ endpoint, body });
        if (endpoint === "quote") {
          assert.equal(body.generatePermitAsTransaction, true);
          assert.equal(body.permitAmount, "EXACT");
          assert.equal(body.swapSource, undefined);
          assert.deepEqual(body.protocols, ["V2", "V3", "V4"]);
          assert.equal(body.routingPreference, "BEST_PRICE");
          const tokenIn = String(body.tokenIn),
            tokenOut = String(body.tokenOut);
          const unit = (token: string) =>
            token === assets.accountingToken ? 10n ** 6n : 10n ** 18n;
          const price = (token: string) =>
            token === A ? 2n : token === assets.wrappedNative ? 1000n : 1n;
          const amount = BigInt(String(body.amount)),
            output =
              (amount * price(tokenIn) * unit(tokenOut)) /
              (unit(tokenIn) * price(tokenOut)),
            minimum = (output * 995n) / 1000n;
          assert.ok(
            (amount * price(tokenIn) * 10n ** 6n) / unit(tokenIn) <=
              BigInt(LIMITS.quoteValueUsd) * 10n ** 6n,
            "all quote inputs stay below the internal value ceiling",
          );
          return Response.json({
            routing: "CLASSIC",
            permitData: null,
            quote: {
              chainId: 1,
              blockNumber: "123",
              tradeType: "EXACT_INPUT",
              swapper: RESOLVER,
              slippage: 0.5,
              quoteId: "pipeline",
              priceImpact: tokenIn === A && tokenOut === Q ? priceImpact : 0.01,
              input: { token: tokenIn, amount: amount.toString() },
              output: {
                token: tokenOut,
                amount: output.toString(),
                recipient: RESOLVER,
              },
              aggregatedOutputs: [
                {
                  token: tokenOut,
                  amount: output.toString(),
                  minAmount: minimum.toString(),
                  recipient: RESOLVER,
                  bps: 10000,
                },
              ],
              route: [
                [
                  {
                    type: "v3-pool",
                    tokenIn: { address: tokenIn, chainId: 1 },
                    tokenOut: { address: tokenOut, chainId: 1 },
                  },
                ],
              ],
            },
          });
        }
        assert.equal(endpoint, "swap");
        assert.deepEqual(Object.keys(body).sort(), [
          "deadline",
          "quote",
          "safetyMode",
        ]);
        const quote = body.quote as {
          input: { token: string; amount: string };
          output: { token: string };
          aggregatedOutputs: { minAmount: string }[];
        };
        const input = encodeAbiParameters(
          parseAbiParameters("address,uint256,uint256,bytes,bool,uint256[]"),
          [
            RESOLVER,
            BigInt(quote.input.amount),
            BigInt(quote.aggregatedOutputs[0].minAmount),
            `0x${quote.input.token.slice(2)}0001f4${quote.output.token.slice(2)}`,
            true,
            [],
          ],
        );
        return Response.json({
          swap: {
            to: config.router,
            chainId: 1,
            value: "0x00",
            data: encodeFunctionData({
              abi: routerAbi,
              functionName: "execute",
              args: [
                "0x00",
                [input],
                BigInt(Math.floor(Date.now() / 1000) + 1800),
              ],
            }),
          },
        });
      },
    );
    const priceTick = promising ? 6700 : 7000;
    const activeTick = tickCandidates(pairId, 6900, 100, 2).find(
      (t) => t.direction === 0 && t.priceTick === priceTick,
    )!;
    const reads: number[] = [];
    const groups: string[][] = [];
    let blockReads = 0;
    let simulations = 0;
    const rpc = {
      getChainId: async () => 1,
      getCode: async () => "0x6000",
      getBlockNumber: async () => {
        blockReads++;
        return 123n;
      },
      estimateFeesPerGas: async () => ({
        maxFeePerGas: 1000000n,
        maxPriorityFeePerGas: 1n,
      }),
      readContract: async () => {
        throw new Error("view reads must use multicall");
      },
      multicall: async ({
        contracts,
        allowFailure,
        blockNumber,
      }: {
        contracts: {
          address: string;
          functionName: string;
          args?: readonly unknown[];
        }[];
        allowFailure: boolean;
        blockNumber?: bigint;
      }) => {
        groups.push(contracts.map((c) => c.functionName));
        if (contracts[0].functionName === "getTick") {
          reads.push(contracts.length);
          assert.equal(blockNumber, 123n, "tick reads use the AMM quote block");
        }
        return contracts.map((c) => {
          let result: unknown;
          switch (c.functionName) {
            case "YLD":
              result = deploymentFor("eip155:1").address;
              break;
            case "PERMIT2":
              result = config.permit2;
              break;
            case "MORPHO":
              result = config.morpho;
              break;
            case "UNIVERSAL_ROUTER":
              result = config.router;
              break;
            case "getPair":
              result = [pairId, A, Q, true];
              break;
            case "balanceOf":
              result =
                c.address ===
                (mode === 0 ? Q : mode === 1 ? A : assets.accountingToken)
                  ? mode === 2
                    ? 100n * 10n ** 6n
                    : 10n ** 18n
                  : 0n;
              break;
            case "decimals":
              result = c.address === assets.accountingToken ? 6 : 18;
              break;
            case "getTick":
              result = {
                asset: A,
                quote: Q,
                durationDays: 7n,
                priceX128: priceAtTick(priceTick),
                availableSupply:
                  c.args?.[0] === activeTick.id ? 10n ** 18n : 0n,
                workingSupply: 0n,
                exitWorking: 0n,
                activeWorking: 0n,
                activePrincipal: 0n,
                settleCursor: 0n,
              };
              break;
            default:
              throw new Error(`unexpected read: ${c.functionName}`);
          }
          return allowFailure === false
            ? result
            : { status: "success", result };
        });
      },
      simulateContract: async ({
        args,
        account,
      }: {
        args: [
          { flashToken: Address; flashAmount: bigint; amount: bigint }[],
          Address,
        ];
        account: Address;
      }) => {
        simulations++;
        assert.equal(args[0].length, 1);
        assert.equal(args[1].toLowerCase(), core.feeTo.toLowerCase());
        assert.equal(
          account,
          withKey ? privateKeyToAccount(TEST_KEY).address : BOT,
        );
        const order = args[0][0];
        assert.equal(
          order.flashToken,
          mode === 0 ? Q : mode === 1 ? A : assets.accountingToken,
        );
        assert.ok(
          order.flashAmount <= (mode === 2 ? 100n * 10n ** 6n : 10n ** 18n),
        );
        assert.ok(
          order.amount <= 10n ** 18n,
          "size fits available book liquidity",
        );
        return { result: 1n };
      },
      estimateContractGas: async () => 2500000n,
    } as unknown as PublicClient;
    const stored = new Map<string, unknown>([["marketCursor", initialCursor]]);
    const state = {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async (key: string) => stored.delete(key),
    } as State;
    const env = {
      DRY_RUN: "true",
      UNISWAP_API_KEY: "test-key",
      MIN_EXPECTED_NET_USD: threshold,
      ...(withKey ? { MARKETS_API: marketsApi.href } : {}),
      ...(withKey ? { RESOLVER_SIGNING_KEY: TEST_KEY } : {}),
    } as Env;
    await resolveChain(env, "ethereum", state, { client: rpc });
    assert.equal(stored.get("marketCursor"), (initialCursor + 1) % 3);
    assert.equal(
      stored.has("pending"),
      false,
      "dry runs must not reserve a broadcast nonce",
    );
    const swapCount = requests.filter((r) => r.endpoint === "swap").length;
    assert.equal(swapCount > 0, promising && priceImpact >= 0);
    assert.ok(
      requests.length <= LIMITS.quoteRequests,
      "all API calls share one budget",
    );
    assert.deepEqual(groups[0], [
      "YLD",
      "MORPHO",
      "UNIVERSAL_ROUTER",
      "PERMIT2",
    ]);
    assert.deepEqual(groups[1], ["getPair", ...Array(4).fill("balanceOf")]);
    assert.deepEqual(groups[2], Array(4).fill("decimals"));
    assert.equal(
      blockReads,
      1,
      "the price quote supplies the discovery block without another RPC",
    );
    if (priceImpact < 0) {
      assert.deepEqual(reads, []);
      assert.equal(simulations, 0);
      assert.ok(metrics.some((m) => m.type === "reference_price_impact_skip"));
    } else if (promising) {
      assert.deepEqual(reads, [82]);
      if (threshold !== "1")
        assert.deepEqual(
          groups.at(-1),
          ["balanceOf"],
          "gas-covering batches recheck liquidity before final simulation",
        );
      else
        assert.notDeepEqual(
          groups.at(-1),
          ["balanceOf"],
          "extra profit threshold rejects the batch",
        );
      assert.ok(
        simulations >= 3,
        "candidate and ordered batch simulations must run",
      );
      const valued = metrics.find((m) => m.type === "batch_valued");
      assert.ok(valued);
      assert.ok(BigInt(String(valued.net)) > 0n);
      assert.ok(
        BigInt(String(valued.net)) < 1000000n,
        "gas coverage does not require an extra dollar",
      );
      assert.ok(
        metrics.some(
          (m) => m.type === "candidate_simulated" && m.mode === mode,
        ),
      );
    } else {
      assert.deepEqual(reads, [82]);
      assert.equal(simulations, 0);
      assert.deepEqual(
        requests
          .filter((r) => r.endpoint === "quote")
          .map((r) => r.body.amount),
        ["10000000000000000", "1000000000000000"],
      );
    }
  });
