import test from "node:test";
import assert from "node:assert/strict";
import { isAddress, type Address, type PublicClient } from "viem";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import manifest from "@yld-cx/ethereum-protocol/deployments/resolver.json" with { type: "json" };
import { chainConfig } from "../src/config.ts";
import { roundRobin } from "../src/markets.ts";
import {
  quotePrincipal,
  sizes,
  fundedSizes,
  referenceAmount,
} from "../src/ticks.ts";
import { Quotes } from "../src/quotes.ts";
import { expectedBitmap, simulate } from "../src/simulate.ts";
import {
  netPositive,
  observePending,
  resolveChain,
  type State,
} from "../src/execute.ts";
import type { Candidate, Env } from "../src/shared.ts";
import type { UniswapClient } from "@yld-cx/sdk/uniswap";
const A = "0x1111111111111111111111111111111111111111",
  Q = "0x2222222222222222222222222222222222222222",
  F = "0x3333333333333333333333333333333333333333";
const c: Candidate = {
  order: {
    tickId: 1n,
    amount: 100n,
    flashToken: Q,
    flashAmount: 100n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 180),
    preSwapData: "0x",
    postSwapData: "0x12345678",
  },
  mode: 0,
  surplusToken: Q,
  surplus: 10n,
  quotedAt: Date.now(),
  routeIds: ["test"],
};
test("bounded sizes preserve raw units and exact YLD ceil convention", () => {
  assert.deepEqual(sizes(1000n, 100n), [100n, 50n, 25n, 10n]);
  assert.deepEqual(sizes(1n, 100n), [1n]);
  assert.equal(quotePrincipal(1n, (1n << 128n) + 1n), 2n);
  assert.deepEqual(roundRobin([1, 2, 3, 4], 3, 2), [4, 1]);
});
test("bitmap reflects every independent execution in the ordered batch", () => {
  assert.equal(expectedBitmap(3), 7n);
  assert.equal(netPositive(100n, 50n, 49n), true);
  assert.equal(netPositive(100n, 50n, 50n), false);
});
test("gas coverage is strict, with zero extra profit by default and optional additional profit", () => {
  assert.equal(netPositive(101n, 100n), true);
  assert.equal(netPositive(100n, 100n), false);
  assert.equal(netPositive(99n, 100n), false);
  assert.equal(netPositive(101n, 100n, 1n), false);
  assert.equal(netPositive(102n, 100n, 1n), true);
});
test("reference sizes respect decimals and dynamic sizes respect book and flash liquidity", () => {
  assert.equal(referenceAmount(18), 10n ** 15n);
  assert.equal(referenceAmount(6), 1000n);
  assert.equal(referenceAmount(2), 1n);
  assert.throws(() => referenceAmount(255), /Unsupported token decimals/);
  assert.throws(() => referenceAmount(NaN), /Unsupported token decimals/);
  const tick = { availableSupply: 1000n, priceX128: 2n << 128n };
  assert.deepEqual(fundedSizes(tick, 0n, 100n, 1000n), [50n, 25n, 12n, 5n]);
  assert.deepEqual(fundedSizes(tick, 100n, 0n, 1000n), [100n, 50n, 25n, 10n]);
  assert.deepEqual(fundedSizes(tick, 0n, 0n, 100n, 200n), [
    100n,
    50n,
    25n,
    10n,
  ]);
  assert.deepEqual(fundedSizes(tick, 0n, 0n, 100n, 10n), [5n, 2n, 1n]);
  assert.deepEqual(fundedSizes(tick, 0n, 0n, 100n), []);
  assert.equal(sizes(10n ** 40n, 10n ** 40n)[0], 10n ** 30n);
});
test("static assets and fallback RPCs cover every supported deployment", () => {
  assert.deepEqual(
    Object.keys(chainConfig).sort(),
    Object.values({ ethereum: 1, base: 8453, robinhood: 4663 })
      .map(String)
      .sort(),
  );
  for (const slug of ["ethereum", "base", "robinhood"] as const) {
    const config = chainConfig[getNetwork(slug).chain.id];
    assert.ok(isAddress(config.wrappedNative));
    assert.ok(isAddress(config.accountingToken));
    assert.notEqual(config.wrappedNative, config.accountingToken);
    assert.equal(config.accountingDecimals, 6);
    assert.ok(config.rpcUrls.length >= 2 && config.rpcUrls.length <= 3);
    assert.ok(
      config.rpcUrls.every((url) => new URL(url).protocol === "https:"),
    );
  }
});
test("live execution requires a valid signing key before contacting RPC", async (t) => {
  const config = manifest.chains["1"];
  const saved = structuredClone(config);
  t.after(() => Object.assign(config, saved));
  Object.assign(config, {
    resolver: A,
    resolverCodeHash: `0x${"a".repeat(64)}`,
  });
  const state = {} as State;
  const env = { DRY_RUN: "false" } as Env;
  await assert.rejects(
    resolveChain(env, "ethereum", state),
    /Resolver signing key missing/,
  );
  await assert.rejects(
    resolveChain({ ...env, RESOLVER_SIGNING_KEY: "0x00" }, "ethereum", state),
  );
});
test("third-token quotes bind both legs and use the pre-leg minimum", async () => {
  const requests: { tokenIn: Address; tokenOut: Address; amount: string }[] =
    [];
  const quotes = new Quotes(
    {
      quote: async (request: {
        tokenIn: Address;
        tokenOut: Address;
        amount: string;
      }) => {
        requests.push(request);
        return {
          minimumAmountOut: requests.length === 1 ? "110" : "150",
          quotedAt: Date.now(),
          routeId: "route",
          transaction: { data: "0x12345678" },
        };
      },
    } as unknown as UniswapClient,
    8453,
    A,
    0.5,
    10,
  );
  const result = await quotes.candidate(
    {
      id: 1n,
      asset: A,
      quote: Q,
      priceX128: 1n << 128n,
      availableSupply: 1000n,
    },
    100n,
    F,
    100n,
  );
  assert.equal(result?.surplus, 50n);
  assert.equal(result?.surplusToken, F);
  assert.deepEqual(
    requests.map((r) => [r.tokenIn, r.tokenOut]),
    [
      [F, Q],
      [A, F],
    ],
  );
});
test("high-impact reference quotes retry smaller amounts without relaxing the impact limit", async () => {
  const amounts: string[] = [];
  const quotes = new Quotes(
    {
      price: async ({ amount }: { amount: string }) => {
        amounts.push(amount);
        return {
          amountIn: amount,
          priceImpact: amounts.length === 1 ? 0.11 : 0.1,
        };
      },
    } as unknown as UniswapClient,
    8453,
    A,
    0.5,
    10,
  );
  const reference = await quotes.reference(A, Q, 10n ** 15n, 0.1);
  assert.deepEqual(amounts, ["1000000000000000", "100000000000000"]);
  assert.equal(reference.priceImpact, 0.1);
  assert.equal(reference.amountIn, amounts[1]);
});
test("a pre-leg estimate that clears cost cannot compensate for an insufficient minimum", async () => {
  let calls = 0;
  const quotes = new Quotes(
    {
      quote: async () => {
        calls++;
        return { minimumAmountOut: "99", estimatedAmountOut: "200" };
      },
    } as unknown as UniswapClient,
    8453,
    A,
    0.5,
    10,
  );
  assert.equal(
    await quotes.candidate(
      {
        id: 1n,
        asset: A,
        quote: Q,
        priceX128: 1n << 128n,
        availableSupply: 100n,
      },
      100n,
      F,
      100n,
    ),
    undefined,
  );
  assert.equal(calls, 1);
});
test("actual resolver simulation must accept every expected index before estimating gas", async () => {
  const calls: string[] = [];
  const client = {
    simulateContract: async (args: { args: unknown }) => {
      calls.push("simulate");
      assert.deepEqual(args.args, [[c.order], A]);
      return { result: 1n };
    },
    estimateContractGas: async () => {
      calls.push("estimate");
      return 500000n;
    },
  } as unknown as PublicClient;
  assert.equal((await simulate(client, A, F, A, [c])).gas, 600000n);
  assert.deepEqual(calls, ["simulate", "estimate"]);
  const partial = {
    ...client,
    simulateContract: async () => ({ result: 1n }),
  } as unknown as PublicClient;
  await assert.rejects(
    simulate(partial, A, F, A, [
      c,
      { ...c, order: { ...c.order, tickId: 2n } },
    ]),
    /PartialSimulation/,
  );
  await assert.rejects(
    simulate(client, A, F, A, [{ ...c, quotedAt: 0 }]),
    /StaleBatch/,
  );
});
test("gas estimation cannot silently skip later orders in a successful batch", async () => {
  const limits: bigint[] = [];
  const client = {
    simulateContract: async ({ gas }: { gas: bigint }) => {
      limits.push(gas);
      return { result: gas >= 4_000_000n ? 3n : 1n };
    },
    estimateContractGas: async () => 2_200_000n,
  } as unknown as PublicClient;
  const result = await simulate(client, A, F, A, [
    c,
    { ...c, order: { ...c.order, tickId: 2n } },
  ]);
  assert.equal(result.bitmap, 3n);
  assert.equal(result.gas, 5_280_000n);
  assert.deepEqual(limits, [16_000_000n, 2_640_000n, 5_280_000n]);
  await assert.rejects(
    simulate(
      {
        ...client,
        estimateContractGas: async () => 0n,
      } as unknown as PublicClient,
      A,
      F,
      A,
      [c, c],
    ),
    /InvalidGasEstimate/,
  );
});
test("unknown broadcast state keeps nonce reservation; confirmed receipts release it", async () => {
  let deleted = false;
  const state = {
    get: async () => ({
      hash: `0x${"a".repeat(64)}`,
      nonce: 1,
      createdAt: 0,
      resolver: A,
      expectedBitmap: "1",
      expectedGross: "100",
      expectedGasCost: "10",
    }),
    delete: async () => {
      deleted = true;
      return true;
    },
    put: async () => {},
  } as State;
  assert.equal(
    await observePending(
      {
        getTransactionReceipt: async () => {
          throw new Error("RPC with secret URL");
        },
      } as unknown as PublicClient,
      state,
      8453,
    ),
    true,
  );
  assert.equal(deleted, false);
  const client = {
    getTransactionReceipt: async () => ({
      status: "success",
      blockNumber: 10n,
      gasUsed: 1n,
      logs: [],
    }),
    getBlockNumber: async () => 13n,
  } as unknown as PublicClient;
  assert.equal(await observePending(client, state, 8453), false);
  assert.equal(deleted, true);
});
