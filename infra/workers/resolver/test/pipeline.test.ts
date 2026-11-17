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
import manifest from "../../../../protocol/ethereum/deployments/resolver.json" with { type: "json" };
import { resolveChain, type State } from "../src/execute.ts";
import type { Env } from "../src/shared.ts";

const A = "0x1111111111111111111111111111111111111111",
  Q = "0x2222222222222222222222222222222222222222";
const RESOLVER = "0x3333333333333333333333333333333333333333",
  BOT = "0x4444444444444444444444444444444444444444";
const pairId = pairIdFor(A, Q);
const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

for (const promising of [true, false])
  test(`complete resolver dry-run ${promising ? "selects and values a profitable batch" : "filters wrong-price liquidity before execution quotes"}`, async (t) => {
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
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL, options?: RequestInit) => {
        const endpoint = new URL(String(url)).pathname.split("/").at(-1)!;
        if (endpoint === "markets")
          return Response.json({
            markets: [
              {
                network: "eip155:1",
                token0: { address: A },
                token1: { address: Q },
                stepTicks: 1000,
              },
            ],
          });
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
          const amount = BigInt(String(body.amount)),
            output = amount * 2n,
            minimum = (output * 995n) / 1000n;
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
              priceImpact: 0.01,
              input: { token: A, amount: amount.toString() },
              output: {
                token: Q,
                amount: output.toString(),
                recipient: RESOLVER,
              },
              aggregatedOutputs: [
                {
                  token: Q,
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
                    tokenIn: { address: A, chainId: 1 },
                    tokenOut: { address: Q, chainId: 1 },
                  },
                ],
              ],
            },
          });
        }
        assert.equal(endpoint, "swap");
        const quote = body.quote as {
          input: { amount: string };
          aggregatedOutputs: { minAmount: string }[];
        };
        const input = encodeAbiParameters(
          parseAbiParameters("address,uint256,uint256,bytes,bool,uint256[]"),
          [
            RESOLVER,
            BigInt(quote.input.amount),
            BigInt(quote.aggregatedOutputs[0].minAmount),
            `0x${A.slice(2)}0001f4${Q.slice(2)}`,
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
    const priceTick = promising ? 6000 : 8000;
    const activeTick = tickCandidates(pairId, 7000, 1000, 2).find(
      (t) =>
        t.direction === 0 && t.priceTick === priceTick && t.durationDays === 7,
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
        maxFeePerGas: 1n,
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
        contracts: { functionName: string; args?: readonly unknown[] }[];
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
              result = 10n ** 30n;
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
      simulateContract: async ({ args }: { args: [unknown[], Address] }) => {
        simulations++;
        assert.equal(args[0].length, 1);
        assert.equal(args[1], BOT);
        return { result: 1n };
      },
      estimateContractGas: async () => 2500000n,
    } as unknown as PublicClient;
    const stored = new Map<string, unknown>();
    const state = {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async (key: string) => stored.delete(key),
    } as State;
    const env = {
      DRY_RUN: "true",
      BOT_ADDRESS: BOT,
      BENEFICIARY_ADDRESS: BOT,
      UNISWAP_API_KEY: "test-key",
      MAX_BATCH: "1",
      MIN_EXPECTED_NET_USD: "0.01",
      TOKEN_LIMITS: JSON.stringify({
        ethereum: { [A]: "1000000000000000000", [Q]: "10000000000000000000" },
      }),
      BRIDGE_TOKENS: JSON.stringify({
        ethereum: {
          accountingToken: Q,
          accountingDecimals: 18,
          wrappedNative: A,
          bridges: [],
        },
      }),
    } as Env;
    await resolveChain(env, "ethereum", state, { client: rpc });
    assert.equal(
      stored.has("pending"),
      false,
      "dry runs must not reserve a broadcast nonce",
    );
    assert.equal(
      requests.filter((r) => r.endpoint === "swap").length,
      promising ? 4 : 0,
      "only executable candidates build transactions; price/valuation quotes do not",
    );
    assert.deepEqual(groups[0], [
      "YLD",
      "MORPHO",
      "UNIVERSAL_ROUTER",
      "PERMIT2",
    ]);
    assert.deepEqual(groups[1], ["getPair", "balanceOf", "balanceOf"]);
    assert.equal(
      blockReads,
      1,
      "the price quote supplies the discovery block without another RPC",
    );
    if (promising) {
      assert.deepEqual(reads, [20]);
      assert.deepEqual(
        groups.at(-1),
        ["balanceOf"],
        "final liquidity is rechecked in one multicall",
      );
      assert.ok(
        simulations >= 3,
        "candidate and ordered batch simulations must run",
      );
      const valued = metrics.find((m) => m.type === "batch_valued");
      assert.ok(valued);
      assert.ok(BigInt(String(valued.net)) > 0n);
    } else {
      assert.deepEqual(reads, [20, 16]);
      assert.equal(simulations, 0);
      assert.deepEqual(
        requests
          .filter((r) => r.endpoint === "quote")
          .map((r) => r.body.amount),
        ["10000000000000000", "1000000000000000"],
      );
    }
  });
