import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  compactToken,
  fallbackToken,
  fetchTokenMetadata,
  loadTokenMetadata,
  selectorTokens,
} from "@/lib/token-metadata";
import { tokenMetadataOptions } from "@/hooks/use-token-metadata";
import { TokenIcon, tokenIconFallback } from "@/components/markets/token-icon";
const network = "eip155:8453";
const a = "0x1111111111111111111111111111111111111111";
const b = "0x2222222222222222222222222222222222222222";
const meta = {
  chainId: 8453,
  address: a,
  status: "available",
  symbol: "ONE",
  name: "One",
  geckoTerminal: { attributes: { price_usd: "10.50", decimals: 7 } },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Worker token loading", () => {
  it.each([
    { browser: true, proxy: "true", endpoint: "/api/md" },
    { browser: true, proxy: "false", endpoint: "https://md.yld.cx" },
    { browser: false, proxy: "true", endpoint: "https://md.yld.cx" },
  ])(
    "uses $endpoint with browser=$browser and proxy=$proxy",
    async ({ browser, proxy, endpoint }) => {
      vi.stubEnv("NEXT_PUBLIC_METADATA_PROXY", proxy);
      if (browser) vi.stubGlobal("window", {});
      const fetcher = vi
        .fn()
        .mockResolvedValue(Response.json({ tokens: [meta] }));
      expect((await fetchTokenMetadata(network, [a], fetcher))[0].symbol).toBe(
        "ONE",
      );
      expect(fetcher.mock.calls[0][0]).toBe(
        `${endpoint}/tokens?${new URLSearchParams({ chainId: "8453", addresses: a })}`,
      );
    },
  );
  it("batches at most 30 unique addresses and omits invalid input", async () => {
    const addresses = Array.from(
      { length: 65 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const params = new URL(String(url)).searchParams;
      expect(params.get("chainId")).toBe("8453");
      const group = params.get("addresses")!.split(",");
      expect(group.length).toBeLessThanOrEqual(30);
      return Response.json({
        tokens: group.map((address) => ({ ...meta, address })),
      });
    });
    const tokens = await fetchTokenMetadata(
      network,
      [...addresses, addresses[0], "invalid"],
      fetcher,
    );
    expect(tokens).toHaveLength(65);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(tokens[0].priceUsd).toBe("10.50");
    expect(tokens[0]).not.toHaveProperty("decimals");
  });
  it("deduplicates in-flight per-token work and coalesces pairs", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ tokens: [meta, { ...meta, address: b }] }),
      );
    vi.stubGlobal("fetch", fetcher);
    const first = loadTokenMetadata(network, a);
    expect(loadTokenMetadata(network, a.toUpperCase())).toBe(first);
    const second = loadTokenMetadata(network, b);
    const tokens = await Promise.all([first, second]);
    expect(tokens.map((t) => t.symbol)).toEqual(["ONE", "ONE"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps queries cached across consumers on the same normalized network and address", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ tokens: [meta] }));
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient();
    const first = await client.fetchQuery(tokenMetadataOptions("base", a));
    const second = await client.fetchQuery(
      tokenMetadataOptions("base", a.toUpperCase()),
    );
    expect(first).toEqual(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it("retains cached available metadata and prices when a refresh is rate limited", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ tokens: [meta] }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient();
    const options = tokenMetadataOptions("base", a);
    const first = await client.fetchQuery(options);
    await client.invalidateQueries({ queryKey: options.queryKey });
    const retained = await client.fetchQuery(options);
    expect(retained).toMatchObject({
      symbol: first.symbol,
      priceUsd: first.priceUsd,
      stale: true,
    });
    expect(retained.retryAfter).toBeGreaterThan(Date.now() / 1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.clear();
  });
  it.each(["unknown", "unavailable", "stale"])(
    "handles %s without trusting upstream decimals",
    async (status) => {
      const row =
        status === "stale"
          ? { ...meta, stale: true, retryAfter: 9999999999 }
          : {
              ...meta,
              status,
            };
      const fetcher = vi
        .fn()
        .mockResolvedValue(Response.json({ tokens: [row], upstream: status }));
      const [token] = await fetchTokenMetadata(network, [a], fetcher);
      expect(token.status).toBe(status === "stale" ? "available" : status);
      expect(token).not.toHaveProperty("decimals");
      if (status === "stale") expect(token.stale).toBe(true);
    },
  );
  it.each([429, 500])("falls back on HTTP %s", async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    expect(await fetchTokenMetadata(network, [a], fetcher)).toEqual([
      fallbackToken(network, a),
    ]);
  });
  it("ignores metadata for other networks and rejects invalid prices", () => {
    expect(compactToken({ ...meta, chainId: 1 }, network)).toBeUndefined();
    expect(
      compactToken(
        { ...meta, geckoTerminal: { attributes: { price_usd: "Infinity" } } },
        network,
      )?.priceUsd,
    ).toBeUndefined();
  });
});
describe("token selection and images", () => {
  it("deduplicates normalized network/address and puts configured tokens first without decimals", () => {
    const configured = [{ network, address: b.toUpperCase() }] as const;
    const discovered = [
      fallbackToken(network, a),
      fallbackToken(network, b),
      fallbackToken("eip155:1", a),
    ];
    const tokens = selectorTokens(configured, discovered, [
      { ...fallbackToken(network, b), status: "available", symbol: "TWO" },
    ]);
    expect(tokens.map((t) => `${t.network}/${t.address}`)).toEqual([
      `${network}/${b}`,
      `${network}/${a}`,
      `eip155:1/${a}`,
    ]);
    expect(tokens[0].symbol).toBe("TWO");
    expect(tokens.every((t) => !("decimals" in t))).toBe(true);
  });
  it("renders remote metadata images and the universal fallback with unchanged dimensions", () => {
    const imageUrl = "https://coin-images.coingecko.com/token.png";
    expect(
      renderToStaticMarkup(
        <TokenIcon token={{ symbol: "ONE", imageUrl }} size={24} />,
      ),
    ).toContain(imageUrl);
    const fallback = renderToStaticMarkup(
      <TokenIcon token={{ symbol: "ONE" }} size={24} />,
    );
    expect(fallback).toContain('src="/token.svg"');
    expect(fallback).toContain('width="24" height="24"');
  });
  it("stops retrying when the fallback also fails", () => {
    let source = "https://coin-images.coingecko.com/token.png";
    const set = vi.fn((value: string) => {
      source = value;
    });
    const image = {
      getAttribute: () => source,
      set src(value: string) {
        set(value);
      },
    } as unknown as HTMLImageElement;
    tokenIconFallback(image);
    tokenIconFallback(image);
    expect(set).toHaveBeenCalledExactlyOnceWith("/token.svg");
  });
});
