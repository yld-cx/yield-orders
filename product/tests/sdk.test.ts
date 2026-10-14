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
