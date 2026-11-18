import { describe, it, expect, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type PublicClient,
} from "viem";
import { atomicRequestUnsupported, swapCalls } from "../lib/swap-flow.ts";
import {
  PERMIT2,
  permit2Abi,
  swapNetwork,
  type SwapQuoteResult,
} from "@yld-cx/sdk/uniswap";
const TOKEN = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const ROUTER = swapNetwork(8453).router;
const permitTransaction = {
  to: PERMIT2,
  value: "0",
  chainId: 8453,
  data: encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [TOKEN, ROUTER, 100n, 1000],
  }),
};
const quote: SwapQuoteResult = {
  chainId: 8453,
  mode: "wallet-router",
  tokenIn: TOKEN,
  tokenOut: OWNER,
  amountIn: "100",
  estimatedAmountOut: "200",
  minimumAmountOut: "199",
  routing: "CLASSIC",
  routeVersion: "2.1.2",
  quotedAt: 0,
  expiresAt: 100,
  routeId: "test",
  transaction: { to: ROUTER, data: "0x12345678", value: "0", chainId: 8453 },
  permitTransaction,
};
function rpc(
  allowance = 0n,
  permitted = 0n,
  balance = 100n,
  expiration = 1000,
) {
  const multicall = vi.fn(async () => [
    balance,
    allowance,
    [permitted, expiration, 0],
  ]);
  return { multicall } as unknown as PublicClient;
}
describe("swap wallet planning", () => {
  it("offers sequential fallback only for atomic capability errors", () => {
    expect(atomicRequestUnsupported({ cause: { code: 5760 } })).toBe(true);
    expect(atomicRequestUnsupported({ code: -32601 })).toBe(true);
    expect(atomicRequestUnsupported({ cause: { code: 4001 } })).toBe(false);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(atomicRequestUnsupported(cycle)).toBe(false);
  });
  it("reads RPC allowances and orders exact ERC20 approval, Permit2 authorization and swap", async () => {
    const client = rpc();
    const calls = await swapCalls(client, quote, OWNER, 8453, 0);
    expect(calls.map((c) => c.to)).toEqual([TOKEN, PERMIT2, ROUTER]);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args,
    ).toEqual([PERMIT2, 100n]);
    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(client.multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: false,
        contracts: [
          expect.objectContaining({ functionName: "balanceOf", args: [OWNER] }),
          expect.objectContaining({
            functionName: "allowance",
            args: [OWNER, PERMIT2],
          }),
          expect.objectContaining({
            functionName: "allowance",
            args: [OWNER, TOKEN, ROUTER],
          }),
        ],
      }),
    );
  });
  it("resets an insufficient nonzero ERC20 allowance before exact approval", async () => {
    const calls = await swapCalls(rpc(1n), quote, OWNER, 8453, 0);
    expect(calls.map((c) => c.to)).toEqual([TOKEN, TOKEN, PERMIT2, ROUTER]);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args,
    ).toEqual([PERMIT2, 0n]);
  });
  it("skips token and Permit2 authorizations independently when RPC shows enough allowance", async () => {
    expect(
      (await swapCalls(rpc(100n), quote, OWNER, 8453, 0)).map((c) => c.to),
    ).toEqual([PERMIT2, ROUTER]);
    expect(
      (await swapCalls(rpc(0n, 100n), quote, OWNER, 8453, 0)).map((c) => c.to),
    ).toEqual([TOKEN, ROUTER]);
    expect(
      (await swapCalls(rpc(100n, 100n), quote, OWNER, 8453, 0)).map(
        (c) => c.to,
      ),
    ).toEqual([ROUTER]);
  });
  it("requires a fresh API permit transaction after an existing Permit2 authorization expires", async () => {
    const noPermit = { ...quote, permitTransaction: undefined };
    await expect(
      swapCalls(rpc(100n, 100n, 100n, 0), noPermit, OWNER, 8453, 0),
    ).rejects.toThrow("Permit2 allowance changed");
    await expect(
      swapCalls(rpc(100n, 0n), noPermit, OWNER, 8453, 0),
    ).rejects.toThrow("Permit2 allowance changed");
  });
  it("rejects an insufficient current balance before planning any wallet calls", async () => {
    await expect(
      swapCalls(rpc(0n, 0n, 99n), quote, OWNER, 8453, 0),
    ).rejects.toThrow("available token balance");
  });
  it("rejects stale quotes, wrong-chain and resolver-mode calldata before reading RPC", async () => {
    const client = rpc();
    await expect(swapCalls(client, quote, OWNER, 8453, 101)).rejects.toThrow();
    await expect(swapCalls(client, quote, OWNER, 1, 0)).rejects.toThrow();
    await expect(
      swapCalls(client, { ...quote, mode: "resolver-router" }, OWNER, 8453, 0),
    ).rejects.toThrow();
    expect(client.multicall).not.toHaveBeenCalled();
  });
});
