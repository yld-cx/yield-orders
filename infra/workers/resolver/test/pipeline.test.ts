import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseTransaction,
  type Hex,
  type Address,
  type PublicClient,
} from "viem";
import { deploymentFor, priceAtTick } from "@yld-cx/sdk/ethereum";
import { privateKeyToAccount } from "viem/accounts";
import core from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { chainConfig, LIMITS } from "../src/config.ts";
import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import { resolveChain } from "../src/execute.ts";
import { reservePending } from "../src/pending.ts";
import { Subrequests } from "../src/subrequests.ts";
import { discoverTicks } from "../src/ticks.ts";
import { testDatabase } from "./database.ts";
import type { Env } from "../src/shared.ts";

const A = "0x1111111111111111111111111111111111111111" as const,
  Q = "0x2222222222222222222222222222222222222222" as const;
const B = "0x0101010101010101010101010101010101010101" as const;
const RESOLVER = "0x3333333333333333333333333333333333333333",
  BOT = "0x000000000000000000000000000000000000dEaD";
const TEST_KEY = `0x${"01".repeat(32)}` as const;
const assets = chainConfig[1];
const RPC_URLS = '{"ethereum":["https://rpc.test/" ]}';
const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline)",
]);

for (const dryRun of ["true", "false"])
  test(`resolver address controls chain enablement with DRY_RUN=${dryRun}`, async (t) => {
    const config = manifest.chains["1"];
    const saved = structuredClone(config);
    t.after(() => Object.assign(config, saved));
    t.mock.method(console, "log", () => {});
    const env = {
      DRY_RUN: dryRun,
      RESOLVER_SIGNING_KEY: TEST_KEY,
      RPC_URLS,
    } as Env;
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
    await resolveChain(env, "ethereum", [], { client });
    assert.equal(
      rpcCalls,
      0,
      "a null address skips execution before RPC access",
    );

    Object.assign(config, { resolver: RESOLVER, resolverCodeHash: null });
    await assert.rejects(
      resolveChain(env, "ethereum", [], { client }),
      /Resolver code hash missing/,
    );

    Object.assign(config, { resolverCodeHash: keccak256("0x6000") });
    await assert.rejects(
      resolveChain(env, "ethereum", [], { client }),
      /RPC chain mismatch/,
    );
    assert.equal(
      rpcCalls,
      1,
      "a configured address reaches chain verification",
    );
  });

for (const [name, options] of Object.entries({
  profitable: {},
  underwater: { promising: false },
  unreliable: { priceImpact: -100 },
  assetFlash: { mode: 1 },
  bridgeFlash: { mode: 2 },
  threshold: { threshold: "1" },
  failedImmutableRead: { failedImmutable: true },
  drainedTick: { freshSupply: 0n },
  drainedFlash: { freshFlash: false },
  empty: { empty: true },
  live: { live: true, withKey: true },
  limitedBudget: { live: true, withKey: true, requestBudget: 22 },
  expiredPending: { live: true, withKey: true, expired: true },
  existingPending: {
    live: true,
    withKey: true,
    expired: true,
    initialPending: 8,
  },
  changedNonce: { live: true, withKey: true, finalNonce: 8 },
  ambiguousBroadcast: { live: true, withKey: true, ambiguousBroadcast: true },
  ranked: { competing: true },
  freshReference: { freshReference: true },
}))
  test(`D1 resolver pipeline: ${name}`, async (t) => {
    const now = Date.now();
    t.mock.method(Date, "now", () => now);
    const {
      promising = true,
      priceImpact = 0.01,
      mode = 0,
      threshold,
      failedImmutable = false,
      freshSupply = 10n ** 18n,
      freshFlash = true,
      empty = false,
      withKey = false,
      live = false,
      requestBudget = LIMITS.externalRequests,
      expired = false,
      initialPending = 7,
      finalNonce = 7,
      ambiguousBroadcast = false,
      competing = false,
      freshReference = false,
    } = options as {
      promising?: boolean;
      priceImpact?: number;
      mode?: number;
      threshold?: string;
      failedImmutable?: boolean;
      freshSupply?: bigint;
      freshFlash?: boolean;
      empty?: boolean;
      withKey?: boolean;
      live?: boolean;
      requestBudget?: number;
      expired?: boolean;
      initialPending?: number;
      finalNonce?: number;
      ambiguousBroadcast?: boolean;
      competing?: boolean;
      freshReference?: boolean;
    };
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
    const { db, putTick, sqlite } = testDatabase();
    const sent: Hex[] = [];
    let assetPrice = 2n;
    const block = 100n;
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL, options?: RequestInit) => {
        const requestUrl = new URL(String(url));
        if (["rpc.test", "fallback.rpc.test"].includes(requestUrl.host)) {
          const [request] = JSON.parse(String(options?.body));
          assert.equal(request.method, "eth_sendRawTransaction");
          const signed = request.params[0] as Hex;
          assert.equal(parseTransaction(signed).nonce, 7);
          assert.equal(
            parseTransaction(signed).to?.toLowerCase(),
            RESOLVER.toLowerCase(),
          );
          const record = sqlite.prepare("SELECT meta FROM state").get();
          const pending = JSON.parse(String(record?.meta));
          assert.equal(pending.hash, keccak256(signed));
          assert.equal(pending.nonce, 7);
          assert.equal(pending.submittedBlock, block.toString());
          sent.push(signed);
          if (ambiguousBroadcast)
            return new Response("Ambiguous", { status: 503 });
          return Response.json([
            { jsonrpc: "2.0", id: request.id, result: keccak256(signed) },
          ]);
        }
        const endpoint = requestUrl.pathname.split("/").at(-1)!;
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
            token === A
              ? assetPrice
              : token === assets.wrappedNative
                ? 1000n
                : 1n;
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
    const tick = {
      id: 99n,
      asset: A,
      quote: Q,
      priceX128: priceAtTick(promising ? 6700 : 7000),
      availableSupply: 10n ** 20n,
    };
    if (!empty) putTick(1, tick);
    const other = {
      ...tick,
      id: 98n,
      asset: B,
      priceX128: priceAtTick(-1000),
      availableSupply: 10n ** 18n,
    };
    if (competing) putTick(1, other, true, 1);
    putTick(8453, { ...tick, id: 100n });
    putTick(1, { ...tick, id: 101n, availableSupply: 0n });
    const reads: bigint[][] = [];
    const groups: string[][] = [];
    let simulations = 0;
    let nonceReads = 0;
    const rpc = {
      getChainId: async () => 1,
      getCode: async () => "0x6000",
      getBalance: async () => 10n ** 18n,
      getBlockNumber: async () => block,
      getTransactionCount: async ({ blockTag }: { blockTag: string }) => {
        const phase = Math.floor(nonceReads++ / 2);
        return phase === 0
          ? blockTag === "pending"
            ? initialPending
            : 7
          : finalNonce;
      },
      getTransactionReceipt: async () => {
        throw new Error("No known receipt");
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
          const tickReads = contracts.filter(
            (c) => c.functionName === "getTick",
          );
          reads.push(tickReads.map((c) => c.args?.[0] as bigint));
          assert.equal(allowFailure, true);
          assert.deepEqual(
            contracts.slice(tickReads.length).map((c) => c.functionName),
            Array(competing ? 5 : 4).fill("balanceOf"),
          );
          assert.equal(
            blockNumber,
            undefined,
            "onchain revalidation uses current state",
          );
        }
        return contracts.map((c) => {
          let result: unknown;
          switch (c.functionName) {
            case "YLD":
              if (failedImmutable) return { status: "failure" };
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
            case "balanceOf":
              result =
                (allowFailure || freshFlash) &&
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
              const indexed = c.args?.[0] === tick.id ? tick : other;
              result = {
                asset: indexed.asset,
                quote: Q,
                durationDays: 7n,
                priceX128: indexed.priceX128,
                availableSupply: c.args?.[0] === tick.id ? freshSupply : 0n,
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
    const env: Env = {
      DB: db,
      RPC_URLS: ambiguousBroadcast
        ? JSON.stringify({
            ethereum: ["https://rpc.test/", "https://fallback.rpc.test/"],
          })
        : RPC_URLS,
      DRY_RUN: live ? "false" : "true",
      UNISWAP_API_KEY: "test-key",
      MIN_EXPECTED_NET_USD: threshold,
      ...(withKey ? { RESOLVER_SIGNING_KEY: TEST_KEY } : {}),
    };
    if (expired) {
      assert.ok(
        await reservePending(db, 1, privateKeyToAccount(TEST_KEY).address, {
          hash: `0x${"a".repeat(64)}`,
          nonce: 7,
          submittedBlock: (block - 3n).toString(),
          createdAt: now,
          resolver: RESOLVER,
          expectedBitmap: "1",
          expectedGross: "100",
          expectedGasCost: "10",
        }),
      );
    }
    const subrequests = new Subrequests(requestBudget);
    const run = async (budget = subrequests) => {
      const selected = await discoverTicks(db, [1], 0);
      await resolveChain(
        env,
        "ethereum",
        selected.map(({ tick }) => tick),
        { client: rpc, subrequests: budget },
      );
    };
    if (failedImmutable) {
      await assert.rejects(run, /Resolver immutable mismatch/);
      assert.equal(requests.length, 0);
      assert.equal(sent.length, 0);
      return;
    }
    if (ambiguousBroadcast) {
      await assert.rejects(run, { status: 503 });
      assert.equal(sent.length, 2);
      assert.equal(sent[0], sent[1]);
      const count = nonceReads;
      await run();
      assert.equal(sent.length, 2);
      assert.equal(
        nonceReads,
        count,
        "ambiguous journal blocks even before a new nonce read",
      );
    } else {
      await run();
      assert.equal(
        sent.length,
        live && initialPending === 7 && finalNonce === 7 ? 1 : 0,
      );
    }
    assert.equal(
      sqlite.prepare("SELECT count(*) AS n FROM state").get()?.n,
      sent.length ? 1 : 0,
    );
    if (expired)
      assert.ok(
        metrics.some(
          (m) => m.type === "resolver_receipt" && m.status === "unresolved",
        ),
      );
    const swapCount = requests.filter((r) => r.endpoint === "swap").length;
    const eligible =
      promising &&
      priceImpact >= 0 &&
      freshSupply > 0n &&
      !empty &&
      initialPending === 7;
    assert.equal(swapCount > 0, eligible);
    if (name === "limitedBudget") assert.equal(swapCount, 1);
    assert.ok(requests.length <= LIMITS.quoteRequests);
    assert.equal(
      subrequests.remaining,
      requestBudget - requests.length - sent.length,
    );
    if (empty || initialPending !== 7) {
      assert.deepEqual(groups, []);
      assert.equal(requests.length, 0);
    } else {
      assert.deepEqual(groups[0], [
        "YLD",
        "MORPHO",
        "UNIVERSAL_ROUTER",
        "PERMIT2",
        ...Array(competing ? 5 : 4).fill("decimals"),
      ]);
    }
    if (eligible) {
      assert.ok(simulations >= 2);
      const valued = metrics.find((m) => m.type === "batch_valued");
      assert.ok(
        valued &&
          BigInt(String(valued.net)) > 0n &&
          BigInt(String(valued.net)) < 1000000n,
      );
      assert.ok(
        metrics.some(
          (m) => m.type === "candidate_simulated" && m.mode === mode,
        ),
      );
      if (!threshold && freshFlash) assert.equal(simulations >= 3, true);
      if (!freshFlash) assert.deepEqual(groups.at(-1), ["balanceOf"]);
    } else assert.equal(simulations, 0);
    if (competing) {
      assert.deepEqual(
        reads,
        [[tick.id, other.id]],
        "estimated profit outranks discovery order",
      );
      assert.equal(
        requests.filter(
          ({ endpoint, body }) =>
            endpoint === "quote" &&
            body.tokenIn === A &&
            body.tokenOut === Q &&
            body.amount === "1000000000000000",
        ).length,
        1,
      );
    } else if (eligible || name === "drainedTick")
      assert.deepEqual(reads, [[tick.id]]);
    else assert.deepEqual(reads, []);
    if (freshReference) {
      const previous = requests.length;
      assetPrice = 1n;
      await run(new Subrequests(LIMITS.externalRequests));
      const fresh = requests.slice(previous);
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].endpoint, "quote");
      assert.equal(fresh[0].body.tokenIn, A);
      assert.equal(fresh[0].body.tokenOut, Q);
      assert.deepEqual(
        reads,
        [[tick.id]],
        "a lower fresh price prevents revalidation and execution",
      );
    }
  });
