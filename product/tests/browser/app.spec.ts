import { test, expect, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  encodeErrorResult,
  multicall3Abi,
  type Hex,
} from "viem";
import {
  protocolAbi,
  pairIdFor,
  tickIdFor,
  priceAtTick,
  humanPrice,
} from "../../packages/sdk/src/ethereum/index.js";
import type { TickState } from "../../packages/sdk/src/types/index.js";
type TickOverrides = Map<bigint, Partial<TickState> | null>;
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  key = `${a}:${b}`;
const directId = tickIdFor(pairIdFor(a, b), 0, -196123, 7);
const pairId = pairIdFor(a, b),
  id7 = tickIdFor(pairId, 0, -196000, 7),
  id30 = tickIdFor(pairId, 0, -196000, 30),
  bid7 = tickIdFor(pairId, 1, 196000, 7),
  bid30 = tickIdFor(pairId, 1, 196000, 30);
function contractCall(
  data: Hex,
  pairExists = true,
  tickOverrides?: TickOverrides,
): { success: boolean; returnData: Hex } {
  try {
    const decoded = decodeFunctionData({ abi: protocolAbi, data });
    if (decoded.functionName === "getPair") {
      const aa = decoded.args[0].toLowerCase() as typeof a,
        bb = decoded.args[1].toLowerCase() as typeof b;
      const ordered = [aa, bb].sort();
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: protocolAbi,
          functionName: "getPair",
          result: [
            pairIdFor(aa, bb),
            ordered[0] as typeof a,
            ordered[1] as typeof b,
            pairExists,
          ],
        }),
      };
    }
    if (decoded.functionName === "getTick") {
      const id = decoded.args[0];
      if (
        tickOverrides?.get(id) === null ||
        (![id7, id30, bid7, bid30, directId].includes(id) &&
          !tickOverrides?.has(id))
      )
        throw new Error("missing");
      const bid = id === bid7 || id === bid30;
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: protocolAbi,
          functionName: "getTick",
          result: {
            asset: bid ? b : a,
            quote: bid ? a : b,
            durationDays: id === id30 || id === bid30 ? 30n : 7n,
            priceX128: priceAtTick(
              bid ? 196000 : id === directId ? -196123 : -196000,
            ),
            availableSupply: 1000n * 10n ** (bid ? 6n : 18n),
            workingSupply: 0n,
            exitWorking: 0n,
            activeWorking: 0n,
            activePrincipal: 1000n * 10n ** 18n,
            settleCursor: 0n,
            ...tickOverrides?.get(id),
          },
        }),
      };
    }
    if (decoded.functionName === "quoteUse")
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: protocolAbi,
          functionName: "quoteUse",
          result: [
            decoded.args[0] === bid7 || decoded.args[0] === bid30
              ? (decoded.args[1] * 10n ** 12n) / 3000n
              : (decoded.args[1] * 3000n) / 10n ** 12n,
            decoded.args[1] / 100n,
          ],
        }),
      };
    if (
      decoded.functionName === "getEarnPositions" ||
      decoded.functionName === "getUsePositions"
    )
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: protocolAbi,
          functionName: decoded.functionName,
          result: [],
        }),
      };
    throw new Error("missing");
  } catch {
    return {
      success: false,
      returnData: encodeErrorResult({
        abi: protocolAbi,
        errorName: "NotFound",
      }),
    };
  }
}
async function rpc(
  page: Page,
  pairExists = true,
  tickOverrides?: TickOverrides,
) {
  await page.route(
    /https:\/\/(mainnet\.base\.org|ethereum-rpc\.publicnode\.com|rpc\.mainnet\.chain\.robinhood\.com)\/?$/,
    async (route) => {
      const payload = route.request().postDataJSON() as
        | { id: number; method: string; params: unknown[] }
        | { id: number; method: string; params: unknown[] }[];
      const respond = (item: {
        id: number;
        method: string;
        params: unknown[];
      }) => {
        let result: unknown = "0x";
        if (item.method === "eth_blockNumber") result = "0x989680";
        else if (item.method === "eth_chainId") result = "0x2105";
        else if (item.method === "eth_call") {
          const call = item.params[0] as { data: Hex };
          let value;
          try {
            const decoded = decodeFunctionData({
              abi: multicall3Abi,
              data: call.data,
            });
            if (decoded.functionName === "aggregate3") {
              value = {
                success: true,
                returnData: encodeFunctionResult({
                  abi: multicall3Abi,
                  functionName: "aggregate3",
                  result: decoded.args[0].map((c) =>
                    contractCall(c.callData, pairExists, tickOverrides),
                  ),
                }),
              };
            }
          } catch {}
          value ??= contractCall(call.data, pairExists, tickOverrides);
          if (!value.success)
            return {
              id: item.id,
              jsonrpc: "2.0",
              error: {
                code: 3,
                message: "execution reverted",
                data: value.returnData,
              },
            };
          result = value.returnData;
        }
        return { id: item.id, jsonrpc: "2.0", result };
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          Array.isArray(payload) ? payload.map(respond) : respond(payload),
        ),
      });
    },
  );
}
async function injectWallets(page: Page) {
  await page.addInitScript(() => {
    type Request = { method: string; params?: { chainId: string }[] };
    const create = (
      initial: string,
      name: string,
      rdns: string,
      uuid: string,
    ) => {
      let address = sessionStorage.getItem(rdns + ".address") ?? initial,
        authorized = sessionStorage.getItem(rdns + ".authorized") === "true",
        chain = sessionStorage.getItem(rdns + ".chain") ?? "0x1";
      const events = new Map<string, ((value: unknown) => void)[]>();
      const provider = {
        request: async ({ method, params }: Request) => {
          if (method === "eth_requestAccounts") {
            authorized = true;
            sessionStorage.setItem(rdns + ".authorized", "true");
            return [address];
          }
          if (method === "eth_accounts") return authorized ? [address] : [];
          if (method === "eth_chainId") return chain;
          if (method === "wallet_switchEthereumChain") {
            chain = params![0].chainId;
            sessionStorage.setItem(rdns + ".chain", chain);
            events.get("chainChanged")?.forEach((fn) => fn(chain));
            return null;
          }
          throw new Error(`Unsupported test method ${method}`);
        },
        on: (event: string, listener: (v: unknown) => void) =>
          events.set(event, [...(events.get(event) ?? []), listener]),
        removeListener: (event: string, listener: (v: unknown) => void) =>
          events.set(
            event,
            (events.get(event) ?? []).filter((fn) => fn !== listener),
          ),
      };
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent("eip6963:announceProvider", {
            detail: {
              info: {
                uuid,
                name,
                rdns,
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
              },
              provider,
            },
          }),
        );
      window.addEventListener("eip6963:requestProvider", announce);
      announce();
      return {
        account: (next: string) => {
          address = next;
          sessionStorage.setItem(rdns + ".address", next);
          events.get("accountsChanged")?.forEach((fn) => fn([next]));
        },
        chain: (next: string) => {
          chain = next;
          events.get("chainChanged")?.forEach((fn) => fn(next));
        },
      };
    };
    const metamask = create(
      "0x0000000000000000000000000000000000000001",
      "MetaMask",
      "io.metamask",
      "00000000-0000-4000-8000-000000000001",
    );
    create(
      "0x0000000000000000000000000000000000000002",
      "Phantom",
      "app.phantom",
      "00000000-0000-4000-8000-000000000002",
    );
    Object.assign(window, { testWallet: metamask });
  });
}
test.beforeAll(async ({ request }) => {
  if (process.env.PLAYWRIGHT_SERVER !== "development") return;
  // Finish Next's cold route compilation before interactive HMR clients mount.
  for (const path of [
    "/orders",
    "/market/open",
    `/market/base/${key}`,
    `/market/base/${key}/og`,
    "/opengraph-image",
  ]) {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
  }
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const events: string[] = [];
    Object.assign(window, { testCspEvents: events });
    document.addEventListener("securitypolicyviolation", (event) =>
      events.push(event.violatedDirective),
    );
  });
  await rpc(page);
});
test("market keeps one spinner through initial reads and preserves content during refresh", async ({
  page,
}) => {
  let releasePair!: () => void;
  let releaseBook!: () => void;
  const pairReady = new Promise<void>((resolve) => (releasePair = resolve));
  let bookReady = new Promise<void>((resolve) => (releaseBook = resolve));
  let bookRequests = 0;
  const pairCall = encodeFunctionData({
    abi: protocolAbi,
    functionName: "getPair",
    args: [a, b],
  }).slice(2);
  await page.route("https://mainnet.base.org", async (route) => {
    if (route.request().postData()!.includes(pairCall)) await pairReady;
    else {
      bookRequests++;
      await bookReady;
    }
    await route.fallback();
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/market/base/${key}`);
  const loading = page
    .getByRole("status")
    .filter({ hasText: "Loading market…" });
  await expect(loading).toBeVisible();
  await expect(loading.locator('[aria-hidden="true"]')).toHaveCSS(
    "animation-name",
    "none",
  );
  const spinner = loading.locator("svg");
  await expect(spinner).toHaveCSS("color", "rgb(0, 255, 76)");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(spinner).toHaveCSS("animation-name", "spin");
  await expect(spinner).toHaveCSS("animation-iteration-count", "infinite");
  await expect(spinner).toHaveCSS("animation-timing-function", "linear");
  const initialSpinner = await loading.boundingBox();
  const initialFooter = await page.locator("footer").boundingBox();
  releasePair();
  await expect.poll(() => bookRequests).toBeGreaterThan(0);
  await expect(loading).toBeVisible();
  expect(await loading.boundingBox()).toEqual(initialSpinner);
  expect(await page.locator("footer").boundingBox()).toEqual(initialFooter);
  await expect(page.getByRole("heading", { name: "Yield Book" })).toHaveCount(
    0,
  );
  releaseBook();
  await expect(page.getByRole("heading", { name: "Yield Book" })).toBeVisible();
  await expect(loading).toHaveCount(0);
  await page.getByLabel("Posted price").fill("3000");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.getByText("More price levels", { exact: true }).click();
  bookReady = new Promise<void>((resolve) => (releaseBook = resolve));
  await page.getByRole("button", { name: "Retry discovery" }).click();
  await expect(
    page.getByRole("button", { name: "Retry discovery" }),
  ).toBeDisabled();
  await expect(loading).toHaveCount(0);
  await expect(page.getByLabel("Posted price")).toHaveValue("3000");
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
  releaseBook();
  await expect(
    page.getByRole("button", { name: "Retry discovery" }),
  ).toBeEnabled();
});

test("market lookup reserves space while loading", async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  await page.route("https://mainnet.base.org", async (route) => {
    await ready;
    await route.fallback();
  });
  await page.goto("/market/open");
  const loading = page
    .getByRole("status")
    .filter({ hasText: "Checking market…" });
  await expect(loading).toBeVisible();
  const description = page.getByText(
    "Creating a pair does not supply liquidity",
    {
      exact: false,
    },
  );
  const before = await description.boundingBox();
  release();
  await expect(
    page.getByRole("button", { name: "View Market →" }),
  ).toBeVisible();
  await expect(loading).toHaveCount(0);
  expect(await description.boundingBox()).toEqual(before);
});

test("market summary cells keep their positions when reads finish", async ({
  page,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  await page.route("https://mainnet.base.org", async (route) => {
    await ready;
    await route.fallback();
  });
  await page.goto("/");
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  });
  await expect(row.locator('[data-slot="skeleton"]').first()).toBeVisible();
  await expect(row.getByRole("status")).toHaveCount(0);
  const cells = row.getByRole("cell");
  const before = await cells.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().toJSON()),
  );
  release();
  await expect(row.locator('[data-slot="skeleton"]')).toHaveCount(0);
  expect(
    await cells.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().toJSON()),
    ),
  ).toEqual(before);
});

test("market search, tags, network isolation and responsive layout", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Yield Markets" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  const market = page.getByRole("link", {
    name: "Open WETH / USDC",
    exact: true,
  });
  const pairName = await market.locator("strong").boundingBox();
  const metadata = await market.locator("small").boundingBox();
  expect(metadata!.y).toBeGreaterThanOrEqual(pairName!.y + pairName!.height);
  const controls = await Promise.all([
    page.locator('a[href="/market/open"]').boundingBox(),
    page.getByRole("textbox", { name: "Search markets" }).boundingBox(),
    page
      .getByRole("combobox", { name: "Market duration", exact: true })
      .boundingBox(),
  ]);
  const centers = controls.map((box) => box!.y + box!.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
  await page
    .getByRole("combobox", { name: "Market duration", exact: true })
    .click();
  await page.getByRole("option", { name: "30D", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Market duration", exact: true }),
  ).toContainText("30D");
  await page.screenshot({
    path: testInfo.outputPath("inline-market-toolbar.png"),
    fullPage: true,
  });
  await page.getByLabel("Search markets").fill("cbBTC");
  await expect(
    page.getByRole("link", { name: "Open cbBTC / USDC", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Search markets").clear();
  await page.getByRole("button", { name: "Stable", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open cbBTC / USDC", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Meme", exact: true }).click();
  await expect(page.getByText("No matching markets")).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Network", exact: true }).click();
  await page.getByRole("option", { name: "Robinhood", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Network", exact: true }),
  ).toContainText("Robinhood");
  await expect(page.locator('[data-slot="empty"]')).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
test("shared market filters restore after reload and browser history, with a centered empty state", async ({
  page,
  context,
}, testInfo) => {
  await context.addCookies([
    { name: "yld.network", value: "base", url: testInfo.project.use.baseURL! },
  ]);
  await page.goto("/?search=WETH&tag=blue-chip&duration=30&network=ethereum");
  const network = page.getByRole("combobox", { name: "Network", exact: true });
  const search = page.getByRole("textbox", { name: "Search markets" });
  const duration = page.getByRole("combobox", {
    name: "Market duration",
    exact: true,
  });
  await expect(network).toContainText("Ethereum");
  await expect(search).toHaveValue("WETH");
  await expect(duration).toContainText("30D");
  await expect(
    page.getByRole("button", { name: "Blue chip", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toHaveAttribute("href", /market\/ethereum\//);
  await page.reload();
  await expect(network).toContainText("Ethereum");
  await expect(search).toHaveValue("WETH");
  await expect(duration).toContainText("30D");
  await page.getByRole("button", { name: "Meme", exact: true }).click();
  await expect(page).toHaveURL(/tag=meme/);
  const empty = page.locator('[data-slot="empty"]');
  await expect(empty).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  const emptyBox = await empty.boundingBox();
  const descriptionBox = await empty
    .locator('[data-slot="empty-description"]')
    .boundingBox();
  expect(
    Math.abs(
      emptyBox!.x +
        emptyBox!.width / 2 -
        (descriptionBox!.x + descriptionBox!.width / 2),
    ),
  ).toBeLessThan(2);
  await expect(page.getByText("Sides per market", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Terms", { exact: true })).toHaveCount(0);
  for (const [title, color] of [
    ["01 · Provide", "rgb(231, 185, 77)"],
    ["02 · Rent or swap", "rgb(211, 195, 255)"],
    ["03 · Earn or settle", "rgb(0, 255, 76)"],
  ]) {
    await expect(
      page
        .getByRole("heading", { name: title, exact: true })
        .locator("..")
        .locator("svg"),
    ).toHaveCSS("color", color);
  }
  await page.screenshot({
    path: testInfo.outputPath("market-empty-state.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await expect
    .poll(() => new URL(page.url()).searchParams.has("search"))
    .toBe(false);
  await expect(duration).toContainText("30D");
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(search).toHaveValue("WETH");
  await expect(empty).toBeVisible();
  await page.goForward();
  await expect(search).toHaveValue("");
  await expect(empty).toHaveCount(0);
  await network.click();
  await page.getByRole("option", { name: "Base", exact: true }).click();
  await expect(page).toHaveURL(/network=base/);
  await expect(duration).toContainText("30D");
  await page.goBack();
  await expect(network).toContainText("Ethereum");
});

test("multiple injected providers, wallet selection, account and network switching", async ({
  page,
}) => {
  await injectWallets(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "MetaMask", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Phantom", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Injected", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  await expect(page.getByRole("button", { name: "0x0000…0001" })).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { testWallet: { account: (a: string) => void } }
    ).testWallet.account("0x0000000000000000000000000000000000000003");
  });
  await expect(page.getByRole("button", { name: "0x0000…0003" })).toBeVisible();
  await expect(page.getByRole("button", { name: "0x0000…0003" })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { testCspEvents: string[] }).testCspEvents,
    ),
  ).toEqual([]);
  await page.goto(`/market/base/${key}`);
  await expect(page.getByRole("heading", { name: "Yield Book" })).toBeVisible();
  await page.getByLabel("Posted price").fill("3000");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await expect(
    page.getByRole("button", { name: "Switch wallet network" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch wallet network" }).click();
  await expect(
    page.getByRole("button", { name: "Switch wallet network" }),
  ).toHaveCount(0);
});
test("duration, pair inversion, exact price snapping and bounded discovery", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await expect(page.getByRole("heading", { name: "Yield Book" })).toBeVisible();
  await page.getByText("More price levels", { exact: true }).click();
  await expect(
    page.getByText("36 identities checked", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Posted price").fill("3000");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.getByText("Price details", { exact: true }).click();
  await expect(page.getByText("-196000", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Term", exact: true }).click();
  await page.getByRole("option", { name: "30D", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Preview Provide" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load more price levels" }).click();
  await expect(
    page.getByText("68 identities checked", { exact: false }),
  ).toBeVisible();
  const canonical = await page
    .locator('link[rel="canonical"]')
    .getAttribute("href");
  await page.getByRole("button", { name: "Invert" }).click();
  await expect(page.getByLabel("Posted price")).toBeVisible();
  expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toBe(
    canonical,
  );
  await page.getByRole("tab", { name: "Ask · USDC", exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("0.0000001");
  await expect(
    page.getByRole("alert").filter({ hasText: "6 decimal places" }),
  ).toBeVisible();
});
test("canonical redirect, server metadata and OG without wallet or RPC", async ({
  request,
}) => {
  const response = await request.get(`/market/BASE/${b}:${a}`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe(`/market/base/${key}`);
  const page = await request.get(`/market/base/${key}`);
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain(`https://yld.cx/market/base/${key}/og`);
  const csp = page.headers()["content-security-policy"];
  expect(csp).toContain("nonce-");
  const scripts = csp.split("; ").find((d) => d.startsWith("script-src"))!;
  expect(scripts).not.toContain("unsafe-inline");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(scripts.includes("unsafe-eval")).toBe(
    process.env.PLAYWRIGHT_SERVER === "development",
  );
  const og = await request.get(`/market/base/${key}/og`);
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toContain("image/png");
  expect((await og.body()).length).toBeGreaterThan(10000);
  expect(og.headers()["cache-control"]).toContain("s-maxage=86400");
  const favicon = await request.get("/icon.svg");
  expect(favicon.status()).toBe(200);
  expect(await favicon.text()).toContain("👑");
  const generic = await request.get("/opengraph-image");
  expect(generic.status()).toBe(200);
  expect(generic.headers()["content-type"]).toContain("image/png");
});
test("Orders connection and invalid pair validation", async ({ page }) => {
  await page.goto("/orders");
  await expect(
    page.getByRole("heading", { name: "Connect to see your Orders" }),
  ).toBeVisible();
  await page.goto("/market/open");
  await page
    .getByRole("combobox", { name: "Token B selection", exact: true })
    .click();
  await page.getByRole("option", { name: "WETH", exact: true }).click();
  await expect(page.getByText("Select two different tokens")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Market" })).toHaveCount(
    0,
  );
});

test("exact off-grid Tick access preserves Supply price and duration", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await expect(page.getByRole("heading", { name: "Yield Book" })).toBeVisible();
  await page.getByText("More price levels", { exact: true }).click();
  await page.getByLabel("Exact Tick ID").fill(directId.toString());
  await page.getByRole("button", { name: "Select exact Tick · 7D" }).click();

  await expect(
    page.getByText(humanPrice(priceAtTick(-196123), 18, 6) + " USDC / WETH", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await expect(
    page.getByRole("button", { name: "Preview Provide" }),
  ).toBeVisible();
  await page.getByText("Price details", { exact: true }).click();
  await expect(
    page.getByText("Supply to the selected existing Tick.", { exact: false }),
  ).toBeVisible();
});

test("Base UI keyboard navigation, tab panels and dialog focus restoration", async ({
  page,
}, testInfo) => {
  await injectWallets(page);
  await page.goto(`/market/base/${key}`);
  await expect(page.getByRole("heading", { name: "Yield Book" })).toBeVisible();
  await page.getByRole("tab", { name: "Ask · WETH", exact: true }).focus();
  await page
    .getByRole("tab", { name: "Ask · WETH", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Bid · USDC", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("tab", { name: "Bid · USDC", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("tab", { name: "Bid · USDC", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("tabpanel", { name: "Bid · USDC", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Posted price")).toBeVisible();
  await page.getByRole("tab", { name: "Swap now", exact: true }).click();
  await expect(
    page.getByRole("tabpanel", { name: "Swap now", exact: true }),
  ).toBeVisible();
  const duration = page.getByRole("combobox", {
    name: "Term",
    exact: true,
  });
  await duration.press("Space");
  await page
    .getByRole("option", { name: "7D", exact: true })
    .press("ArrowDown");
  await page.getByRole("option", { name: "30D", exact: true }).press("Enter");
  await expect(duration).toContainText("30D");
  const wallet = page.getByRole("button", {
    name: "Connect wallet",
    exact: true,
  });
  await wallet.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(wallet).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as unknown as { testCspEvents: string[] }).testCspEvents,
    ),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("shadcn-market.png"),
    fullPage: true,
  });
});

test("prototype market overview and inversion preserve canonical economics", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  const overview = page.getByRole("region", { name: "Market overview" });
  await expect(
    overview.getByText("Provide or rent WETH or USDC at your price."),
  ).toBeVisible();
  await expect(overview.getByLabel("WETH crowned token")).toBeVisible();
  await expect(overview.getByText("1,000 WETH", { exact: true })).toBeVisible();
  await expect(overview.getByText("1,000 USDC", { exact: true })).toBeVisible();
  await expect(overview.getByText("0.07%", { exact: true })).toBeVisible();
  await page.getByLabel("Posted price").fill("3000");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.getByText("Price details", { exact: true }).click();
  await expect(page.getByText("-196000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Invert", exact: true }).click();
  await expect(overview.getByLabel("USDC crowned token")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Bid · WETH", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
  await expect(page.getByText("-196000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Invert", exact: true }).click();
  await expect(page.getByLabel("Posted price")).toHaveValue("3000");
  await page.getByRole("tab", { name: "Bid · USDC", exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await expect(page.getByText("196000", { exact: true })).toBeVisible();
  await page.getByText("More price levels", { exact: true }).click();
  await page.getByLabel("Exact Tick ID").fill(bid7.toString());
  await page.getByRole("button", { name: "Select exact Tick · 7D" }).click();
  await page.getByLabel("Amount", { exact: true }).fill("12.123456");
  await page.getByRole("tab", { name: "Swap now", exact: true }).click();
  await page.getByLabel("You receive").fill("20");
  await page.getByRole("button", { name: "Invert", exact: true }).click();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue(
    "12.123456",
  );
  await expect(page.getByLabel("You receive")).toHaveValue("20");
  await expect(
    page.getByRole("tab", { name: "Swap now", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Quote paid", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview Swap", exact: true }),
  ).toBeVisible();
});

test("returning to a selected price clears amounts only when the supplied token changes", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await page
    .locator(".yield-book button[aria-pressed]")
    .filter({ hasText: "WETH" })
    .first()
    .click();
  const amount = page.getByLabel("Amount", { exact: true });
  await amount.fill("2");
  await page
    .getByRole("button", { name: "Use selected price", exact: true })
    .click();
  await expect(amount).toHaveValue("2");
  await page.getByRole("tab", { name: "Bid · USDC", exact: true }).click();
  await amount.fill("100");
  await page
    .getByRole("button", { name: "Use selected price", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Ask · WETH", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(amount).toHaveValue("");
});

test("selected grid and exact Ticks refresh availability and Yield without losing entered amounts", async ({
  page,
}) => {
  const overrides: TickOverrides = new Map();
  await rpc(page, true, overrides);
  await page.clock.install();
  await page.goto(`/market/base/${key}`);
  await page
    .locator(".yield-book button[aria-pressed]")
    .filter({ hasText: "WETH" })
    .first()
    .click();
  const usePanel = page
    .getByRole("tabpanel")
    .filter({ has: page.getByLabel("You receive") });
  const supply = page.getByLabel("Provide liquidity", { exact: true });
  await page.getByLabel("Amount", { exact: true }).fill("3");
  await page.getByLabel("You receive").fill("1");
  await expect(usePanel.getByText("1,000 WETH", { exact: true })).toBeVisible();
  overrides.set(id7, {
    availableSupply: 500n * 10n ** 18n,
    activeWorking: 500n * 10n ** 18n,
  });
  await page.clock.fastForward(16000);
  await expect(usePanel.getByText("500 WETH", { exact: true })).toBeVisible();
  await expect(supply.getByText("0.9362% / 7D", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("You receive")).toHaveValue("1");

  await page.getByText("More price levels", { exact: true }).click();
  await page.getByLabel("Exact Tick ID").fill(directId.toString());
  await page.getByRole("button", { name: "Select exact Tick · 7D" }).click();
  await expect(usePanel.getByText("1,000 WETH", { exact: true })).toBeVisible();
  overrides.set(directId, {
    availableSupply: 250n * 10n ** 18n,
    activeWorking: 750n * 10n ** 18n,
  });
  await page.clock.fastForward(16000);
  await expect(usePanel.getByText("250 WETH", { exact: true })).toBeVisible();
  await expect(supply.getByText("2.9935% / 7D", { exact: true })).toBeVisible();
});

test("periodic discovery finds a newly funded level that was previously missing", async ({
  page,
}) => {
  const newId = tickIdFor(pairId, 0, -197000, 7);
  const overrides: TickOverrides = new Map([[newId, null]]);
  await rpc(page, true, overrides);
  await page.clock.install();
  await page.goto(`/market/base/${key}`);
  const rows = page
    .locator(".yield-book button[aria-pressed]")
    .filter({ hasText: "WETH" });
  await expect(rows).toHaveCount(1);
  overrides.set(newId, {
    priceX128: priceAtTick(-197000),
    availableSupply: 25n * 10n ** 18n,
  });
  await page.clock.fastForward(31000);
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "25 WETH" })).toBeVisible();
});

test("prototype branding, background and copy", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Liquidity, on your terms." }),
  ).toBeVisible();
  await expect(page.locator(".brand-wordmark")).toHaveAttribute(
    "viewBox",
    "0 0 800 275",
  );
  await expect(page.locator(".brand-wordmark path")).toHaveCount(20);
  await expect(
    page.getByText("Open. Permissionless. Immutable.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Telegram ↗" })).toHaveAttribute(
    "href",
    "https://t.me/yld_cx",
  );
  await expect(page.getByText("Protocol fee 1%", { exact: false })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Liquidity covers a bounded", { exact: false }),
  ).toHaveCount(0);
  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundImage,
  );
  expect(background.match(/linear-gradient/g)).toHaveLength(2);
  await page.screenshot({
    path: testInfo.outputPath("prototype-aligned-home.png"),
    fullPage: true,
  });
  await page.goto(`/market/base/${key}`);
  await expect(
    page
      .getByRole("region", { name: "Market overview" })
      .getByText("1,000 WETH", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("prototype-aligned-market.png"),
    fullPage: true,
  });
});

test("failed market reads remain incomplete rather than empty liquidity", async ({
  page,
}) => {
  await page.route(/https:\/\/mainnet\.base\.org\/?$/, async (route) => {
    const payload = route.request().postDataJSON();
    const items = Array.isArray(payload) ? payload : [payload];
    const hasTickRead = (data: Hex) => {
      try {
        const call = decodeFunctionData({ abi: protocolAbi, data });
        if (call.functionName === "getTick") return true;
      } catch {}
      try {
        const call = decodeFunctionData({ abi: multicall3Abi, data });
        return (
          call.functionName === "aggregate3" &&
          call.args[0].some((item) => {
            try {
              return (
                decodeFunctionData({ abi: protocolAbi, data: item.callData })
                  .functionName === "getTick"
              );
            } catch {
              return false;
            }
          })
        );
      } catch {
        return false;
      }
    };
    if (
      items.some(
        (item) =>
          item.method === "eth_call" && hasTickRead(item.params[0].data),
      )
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          Array.isArray(payload)
            ? items.map((item) => ({
                id: item.id,
                jsonrpc: "2.0",
                error: { code: -32000, message: "RPC unavailable" },
              }))
            : {
                id: payload.id,
                jsonrpc: "2.0",
                error: { code: -32000, message: "RPC unavailable" },
              },
        ),
      });
    } else await route.fallback();
  });
  await page.goto(`/market/base/${key}`);
  await expect(
    page.getByRole("alert").filter({ hasText: "Some reads failed" }),
  ).toBeVisible();
  const overview = page.getByRole("region", { name: "Market overview" });
  await expect(overview.getByText("Incomplete", { exact: true })).toHaveCount(
    4,
  );
  await expect(
    page.getByText("New · No liquidity", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("No liquidity yet", { exact: true })).toHaveCount(
    0,
  );
});

test("new markets retain the prototype overview and require Pair creation before Supply", async ({
  page,
}) => {
  await rpc(page, false);
  await page.goto(`/market/base/${key}`);
  const overview = page.getByRole("region", { name: "Market overview" });
  await expect(
    overview.getByText("An open market, ready for its first provider."),
  ).toBeVisible();
  await expect(overview.getByText("Not set", { exact: true })).toBeVisible();
  await expect(
    overview.getByText("New · No liquidity", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Provide liquidity" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No liquidity yet" }),
  ).toBeVisible();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.getByLabel("Posted price").fill("3000");
  await expect(
    page.getByRole("button", { name: "Preview Provide", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Create Tick", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create Market", exact: true }),
  ).toBeVisible();
});

test("standard shadcn controls retain semantic theme colors and keyboard behavior", async ({
  page,
}, testInfo) => {
  await page.goto(`/market/base/${key}`);
  const ask = page.getByRole("tab", { name: "Ask · WETH", exact: true });
  const bid = page.getByRole("tab", { name: "Bid · USDC", exact: true });
  const rent = page.getByRole("tab", { name: "Rent", exact: true });
  const swap = page.getByRole("tab", { name: "Swap now", exact: true });
  await expect(ask).toHaveCSS("color", "rgb(241, 162, 168)");
  await expect(rent).toHaveCSS("color", "rgb(211, 195, 255)");
  await bid.hover();
  await bid.click();
  await expect(bid).toHaveCSS("color", "rgb(159, 228, 190)");
  await swap.click();
  await expect(swap).toHaveCSS("color", "rgb(241, 244, 247)");
  const monthly = page
    .getByRole("group", { name: "Book term" })
    .getByRole("button", { name: "30D", exact: true });
  await monthly.click();
  await expect(monthly).toHaveAttribute("aria-pressed", "true");
  await expect(monthly).toHaveCSS("color", "rgb(231, 185, 77)");
  await bid.focus();
  await bid.press("ArrowLeft");
  await expect(ask).toBeFocused();
  await ask.press("Enter");
  await expect(ask).toHaveAttribute("aria-selected", "true");
  await expect(ask).toHaveCSS("color", "rgb(241, 162, 168)");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("simple-shadcn-market.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { testCspEvents: string[] }).testCspEvents,
    ),
  ).toEqual([]);
});

test("CSP permits UI positioning styles and blocks untrusted parser scripts", async ({
  page,
  context,
}) => {
  // An intercepted document has a synthetic address space in Chromium.
  // Permit its loopback HMR connection, just as the real localhost response does.
  await context.grantPermissions(["local-network-access"]);
  await page.route(`**/market/base/${key}`, async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const html = (await response.text()).replace(
      "</head>",
      "<script>window.untrustedScriptRan = true</script></head>",
    );
    await route.fulfill({ response, body: html });
  });
  await page.goto(`/market/base/${key}`);
  await expect(page.getByRole("heading", { name: "Yield Book" })).toBeVisible();
  await page.getByRole("combobox", { name: "Term", exact: true }).click();
  await page.getByRole("option", { name: "30D", exact: true }).click();
  await page.evaluate(() => {
    const element = document.createElement("div");
    element.id = "csp-style-check";
    element.setAttribute("style", "width: 123px");
    document.body.append(element);
  });
  await expect(page.locator("#csp-style-check")).toHaveCSS("width", "123px");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { untrustedScriptRan?: boolean })
          .untrustedScriptRan,
    ),
  ).toBeUndefined();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { testCspEvents: string[] }).testCspEvents,
      ),
    )
    .toContain("script-src-elem");
  const events = await page.evaluate(
    () => (window as unknown as { testCspEvents: string[] }).testCspEvents,
  );
  expect(events.every((directive) => directive === "script-src-elem")).toBe(
    true,
  );
});

test("development HMR connects under the development CSP", async ({ page }) => {
  test.skip(
    process.env.PLAYWRIGHT_SERVER !== "development",
    "HMR is only served by next dev",
  );
  const frames: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framereceived", (frame) => frames.push(String(frame.payload))),
  );
  const websocket = page.waitForEvent("websocket", {
    predicate: (socket) => socket.url().includes("/_next/hmr"),
  });
  await page.goto("/");
  const socket = await websocket;
  expect(socket.url()).toContain("ws://127.0.0.1:3000");
  await expect.poll(() => frames.length).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "Yield Markets" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { testCspEvents: string[] }).testCspEvents,
    ),
  ).toEqual([]);
});
