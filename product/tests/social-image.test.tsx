import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactElement } from "react";
import { ImageResponse } from "next/og";
import { GET } from "@/app/market/[network]/[pair]/og/route";
import { SocialImage, tokenLogoData } from "@/components/layout/social-image";

vi.mock("next/og", () => ({
  ImageResponse: vi.fn(function () {
    return new Response();
  }),
}));

const weth = "0x4200000000000000000000000000000000000006",
  usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  btc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  unknown = "0x1111111111111111111111111111111111111111";

describe("market social previews", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      pair: `${weth}:${usdc}`,
      label: "WETH / USDC",
      logos: ["/tokens/weth.webp", "/tokens/usdc.webp"],
    },
    {
      pair: `${usdc}:${btc}`,
      label: "cbBTC / USDC",
      logos: ["/tokens/cbbtc.webp", "/tokens/usdc.webp"],
    },
    {
      pair: `${weth}:${btc}`,
      label: "cbBTC / WETH",
      logos: ["/tokens/cbbtc.webp", "/tokens/weth.webp"],
    },
    {
      pair: `${weth}:${unknown}`,
      label: "0x1111…1111 / WETH",
      logos: [undefined, "/tokens/weth.webp"],
    },
    {
      pair: `${weth}:0xffffffffffffffffffffffffffffffffffffffff`,
      label: "0xffff…ffff / WETH",
      logos: [undefined, "/tokens/weth.webp"],
    },
    {
      pair: `${usdc}:0xffffffffffffffffffffffffffffffffffffffff`,
      label: "0xffff…ffff / USDC",
      logos: [undefined, "/tokens/usdc.webp"],
    },
  ])("renders $label with matching logos", async ({ pair, label, logos }) => {
    const response = await GET(new Request("https://yld.cx"), {
      params: Promise.resolve({ network: "base", pair }),
    });
    expect(response.status).toBe(200);
    const [element] = vi.mocked(ImageResponse).mock.calls[0];
    const { props } = element as ReactElement<
      ComponentProps<typeof SocialImage>
    >;
    expect(props.label).toBe(label);
    expect(props.network).toBe("Base");
    expect(props.logos).toEqual(
      await Promise.all(logos.map((logoURI) => tokenLogoData({ logoURI }))),
    );
  });

  it("uses fallbacks for tokens not listed on the requested network", async () => {
    await GET(new Request("https://yld.cx"), {
      params: Promise.resolve({ network: "ethereum", pair: `${weth}:${btc}` }),
    });
    const [element] = vi.mocked(ImageResponse).mock.calls[0];
    const { props } = element as ReactElement<
      ComponentProps<typeof SocialImage>
    >;
    expect(props.label).toBe("0x4200…0006 / 0xcbb7…33bf");
    expect(props.logos).toEqual([
      await tokenLogoData({}),
      await tokenLogoData({}),
    ]);
  });

  it("returns 404 for an invalid pair", async () => {
    const response = await GET(new Request("https://yld.cx"), {
      params: Promise.resolve({ network: "base", pair: `${weth}:${weth}` }),
    });
    expect(response.status).toBe(404);
    expect(ImageResponse).not.toHaveBeenCalled();
  });
});
