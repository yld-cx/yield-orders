import { describe, expect, it } from "vitest";
import { walletSwapAvailable } from "../lib/swap-availability.ts";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const WETH = "0x4200000000000000000000000000000000000006";

describe("wallet swap availability", () => {
  it("allows a listed pair beyond the original fork-tested pairs in either direction", () => {
    expect(walletSwapAvailable(8453, USDC, CBBTC)).toBe(true);
    expect(walletSwapAvailable(8453, CBBTC, USDC)).toBe(true);
    expect(
      walletSwapAvailable(8453, USDC, `0x${CBBTC.slice(2).toUpperCase()}`),
    ).toBe(true);
  });

  it("allows unlisted pairs and tokens on supported swap chains", () => {
    expect(walletSwapAvailable(8453, WETH, CBBTC)).toBe(true);
    const unlisted = "0x2222222222222222222222222222222222222222";
    for (const chainId of [1, 8453, 4663]) {
      expect(walletSwapAvailable(chainId, USDC, unlisted)).toBe(true);
      expect(walletSwapAvailable(chainId, unlisted, USDC)).toBe(true);
    }
  });

  it("rejects unsupported chains", () => {
    expect(walletSwapAvailable(10, USDC, CBBTC)).toBe(false);
  });

  it("returns unavailable for invalid token identities", () => {
    expect(walletSwapAvailable(8453, USDC, USDC)).toBe(false);
    expect(
      walletSwapAvailable(8453, CBBTC, CBBTC.toUpperCase().replace("0X", "0x")),
    ).toBe(false);
    expect(walletSwapAvailable(8453, USDC, "invalid")).toBe(false);
    expect(
      walletSwapAvailable(
        8453,
        USDC,
        "0x0000000000000000000000000000000000000000",
      ),
    ).toBe(false);
    expect(
      walletSwapAvailable(
        8453,
        USDC,
        "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      ),
    ).toBe(false);
  });
});
