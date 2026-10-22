import { describe, it, expect } from "vitest";
import { Category } from "@yld-cx/sdk";
import {
  Registry,
  canonicalPair,
  pairKey,
  normalizeAddress,
  networkSchema,
  yieldListSchema,
  marketMetadataSchema,
  decodeBase58,
} from "@yld-cx/sdk/registry";
import list from "../public/yieldlist.json";
const network = "eip155:8453",
  a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
describe("YieldList", () => {
  it("validates registry entries and defaults", () => {
    const registry = new Registry(list);
    expect(registry.getMarkets(network)).toHaveLength(
      Object.keys(list.markets[network]).length,
    );
    expect(marketMetadataSchema.parse({})).toEqual({
      defaultDuration: 7,
      tags: [],
      stepTicks: 1000,
    });
  });
  it.each([
    "eip155:1",
    "eip155:8453",
    "eip155:4663",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  ])("accepts CAIP-2 %s", (v) =>
    expect(networkSchema.safeParse(v).success).toBe(true),
  );
  it.each([
    "base",
    "eip155:0",
    "eip155:01",
    "eip155:-1",
    "solana:invalid",
    "eip155:1:2",
  ])("rejects network %s", (v) =>
    expect(networkSchema.safeParse(v).success).toBe(false),
  );
  it("normalizes EVM case and orders by address bytes", () => {
    expect(normalizeAddress(network, b.toUpperCase().replace("0X", "0x"))).toBe(
      b,
    );
    expect(canonicalPair(network, b, a)).toEqual([a, b]);
    expect(pairKey(network, b, a)).toBe(`${a}:${b}`);
    expect(() => canonicalPair(network, a, a)).toThrow();
    expect(() => normalizeAddress(network, "0x0")).toThrow();
  });
  it("preserves Solana case and compares decoded bytes", () => {
    const n = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      first = "11111111111111111111111111111111",
      second = "So11111111111111111111111111111111111111112";
    expect(decodeBase58(second)).toHaveLength(32);
    expect(canonicalPair(n, second, first)).toEqual([first, second]);
    expect(normalizeAddress(n, second)).toBe(second);
    expect(normalizeAddress(n, second.toLowerCase())).not.toBe(second);
  });
  it("indexes token identity, reverse market lookup, tags, pair and address searches", () => {
    const fixture = {
      version: 1,
      markets: {
        [network]: { [`${a}:${b}`]: list.markets[network][`${a}:${b}`] },
      },
    };
    const r = new Registry(fixture);
    expect(r.getToken(network, a)).toEqual({ network, address: a });
    expect(r.getTokens(network)).toHaveLength(2);
    expect(r.data).not.toHaveProperty("tokens");
    expect(r.getMarket(network, b, a)?.key).toBe(`${a}:${b}`);
    expect(r.getMarketsByToken(network, b)).toHaveLength(1);
    expect(r.getMarketsByTag(network, Category.BlueChip)).toHaveLength(1);
    expect(r.getMarketsByTag(network, Category.Stable)).toHaveLength(1);
    expect(r.getMarketsByTag("eip155:1", Category.Stable)).toHaveLength(0);
    const metadata = [
      { address: a, symbol: "WETH", name: "Wrapped Ether" },
      { address: b, symbol: "USDC", name: "USD Coin" },
    ];
    expect(r.searchMarkets(network, "wrapped ether", metadata)).toHaveLength(1);
    expect(r.searchMarkets(network, "USDC / WETH", metadata)).toHaveLength(1);
    expect(r.searchMarkets(network, "0x4200")).toHaveLength(1);
    expect(r.getMarkets("eip155:4663")).toHaveLength(0);
  });
  it.each([
    { stepTicks: 0 },
    { stepTicks: -10 },
    { stepTicks: 0.1 },
    { stepTicks: 1000, baseTick: 1 },
    { baseTick: 887273 },
    { defaultDuration: 14 },
    { telegramPost: "javascript:alert(1)" },
    { featured: true },
  ])("rejects invalid market metadata %j", (v) =>
    expect(marketMetadataSchema.safeParse(v).success).toBe(false),
  );
  it("accepts optional metadata without redundant fields", () => {
    expect(
      marketMetadataSchema.parse({
        stepTicks: 1000,
        baseTick: -196000,
        defaultDuration: 30,
        telegramPost: "https://t.me/yld_cx/123",
      }).defaultDuration,
    ).toBe(30);
  });
  it("validates pairs independently and rejects static token metadata", () => {
    const clone = () => structuredClone(list);
    const reversed = {
      ...clone(),
      markets: {
        [network]: { [`${b}:${a}`]: { baseTick: 0, stepTicks: 1000 } },
      },
    };
    expect(yieldListSchema.safeParse(reversed).success).toBe(false);
    const arbitrary = "0x1111111111111111111111111111111111111111";
    expect(
      yieldListSchema.safeParse({
        version: 1,
        markets: { [network]: { [`${arbitrary}:${b}`]: {} } },
      }).success,
    ).toBe(true);
    expect(yieldListSchema.safeParse({ ...clone(), tokens: {} }).success).toBe(
      false,
    );
    expect(
      marketMetadataSchema.safeParse({ tags: ["stable", "stable"] }).success,
    ).toBe(false);
    expect(marketMetadataSchema.safeParse({ tags: ["verified"] }).success).toBe(
      false,
    );
  });
});
