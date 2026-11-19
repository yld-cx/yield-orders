import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { parseUnits, type PublicClient } from "viem";
import { EthereumClient, protocolAbi } from "@yld-cx/sdk/ethereum";
import { assetTvlOptions, useAssetTvl } from "@/hooks/use-asset-tvl";
import { queryKeys } from "@/lib/query-keys";
import { getSdk } from "@/lib/rpc";

const asset = "0x4200000000000000000000000000000000000006";
const other = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function setup(decimals = 18) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKeys.token("base", asset), {
    address: asset,
    network: "eip155:8453",
    symbol: "ONCHAIN",
    name: "Wrapped Ether",
    decimals,
  });
  client.setQueryData(queryKeys.tokenMetadata("base", asset), {
    address: asset,
    network: "eip155:8453",
    status: "available",
    symbol: "WETH",
    name: "Wrapped Ether",
    // Remote metadata must never override the ERC-20 decimals.
    decimals: 99,
  });
  return client;
}

function renderTvl(client: QueryClient) {
  function Harness() {
    return <span>{useAssetTvl("base", asset)}</span>;
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Asset TVL", () => {
  it("reads tokenLiability from the Yield Orders deployment for the asset", async () => {
    const readContract = vi.fn(async () => 12450000n);
    const sdk = new EthereumClient(
      { readContract } as unknown as PublicClient,
      "eip155:8453",
    );
    expect(await sdk.tokenLiability(asset)).toBe(12450000n);
    expect(readContract).toHaveBeenCalledExactlyOnceWith({
      address: sdk.address,
      abi: protocolAbi,
      functionName: "tokenLiability",
      args: [asset],
    });
  });

  it("shares in-flight and cached TVL reads between pages and network aliases", async () => {
    const client = setup();
    const read = vi
      .spyOn(getSdk("base"), "tokenLiability")
      .mockResolvedValue(12450000000000000000n);
    const home = assetTvlOptions("base", asset);
    const market = assetTvlOptions("eip155:8453", asset.toUpperCase());
    expect(
      await Promise.all([client.fetchQuery(home), client.fetchQuery(market)]),
    ).toEqual([12450000000000000000n, 12450000000000000000n]);
    expect(await client.fetchQuery(market)).toBe(12450000000000000000n);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(asset);
    expect(renderTvl(client)).toContain("12.45 WETH");
    expect(home.queryKey).not.toEqual(queryKeys.assetTvl("ethereum", asset));
    expect(home.queryKey).not.toEqual(queryKeys.assetTvl("base", other));
    client.clear();
  });

  it.each([0, 6, 8, 18, 24])(
    "formats using the token's %s onchain decimals",
    (decimals) => {
      const client = setup(decimals);
      const amount = decimals === 0 ? 12n : 1245n * 10n ** BigInt(decimals - 2);
      client.setQueryData(queryKeys.assetTvl("base", asset), amount);
      expect(renderTvl(client)).toContain(
        decimals === 0 ? "12 WETH" : "12.45 WETH",
      );
      client.clear();
    },
  );

  it("shows zero TVL as 0 with the token symbol", () => {
    const client = setup();
    client.setQueryData(queryKeys.assetTvl("base", asset), 0n);
    expect(renderTvl(client)).toBe("<span>0 WETH</span>");
    client.clear();
  });

  it.each([
    ["2032.449873", "2,032.45"],
    ["859.48208", "859.48"],
    ["1689.456653", "1,689.46"],
    ["0.016584", "0.0166"],
    ["0.0011", "0.0011"],
    ["0.012305", "0.0123"],
    ["0.000000000000000001", "0.000000000000000001"],
  ])("rounds summary TVL %s to %s", (amount, expected) => {
    const client = setup();
    client.setQueryData(
      queryKeys.assetTvl("base", asset),
      parseUnits(amount, 18),
    );
    expect(renderTvl(client)).toBe(`<span>${expected} WETH</span>`);
    client.clear();
  });

  it("shows an em dash while TVL or token decimals are unavailable", () => {
    const client = setup();
    expect(renderTvl(client)).toBe("<span>—</span>");
    client.setQueryData(queryKeys.assetTvl("base", asset), 1n);
    client.removeQueries({ queryKey: queryKeys.token("base", asset) });
    expect(renderTvl(client)).toBe("<span>—</span>");
    client.clear();
  });

  it("shows an em dash when the liability read fails", async () => {
    const client = setup();
    vi.spyOn(getSdk("base"), "tokenLiability").mockRejectedValue(
      new Error("RPC unavailable"),
    );
    await expect(
      client.fetchQuery(assetTvlOptions("base", asset)),
    ).rejects.toThrow("RPC unavailable");
    expect(renderTvl(client)).toBe("<span>—</span>");
    client.clear();
  });
});
