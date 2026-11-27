import {
  coinbaseWalletAbi,
  coinbaseOwnerBytes,
  coinbaseWalletDeployment,
  coinbaseWalletFactoryAbi,
  inspectCoinbaseWallets,
} from "@yld-cx/sdk/coinbase";
import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  multicall3Abi,
  type Address,
  type PublicClient,
} from "viem";
import {
  deployAgentWallet,
  discoverAgentWallets,
  readAgentSigner,
} from "@/lib/agent-wallets";
import { base } from "viem/chains";

vi.mock("@yld-cx/sdk/coinbase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@yld-cx/sdk/coinbase")>()),
  inspectCoinbaseWallets: vi.fn(),
}));

const main = "0x0000000000000000000000000000000000000001";
const addresses = Array.from(
  { length: 32 },
  (_, index) => `0x${(index + 2).toString(16).padStart(40, "0")}` as Address,
);
const { factory, implementation } = coinbaseWalletDeployment;
const blockNumber = 123n;
const nonce = (index: number) =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }],
        ["yld.cx/agents/v1", BigInt(index)],
      ),
    ),
  );

describe("agent wallet discovery", () => {
  it("scans all slots and filters deployed wallets by implementation and owner", async () => {
    const multicall = vi.fn().mockResolvedValueOnce(addresses);
    const readContract = vi.fn().mockResolvedValueOnce(
      addresses.map((_, index) => ({
        success: index !== 0,
        returnData: [1, 3, 5, 31].includes(index)
          ? encodeAbiParameters([{ type: "bool" }], [index !== 3])
          : "0x",
      })),
    );
    const getCode = vi
      .fn()
      .mockResolvedValueOnce("0x1234")
      .mockResolvedValueOnce(undefined);
    const rpc = {
      getChainId: async () => 8453,
      getBlockNumber: async () => blockNumber,
      multicall,
      readContract,
      getCode,
    } as unknown as PublicClient;
    vi.mocked(inspectCoinbaseWallets).mockResolvedValueOnce(
      [1, 5, 31].map((index) =>
        index === 5
          ? {
              address: addresses[index],
              status: "unsupported",
              reason: "Unexpected proxy",
            }
          : { address: addresses[index], status: "verified", implementation },
      ),
    );

    expect(await discoverAgentWallets(rpc, main)).toEqual({
      blockNumber,
      wallets: [
        { address: addresses[1], index: 1 },
        { address: addresses[31], index: 31 },
      ],
      next: { address: addresses[2], index: 2 },
    });
    expect(multicall.mock.calls[0][0]).toMatchObject({
      allowFailure: false,
      batchSize: 0,
      blockNumber,
      contracts: Array.from({ length: 32 }, (_, index) => ({
        address: factory,
        functionName: "getAddress",
        args: [[coinbaseOwnerBytes(main)], nonce(index)],
      })),
    });
    const ownerCall = encodeFunctionData({
      abi: coinbaseWalletAbi,
      functionName: "isOwnerAddress",
      args: [main],
    });
    expect(readContract).toHaveBeenCalledWith({
      abi: multicall3Abi,
      address: base.contracts.multicall3.address,
      functionName: "aggregate3",
      blockNumber,
      args: [
        addresses.map((target) => ({
          target,
          allowFailure: true,
          callData: ownerCall,
        })),
      ],
    });
    expect(getCode.mock.calls).toEqual([
      [{ address: addresses[0], blockNumber }],
      [{ address: addresses[2], blockNumber }],
    ]);
    expect(inspectCoinbaseWallets).toHaveBeenCalledWith(
      rpc,
      [addresses[1], addresses[5], addresses[31]],
      blockNumber,
    );
  });

  it("propagates an ownership batch RPC failure before checking for empty slots", async () => {
    const getCode = vi.fn();
    const rpc = {
      getChainId: async () => base.id,
      getBlockNumber: async () => blockNumber,
      multicall: vi.fn().mockResolvedValueOnce(addresses),
      readContract: vi.fn().mockRejectedValueOnce(new Error("HTTP 429")),
      getCode,
    } as unknown as PublicClient;

    await expect(discoverAgentWallets(rpc, main)).rejects.toThrow("HTTP 429");
    expect(getCode).not.toHaveBeenCalled();
  });

  it("deploys the discovered slot with the main wallet as the sole initial owner", () => {
    const { to, value, data } = deployAgentWallet(main, 2);
    expect(to).toBe(factory);
    expect(value).toBe(0n);
    expect(
      decodeFunctionData({
        abi: coinbaseWalletFactoryAbi,
        data,
      }),
    ).toEqual({
      functionName: "createAccount",
      args: [[coinbaseOwnerBytes(main)], nonce(2)],
    });
  });

  it("rediscovers an agent signer after a slot has been revoked", async () => {
    const account = addresses[0];
    const agent = addresses[1];
    const rpc = {
      multicall: vi
        .fn()
        .mockResolvedValueOnce([2n, 4n])
        .mockResolvedValueOnce([
          "0x",
          coinbaseOwnerBytes(agent),
          "0x",
          coinbaseOwnerBytes(main),
        ]),
      getCode: vi.fn().mockResolvedValue(undefined),
    } as unknown as PublicClient;
    expect(await readAgentSigner(rpc, account, main, blockNumber)).toEqual({
      address: agent,
      index: 2n,
    });
  });
});
