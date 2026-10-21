import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement } from "react";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { GET } from "@/app/market/[network]/[pair]/og/route";
import { generateMetadata } from "@/app/market/[network]/[pair]/page";
import { SocialImage, tokenLogoData } from "@/components/layout/social-image";
vi.mock("next/og", () => ({
  ImageResponse: vi.fn(function () {
    return new Response();
  }),
}));
const weth = "0x4200000000000000000000000000000000000006";
const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const imageUrl =
  "https://coin-images.coingecko.com/coins/images/1/small/token.png";
const params = { network: "base", pair: `${weth}:${usdc}` };
describe("market social previews and SEO", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());
  it("resolves Worker symbols and rasterizes remote logos for configured and arbitrary markets", async () => {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "red" },
    })
      .png()
      .toBuffer();
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://md.yld.cx/")
        ? Response.json({
            tokens: [
              {
                chainId: 8453,
                address: weth,
                status: "available",
                symbol: "WETH",
                name: "Ether",
                imageUrl,
              },
              {
                chainId: 8453,
                address: usdc,
                status: "available",
                symbol: "USDC",
                name: "USD Coin",
                imageUrl,
              },
            ],
          })
        : new Response(new Uint8Array(bytes), {
            headers: { "content-type": "image/png" },
          }),
    );
    vi.stubGlobal("fetch", fetcher);
    const metadata = await generateMetadata({
      params: Promise.resolve(params),
    });
    expect(metadata.title).toBe("WETH / USDC · Base Liquidity Rental Market");
    const response = await GET(new Request("https://yld.cx"), {
      params: Promise.resolve(params),
    });
    expect(response.status).toBe(200);
    const props = (
      vi.mocked(ImageResponse).mock.calls[0][0] as ReactElement<
        ComponentProps<typeof SocialImage>
      >
    ).props;
    expect(props.label).toBe("WETH / USDC");
    expect(
      props.logos?.every((logo) => logo.startsWith("data:image/png;base64,")),
    ).toBe(true);
    const arbitrary = {
      network: "base",
      pair: `0x1111111111111111111111111111111111111111:${weth}`,
    };
    await GET(new Request("https://yld.cx"), {
      params: Promise.resolve(arbitrary),
    });
    expect(
      fetcher.mock.calls.some(([url]) => String(url).includes("0x111111")),
    ).toBe(true);
  });
  it("uses address labels and universal logos when metadata fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
    await GET(new Request("https://yld.cx"), {
      params: Promise.resolve(params),
    });
    const props = (
      vi.mocked(ImageResponse).mock.calls[0][0] as ReactElement<
        ComponentProps<typeof SocialImage>
      >
    ).props;
    expect(props.label).toBe("0x4200…0006 / 0x8335…2913");
    expect(props.logos).toEqual([
      await tokenLogoData({}),
      await tokenLogoData({}),
    ]);
    expect(
      (await generateMetadata({ params: Promise.resolve(params) })).title,
    ).toContain("0x4200…0006");
  });
  it.each([
    "http://127.0.0.1/a",
    "https://localhost/a",
    "https://evil.example/a",
    "https://coin-images.coingecko.com@127.0.0.1/a",
    "https://coin-images.coingecko.com:8443/a",
  ])("rejects unsafe image URL %s before fetching", async (imageUrl) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await tokenLogoData({ imageUrl })).toBe(await tokenLogoData({}));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["failure", "redirect", "large", "stream", "invalid"])(
    "falls back on %s downloads",
    async (kind) => {
      const response =
        kind === "failure"
          ? new Response(null, { status: 503 })
          : kind === "redirect"
            ? new Response(null, {
                status: 302,
                headers: { location: "http://localhost" },
              })
            : kind === "large"
              ? new Response("", {
                  headers: {
                    "content-type": "image/png",
                    "content-length": "99999999",
                  },
                })
              : kind === "stream"
                ? new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
                    headers: { "content-type": "image/png" },
                  })
                : new Response("invalid", {
                    headers: { "content-type": "image/png" },
                  });
      const fetcher = vi.fn().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetcher);
      expect(await tokenLogoData({ imageUrl })).toBe(await tokenLogoData({}));
      expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error" });
    },
  );
  it("returns 404 for an invalid pair", async () => {
    expect(
      (
        await GET(new Request("https://yld.cx"), {
          params: Promise.resolve({ network: "base", pair: `${weth}:${weth}` }),
        })
      ).status,
    ).toBe(404);
    expect(ImageResponse).not.toHaveBeenCalled();
  });
});
