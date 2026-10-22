import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseMarketRoute } from "@/lib/registry";
import { contentSecurityPolicy } from "@/lib/csp";
import {
  parseMarketFilters,
  marketFilterParams,
  MarketTab,
} from "@/lib/market-filters";
import { Category, Duration } from "@yld-cx/sdk";
import { TransactionPreview } from "@/components/transactions/transaction-preview";
import { distinctConnectors } from "@/components/wallet/wallet-connect";
import type { Connector } from "wagmi";
import type { Preview } from "@yld-cx/sdk/ethereum";
import { explainError } from "@yld-cx/sdk/ethereum";
import { BaseError } from "viem";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
describe("product identity and security", () => {
  it("renders raw token amounts when preview token metadata is unavailable", () => {
    const preview: Preview = {
      plan: { calls: [] },
      action: {
        kind: "use",
        tickId: 1n,
        amount: 1000n,
        maxFullTermYieldAsset: 100n,
        deadline: 200n,
      },
      account: a,
      chainId: 8453,
      blockNumber: 10n,
      timestamp: 100n,
      gas: 40000n,
      position: {
        tickId: 1n,
        tickSeq: 0n,
        user: a,
        assetAmount: 1000n,
        quotePrincipal: 2000n,
        fullTermYieldAsset: 100n,
        closeFee: 20n,
        openedAt: 100n,
        maturity: 604900n,
        status: 1,
      },
    };
    const html = renderToStaticMarkup(<TransactionPreview preview={preview} />);
    expect(html).toContain("1000 raw Asset units");
    expect(html).toContain("2000 raw Quote units");
    expect(html).toContain("100 raw Asset units");
  });
  it("round-trips shared market filters, preserving search text and unrelated parameters", () => {
    const filters = {
      search: "WETH / USDC +",
      tag: Category.BlueChip,
      duration: Duration.Monthly,
      network: "ethereum",
      page: 3,
    } as const;
    const params = marketFilterParams(
      filters,
      new URLSearchParams("ref=example"),
    );
    expect(parseMarketFilters(params, "base")).toEqual(filters);
    expect(params.get("ref")).toBe("example");
    expect(
      parseMarketFilters(new URLSearchParams(params.toString()), "base"),
    ).toEqual(filters);
    const cleared = marketFilterParams({ ...filters, search: "" }, params);
    expect(cleared.has("search")).toBe(false);
    expect(parseMarketFilters(cleared, "base")).toEqual({
      ...filters,
      search: "",
    });
  });
  it("falls back safely for unsupported URL tags, durations and networks", () => {
    expect(
      parseMarketFilters(
        new URLSearchParams("tag=unknown&duration=999&network=unknown"),
        "base",
      ),
    ).toEqual({
      search: "",
      tag: MarketTab.YieldList,
      duration: Duration.Weekly,
      network: "base",
      page: 1,
    });
  });
  it.each(["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])(
    "defaults invalid market page %s to the first page",
    (page) => {
      const filters = parseMarketFilters(new URLSearchParams({ page }), "base");
      expect(filters.page).toBe(1);
      expect(marketFilterParams(filters).has("page")).toBe(false);
    },
  );
  it("distinguishes RPC failures from wallet rejection", () => {
    expect(explainError(new BaseError("RPC connection failed"))).toBe(
      "RPC connection failed",
    );
    expect(
      explainError(
        new BaseError("Request rejected", {
          cause: Object.assign(new Error("Declined"), { code: 4001 }),
        }),
      ),
    ).toContain("declined");
  });
  it("normalizes canonical URLs independently of pair display orientation", () => {
    expect(parseMarketRoute("base", `${a}%3A${b}`).key).toBe(`${a}:${b}`);
    expect(parseMarketRoute("BASE", `${b}:${a}`).canonicalPath).toBe(
      `/market/base/${a}:${b}`,
    );
    expect(() => parseMarketRoute("solana", `${a}:${b}`)).toThrow();
    expect(() => parseMarketRoute("base", `${a}:${a}`)).toThrow();
  });
  it("includes canonical markets in sitemap and excludes Orders from indexing", () => {
    expect(
      sitemap().some(
        (item) => item.url === `https://yld.cx/market/base/${a}:${b}`,
      ),
    ).toBe(true);
    expect(robots().rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: "/orders",
    });
  });
  it("uses nonce scripts and restricted RPC/wallet origins in production CSP", () => {
    const csp = contentSecurityPolicy("abc", ["https://mainnet.base.org"]);
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    const scripts = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scripts).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-hashes");
    expect(csp).not.toContain("*");
    expect(csp).toContain("https://app.safe.global");
    expect(csp).toContain("https://mainnet.base.org");
  });
  it("keeps development CSP enabled while permitting Next.js eval and HMR", () => {
    const development = contentSecurityPolicy(
      "dev",
      ["http://127.0.0.1:8545"],
      true,
    );
    expect(development).toContain("'nonce-dev'");
    expect(development).toContain("'unsafe-eval'");
    expect(development).toContain("http://127.0.0.1:8545");
    expect(development).toContain(" ws:");
    expect(development).not.toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy("prod", [])).not.toContain(" ws:");
  });
  it("keeps multiple EIP-6963 wallets distinct and removes generic duplicates", () => {
    const connectors = [
      { id: "injected", type: "injected", name: "Injected" },
      { id: "io.metamask", type: "injected", name: "MetaMask" },
      { id: "app.phantom", type: "injected", name: "Phantom" },
      { id: "io.metamask", type: "injected", name: "MetaMask" },
      { id: "walletConnect", type: "walletConnect", name: "WalletConnect" },
    ] as Connector[];
    expect(distinctConnectors(connectors).map((c) => c.name)).toEqual([
      "MetaMask",
      "Phantom",
      "WalletConnect",
    ]);
  });
  it("omits the generic injected option when no named wallets are detected", () => {
    const connectors = [
      { id: "injected", type: "injected", name: "Injected" },
      {
        id: "coinbaseWalletSDK",
        type: "coinbaseWallet",
        name: "Coinbase Wallet",
      },
      { id: "walletConnect", type: "walletConnect", name: "WalletConnect" },
    ] as Connector[];
    expect(distinctConnectors(connectors).map((c) => c.name)).toEqual([
      "Coinbase Wallet",
      "WalletConnect",
    ]);
  });
  it("renders market creation details and gas", () => {
    const preview: Preview = {
      plan: { calls: [] },
      action: { kind: "createPair", tokenA: a, tokenB: b },
      account: a,
      chainId: 8453,
      blockNumber: 10n,
      timestamp: 100n,
      gas: 40000n,
    };
    const html = renderToStaticMarkup(<TransactionPreview preview={preview} />);
    expect(html).toContain("Creates new market for the token pair.");
    expect(html).toContain("40000");
    expect(html).toContain("Base · 8453");
  });
});
