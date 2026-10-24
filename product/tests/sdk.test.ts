import { describe, it, expect, vi } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  keccak256,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  EthereumClient,
  actionData,
  protocolAbi,
  tickCandidates,
  Q128,
  type Preview,
} from "@yld-cx/sdk/ethereum";
import {
  DISCOVERY_DEFAULTS,
  DISCOVERY_BATCH_SIZE,
  type EconomicAction,
} from "@yld-cx/sdk";
const address = "0x0000000000000000000000000000000000000001";
const owner = "0x0000000000000000000000000000000000000002";
const state = {
  asset: address,
  quote: owner,
  durationDays: 7n,
  priceX128: Q128,
  availableSupply: 1n,
  workingSupply: 0n,
  exitWorking: 0n,
  activeWorking: 0n,
  activePrincipal: 1n,
  settleCursor: 0n,
};
function client(methods: object) {
  return new EthereumClient(methods as PublicClient, "eip155:8453", {
    address,
    runtimeCodeHash: keccak256("0x1234"),
  });
}
describe("balance requirements and approval caps", () => {
  const repay: EconomicAction = {
    kind: "repay",
    positionId: 1n,
    maxYieldAsset: 100n,
  };
  const swap: EconomicAction = {
    kind: "swap",
    tickId: 42n,
    amount: 1000n,
    maxQuoteIn: 1005n,
    deadline: 300n,
  };
  function setup(balance: bigint, allowance = 0n, timestamp = 110n) {
    const readContract = vi.fn(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "getTick") return state;
        if (functionName === "getPosition")
          return {
            tickId: 42n,
            assetAmount: 1000n,
            fullTermYieldAsset: 100n,
            openedAt: 100n,
            maturity: 200n,
          };
        if (functionName === "quoteUse") return [1000n, 100n];
        if (functionName === "balanceOf") return balance;
        if (functionName === "allowance") return allowance;
        throw new Error(`Unexpected read: ${functionName}`);
      },
    );
    const simulateContract = vi.fn(
      async ({ args }: { args: readonly [string, bigint] }) => {
        if (allowance > 0n && args[1] > 0n)
          throw new BaseError("zero first", {
            cause: new ContractFunctionRevertedError({
              abi: protocolAbi,
              functionName: "approve",
              message: "reset allowance",
            }),
          });
        return { request: { args } };
      },
    );
    const getTransactionReceipt = vi.fn(async () => ({
      status: "success",
      blockNumber: 100n,
    }));
    const sdk = client({
      getChainId: async () => 8453,
      getCode: async () => "0x1234",
      getBlock: async () => ({ number: 99n, timestamp }),
      readContract,
      getTransactionReceipt: async () => ({
        status: "success",
        transactionHash: "0x1234",
        blockNumber: 100n,
      }),
      simulateContract,
    });
    const writeContract = vi.fn(
      async ({ args }: { args: readonly [string, bigint] }) => {
        allowance = args[1];
        return "0x1234";
      },
    );
    const wallet = {
      uid: "approval-wallet",
      getChainId: async () => 8453,
      getAddresses: async () => [owner],
      writeContract,
      getTransactionReceipt,
      getBlockNumber: async () => 101n,
      pollingInterval: 5,
    } as unknown as WalletClient;
    return {
      sdk,
      wallet,
      readContract,
      simulateContract,
      writeContract,
      getTransactionReceipt,
    };
  }
  it("pins early repayment estimates and rounds elapsed Yield up", async () => {
    const { sdk, readContract } = setup(1010n);
    expect(await sdk.requiredInput(repay)).toEqual({
      token: address,
      amount: 1010n,
      allowanceAmount: 1100n,
    });
    expect(
      readContract.mock.calls.every(
        ([call]) => "blockNumber" in call && call.blockNumber === 99n,
      ),
    ).toBe(true);
    expect(
      (await setup(1001n, 0n, 100n).sdk.requiredInput(repay))?.amount,
    ).toBe(1001n);
  });
  it.each([
    { action: repay, balance: 1010n, cap: 1100n },
    { action: swap, balance: 1000n, cap: 1005n },
  ])(
    "approves the $action.kind cap with only the current transfer balance",
    async ({ action, balance, cap }) => {
      const {
        sdk,
        wallet,
        simulateContract,
        writeContract,
        getTransactionReceipt,
      } = setup(balance, 1n);
      await sdk.approve(action, wallet, owner);
      expect(simulateContract.mock.calls).toHaveLength(3);
      expect(simulateContract).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          functionName: "approve",
          args: [address, 0n],
        }),
      );
      expect(simulateContract).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          functionName: "approve",
          args: [address, cap],
        }),
      );
      expect(writeContract).toHaveBeenCalledTimes(2);
      expect(getTransactionReceipt).toHaveBeenCalledTimes(2);
      expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: "0x1234" });
    },
  );
  it("keeps actual Swap payment separate from its tolerance cap", async () => {
    expect(await setup(1000n).sdk.requiredInput(swap)).toEqual({
      token: owner,
      amount: 1000n,
      allowanceAmount: 1005n,
    });
  });
  it("rejects insufficient current balance before requesting approval", async () => {
    const { sdk, wallet, writeContract } = setup(1009n);
    await expect(sdk.approve(repay, wallet, owner)).rejects.toThrow(
      "Insufficient token balance",
    );
    expect(writeContract).not.toHaveBeenCalled();
  });
  it("does not reset an allowance that already covers the cap", async () => {
    const { sdk, wallet, writeContract } = setup(1010n, 1100n);
    await sdk.approve(repay, wallet, owner);
    expect(writeContract).not.toHaveBeenCalled();
  });
  it("directs matured repayments to a fresh Close review", async () => {
    await expect(
      setup(1100n, 0n, 200n).sdk.requiredInput(repay),
    ).rejects.toThrow("review Close");
  });
});
describe("direct reads and write safety", () => {
  it.each(["cancelled", "replaced", "repriced"])(
    "handles a %s replacement without treating changed data as success",
    async (reason) => {
      const methods: Record<string, unknown> = {
        getChainId: async () => 8453,
        getCode: async () => "0x1234",
        getBlock: async () => ({ number: 1n, timestamp: 1n }),
        simulateContract: async () => ({ request: {} }),
      };
      const getTransactionReceipt = vi
        .fn()
        .mockRejectedValueOnce(
          new TransactionReceiptNotFoundError({ hash: "0x1234" }),
        )
        .mockRejectedValueOnce(
          new TransactionReceiptNotFoundError({ hash: "0x1234" }),
        )
        .mockResolvedValue({
          status: "success",
          logs: [],
          transactionHash: "0x5678",
          blockNumber: 1n,
        });
      const wallet = {
        uid: `replacement-wallet-${reason}`,
        pollingInterval: 10,
        getChainId: async () => 8453,
        getAddresses: async () => [owner],
        writeContract: async () => "0x1234",
        getTransactionReceipt,
        getBlockNumber: async () => 2n,
        getTransaction: async () => ({
          hash: "0x1234",
          from: owner,
          to: address,
          nonce: 0,
          value: 1n,
          input: "0xab",
        }),
        getBlock: async () => ({
          transactions: [
            {
              hash: "0x5678",
              from: owner,
              to: reason === "cancelled" ? owner : address,
              nonce: 0,
              value:
                reason === "cancelled" ? 0n : reason === "repriced" ? 1n : 2n,
              input: reason === "repriced" ? "0xab" : "0xcd",
            },
          ],
        }),
      } as unknown as WalletClient;
      Object.assign(methods, {
        ...wallet,
        getBlock: async (args?: { includeTransactions?: boolean }) =>
          args?.includeTransactions
            ? (
                wallet as unknown as { getBlock: () => Promise<unknown> }
              ).getBlock()
            : { number: 1n, timestamp: 1n },
      });
      const sdk = client(methods);
      const preview: Preview = {
        action: { kind: "createPair", tokenA: address, tokenB: owner },
        plan: {
          calls: [
            actionData({ kind: "createPair", tokenA: address, tokenB: owner }),
          ],
        },
        account: owner,
        chainId: 8453,
        blockNumber: 1n,
        timestamp: 1n,
        gas: 1n,
      };
      if (reason === "repriced") {
        const status = vi.fn();
        await expect(
          sdk.execute(preview, wallet, status),
        ).resolves.toMatchObject({ hash: "0x5678" });
        expect(status).toHaveBeenCalledWith("pending", "0x5678");
      } else {
        await expect(sdk.execute(preview, wallet)).rejects.toThrow(
          reason === "cancelled" ? "cancelled" : "different data",
        );
      }
    },
  );
  it("blocks a wrong chain, absent code and hash mismatch", async () => {
    await expect(
      client({
        getChainId: async () => 1,
        getCode: async () => "0x1234",
      }).verifyDeployment(),
    ).rejects.toThrow("wrong network");
    await expect(
      client({
        getChainId: async () => 8453,
        getCode: async () => "0x",
      }).verifyDeployment(),
    ).rejects.toThrow("unavailable");
    await expect(
      client({
        getChainId: async () => 8453,
        getCode: async () => "0x5678",
      }).verifyDeployment(),
    ).rejects.toThrow("manifest");
    await expect(
      client({
        getChainId: async () => 8453,
        getCode: async () => "0x1234",
      }).verifyDeployment(),
    ).resolves.toBeUndefined();
  });
  it("keeps successful reads and distinguishes NotFound from failed RPC reads", async () => {
    const { encodeErrorResult } = await import("viem");
    const missing = new BaseError("revert", {
      cause: new ContractFunctionRevertedError({
        abi: protocolAbi,
        data: encodeErrorResult({ abi: protocolAbi, errorName: "NotFound" }),
        functionName: "getTick",
      }),
    });
    const sdk = client({
      getBlockNumber: async () => 12n,
      multicall: async () => [
        { status: "success", result: state },
        { status: "failure", error: missing },
        { status: "failure", error: new Error("RPC timeout") },
        { status: "success", result: state },
      ],
    });
    const result = await sdk.discover(42n, { radius: 0 });
    expect(result.reads.map((r) => r.status)).toEqual([
      "exists",
      "missing",
      "failed",
      "exists",
    ]);
    expect(result.complete).toBe(false);
    expect(sdk.knownTicks.size).toBe(2);
  });
  it("bounds multicall batches and does not stop at empty levels", async () => {
    const multicall = vi.fn(async ({ contracts }: { contracts: unknown[] }) =>
      contracts.map(() => ({ status: "success", result: state })),
    );
    const sdk = client({ getBlockNumber: async () => 12n, multicall });
    const result = await sdk.discover(42n);
    expect(
      multicall.mock.calls.every(
        ([call]) => call.contracts.length <= DISCOVERY_BATCH_SIZE,
      ),
    ).toBe(true);
    expect(result.radius).toBe(DISCOVERY_DEFAULTS.radius);
    expect(result.reads).toHaveLength(tickCandidates(42n).length);
  });
  it.each([7, 30] as const)(
    "discovers only the selected %sD duration",
    async (duration) => {
      const multicall = vi.fn(
        async ({ contracts }: { contracts: { args: readonly [bigint] }[] }) =>
          contracts.map(() => ({ status: "success", result: state })),
      );
      const sdk = client({ getBlockNumber: async () => 12n, multicall });
      const expected = tickCandidates(42n).filter(
        (tick) => tick.durationDays === duration,
      );
      const result = await sdk.discover(42n, { duration });
      expect(result.reads.map((read) => read.identity)).toEqual(expected);
      expect(
        multicall.mock.calls.flatMap(([call]) =>
          call.contracts.map((contract) => contract.args[0]),
        ),
      ).toEqual(expected.map((tick) => tick.id));
      expect(expected).toHaveLength(tickCandidates(42n).length / 2);
    },
  );
  it("pins portfolio reads, shares repeated ticks and retains a zero-raw supplier position", async () => {
    const blocks: bigint[] = [];
    const readContract = vi.fn(
      async ({
        functionName,
        blockNumber,
      }: {
        functionName: string;
        blockNumber: bigint;
      }) => {
        blocks.push(blockNumber);
        if (functionName === "getEarnPositions") return [42n];
        if (functionName === "getUsePositions") return [1n, 2n];
        if (functionName === "getPosition") return { tickId: 42n };
        if (functionName === "getEarnPosition")
          return { activePrincipal: 0n, activePrincipalX36: 1n };
        return state;
      },
    );
    const page = await client({
      getBlock: async () => ({ number: 99n, timestamp: 123n }),
      readContract,
    }).portfolio(owner);
    expect(page.providers).toHaveLength(1);
    expect(page.providers[0].position.activePrincipal).toBe(0n);
    expect(page.uses).toHaveLength(2);
    expect(
      readContract.mock.calls.filter(
        ([call]) => call.functionName === "getTick",
      ),
    ).toHaveLength(1);
    expect(blocks.every((b) => b === 99n)).toBe(true);
    expect(page.hasMore).toBe(false);
  });
  it("does not treat failed portfolio reads as an empty wallet", async () => {
    await expect(
      client({
        getBlock: async () => ({ number: 99n, timestamp: 123n }),
        readContract: async () => {
          throw new Error("RPC failed");
        },
      }).portfolio(owner),
    ).rejects.toThrow("RPC failed");
  });
});
