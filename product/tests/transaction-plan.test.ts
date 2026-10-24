import { describe, it, expect, vi } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  erc20Abi,
  type GetCallsStatusReturnType,
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
  actionData,
  pairIdFor,
  tickIdFor,
  protocolAbi,
  Q128,
  supportsAtomic,
} from "@yld-cx/sdk/ethereum";
import {
  Duration,
  type EconomicAction,
  type TickState,
  type UsePosition,
} from "@yld-cx/sdk";
// Keep unexpected receipt waits bounded in tests.
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
    zeroFirst: false,
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
      if (call.functionName === "approve") {
        if (
          state.zeroFirst &&
          state.allowance > 0n &&
          (call.args[1] as bigint) > 0n
        )
          throw missing();
        return { request: call };
      }
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
  const simulateCalls = vi.fn(
    async ({ calls }: { calls: { to: string; data: Hex }[] }) => ({
      results: await Promise.all(
        calls.map(async ({ data }) => {
          let result: Hex;
          try {
            const token = decodeFunctionData({ abi: erc20Abi, data });
            if (token.functionName !== "approve") throw new Error("unexpected");
            result = encodeFunctionResult({
              abi: erc20Abi,
              functionName: "approve",
              result: true,
            });
          } catch {
            const decoded = decodeFunctionData({ abi: protocolAbi, data });
            const simulated = await simulateContract({
              functionName: decoded.functionName,
              args: decoded.args ?? [],
            });
            result = encodeFunctionResult({
              abi: protocolAbi,
              functionName: "multicall",
              result: simulated.result!,
            });
          }
          return { status: "success", data: result, gasUsed: 123n };
        }),
      ),
    }),
  );
  const estimateContractGas = vi.fn(async () => 123456n);
  const getTransactionReceipt = vi.fn(async () => ({
    status: "success",
    transactionHash: hash,
    blockNumber: 100n,
    logs: [],
  }));
  const verifyReceipt = vi.fn(async () => ({
    status: "success",
    transactionHash: hash,
    blockNumber: 100n,
    logs: [],
  }));
  const sdk = new EthereumClient(
    {
      uid: `public-${Math.random()}`,
      getTransactionReceipt: verifyReceipt,
      getChainId: async () => 8453,
      getCode: async () => "0x1234",
      getBlock: async (args?: { blockNumber?: bigint }) => ({
        number: args?.blockNumber ?? 99n,
        timestamp: 100n,
      }),
      readContract,
      simulateContract,
      simulateCalls,
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
  const watchBlockNumber = vi.fn(
    ({ onBlockNumber }: { onBlockNumber: (block: bigint) => void }) => {
      queueMicrotask(() => onBlockNumber(101n));
      return () => {};
    },
  );
  const wallet = {
    uid: `plan-wallet-${Math.random()}`,
    getChainId: async () => 8453,
    getAddresses: async () => [owner],
    writeContract,
    getTransactionReceipt,
    getCallsStatus: vi.fn(async () => batchStatus()),
    pollingInterval: 5,
    watchBlockNumber,
  } as unknown as WalletClient;
  return {
    sdk,
    wallet,
    state,
    names,
    readContract,
    simulateContract,
    estimateContractGas,
    simulateCalls,
    writeContract,
    getTransactionReceipt,
    verifyReceipt,
    watchBlockNumber,
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
describe("validation and transaction confirmation", () => {
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
  it.each(["action", "approval"] as const)(
    "waits for two confirmations before completing an %s",
    async (phase) => {
      const f = fixture();
      f.state.allowance = phase === "approval" ? 0n : 10000n;
      const preview = await f.sdk.preview(supply(), owner);
      let onBlock!: (block: bigint) => void;
      f.watchBlockNumber.mockImplementation(({ onBlockNumber }) => {
        onBlock = onBlockNumber;
        return () => {};
      });
      const status = vi.fn();
      let completed = false;
      const submitted = (
        phase === "approval"
          ? f.sdk.approve(supply(), f.wallet, owner, status)
          : f.sdk.execute(preview, f.wallet, status)
      ).then(() => {
        completed = true;
      });
      await vi.waitFor(() => expect(onBlock).toBeTypeOf("function"));
      await onBlock(100n);
      expect(completed).toBe(false);
      expect(status).not.toHaveBeenCalledWith("confirmed", hash);
      await onBlock(101n);
      await submitted;
      expect(completed).toBe(true);
      expect(f.writeContract).toHaveBeenCalledTimes(1);
    },
  );
  it("recovers from approval rejection, including after a zero-first reset", async () => {
    const f = fixture(false, false);
    f.state.allowance = 1n;
    f.state.zeroFirst = true;
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

function batchStatus(
  status: "pending" | "success" | "failure" = "success",
): GetCallsStatusReturnType {
  return {
    id: "batch",
    atomic: true,
    chainId: 8453,
    version: "2.0.0",
    status,
    statusCode: status === "pending" ? 100 : status === "success" ? 200 : 500,
    receipts:
      status === "pending"
        ? []
        : [
            {
              transactionHash: hash,
              blockNumber: 100n,
              status: "success",
              gasUsed: 100n,
              logs: [],
              blockHash: hash,
            },
          ],
  };
}
describe("wallet batching", () => {
  it.each([
    undefined,
    {},
    { atomic: { status: "unsupported" } },
    { atomic: { status: "ready" } },
  ])(
    "rejects capabilities without explicit atomic support: %j",
    (capabilities) => {
      expect(supportsAtomic(capabilities)).toBe(false);
    },
  );
  it("accepts explicit atomic support", () => {
    expect(supportsAtomic({ atomic: { status: "supported" } })).toBe(true);
  });
  it.each([false, true])(
    "simulates ordered approval and preserves the protocol multicall (zero first: %s)",
    async (zeroFirst) => {
      const f = fixture(false, false);
      f.state.allowance = zeroFirst ? 1n : 0n;
      f.state.zeroFirst = zeroFirst;
      const preview = await f.sdk.preview(supply(), owner, { atomic: true });
      const calls = preview.walletCalls!;
      expect(calls).toHaveLength(zeroFirst ? 3 : 2);
      expect(
        calls
          .slice(0, -1)
          .map((c) => decodeFunctionData({ abi: erc20Abi, data: c.data }).args),
      ).toEqual(
        zeroFirst
          ? [
              [a, 0n],
              [a, 123n],
            ]
          : [[a, 123n]],
      );
      const protocol = decodeFunctionData({
        abi: protocolAbi,
        data: calls.at(-1)!.data,
      });
      expect(protocol.functionName).toBe("multicall");
      expect(protocol.args).toEqual([preview.plan.calls]);
      expect(f.names(preview.plan.calls)).toEqual([
        "createPair",
        "createTick",
        "supply",
      ]);
      expect(f.simulateCalls).toHaveBeenCalledTimes(1);
      const send = vi.fn(async () => "batch-1");
      await expect(
        f.sdk.execute(preview, f.wallet, undefined, send),
      ).resolves.toMatchObject({ hash });
      expect(send).toHaveBeenCalledExactlyOnceWith(calls);
      expect(f.writeContract).not.toHaveBeenCalled();
      expect(f.wallet.getCallsStatus).toHaveBeenCalledWith({ id: "batch-1" });
    },
  );
  it("omits approvals when allowance is sufficient", async () => {
    const f = fixture();
    const preview = await f.sdk.preview(supply(), owner, { atomic: true });
    expect(preview.walletCalls).toHaveLength(1);
    expect(
      decodeFunctionData({
        abi: protocolAbi,
        data: preview.walletCalls![0].data,
      }).functionName,
    ).toBe("multicall");
  });
  it("uses one direct approval when a nonzero allowance can be increased", async () => {
    const f = fixture();
    f.state.allowance = 1n;
    await f.sdk.approve(supply(), f.wallet, owner);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
    expect(f.writeContract.mock.calls[0][0].args[1]).toBe(123n);
  });
  it("returns the approval block for the refreshed preview", async () => {
    const f = fixture();
    f.state.allowance = 0n;
    expect(await f.sdk.approve(supply(), f.wallet, owner)).toBe(100n);
    expect(f.writeContract).toHaveBeenCalledTimes(1);
    expect(
      (await f.sdk.preview(supply(), owner, { minBlock: 100n })).blockNumber,
    ).toBe(100n);
  });
  it("waits for wallet batch execution before checking confirmations", async () => {
    const f = fixture();
    f.state.allowance = 0n;
    const preview = await f.sdk.preview(supply(), owner, { atomic: true });
    const getStatus = vi
      .spyOn(f.wallet, "getCallsStatus")
      .mockResolvedValue(batchStatus("pending"));
    const send = vi.fn(async () => "proposal");
    const status = vi.fn();
    const submitted = f.sdk.execute(preview, f.wallet, status, send);
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(f.getTransactionReceipt).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith("confirmed", hash);
    getStatus.mockResolvedValue(batchStatus());
    await expect(submitted).resolves.toMatchObject({ hash });
    expect(send).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith("confirmed", hash);
  });
  it.each([4001, 4200])(
    "allows retry after a known wallet failure (%s)",
    async (code) => {
      const f = fixture();
      const preview = await f.sdk.preview(supply(), owner);
      f.writeContract.mockRejectedValueOnce(
        Object.assign(new Error("Wallet request failed"), { code }),
      );
      await expect(f.sdk.execute(preview, f.wallet)).rejects.toThrow(
        "Wallet request failed",
      );
      await f.sdk.execute(preview, f.wallet);
      expect(f.writeContract).toHaveBeenCalledTimes(2);
    },
  );
  it("surfaces reverted wallet batches without reporting confirmation", async () => {
    const f = fixture();
    f.state.allowance = 0n;
    const preview = await f.sdk.preview(supply(), owner, { atomic: true });
    vi.spyOn(f.wallet, "getCallsStatus").mockResolvedValue(
      batchStatus("failure"),
    );
    const status = vi.fn();
    await expect(
      f.sdk.execute(preview, f.wallet, status, async () => "batch"),
    ).rejects.toThrow("failed or reverted");
    expect(f.getTransactionReceipt).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith("confirmed", hash);
  });
  it("refreshes changed atomic calldata for review before any wallet submission", async () => {
    const f = fixture(false, false);
    f.state.allowance = 0n;
    const preview = await f.sdk.preview(supply(), owner, { atomic: true });
    f.state.pair = f.state.tick = true;
    const send = vi.fn();
    await expect(
      f.sdk.execute(preview, f.wallet, undefined, send),
    ).rejects.toBeInstanceOf(PreviewChangedError);
    expect(send).not.toHaveBeenCalled();
  });
});

it("uses the installed Safe provider's capabilities and batch status through Viem", async () => {
  const { SafeAppProvider } = await import("@safe-global/safe-apps-provider");
  const { TransactionStatus } = await import("@safe-global/safe-apps-sdk");
  const { createWalletClient, custom } = await import("viem");
  const { base } = await import("viem/chains");
  let executed = false;
  const getBySafeTxHash = vi.fn(async () => ({
    txStatus: executed
      ? TransactionStatus.SUCCESS
      : TransactionStatus.AWAITING_CONFIRMATIONS,
    txHash: executed ? hash : undefined,
  }));
  const send = vi.fn(async () => ({ safeTxHash: hash }));
  const provider = new SafeAppProvider(
    { safeAddress: owner, chainId: 8453 } as ConstructorParameters<
      typeof SafeAppProvider
    >[0],
    {
      txs: {
        send,
        getBySafeTxHash,
      },
      eth: {
        getBlockByNumber: async () => ({ number: "0x65" }),
        getTransactionReceipt: async () => ({
          blockNumber: "0x64",
          transactionHash: hash,
          transactionIndex: "0x0",
          status: "0x1",
          gasUsed: "0x64",
          blockHash: hash,
          logs: [],
        }),
      },
    } as unknown as ConstructorParameters<typeof SafeAppProvider>[1],
  );
  const wallet = createWalletClient({
    account: owner,
    chain: base,
    pollingInterval: 5,
    transport: custom(provider),
  });
  expect(supportsAtomic(await wallet.getCapabilities({ chainId: 8453 }))).toBe(
    true,
  );
  const f = fixture();
  f.state.allowance = 0n;
  const preview = await f.sdk.preview(supply(), owner, { atomic: true });
  const submitted = f.sdk.execute(
    preview,
    wallet,
    undefined,
    async (calls) => (await wallet.sendCalls({ calls, forceAtomic: true })).id,
  );
  await vi.waitFor(() => expect(getBySafeTxHash).toHaveBeenCalled());
  expect(f.getTransactionReceipt).not.toHaveBeenCalled();
  executed = true;
  await expect(submitted).resolves.toMatchObject({ hash });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toEqual([
    { txs: preview.walletCalls!.map((call) => ({ ...call, value: "0x0" })) },
  ]);
});

it.each(["supply", "use", "swap", "repay"] as const)(
  "atomic %s preserves approval caps and economic calldata",
  async (kind) => {
    const f = fixture();
    f.state.allowance = 0n;
    const action: EconomicAction =
      kind === "supply"
        ? supply()
        : kind === "repay"
          ? { kind, positionId: 9n, maxYieldAsset: 11n }
          : kind === "use"
            ? {
                kind,
                tickId: 1n,
                amount: 123n,
                maxFullTermYieldAsset: 11n,
                deadline: 500n,
              }
            : {
                kind,
                tickId: 1n,
                amount: 123n,
                maxQuoteIn: 210n,
                deadline: 500n,
              };
    const preview = await f.sdk.preview(action, owner, { atomic: true });
    const approval = decodeFunctionData({
      abi: erc20Abi,
      data: preview.walletCalls![0].data,
    });
    expect(approval.args?.[1]).toBe(
      kind === "supply"
        ? 123n
        : kind === "use"
          ? 200n
          : kind === "swap"
            ? 210n
            : 134n,
    );
    expect(preview.plan.calls.at(-1)).toBe(actionData(action));
  },
);
