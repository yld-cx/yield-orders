import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageResponse } from "next/og";
import { renderToStaticMarkup } from "react-dom/server";
import { humanPrice, priceAtTick } from "@yld-cx/sdk/ethereum";
import { GET as scenarioImage } from "@/app/play/[network]/[strategy]/og/route";
import { GET as networkImage } from "@/app/play/[network]/og/route";
import { GET as genericImage } from "@/app/play/og/route";
import { generateMetadata as scenarioMetadata } from "@/app/play/[network]/[strategy]/page";
import { generateMetadata as networkMetadata } from "@/app/play/[network]/page";
import { generateMetadata as genericMetadata } from "@/app/play/page";
import { readPlaySelection } from "@/lib/play-market";
import {
  encodePlayStrategy,
  playPath,
  PlayStrategy,
  type PlaySettings,
} from "@/lib/play";
import { priceText } from "@/lib/market-values";

vi.mock("next/og", () => ({
  ImageResponse: vi.fn(function () {
    return new Response();
  }),
}));
vi.mock("@/components/layout/social-image", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/layout/social-image")
  >()),
  tokenLogoData: vi.fn(async () => "data:image/png;base64,"),
}));
vi.mock("@/lib/token-metadata", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/token-metadata")>();
  return {
    ...original,
    fetchTokenMetadata: vi.fn(
      async (
        network: Parameters<typeof original.fetchTokenMetadata>[0],
        addresses: readonly string[],
      ) =>
        addresses.map((address: string) => ({
          ...original.fallbackToken(network, address),
          symbol: address.startsWith("0x4200") ? "WETH" : "USDC",
        })),
    ),
  };
});

const settings = {
  id: PlayStrategy.Long,
  token: "0x42000000000000000000000000000000000000aa",
  amount: "1000",
  entry: "1700",
  target: "1870",
  rate: "0.5",
};
const scenario = (settings: PlaySettings) => ({
  network: "base",
  strategy: encodePlayStrategy(settings),
});
const params = scenario(settings);
const metadata = (value: typeof params) =>
  scenarioMetadata({
    params: Promise.resolve(value),
    searchParams: Promise.resolve({}),
  });
const image = (value: typeof params) =>
  scenarioImage(
    new Request(`https://yld.cx${playPath("base", value.strategy)}/og`),
    {
      params: Promise.resolve(value),
    },
  );

describe("Yield Explorer social previews", () => {
  afterEach(() => vi.clearAllMocks());
  it("accepts a valid token outside the Yield List and validates the network", () => {
    expect(readPlaySelection(params)?.settings).toEqual(settings);
    expect(
      readPlaySelection({ ...params, strategy: "unknown" }),
    ).toBeUndefined();
    expect(
      readPlaySelection({ ...params, network: "unknown" }),
    ).toBeUndefined();
  });
  it("creates distinct OG and Twitter image URLs for different scenarios", async () => {
    const first = await metadata(params);
    const second = await metadata(scenario({ ...settings, target: "2000" }));
    expect(first.title).toBe("Bullish on WETH · Yield Explorer");
    expect(first.openGraph?.title).toBe(first.title);
    expect(first.twitter?.title).toBe(first.title);
    expect(first.description).toBe("Potential PnL · +95 USDC");
    const og = first.openGraph?.images as { url: string }[];
    const next = second.openGraph?.images as { url: string }[];
    expect(first.openGraph?.url).toBe(
      `https://yld.cx/play/base/${params.strategy}`,
    );
    expect(og[0].url).toBe(`${first.openGraph?.url}/og`);
    expect(og[0].url).not.toBe(next[0].url);
    expect(first.twitter?.images).toEqual([og[0].url]);
  });
  it("renders the selected strategy, inputs and outcome in the preview", async () => {
    await image(params);
    expect(vi.mocked(ImageResponse)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ width: 1200, height: 630 }),
    );
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    for (const text of [
      "Yield Explorer",
      "Bullish on WETH",
      "🐂 Long",
      "Rent amount",
      "Target price",
      "7-day rental cost",
      "0.5%",
      "Potential PnL",
      "+95 USDC",
      "+9.5%",
    ]) {
      expect(html).toContain(text);
    }
  });
  it.each([
    {
      rentSelectedToken: false,
      entry: "0.1",
      amount: "1000",
      asset: "USDC",
      quote: "WETH",
      repayment: "1,000.7",
      quoteAmount: "100",
    },
    {
      rentSelectedToken: true,
      entry: "10",
      amount: "100",
      asset: "WETH",
      quote: "USDC",
      repayment: "100.07",
      quoteAmount: "1,000",
    },
  ])(
    "keeps the title and preview in sync when renting $asset",
    async ({
      rentSelectedToken,
      entry,
      amount,
      asset,
      quote,
      repayment,
      quoteAmount,
    }) => {
      const params = scenario({
        id: PlayStrategy.UseLiquidity,
        token: settings.token,
        rentSelectedToken,
        amount,
        entry,
      });
      const copy = `Rent ${asset} with ${quote}`;
      expect((await metadata(params)).title).toBe(`${copy} · Yield Explorer`);
      await image(params);
      const html = renderToStaticMarkup(
        vi.mocked(ImageResponse).mock.calls[0][0],
      );
      expect(html).toContain(copy);
      expect(html).toContain("Entry price");
      expect(html).toContain(">10 USDC</span>");
      expect(html).toContain(`${repayment} ${asset}`);
      expect(html).toContain(`Estimated quote · ${quoteAmount} ${quote}`);
    },
  );
  it("shows the provided asset and quote proceeds in the Take Profit preview", async () => {
    await image(
      scenario({
        ...settings,
        id: PlayStrategy.TakeProfit,
        amount: "4",
        entry: "10",
        target: "15",
      }),
    );
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    for (const text of [
      "Provide amount",
      "4 WETH",
      "Potential tokens",
      "60 USDC",
    ]) {
      expect(html).toContain(text);
    }
  });
  it.each([undefined, -351200])(
    "uses the Yield Book precision for entry and target prices with saved tick %s",
    async (targetTick) => {
      const target = humanPrice(priceAtTick(-351200), 18, 6);
      await image(
        scenario({ ...settings, entry: ".0003741863826", target, targetTick }),
      );
      const html = renderToStaticMarkup(
        vi.mocked(ImageResponse).mock.calls[0][0],
      );
      expect(html).toContain(">0.000374186 USDC</span>");
      expect(html).toContain(`>${priceText(target)} USDC</span>`);
    },
  );
  it("keeps the network in the preview when a strategy has not been selected", async () => {
    const params = Promise.resolve({ network: "base" });
    const page = await networkMetadata({
      params,
      searchParams: Promise.resolve({}),
    });
    const title = "Yield Explorer";
    const subtitle = "Play yld.cx way on Base";
    expect(page.openGraph?.title).toBe(title);
    expect(page.twitter?.title).toBe(title);
    expect(page.openGraph?.description).toBe(subtitle);
    expect(page.twitter?.description).toBe(subtitle);
    expect(page.openGraph?.url).toBe("https://yld.cx/play/base");
    expect(page.openGraph?.images).toEqual([
      expect.objectContaining({
        url: "https://yld.cx/play/base/og",
        alt: title,
      }),
    ]);
    expect(page.twitter?.images).toEqual(["https://yld.cx/play/base/og"]);
    await networkImage(new Request("https://yld.cx/play/base/og"), { params });
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    expect(html).toContain(`>${title}</span>`);
    expect(html).toContain(
      '<span style="color:#ffffff;font-weight:400">Base</span>',
    );
    expect(html.indexOf(`>${title}</span>`)).toBeLessThan(
      html.indexOf(">Play</span>"),
    );
  });
  it("uses a generic preview when there is no selected market", async () => {
    expect((await genericMetadata()).title).toBe("Yield Explorer");
    await genericImage();
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain(
      "Play yld.cx way",
    );
  });
});
