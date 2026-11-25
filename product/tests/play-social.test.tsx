import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageResponse } from "next/og";
import { GET } from "@/app/play/og/route";
import { generateMetadata } from "@/app/play/page";
import { readPlaySelection } from "@/lib/play-market";

vi.mock("next/og", () => ({ ImageResponse: vi.fn(function () { return new Response(); }) }));
vi.mock("@/components/layout/social-image", () => ({ tokenLogoData: vi.fn(async () => "data:image/png;base64,") }));
vi.mock("@/lib/token-metadata", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/token-metadata")>();
  return { ...original, fetchTokenMetadata: vi.fn(async (network: Parameters<typeof original.fetchTokenMetadata>[0], addresses: readonly string[]) =>
    addresses.map((address: string) => ({
      ...original.fallbackToken(network, address),
      symbol: address.startsWith("0x4200") ? "WETH" : "USDC",
    })),
  ) };
});

const market = "0x4200000000000000000000000000000000000006:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const params = { network: "base", market, strategy: "long", amount: "1000", entry: "1700", target: "1870", rate: "0.5" };
const metadata = (value: Record<string, string>) => generateMetadata({ searchParams: Promise.resolve(value) });
const image = (value: Record<string, string>) => GET(new Request("https://yld.cx/play/og?" + new URLSearchParams(value)));

describe("Yield Explorer social previews", () => {
  afterEach(() => vi.clearAllMocks());
  it("validates the registered market and strategy", () => {
    expect(readPlaySelection(new URLSearchParams(params))?.strategy.id).toBe("long");
    expect(readPlaySelection(new URLSearchParams({ ...params, market: "unknown" }))).toBeUndefined();
    expect(readPlaySelection(new URLSearchParams({ ...params, network: "unknown" }))).toBeUndefined();
  });
  it("creates distinct OG and Twitter image URLs for different scenarios", async () => {
    const first = await metadata(params);
    const second = await metadata({ ...params, target: "2000" });
    expect(first.title).toContain("Long WETH");
    const og = first.openGraph?.images as { url: string }[];
    const next = second.openGraph?.images as { url: string }[];
    expect(og[0].url).toContain("/play/og?");
    expect(new URL(og[0].url).searchParams.get("target")).toBe("1870");
    expect(og[0].url).not.toBe(next[0].url);
    expect(first.twitter?.images).toEqual([og[0].url]);
  });
  it("returns a 1200 by 630 preview without needing a wallet or RPC", async () => {
    expect((await image(params)).status).toBe(200);
    expect(vi.mocked(ImageResponse)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ width: 1200, height: 630 }));
  });
  it("uses a generic preview when there is no selected market", async () => {
    expect((await metadata({})).title).toBe("Yield Explorer");
    expect((await image({ strategy: "unknown", market: "invalid" })).status).toBe(200);
  });
});
