import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/tokens/route";
const address = "0x1111111111111111111111111111111111111111";
const meta = {
  chainId: 8453,
  address,
  symbol: "ONE",
  name: "Token One",
  status: "available",
  imageUrl: "https://coin-images.coingecko.com/token.png",
  geckoTerminal: {
    attributes: { price_usd: "1", decimals: 18 },
    secret: "raw data",
  },
};
const request = (chainId = "8453") =>
  new Request(`https://yld.cx/api/tokens?chainId=${chainId}`);
const success = (rows: unknown[]) =>
  Response.json({
    success: true,
    result: [
      {
        success: true,
        results: rows.map((meta) => ({ meta: JSON.stringify(meta) })),
      },
    ],
  });
describe("token discovery API", () => {
  beforeEach(() => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "private-account");
    vi.stubEnv("YLD_D1_DATABASE_ID", "private-database");
    vi.stubEnv("YLD_D1_READ_TOKEN", "private-token");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it.each(["1", "8453", "4663"])(
    "queries supported chain %s with a parameterized bounded query and 24h CDN caching",
    async (chainId) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(success([{ ...meta, chainId: Number(chainId) }]));
      vi.stubGlobal("fetch", fetcher);
      const response = await GET(request(chainId));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=0, s-maxage=86400",
      );
      expect(response.headers.get("vercel-cdn-cache-control")).toContain(
        "s-maxage=86400",
      );
      const body = await response.json();
      expect(body.tokens).toEqual([
        { address, symbol: "ONE", name: "Token One", imageUrl: meta.imageUrl },
      ]);
      expect(JSON.stringify(body)).not.toMatch(
        /private-|geckoTerminal|decimals|price_usd/,
      );
      const [url, options] = fetcher.mock.calls[0];
      expect(url).toContain(
        "api.cloudflare.com/client/v4/accounts/private-account/d1/database/private-database/query",
      );
      expect(options.headers.Authorization).toBe("Bearer private-token");
      const query = JSON.parse(options.body);
      expect(query.params).toEqual([`${chainId}:%`]);
      expect(query.sql).toContain("WHERE id LIKE ?");
      expect(query.sql).toContain("'$.status') = 'available'");
      expect(query.sql).toContain("ORDER BY timestamp DESC, id DESC LIMIT 100");
    },
  );
  it.each([
    "",
    "10",
    "eip155:8453",
    "08453",
    "8453%27%20OR%201=1",
    "8453&chainId=1",
  ])(
    "rejects unsupported/invalid chain %s before accessing D1",
    async (chainId) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect((await GET(request(chainId))).status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("limits public results to 100 and discards cross-chain, unavailable and duplicate identities", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      ...meta,
      address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(success(rows))
        .mockResolvedValueOnce(
          success([
            meta,
            meta,
            { ...meta, chainId: 1 },
            { ...meta, status: "unknown" },
            { address: "invalid" },
          ]),
        ),
    );
    expect((await (await GET(request())).json()).tokens).toHaveLength(100);
    expect((await (await GET(request())).json()).tokens).toHaveLength(1);
  });
  it("returns cached empty results gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(success([])));
    const response = await GET(request());
    expect(await response.json()).toEqual({ tokens: [] });
    expect(response.headers.get("cache-control")).toContain("86400");
  });
  it.each(["CLOUDFLARE_ACCOUNT_ID", "YLD_D1_DATABASE_ID", "YLD_D1_READ_TOKEN"])(
    "handles missing %s without leaking configuration",
    async (name) => {
      vi.stubEnv(name, "");
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/private-|CLOUDFLARE|YLD_D1/);
      expect(fetcher).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
  it.each(["http", "sql", "malformed", "network"])(
    "handles %s errors without caching or exposing internal details",
    async (kind) => {
      const fetcher = vi.fn();
      if (kind === "network")
        fetcher.mockRejectedValue(
          new Error("private-token internal SQL error"),
        );
      else
        fetcher.mockResolvedValue(
          kind === "http"
            ? new Response("private-account", { status: 403 })
            : kind === "sql"
              ? Response.json({
                  success: true,
                  result: [{ success: false, error: "private-database" }],
                })
              : new Response("not json"),
        );
      vi.stubGlobal("fetch", fetcher);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        tokens: [],
        error: "Token discovery unavailable",
      });
    },
  );
});
