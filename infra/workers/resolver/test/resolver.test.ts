import test from "node:test";
import assert from "node:assert/strict";
import type { Address, PublicClient } from "viem";
import { roundRobin } from "../src/markets.ts";
import { quotePrincipal, sizes } from "../src/ticks.ts";
import { Quotes } from "../src/quotes.ts";
import { expectedBitmap, simulate } from "../src/simulate.ts";
import { netPositive, observePending, type State } from "../src/execute.ts";
import type { Candidate } from "../src/shared.ts";
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
