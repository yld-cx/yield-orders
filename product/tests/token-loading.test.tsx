import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicClient } from "viem";
import { EthereumClient, snappedPrice } from "@yld-cx/sdk/ethereum";
import { DISCOVERY_DEFAULTS, type Token } from "@yld-cx/sdk";
import { useMarket, useToken } from "@/hooks/use-market";
import { calculatedBaseTick, discoveryBaseTick } from "@/lib/market-values";
import { fallbackToken, type TokenMetadata } from "@/lib/token-metadata";
const a = "0x4200000000000000000000000000000000000006";
const b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const arbitrary = "0x1111111111111111111111111111111111111111";
const token = (address: string, decimals: number): Token => ({
  network: "eip155:8453",
  address,
  symbol: "ONCHAIN",
  name: "Onchain token",
  decimals,
  listed: false,
});
function setup(
  address = a,
  decimals = 18,
  status: TokenMetadata["status"] = "available",
  priceUsd?: string,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["token", "base", address], token(address, decimals));
  client.setQueryData(["token-metadata", "eip155:8453", address], {
    ...fallbackToken("eip155:8453", address),
    status,
    symbol: "WORKER",
    name: "Worker token",
    priceUsd,
    decimals: 99,
  });
  return client;
}
function renderHook<T>(client: QueryClient, hook: () => T): T {
  let result!: T;
  function Harness() {
    result = hook();
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return result;
}
describe("authoritative ERC-20 metadata", () => {
  it.each([0, 6, 8, 18, 24])("reads decimals %s onchain", async (decimals) => {
    const readContract = vi.fn(async ({ functionName }) =>
      functionName === "decimals" ? decimals : "CHAIN",
    );
    const sdk = new EthereumClient(
      {
        readContract,
        getCode: async () => "0x1234",
      } as unknown as PublicClient,
      "eip155:8453",
    );
    expect((await sdk.tokenMetadata(arbitrary)).decimals).toBe(decimals);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: arbitrary, functionName: "decimals" }),
    );
  });
  it("fails when decimals cannot be read rather than guessing", async () => {
    const sdk = new EthereumClient(
      {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "decimals")
            throw new Error("decimals unavailable");
          return "CHAIN";
        },
        getCode: async () => "0x1234",
      } as unknown as PublicClient,
      "eip155:8453",
    );
    await expect(sdk.tokenMetadata(arbitrary)).rejects.toThrow(
      "decimals unavailable",
    );
  });
  it("combines Worker identity with authoritative onchain decimals for arbitrary addresses", () => {
    const client = setup(arbitrary, 8);
    const result = renderHook(client, () => useToken("base", arbitrary));
    expect(result.data).toMatchObject({
      symbol: "WORKER",
      name: "Worker token",
      decimals: 8,
      listed: false,
    });
    client.clear();
  });
  it.each(["unknown", "unavailable"] as const)(
    "preserves onchain fallback for %s metadata",
    (status) => {
      const client = setup(a, 6, status);
      expect(renderHook(client, () => useToken("base", a)).data).toMatchObject({
        symbol: "ONCHAIN",
        name: "Onchain token",
        decimals: 6,
      });
      client.clear();
    },
  );
  it("never provides a financial Token before onchain decimals are known", () => {
    const client = setup(arbitrary);
    client.removeQueries({ queryKey: ["token", "base", arbitrary] });
    expect(
      renderHook(client, () => useToken("base", arbitrary)).data,
    ).toBeUndefined();
    client.clear();
  });
});
describe("canonical reference price discovery", () => {
  it("uses canonical prices and both decimals before snapping to the configured grid", () => {
    const token0 = { decimals: 18, priceUsd: "3000" };
    const token1 = { decimals: 6, priceUsd: "1" };
    expect(calculatedBaseTick(token0, token1, 500)).toBe(
      snappedPrice("3000", 18, 6, 500).priceTick,
    );
    expect(calculatedBaseTick(token1, token0, 500)).toBe(
      snappedPrice("0.000333333333333333333333333333333333333333", 6, 18, 500)
        .priceTick,
    );
    expect(
      calculatedBaseTick({ decimals: 8, priceUsd: "60000" }, token1, 250)! %
        250,
    ).toBe(0);
  });
  it.each([
    undefined,
    "",
    "0",
    "-1",
    "NaN",
    "Infinity",
    "1" + "0".repeat(100),
    "0." + "0".repeat(120) + "1",
    "1e3",
    "9999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
  ])("rejects invalid or out-of-range price %s", (priceUsd) => {
    expect(
      calculatedBaseTick(
        { decimals: 18, priceUsd },
        { decimals: 6, priceUsd: "1" },
      ),
    ).toBeUndefined();
    expect(
      calculatedBaseTick(
        { decimals: 18, priceUsd: "1" },
        { decimals: 6, priceUsd },
      ),
    ).toBeUndefined();
  });
  it("uses URL > Worker prices > configured tick > default tick", () => {
    const client = setup(a, 18, "available", "5000");
    client.setQueryData(["token", "base", b], token(b, 6));
    client.setQueryData(["token-metadata", "eip155:8453", b], {
      ...fallbackToken("eip155:8453", b),
      status: "available",
      priceUsd: "1",
    });
    const result = renderHook(client, () => useMarket("base", `${a}:${b}`));
    expect(result.market!.baseTick).toBe(
      snappedPrice("5000", 18, 6, 1000).priceTick,
    );
    expect(discoveryBaseTick("1000", result.market!)).toBe(1000);
    expect(discoveryBaseTick("1001", result.market!)).toBe(
      result.market!.baseTick,
    );
    client.setQueryData(
      ["token-metadata", "eip155:8453", b],
      fallbackToken("eip155:8453", b),
    );
    expect(
      renderHook(client, () => useMarket("base", `${a}:${b}`)).market!.baseTick,
    ).toBe(-196000);
    const custom = setup(arbitrary, 8, "unknown");
    custom.setQueryData(["token", "base", b], token(b, 6));
    custom.setQueryData(
      ["token-metadata", "eip155:8453", b],
      fallbackToken("eip155:8453", b),
    );
    expect(
      renderHook(custom, () => useMarket("base", `${arbitrary}:${b}`)).market!
        .baseTick,
    ).toBe(DISCOVERY_DEFAULTS.baseTick);
    client.clear();
    custom.clear();
  });
});
