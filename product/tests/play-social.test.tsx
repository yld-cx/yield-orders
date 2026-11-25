import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageResponse } from "next/og";
import { renderToStaticMarkup } from "react-dom/server";
import { humanPrice, priceAtTick } from "@yld-cx/sdk/ethereum";
import { GET } from "@/app/play/og/route";
import { generateMetadata } from "@/app/play/page";
import { readPlaySelection } from "@/lib/play-market";
import { decodePlayStrategy, playParams, PlayStrategy } from "@/lib/play";
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
const params = Object.fromEntries(playParams("base", settings));
const metadata = (value: Record<string, string>) =>
  generateMetadata({ searchParams: Promise.resolve(value) });
const image = (value: Record<string, string>) =>
  GET(new Request("https://yld.cx/play/og?" + new URLSearchParams(value)));

describe("Yield Explorer social previews", () => {
  afterEach(() => vi.clearAllMocks());
  it("accepts a valid token outside the Yield List and validates the network", () => {
    expect(readPlaySelection(new URLSearchParams(params))?.settings).toEqual(
      settings,
    );
    expect(
      readPlaySelection(
        new URLSearchParams({ ...params, strategy: "unknown" }),
      ),
    ).toBeUndefined();
    expect(
      readPlaySelection(new URLSearchParams({ ...params, network: "unknown" })),
    ).toBeUndefined();
  });
  it("creates distinct OG and Twitter image URLs for different scenarios", async () => {
    const first = await metadata(params);
    const second = await metadata(
      Object.fromEntries(playParams("base", { ...settings, target: "2000" })),
    );
    expect(first.title).toBe("Bullish on WETH · Yield Explorer");
    expect(first.openGraph?.title).toBe(first.title);
    expect(first.twitter?.title).toBe(first.title);
    expect(first.description).toBe("Potential PnL · +95 USDC");
    const og = first.openGraph?.images as { url: string }[];
    const next = second.openGraph?.images as { url: string }[];
    expect(og[0].url).toContain("/play/og?");
    expect(
      decodePlayStrategy(new URL(og[0].url).searchParams.get("strategy")),
    ).toEqual(settings);
    expect(og[0].url).not.toBe(next[0].url);
    expect(first.twitter?.images).toEqual([og[0].url]);
  });
  it("returns a 1200 by 630 preview without needing a wallet or RPC", async () => {
    expect((await image(params)).status).toBe(200);
    expect(vi.mocked(ImageResponse)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ width: 1200, height: 630 }),
    );
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    const [, titleRow, descriptionRow] = html.split(
      'style="display:flex;align-items:center;justify-content:space-between;gap:24px"',
    );
    expect(titleRow).toContain(">Bullish on WETH</span>");
    expect(titleRow).toContain(">Yield Explorer</span>");
    expect(descriptionRow).toContain("🐂 Long");
    expect(descriptionRow).toContain(">Play</span>");
    expect(html).toContain("padding:100px");
    expect(html).toContain("background-size:auto, 28px 28px, 28px 28px");
    expect(html.match(/border:[^;"]+/g)).toEqual(["border:1px solid #26342d"]);
    expect(html).toContain('<span style="color:#00ff4c">yld.cx</span>');
    expect(html).toContain(
      '<span style="color:#ffffff;font-weight:400">Base</span>',
    );
    for (const text of [
      "Yield Explorer",
      "Bullish on WETH",
      "Long",
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
      const query = Object.fromEntries(
        playParams("base", {
          id: PlayStrategy.UseLiquidity,
          token: settings.token,
          rentSelectedToken,
          amount,
          entry,
        }),
      );
      const copy = `Rent ${asset} with ${quote}`;
      expect((await metadata(query)).title).toBe(`${copy} · Yield Explorer`);
      await image(query);
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
  it.each([
    {
      id: PlayStrategy.Short,
      label: "Rent amount",
      target: "5",
      result: "+19.8 USDC",
    },
    {
      id: PlayStrategy.TakeProfit,
      label: "Provide amount",
      target: "15",
      result: "60 USDC",
    },
    {
      id: PlayStrategy.HoldAndEarn,
      label: "Provide amount",
      target: "20",
      result: "0.002772 WETH",
    },
  ] as const)(
    "shows native token amounts and the correct result for $id",
    async ({ id, label, target, result }) => {
      const query = Object.fromEntries(
        playParams("base", {
          ...settings,
          id,
          amount: "4",
          entry: "10",
          target,
          rate: id === PlayStrategy.HoldAndEarn ? undefined : "1",
        }),
      );
      await image(query);
      const html = renderToStaticMarkup(
        vi.mocked(ImageResponse).mock.calls[0][0],
      );
      for (const text of [label, "4 WETH", "10 USDC", result]) {
        expect(html).toContain(text);
      }
    },
  );
  it("uses the Yield Book price formatting for a saved tick", async () => {
    const targetTick = -200000;
    const target = humanPrice(priceAtTick(targetTick), 18, 6);
    await image(
      Object.fromEntries(
        playParams("base", { ...settings, target, targetTick }),
      ),
    );
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    expect(html).toContain(`>${priceText(target)} USDC</span>`);
  });
  it("keeps the network in the preview when a strategy has not been selected", async () => {
    const query = { network: "base" };
    const page = await metadata(query);
    const title = "Yield Explorer";
    const subtitle = "Play yld.cx way on Base";
    expect(page.openGraph?.title).toBe(title);
    expect(page.twitter?.title).toBe(title);
    expect(page.openGraph?.description).toBe(subtitle);
    expect(page.twitter?.description).toBe(subtitle);
    expect(page.openGraph?.url).toBe("https://yld.cx/play?network=base");
    expect(page.openGraph?.images).toEqual([
      expect.objectContaining({
        url: "https://yld.cx/play/og?network=base",
        alt: title,
      }),
    ]);
    expect(page.twitter?.images).toEqual([
      "https://yld.cx/play/og?network=base",
    ]);
    expect((await image(query)).status).toBe(200);
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
    expect((await metadata({})).title).toBe("Yield Explorer");
    expect(
      (await image({ network: "unknown", strategy: "unknown" })).status,
    ).toBe(200);
    const html = renderToStaticMarkup(
      vi.mocked(ImageResponse).mock.calls[0][0],
    );
    expect(html).toContain(
      '<span>Play</span><span style="color:#00ff4c">yld.cx</span><span>way</span>',
    );
  });
});
