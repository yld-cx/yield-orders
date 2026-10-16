import { describe, it, expect, vi } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  EthereumClient,
  PreviewChangedError,
  TransactionPendingError,
  actionData,
  pairIdFor,
  tickIdFor,
  protocolAbi,
  Q128,
} from "@yld-cx/sdk/ethereum";
import {
  Duration,
  type EconomicAction,
  type TickState,
  type UsePosition,
} from "@yld-cx/sdk";
// Exercise timeout recovery without imposing a short timeout on Safe users.
vi.mock("../packages/sdk/src/constants.ts", async (original) => ({
  ...(await original<object>()),
  RECEIPT_TIMEOUT_MS: 200,
}));
const a = "0x0000000000000000000000000000000000000001";
const b = "0x0000000000000000000000000000000000000002";
const owner = "0x0000000000000000000000000000000000000003";
const hash = `0x${"12".repeat(32)}` as Hex;
function missing() {
  return new BaseError("revert", {
    cause: new ContractFunctionRevertedError({
      abi: protocolAbi,
      data: encodeErrorResult({ abi: protocolAbi, errorName: "NotFound" }),
      functionName: "getTick",
    }),
  });
}
function supply(direction: 0 | 1 = 0): EconomicAction {
  return {
    kind: "supply",
    tickId: tickIdFor(pairIdFor(a, b), direction, 100, Duration.Monthly),
    amount: 123n,
    referrer: b,
    initialize: {
      tokenA: b,
      tokenB: a,
      direction,
      priceTick: 100,
      durationDays: Duration.Monthly,
    },
  };
}
function fixture(pair = true, tick = true) {
  const state = {
    pair,
    tick,
    allowance: 10000n,
    balance: 10000n,
    failure: undefined as Error | undefined,
    readFailure: undefined as Error | undefined,
  };
  const names = (calls: readonly Hex[]) =>
    calls.map(
      (data) => decodeFunctionData({ abi: protocolAbi, data }).functionName,
    );
  const readContract = vi.fn(
    async ({ functionName }: { functionName: string }) => {
      if (functionName === "getPair") {
        if (state.readFailure) throw state.readFailure;
        return [pairIdFor(a, b), a, b, state.pair];
      }
      if (functionName === "getTick") {
        if (state.readFailure) throw state.readFailure;
        if (!state.tick) throw missing();
        return tickState;
      }
      if (functionName === "balanceOf") return state.balance;
      if (functionName === "allowance") return state.allowance;
      if (functionName === "quoteUse") return [200n, 10n];
      if (functionName === "nextPositionId") return 9n;
      if (functionName === "getPosition") return position;
      throw new Error(`Unexpected read ${functionName}`);
    },
  );
  const tickState: TickState = {
    asset: a,
    quote: b,
    durationDays: 30n,
    priceX128: Q128,
    availableSupply: 123n,
    workingSupply: 0n,
    exitWorking: 0n,
    activeWorking: 0n,
    activePrincipal: 123n,
    settleCursor: 0n,
  };
  const position: UsePosition = {
    tickId: 1n,
    tickSeq: 0n,
    user: owner,
    assetAmount: 123n,
    quotePrincipal: 200n,
    fullTermYieldAsset: 10n,
    closeFee: 2n,
    openedAt: 1n,
    maturity: 1000n,
    status: 1,
  };
  const simulateContract = vi.fn(
    async (call: { functionName: string; args: readonly unknown[] }) => {
      if (state.failure) throw state.failure;
      if (call.functionName === "approve") return { request: call };
      const calls = call.args[0] as Hex[];
      const result = calls.map((data) => {
        const decoded = decodeFunctionData({ abi: protocolAbi, data });
        const name = decoded.functionName;
        if (name === "getTick")
          return encodeFunctionResult({
            abi: protocolAbi,
            functionName: name,
            result: tickState,
          });
        if (name === "getPosition")
          return encodeFunctionResult({
            abi: protocolAbi,
            functionName: name,
            result: position,
          });
        const abi = protocolAbi.find(
          (entry) => entry.type === "function" && entry.name === name,
        )!;
        // Build zero-valued protocol result tuples, with a recognizable economic field.
        const output = "outputs" in abi ? abi.outputs[0] : undefined;
        if (output?.type === "tuple") {
          const values = Object.fromEntries(
            output.components.map((c) => [
              c.name,
              c.name === "activePrincipal" ? 123n : 0n,
            ]),
          );
          return encodeFunctionResult({
            abi: protocolAbi,
            functionName: name,
            result: values as never,
          });
        }
        return encodeFunctionResult({
          abi: protocolAbi,
          functionName: name,
          result: 0n as never,
        });
      });
      return { result, request: call };
    },
  );
  const estimateContractGas = vi.fn(async () => 123456n);
  const sdk = new EthereumClient(
    {
      getChainId: async () => 8453,
      getCode: async () => "0x1234",
      getBlock: async () => ({ number: 99n, timestamp: 100n }),
      readContract,
      simulateContract,
      estimateContractGas,
    } as unknown as PublicClient,
    "eip155:8453",
    { address: a, runtimeCodeHash: keccak256("0x1234") },
  );
  const writeContract = vi.fn(
    async (request: { functionName: string; args: readonly unknown[] }) => {
      if (request.functionName === "approve")
        state.allowance = request.args[1] as bigint;
      return hash;
    },
  );
  const getTransactionReceipt = vi.fn(async () => ({
    status: "success",
    transactionHash: hash,
    blockNumber: 100n,
    logs: [],
  }));
  const wallet = {
    uid: `plan-wallet-${Math.random()}`,
    getChainId: async () => 8453,
    getAddresses: async () => [owner],
    writeContract,
    getTransactionReceipt,
  } as unknown as WalletClient;
  return {
    sdk,
    wallet,
    state,
    names,
    readContract,
    simulateContract,
    estimateContractGas,
    writeContract,
    getTransactionReceipt,
  };
}
describe("atomic Provide plans", () => {
  it.each([0, 1] as const)(
    "uses the canonical direction %s asset without a nonexistent Tick read",
    async (direction) => {
      const { sdk, readContract } = fixture(false, false);
      expect(await sdk.requiredInput(supply(direction))).toEqual({
        token: direction === 0 ? a : b,
        amount: 123n,
        allowanceAmount: 123n,
      });
      expect(readContract).not.toHaveBeenCalled();
    },
  );
  it.each([
    [true, true],
    [true, false],
    [false, false],
  ])(
    "simulates, estimates and executes one batch (Pair %s, Tick %s)",
    async (pair, tick) => {
      for (const direction of [0, 1] as const) {
        const f = fixture(pair, tick),
          action = supply(direction);
        const preview = await f.sdk.preview(action, owner);
        const expected = [
          ...(!pair ? ["createPair"] : []),
          ...(!tick ? ["createTick"] : []),
          "supply",
        ];
        expect(f.names(preview.plan.calls)).toEqual(expected);
        expect(preview.provider?.activePrincipal).toBe(123n);
        expect(preview.tick?.availableSupply).toBe(123n);
        expect(f.simulateContract.mock.calls[0][0].args[0]).toEqual([
          ...preview.plan.calls,
          expect.any(String),
          expect.any(String),
        ]);
        expect(f.estimateContractGas).toHaveBeenCalledWith(
          expect.objectContaining({ args: [preview.plan.calls] }),
        );
        const supplyCall = decodeFunctionData({
          abi: protocolAbi,
          data: preview.plan.calls.at(-1)!,
        });
        expect(supplyCall.args).toEqual([
          "tickId" in action ? action.tickId : 0n,
          123n,
          b,
        ]);
        await f.sdk.execute(preview, f.wallet);
        expect(f.writeContract).toHaveBeenCalledTimes(1);
        expect(f.writeContract).toHaveBeenCalledWith(
          expect.objectContaining({ args: [preview.plan.calls] }),
        );
        expect(
          f.names(f.writeContract.mock.calls[0][0].args[0] as Hex[]),
        ).toEqual(expected);
      }
    },
  );
  it("propagates Pair and Tick RPC failures without treating them as absence", async () => {
    for (const pair of [true, false]) {
      const f = fixture(pair, false);
      f.state.readFailure = new Error("RPC unavailable");
      await expect(f.sdk.preview(supply(), owner)).rejects.toThrow(
        "RPC unavailable",
      );
      expect(f.simulateContract).not.toHaveBeenCalled();
    }
    const f = fixture(true, false);
    vi.spyOn(f.sdk, "getTick").mockRejectedValue(new Error("RPC Tick failure"));
    await expect(f.sdk.transactionPlan(supply())).rejects.toThrow(
      "RPC Tick failure",
    );
  });
  it("rejects inconsistent deterministic identities", async () => {
    const f = fixture();
    const action = supply();
    if (action.kind === "supply") action.tickId = 1n;
    await expect(f.sdk.transactionPlan(action)).rejects.toThrow("identity");
    expect(f.readContract).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "refreshes concurrent creation for explicit confirmation (Pair initially %s)",
    async (pair) => {
      const f = fixture(pair, false);
      const preview = await f.sdk.preview(supply(), owner);
      f.state.pair = true;
      f.state.tick = true;
      let changed: PreviewChangedError | undefined;
      try {
        await f.sdk.execute(preview, f.wallet);
      } catch (e) {
        expect(e).toBeInstanceOf(PreviewChangedError);
        changed = e as PreviewChangedError;
      }
      expect(f.writeContract).not.toHaveBeenCalled();
      expect(f.names(changed!.preview.plan.calls)).toEqual(["supply"]);
      expect(changed!.preview.action).toEqual(preview.action);
      await f.sdk.execute(changed!.preview, f.wallet);
      expect(f.writeContract).toHaveBeenCalledTimes(1);
    },
  );
  it("catches creation between validation and pending simulation without submitting changed data", async () => {
    const f = fixture(true, false);
    const preview = await f.sdk.preview(supply(), owner);
    f.simulateContract.mockImplementationOnce(async () => {
      f.state.tick = true;
      throw new Error("AlreadyExists");
    });
    await expect(f.sdk.execute(preview, f.wallet)).rejects.toBeInstanceOf(
      PreviewChangedError,
    );
    expect(f.writeContract).not.toHaveBeenCalled();
  });
});
describe("validation and transaction recovery", () => {
  it("never writes on final simulation failure, and preserves the preview for retry", async () => {
    const f = fixture();
    const preview = await f.sdk.preview(supply(), owner);
    f.state.failure = new Error("Slippage");
    await expect(f.sdk.execute(preview, f.wallet)).rejects.toThrow("Slippage");
    expect(f.writeContract).not.toHaveBeenCalled();
    f.state.failure = undefined;
    await f.sdk.execute(preview, f.wallet);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
  });
  it.each(["account", "network"])(
    "rejects changed wallet %s before writing",
    async (change) => {
      const f = fixture();
      const preview = await f.sdk.preview(supply(), owner);
      if (change === "account") f.wallet.getAddresses = async () => [b];
      else f.wallet.getChainId = async () => 1;
      await expect(f.sdk.execute(preview, f.wallet)).rejects.toThrow(
        change === "account" ? "account changed" : "selected network",
      );
      expect(f.writeContract).not.toHaveBeenCalled();
    },
  );
  it("blocks duplicate clicks while a Safe-style receipt is delayed", async () => {
    const f = fixture();
    const preview = await f.sdk.preview(supply(), owner);
    let finish!: (
      value: Awaited<ReturnType<typeof f.getTransactionReceipt>>,
    ) => void;
    f.getTransactionReceipt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const submitted = f.sdk.execute(preview, f.wallet);
    await vi.waitFor(() => expect(f.writeContract).toHaveBeenCalledTimes(1));
    await expect(f.sdk.execute(preview, f.wallet)).rejects.toThrow(
      "already in progress",
    );
    finish({
      status: "success",
      transactionHash: hash,
      blockNumber: 100n,
      logs: [],
    });
    await submitted;
    expect(f.writeContract).toHaveBeenCalledTimes(1);
  });
  it("retries an unknown receipt without another wallet submission", async () => {
    const f = fixture();
    const preview = await f.sdk.preview(supply(), owner);
    f.getTransactionReceipt.mockRejectedValueOnce(new Error("receipt timeout"));
    await expect(f.sdk.execute(preview, f.wallet)).rejects.toBeInstanceOf(
      TransactionPendingError,
    );
    f.state.failure = new Error("state changed while pending");
    await f.sdk.execute(preview, f.wallet);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
    expect(f.getTransactionReceipt).toHaveBeenCalledTimes(2);
  });
  it("resumes approval receipt waiting and never executes the economic action", async () => {
    const f = fixture(false, false);
    f.state.allowance = 0n;
    f.getTransactionReceipt.mockRejectedValueOnce(new Error("timeout"));
    await expect(
      f.sdk.approve(supply(), f.wallet, owner),
    ).rejects.toBeInstanceOf(TransactionPendingError);
    await f.sdk.approve(supply(), f.wallet, owner);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
    expect(f.writeContract.mock.calls[0][0].functionName).toBe("approve");
  });
  it("recovers from approval rejection, including after a zero-first reset", async () => {
    const f = fixture(false, false);
    f.state.allowance = 1n;
    f.writeContract
      .mockImplementationOnce(async () => {
        f.state.allowance = 0n;
        return hash;
      })
      .mockRejectedValueOnce(new Error("User rejected"));
    await expect(f.sdk.approve(supply(), f.wallet, owner)).rejects.toThrow(
      "User rejected",
    );
    expect(f.state.allowance).toBe(0n);
    await f.sdk.approve(supply(), f.wallet, owner);
    expect(f.state.allowance).toBe(123n);
    expect(f.writeContract).toHaveBeenCalledTimes(3);
  });
  it.each([
    "use",
    "swap",
    "withdraw",
    "collect",
    "repay",
    "close",
    "settle",
  ] as const)(
    "preserves the %s call and protections, excluding preview getters",
    async (kind) => {
      const f = fixture();
      const actions: Record<typeof kind, EconomicAction> = {
        use: {
          kind: "use",
          tickId: 1n,
          amount: 123n,
          maxFullTermYieldAsset: 11n,
          deadline: 500n,
        },
        swap: {
          kind: "swap",
          tickId: 1n,
          amount: 123n,
          maxQuoteIn: 210n,
          deadline: 500n,
        },
        withdraw: {
          kind: "withdraw",
          tickId: 1n,
          amount: 123n,
          minImmediateAssetOut: 100n,
          deadline: 500n,
        },
        collect: { kind: "collect", tickId: 1n },
        repay: { kind: "repay", positionId: 9n, maxYieldAsset: 10n },
        close: { kind: "close", positionId: 9n },
        settle: { kind: "settle", tickId: 1n },
      };
      const action = actions[kind];
      const preview = await f.sdk.preview(action, owner);
      expect(preview.plan.calls).toEqual([actionData(action)]);
      await f.sdk.execute(preview, f.wallet);
      expect(f.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ args: [[actionData(action)]] }),
      );
    },
  );
});
