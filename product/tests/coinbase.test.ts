import {
  coinbaseWalletDeployment,
  inspectCoinbaseWallets,
  verifyCoinbaseWallet,
} from "@yld-cx/sdk/coinbase";
import { encodeAbiParameters, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

const account = "0x0000000000000000000000000000000000000001";
const anotherAccount = "0x0000000000000000000000000000000000000002";
const proxyCode =
  "0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";
const blockNumber = 123n;

describe("Coinbase Smart Wallet verification", () => {
  it("rejects a v1.0 implementation behind a valid Coinbase proxy", async () => {
    const legacyImplementation = "0x000100abaad02f1cfC8Bbe32bD5a564817339E72";
    const getCode = vi.fn().mockResolvedValue(proxyCode);
    const client = {
      getChainId: async () => 8453,
      getBlockNumber: async () => blockNumber,
      getCode,
      getStorageAt: vi
        .fn()
        .mockResolvedValue(
          encodeAbiParameters([{ type: "address" }], [legacyImplementation]),
        ),
    } as unknown as PublicClient;

    await expect(verifyCoinbaseWallet(client, account)).rejects.toThrow(
      "Unsupported Coinbase Smart Wallet implementation",
    );
    expect(getCode.mock.calls).toEqual([[{ address: account, blockNumber }]]);
  });

  it("rejects wallets when the v1.1 implementation bytecode hash differs", async () => {
    const { implementation } = coinbaseWalletDeployment;
    const getCode = vi
      .fn()
      .mockResolvedValueOnce(proxyCode)
      .mockResolvedValueOnce(proxyCode)
      .mockResolvedValueOnce("0x6000");
    const client = {
      getCode,
      getStorageAt: vi
        .fn()
        .mockResolvedValue(
          encodeAbiParameters([{ type: "address" }], [implementation]),
        ),
    } as unknown as PublicClient;

    await expect(
      inspectCoinbaseWallets(client, [account, anotherAccount], blockNumber),
    ).resolves.toEqual(
      [account, anotherAccount].map((address) => ({
        address,
        status: "unsupported",
        reason: "Coinbase Smart Wallet implementation code did not match",
      })),
    );
    expect(getCode.mock.calls).toEqual(
      [account, anotherAccount, implementation].map((address) => [
        { address, blockNumber },
      ]),
    );
  });
});
