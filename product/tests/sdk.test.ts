import { describe, it, expect, vi } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  keccak256,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  EthereumClient,
  protocolAbi,
  tickCandidates,
  Q128,
  type Preview,
} from "@yld-cx/sdk/ethereum";
import type { EconomicAction } from "@yld-cx/sdk";
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
    const simulateContract = vi.fn(async () => ({ request: {} }));
    const sdk = client({
      getChainId: async () => 8453,
      getCode: async () => "0x1234",
      getBlock: async () => ({ number: 99n, timestamp }),
      readContract,
      simulateContract,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    });
    const writeContract = vi.fn(async () => "0x1234");
    const wallet = {
      getChainId: async () => 8453,
      getAddresses: async () => [owner],
      writeContract,
    } as unknown as WalletClient;
    return { sdk, wallet, readContract, simulateContract, writeContract };
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
      const { sdk, wallet, simulateContract, writeContract } = setup(
        balance,
        1n,
      );
      await sdk.approve(action, wallet, owner);
      expect(simulateContract.mock.calls).toHaveLength(2);
      expect(simulateContract).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          functionName: "approve",
          args: [address, 0n],
        }),
      );
      expect(simulateContract).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          functionName: "approve",
          args: [address, cap],
        }),
      );
      expect(writeContract).toHaveBeenCalledTimes(2);
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
  it.each(["cancelled", "replaced"])(
    "does not confirm an unrelated %s transaction",
    async (reason) => {
      const sdk = client({
        getChainId: async () => 8453,
        getCode: async () => "0x1234",
        simulateContract: async () => ({ request: {} }),
        waitForTransactionReceipt: async ({
          onReplaced,
        }: {
          onReplaced: (value: unknown) => void;
        }) => {
          onReplaced({ reason, transaction: { hash: "0x1234" } });
          return {
            status: "success",
            logs: [],
            transactionHash: "0x1234",
            blockNumber: 1n,
          };
        },
      });
      const wallet = {
        getChainId: async () => 8453,
        getAddresses: async () => [owner],
        writeContract: async () => "0x1234",
      } as unknown as WalletClient;
      const preview: Preview = {
        action: { kind: "createPair", tokenA: address, tokenB: owner },
        account: owner,
        chainId: 8453,
        blockNumber: 1n,
        timestamp: 1n,
        gas: 1n,
      };
      await expect(sdk.execute(preview, wallet)).rejects.toThrow(
        reason === "cancelled" ? "cancelled" : "different data",
      );
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
    const result = await sdk.discover(42n, { radius: 8 });
    expect(
      multicall.mock.calls.every(([call]) => call.contracts.length <= 40),
    ).toBe(true);
    expect(result.reads).toHaveLength(tickCandidates(42n, 0, 1000, 8).length);
  });
  it("pins all portfolio reads and retains a zero-raw supplier position", async () => {
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
        if (functionName === "getUsePositions") return [];
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
