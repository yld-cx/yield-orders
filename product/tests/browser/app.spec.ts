import { PERMIT2, permit2Abi, swapNetwork } from "@yld-cx/sdk/uniswap";
import { readFileSync } from "node:fs";
import { test, expect, type Page, type Route } from "@playwright/test";
import yieldList from "../../public/yieldlist.json" with { type: "json" };
import { tokenFixture } from "./token-fixtures";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  encodeErrorResult,
  multicall3Abi,
  erc20Abi,
  keccak256,
  type Hex,
} from "viem";
import {
  protocolAbi,
  pairIdFor,
  tickIdFor,
  priceAtTick,
  deploymentFor,
} from "@yld-cx/sdk/ethereum";
import { Registry, pairKey } from "@yld-cx/sdk/registry";
import { DISCOVERY_DEFAULTS } from "@yld-cx/sdk";
import type { ProviderPosition, UsePosition, TickState } from "@yld-cx/sdk";
type TickOverrides = Map<bigint, Partial<TickState> | null>;
const metadataRoute = /(?:https:\/\/md\.yld\.cx|\/api\/md)\/tokens\?/;
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  key = `${a}:${b}`;
const configuredMarkets = new Registry(yieldList).getMarkets("eip155:8453");
const configuredPairs = configuredMarkets.map((market) => market.key);
const configuredAddresses = [
  ...new Set(configuredPairs.flatMap((pair) => pair.split(":"))),
];
function trendingFixtures(addresses: readonly string[]) {
  const registry = new Registry(yieldList);
  const seen = new Set([b]);
  return addresses.flatMap((value) => {
    const address = value.toLowerCase();
    if (seen.has(address)) return [];
    seen.add(address);
    const key = pairKey("eip155:8453", address, b);
    const [a0, a1] = key.split(":");
    return [
      registry.getMarket("eip155:8453", a0, a1) ?? {
        network: "eip155:8453",
        key,
        token0: { network: "eip155:8453", address: a0 },
        token1: { network: "eip155:8453", address: a1 },
        defaultDuration: 7,
        stepTicks: DISCOVERY_DEFAULTS.stepTicks,
      },
    ];
  });
}
async function fulfillTrending(
  route: Route,
  addresses: readonly string[],
  status = 200,
) {
  const params = new URL(route.request().url()).searchParams;
  if (params.get("tag") !== "trending") return route.fallback();
  return route.fulfill({
    status,
    json: {
      markets:
        params.get("chainId") === "8453" ? trendingFixtures(addresses) : [],
    },
  });
}
const directId = tickIdFor(pairIdFor(a, b), 0, -196123, 7);
const pairId = pairIdFor(a, b),
  id7 = tickIdFor(pairId, 0, -196000, 7),
  bid7 = tickIdFor(pairId, 1, 196000, 7);
function tokenContractCall(
  data: Hex,
  address = a,
): { success: boolean; returnData: Hex } | undefined {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    const token = tokenFixture(address);
    if (decoded.functionName === "decimals")
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: erc20Abi,
          functionName: "decimals",
          result: token.decimals,
        }),
      };
    if (decoded.functionName === "symbol" || decoded.functionName === "name")
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: erc20Abi,
          functionName: decoded.functionName,
          result: token[decoded.functionName],
        }),
      };
  } catch {}
}
function contractCall(
  data: Hex,
  pairExists = true,
  tickOverrides?: TickOverrides,
  address = a,
): { success: boolean; returnData: Hex } {
  const token = tokenContractCall(data, address);
  if (token) return token;
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
        !pairExists ||
        tickOverrides?.get(id) === null ||
        (![id7, bid7, directId].includes(id) && !tickOverrides?.has(id))
      )
        throw new Error("missing");
      const bid = id === bid7;
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: protocolAbi,
          functionName: "getTick",
          result: {
            asset: bid ? b : a,
            quote: bid ? a : b,
            durationDays: 7n,
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
            decoded.args[0] === bid7
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
        else if (item.method === "eth_getCode") result = "0x1234";
        else if (item.method === "eth_call") {
          const call = item.params[0] as { data: Hex; to: string };
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
                    contractCall(
                      c.callData,
                      pairExists,
                      tickOverrides,
                      c.target as typeof a,
                    ),
                  ),
                }),
              };
            }
          } catch {}
          value ??= contractCall(
            call.data,
            pairExists,
            tickOverrides,
            call.to as typeof a,
          );
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
async function showMarketSection(
  page: Page,
  section: "Provide" | "Yield Book" | "Use" | "Swap",
) {
  await expect(page.getByLabel("Yield Book", { exact: true })).toBeAttached();
  if (section === "Yield Book") return;
  if (section === "Swap") {
    await page.getByRole("button", { name: /Market · AMM/ }).click();
    return;
  }
  const tab = page.getByLabel("Yield Order", { exact: true }).getByRole("tab", {
    name: section === "Provide" ? "Limit" : "Rent",
    exact: true,
  });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

async function injectWallets(page: Page, transactions = false) {
  await page.addInitScript((transactions) => {
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
      const switchRequests: string[] = [];
      let switchError: number | undefined;
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
            switchRequests.push(params![0].chainId);
            if (switchError)
              throw Object.assign(new Error("Network switch failed"), {
                code: switchError,
              });
            chain = params![0].chainId;
            sessionStorage.setItem(rdns + ".chain", chain);
            events.get("chainChanged")?.forEach((fn) => fn(chain));
            return null;
          }
          if (transactions) {
            const response = await fetch("https://mainnet.base.org", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            });
            const value = await response.json();
            if (value.error)
              throw Object.assign(new Error(value.error.message), {
                code: value.error.code,
              });
            return value.result;
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
        switchRequests,
        failSwitch: (code: number) => {
          switchError = code;
        },
        account: (next: string) => {
          address = next;
          sessionStorage.setItem(rdns + ".address", next);
          events.get("accountsChanged")?.forEach((fn) => fn([next]));
        },
        chain: (next: string) => {
          chain = next;
          sessionStorage.setItem(rdns + ".chain", next);
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
  }, transactions);
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
  await page.route("**/api/market-price?**", (route) =>
    route.fulfill({
      json: {
        status: "available",
        source: "amm",
        price: "3000",
        baseTick: -196000,
        timestamp: Date.now(),
        ammAvailable: true,
      },
    }),
  );
  await page.route(metadataRoute, async (route) => {
    const url = new URL(route.request().url());
    const chainId = Number(url.searchParams.get("chainId"));
    await route.fulfill({
      json: {
        tokens: url.searchParams
          .get("addresses")!
          .split(",")
          .map((address) => ({
            chainId,
            address,
            status: "available",
            fetchedAt: Math.floor(Date.now() / 1000),
            symbol: tokenFixture(address).symbol,
            name: tokenFixture(address).name,
          })),
      },
    });
  });
  await page.route("**/api/tokens?**", (route) =>
    route.fulfill({
      json: {
        tokens:
          new URL(route.request().url()).searchParams.get("chainId") === "8453"
            ? configuredAddresses.map((address) => ({
                address,
                ...tokenFixture(address),
              }))
            : [],
      },
    }),
  );
  await page.route("**/api/markets?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("tag") === "trending")
      return fulfillTrending(route, configuredAddresses);
    const markets = new Registry(yieldList).getMarkets(
      `eip155:${Number(params.get("chainId"))}`,
    );
    await route.fulfill({ json: { markets } });
  });
  await page.addInitScript(() => {
    const events: string[] = [];
    Object.assign(window, { testCspEvents: events });
    document.addEventListener("securitypolicyviolation", (event) =>
      events.push(event.violatedDirective),
    );
  });
  await rpc(page);
});

for (const rememberedWallet of [false, true]) {
  test(`Safe auto-connects after a delayed handshake${rememberedWallet ? " over a remembered browser wallet" : " on first visit"}`, async ({
    page,
    baseURL,
    context,
  }) => {
    test.skip(
      process.env.PLAYWRIGHT_SERVER === "development",
      "The Safe HTTPS proxy requires the production build; next dev does not hydrate at the spoofed origin.",
    );
    test.setTimeout(60000);
    // Keep both frames on HTTPS. Serve the app from the local build while
    // preserving real origins for CSP and Safe's postMessage validation.
    const appOrigin = "https://yld.cx";
    await page.route(`${appOrigin}/**`, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({
        url: `${baseURL}${url.pathname}${url.search}`,
      });
      await route.fulfill({ response });
    });
    await injectWallets(page);
    if (rememberedWallet) {
      await page.goto(appOrigin);
      await expect(
        page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
      ).toBeVisible({ timeout: 15000 });
      await page
        .getByRole("button", { name: "Connect wallet", exact: true })
        .click();
      await page.getByRole("button", { name: "MetaMask", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "0x0000…0001" }),
      ).toBeVisible();
      // Model browsers that allow the previous wallet's cookies in the iframe.
      await context.addCookies(
        (await context.cookies(appOrigin)).map((cookie) => ({
          ...cookie,
          sameSite: "None" as const,
          secure: true,
        })),
      );
    }
    await page.route("https://app.safe.global/safe-app-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>
          <script>
            window.addEventListener('message', (event) => {
              if (event.origin !== ${JSON.stringify(appOrigin)}) return;
              if (event.data.method !== 'getSafeInfo') return;
              setTimeout(() => event.source.postMessage({
                id: event.data.id,
                success: true,
                version: '1.0.0',
                data: {
                  safeAddress: '0x000000000000000000000000000000000000005a',
                  chainId: 8453,
                  threshold: 2,
                  owners: [],
                  isReadOnly: false
                }
              }, event.origin), ${rememberedWallet ? 500 : 100});
            });
          </script>
          <iframe title="Safe App" src="${appOrigin}/" style="width:100%;height:100vh"></iframe>
        </body></html>`,
      }),
    );
    await page.goto("https://app.safe.global/safe-app-test");
    const app = page.frameLocator('iframe[title="Safe App"]');
    await expect(
      app.getByRole("link", { name: "Open WETH / USDC", exact: true }),
    ).toBeVisible({ timeout: 15000 });
    if (rememberedWallet)
      await expect(
        app.getByRole("button", { name: "0x0000…0001" }),
      ).toBeVisible();
    const wallet = app.getByRole("button", { name: "0x0000…005a" });
    await expect(wallet).toBeVisible();
    await wallet.click();
    const dialog = app.getByRole("dialog");
    await expect(dialog.getByText("Safe", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Network: Base")).toBeVisible();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
}

test("header uses a mobile navigation sheet and keeps full network names", async ({
  page,
  isMobile,
}) => {
  await page.goto("/?network=ethereum");
  const header = page.getByRole("banner");
  const menu = header.getByRole("button", { name: "Open navigation menu" });
  const network = header.getByRole("combobox", {
    name: "Network",
    exact: true,
  });
  await expect(network).toContainText("Ethereum");

  if (!isMobile) {
    await expect(menu).toBeHidden();
    await expect(
      header.getByRole("link", { name: "Yield", exact: true }),
    ).toBeVisible();
    await expect(
      header.getByRole("link", { name: "Orders", exact: true }),
    ).toBeVisible();
    return;
  }

  await expect(
    header.getByRole("link", { name: "Yield", exact: true }),
  ).toBeHidden();
  await expect(
    header.getByRole("link", { name: "Orders", exact: true }),
  ).toBeHidden();
  await menu.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByRole("link", { name: "Yield", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sheet.getByRole("link", { name: "Orders", exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(sheet).toBeHidden();
  await menu.click();
  await expect(
    sheet.getByRole("link", { name: "Orders", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(menu).toBeFocused();
  await menu.click();
  await sheet.getByRole("link", { name: "Yield", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(sheet).toBeHidden();
  await expect(network).toContainText("Ethereum");
});

test("wallet options hide unavailable browser and Safe providers", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Coinbase Wallet", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /^(Injected|Browser wallet|Safe)$/ }),
  ).toHaveCount(0);
  for (const wallet of ["Phantom", "MetaMask"])
    await expect(
      dialog.getByRole("button", { name: `Open in ${wallet}`, exact: true }),
    ).toHaveCount(isMobile ? 1 : 0);
});

for (const wallet of ["Phantom", "MetaMask"] as const) {
  test(`mobile ${wallet} link opens the yld.cx home page`, async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "Deep links are available only on mobile");
    await page.goto("/orders?ref=a%26b&search=WETH%20%2F%20USDC#positions");
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .first()
      .click();
    const option = page
      .getByRole("dialog")
      .getByRole("button", { name: `Open in ${wallet}`, exact: true });
    await expect(option).toBeVisible();
    const expected =
      wallet === "Phantom"
        ? "https://phantom.com/ul/browse/https%3A%2F%2Fyld.cx?ref=https%3A%2F%2Fyld.cx"
        : "https://link.metamask.io/dapp/yld.cx";
    // Intercept the destination so the test never opens a real wallet or remote site.
    await page.route(
      wallet === "Phantom"
        ? "https://phantom.com/ul/browse/**"
        : "https://link.metamask.io/dapp/**",
      (route) =>
        route.fulfill({ contentType: "text/html", body: "Wallet browser" }),
    );
    await Promise.all([page.waitForURL(expected), option.click()]);
    expect(page.url()).toBe(expected);
  });

  test(`mobile wallet links hide only the injected ${wallet} option and reuse EVM connection`, async ({
    page,
    isMobile,
  }) => {
    await page.goto("/orders?ref=a%26b&search=WETH%20%2F%20USDC");
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: `Open in ${wallet}`, exact: true }),
    ).toHaveCount(isMobile ? 1 : 0);
    await page.evaluate((wallet) => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              uuid: "00000000-0000-4000-8000-000000000004",
              name: wallet,
              rdns: wallet === "Phantom" ? "app.phantom" : "io.metamask",
              icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
            },
            provider: {
              request: async ({ method }: { method: string }) => {
                if (
                  method === "eth_requestAccounts" ||
                  method === "eth_accounts"
                )
                  return ["0x0000000000000000000000000000000000000001"];
                if (method === "eth_chainId") return "0x2105";
                throw new Error(`Unsupported test method ${method}`);
              },
              on: () => {},
              removeListener: () => {},
            },
          },
        }),
      );
    }, wallet);
    await expect(
      dialog.getByRole("button", { name: `Open in ${wallet}`, exact: true }),
    ).toHaveCount(0);
    const other = wallet === "Phantom" ? "MetaMask" : "Phantom";
    await expect(
      dialog.getByRole("button", { name: `Open in ${other}`, exact: true }),
    ).toHaveCount(isMobile ? 1 : 0);
    await dialog.getByRole("button", { name: wallet, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "0x0000…0001" }).first(),
    ).toBeVisible();
  });
}

for (const profile of [
  {
    name: "Android",
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    maxTouchPoints: 5,
  },
  {
    name: "iPad with desktop user agent",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 5,
  },
  {
    name: "desktop with narrow viewport",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
    platform: "MacIntel",
    maxTouchPoints: 0,
  },
]) {
  test(`wallet deep link visibility on ${profile.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript((profile) => {
      for (const key of ["userAgent", "platform", "maxTouchPoints"] as const)
        Object.defineProperty(navigator, key, { get: () => profile[key] });
    }, profile);
    await page.goto("/");
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: /^Open in (Phantom|MetaMask)$/ }),
    ).toHaveCount(profile.maxTouchPoints ? 2 : 0);
  });
}

test("wallet options name a late discovered wallet without requesting access", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /^(Injected|Browser wallet|Rabby)$/ }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const requests: string[] = [];
    const provider = {
      // Compatibility flags must not override the wallet's announced name.
      isMetaMask: true,
      request: async ({ method }: { method: string }) => {
        requests.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts")
          return ["0x0000000000000000000000000000000000000001"];
        if (method === "eth_chainId") return "0x2105";
        throw new Error(`Unsupported test method ${method}`);
      },
      on: () => {},
      removeListener: () => {},
    };
    Object.assign(window, { testWalletRequests: requests, ethereum: provider });
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: {
            uuid: "00000000-0000-4000-8000-000000000003",
            name: "Rabby",
            rdns: "io.rabby",
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          },
          provider,
        },
      }),
    );
  });
  const rabby = dialog.getByRole("button", {
    name: "Rabby",
    exact: true,
  });
  await expect(rabby).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /^(Injected|Browser wallet|MetaMask)$/,
    }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testWalletRequests: string[] })
          .testWalletRequests,
    ),
  ).toEqual([]);
  await rabby.click();
  const connected = page.getByRole("button", { name: "0x0000…0001" });
  await expect(connected).toBeVisible();
  await connected.click();
  await expect(
    page
      .getByRole("dialog")
      .locator("p")
      .filter({ hasText: /^Rabby$/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Your wallet", exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(
    "Manage your connected wallet.",
  );
  await expect(
    dialog.getByRole("button", { name: /^(Rabby|Coinbase Wallet)$/ }),
  ).toHaveCount(0);
  const address = dialog.locator("code");
  const fullAddress = address.getByText(
    "0x0000000000000000000000000000000000000001",
    { exact: true },
  );
  const shortAddress = address.getByText("0x0000…0001", { exact: true });
  if (isMobile) {
    await expect(shortAddress).toBeVisible();
    await expect(fullAddress).toBeHidden();
  } else {
    await expect(fullAddress).toBeVisible();
    await expect(shortAddress).toBeHidden();
  }
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  const connectWallet = page.getByRole("button", {
    name: "Connect wallet",
    exact: true,
  });
  await expect(connectWallet).toBeVisible();
  await connectWallet.click();
  await expect(dialog).toHaveAccessibleDescription(
    "Choose your wallet to connect.",
  );
  await expect(rabby).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Disconnect" })).toHaveCount(
    0,
  );
});

test("connected wallet shows header status and copies the full address", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await injectWallets(page);
  await page.goto("/");
  const header = page.getByRole("banner");
  const connectedStatus = header.getByRole("status", {
    name: "Wallet connected",
  });
  await expect(connectedStatus).toHaveCount(0);
  await header
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  await expect(connectedStatus).toBeVisible();
  const wallet = header.getByRole("button", { name: "0x0000…0001" });
  await expect(wallet).toHaveAttribute(
    "title",
    "Wallet connected: 0x0000000000000000000000000000000000000001",
  );
  await wallet.click();
  const dialog = page.getByRole("dialog");
  const copy = dialog.getByRole("button", {
    name: "Copy address",
    exact: true,
  });
  await expect(copy).toBeVisible();
  const copyIcon = copy.locator("svg.lucide-copy");
  const checkIcon = copy.locator("svg.lucide-check");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await copy.click();
  await expect(checkIcon).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "0x0000000000000000000000000000000000000001",
  );
  await page.evaluate(() => {
    (
      window as unknown as {
        testWallet: { account: (address: string) => void };
      }
    ).testWallet.account("0x0000000000000000000000000000000000000003");
  });
  await expect(copyIcon).toBeVisible();
  await copy.click();
  await expect(checkIcon).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "0x0000000000000000000000000000000000000003",
  );
  await page.clock.fastForward(1000);
  await copy.click();
  await expect(checkIcon).toBeVisible();
  await page.clock.fastForward(1999);
  await expect(checkIcon).toBeVisible();
  await page.clock.fastForward(1);
  await expect(copyIcon).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        throw new Error("Clipboard access denied");
      },
    });
  });
  await copy.click();
  await expect(copyIcon).toBeVisible();
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(connectedStatus).toHaveCount(0);
  await expect(
    header.getByRole("button", { name: "Connect wallet", exact: true }),
  ).toBeVisible();
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
    page.getByRole("button", { name: /^(Injected|Browser wallet|Safe)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Open in (Phantom|MetaMask)$/ }),
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
  await page
    .getByLabel("Yield Book", { exact: true })
    .getByRole("tab", { name: "Sell", exact: true })
    .click();
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await showMarketSection(page, "Provide");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await expect(
    page
      .getByLabel("Limit order", { exact: true })
      .getByRole("button", { name: "Switch network" }),
  ).toBeVisible();
  await page
    .getByLabel("Limit order", { exact: true })
    .getByRole("button", { name: "Switch network" })
    .click();
  await expect(
    page.getByRole("button", { name: "Switch network" }),
  ).toHaveCount(0);
});
test("network selector switches the connected wallet and preserves market filters", async ({
  page,
}) => {
  await injectWallets(page);
  await page.goto("/?network=ethereum&search=WETH&ref=test#markets");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  const wallet = page.getByRole("button", { name: "0x0000…0001" });
  await expect(wallet).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testWallet: { switchRequests: string[] } })
          .testWallet.switchRequests,
    ),
  ).toEqual([]);
  const network = page.getByRole("combobox", { name: "Network", exact: true });
  await network.click();
  await page.getByRole("option", { name: "Base", exact: true }).click();
  await expect(network).toContainText("Base");
  await expect(network).toBeEnabled();
  await expect(page).toHaveURL(/network=base/);
  const selectedUrl = new URL(page.url());
  expect(selectedUrl.searchParams.get("ref")).toBe("test");
  expect(selectedUrl.hash).toBe("#markets");
  await expect(page.getByLabel("Search markets")).toHaveValue("WETH");
  await expect(
    page.getByRole("combobox", { name: "Market duration" }),
  ).toHaveCount(0);
  await wallet.click();
  await expect(page.getByRole("dialog")).toContainText(/network: Base/i);
  await page.getByRole("dialog").press("Escape");
  await page
    .getByRole("link", { name: "Open WETH / USDC", exact: true })
    .click();
  await expect(page).toHaveURL(`/market/base/${key}`);
  await network.click();
  await page.getByRole("option", { name: "Robinhood", exact: true }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === "/" && url.searchParams.get("network") === "robinhood",
  );
  await expect(network).toBeEnabled();
  await wallet.click();
  await expect(page.getByRole("dialog")).toContainText(/network: Robinhood/i);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { testWallet: { switchRequests: string[] } })
          .testWallet.switchRequests,
    ),
  ).toEqual(["0x2105", "0x1237"]);
});

for (const [reason, code] of [
  ["rejected", 4001],
  ["unsupported", -32601],
] as const) {
  test(`network selector keeps browsing available when wallet switching is ${reason}`, async ({
    page,
  }) => {
    await injectWallets(page);
    await page.goto("/?network=ethereum");
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();
    await page.getByRole("button", { name: "MetaMask", exact: true }).click();
    const wallet = page.getByRole("button", { name: "0x0000…0001" });
    await expect(wallet).toBeVisible();
    await page.evaluate((errorCode) => {
      (
        window as unknown as {
          testWallet: { failSwitch: (code: number) => void };
        }
      ).testWallet.failSwitch(errorCode);
    }, code);
    const network = page.getByRole("combobox", {
      name: "Network",
      exact: true,
    });
    await network.click();
    await page.getByRole("option", { name: "Base", exact: true }).click();
    await expect(network).toContainText("Base");
    await expect(network).toBeEnabled();
    await expect(page).toHaveURL(/network=base/);
    const feedback = page.getByRole("banner").getByRole("alert");
    await expect(feedback).toHaveCount(0);
    await wallet.click();
    await expect(page.getByRole("dialog")).toContainText(/network: Ethereum/i);
    await page.getByRole("dialog").press("Escape");
    await network.click();
    await page.getByRole("option", { name: "Ethereum", exact: true }).click();
    await expect(network).toContainText("Ethereum");
    await expect(feedback).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { testWallet: { switchRequests: string[] } })
            .testWallet.switchRequests,
      ),
    ).toEqual(["0x2105"]);
  });
}

test("Orders connection and invalid pair validation", async ({ page }) => {
  await page.goto("/orders");
  await expect(
    page
      .getByRole("main")
      .getByText("Connect to see your Orders", { exact: true }),
  ).toBeVisible();
  await page.goto("/market/open");
  await page.getByRole("combobox", { name: "Token A selection" }).click();
  await page.getByRole("option", { name: "WETH", exact: true }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Token B selection", exact: true })
    .click();
  await page.getByRole("option", { name: "WETH", exact: true }).click();
  await expect(page.getByText("Select two different tokens")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview Create Market" }),
  ).toHaveCount(0);
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

// Runtime fixture includes the deployed FEE_TO immutable. Verification stays enabled.
const protocolRuntime = readFileSync(
  new URL("../fixtures/protocol-runtime.hex", import.meta.url),
  "utf8",
).trim() as Hex;
async function openProvidePreview(page: Page, selectedId = id7) {
  await showMarketSection(page, "Yield Book");
  await page
    .getByLabel("Yield Book", { exact: true })
    .getByRole("tab", {
      name: selectedId === bid7 ? "Buy" : "Sell",
      exact: true,
    })
    .click();
  await page.locator(`[data-tick-id="${selectedId}"]`).click();
  await showMarketSection(page, "Provide");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.getByRole("button", { name: /^(Buy|Sell) and Earn$/ }).click();
}
async function transactionRpc(
  page: Page,
  options: {
    pair: boolean;
    tick: boolean;
    direction?: 0 | 1;
    allowance?: bigint;
    permitAllowance?: () => readonly [bigint, number, number];
    reject?: boolean;
    fail?: boolean;
    positions?: {
      provider?: Partial<ProviderPosition>;
      use?: Partial<UsePosition>;
      tickIds?: bigint[];
    };
    balance?: bigint;
    atomic?:
      | "supported"
      | "unsupported"
      | "missing"
      | "safe"
      | "ready"
      | "other-chain-only";
    zeroFirst?: boolean;
    simulationUnsupported?: boolean;
    sendUnsupported?: boolean;
  },
) {
  expect(keccak256(protocolRuntime)).toBe(
    deploymentFor("eip155:8453").runtimeCodeHash,
  );
  const state = {
    pair: options.pair,
    allowance: options.allowance ?? 10n ** 30n,
    reject: !!options.reject,
    fail: !!options.fail,
    writes: [] as string[][],
    withdrawals: [] as (readonly bigint[])[],
    swaps: [] as (readonly [bigint, bigint, bigint])[],
    simulations: [] as string[],
    timestamp: 0x68e00000n,
    settlement: false,
    blockNumber: 10000001n,
    batchPending: false,
    batchReverted: false,
    pendingAllowance: undefined as bigint | undefined,
    batches: [] as {
      atomicRequired?: boolean;
      calls: { to: string; data: Hex }[];
    }[],
  };
  const selectedId = options.direction === 1 ? bid7 : id7;
  const overrides: TickOverrides = new Map([
    [
      selectedId,
      options.tick
        ? options.positions
          ? { workingSupply: 60n * 10n ** 18n, activeWorking: 60n * 10n ** 18n }
          : {}
        : null,
    ],
  ]);
  const txHash = `0x${"12".repeat(32)}`;
  const providerAbi = protocolAbi.find(
    (entry) => entry.type === "function" && entry.name === "getEarnPosition",
  )!;
  const provider = Object.assign(
    Object.fromEntries(
      providerAbi.outputs[0].components.map((c) => [c.name, 0n]),
    ) as ProviderPosition,
    {
      activePrincipal: 100n * 10n ** 18n,
      activeAvailable: 40n * 10n ** 18n,
      activeWorking: 60n * 10n ** 18n,
    },
    options.positions?.provider,
  );
  provider.activePrincipalX36 =
    options.positions?.provider?.activePrincipalX36 ??
    provider.activePrincipal * 10n ** 36n;
  const use: UsePosition = {
    tickId: selectedId,
    tickSeq: 0n,
    user: "0x0000000000000000000000000000000000000001",
    assetAmount: 100n * 10n ** 18n,
    quotePrincipal: 200n * 10n ** 6n,
    fullTermYieldAsset: 10n * 10n ** 18n,
    closeFee: 2n * 10n ** 6n,
    openedAt: state.timestamp - 50n,
    maturity: state.timestamp + 50n,
    status: 1,
    ...options.positions?.use,
  };
  function tupleResult(
    name: "withdraw" | "collect" | "repay" | "close" | "swap",
    values: Record<string, bigint>,
  ) {
    const abi = protocolAbi.find(
      (f): f is Extract<(typeof protocolAbi)[number], { name: typeof name }> =>
        f.type === "function" && f.name === name,
    )!;
    return encodeFunctionResult({
      abi: protocolAbi,
      functionName: name,
      result: Object.fromEntries(
        abi.outputs[0].components.map((c) => [c.name, values[c.name] ?? 0n]),
      ) as never,
    });
  }
  function call(
    data: Hex,
    pair = state.pair,
    ticks = overrides,
  ): { success: boolean; returnData: Hex } {
    if (data.startsWith("0x927da105"))
      return {
        success: true,
        returnData: encodeFunctionResult({
          abi: permit2Abi,
          functionName: "allowance",
          result: options.permitAllowance?.() ?? [
            10n ** 30n,
            Math.floor(Date.now() / 1000) + 86400,
            0,
          ],
        }),
      };
    try {
      const token = decodeFunctionData({ abi: erc20Abi, data });
      if (
        token.functionName === "balanceOf" ||
        token.functionName === "allowance"
      ) {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: token.functionName,
            result:
              token.functionName === "allowance"
                ? state.allowance
                : (options.balance ?? 10n ** 30n),
          }),
        };
      }
      if (
        token.functionName === "approve" &&
        options.zeroFirst &&
        state.allowance > 0n &&
        token.args[1] > 0n
      )
        return {
          success: false,
          returnData: encodeErrorResult({
            abi: [
              {
                type: "error",
                name: "Error",
                inputs: [{ name: "message", type: "string" }],
              },
            ],
            errorName: "Error",
            args: ["Reset allowance first"],
          }),
        };
      if (token.functionName === "approve")
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20Abi,
            functionName: "approve",
            result: true,
          }),
        };
    } catch {}
    try {
      const decoded = decodeFunctionData({ abi: protocolAbi, data });
      if (decoded.functionName === "nextPositionId")
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: protocolAbi,
            functionName: "nextPositionId",
            result: 1n,
          }),
        };
      if (decoded.functionName === "getPosition")
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: protocolAbi,
            functionName: "getPosition",
            result: use,
          }),
        };
      if (options.positions) {
        if (
          decoded.functionName === "getEarnPositions" ||
          decoded.functionName === "getUsePositions"
        )
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: protocolAbi,
              functionName: decoded.functionName,
              result:
                decoded.functionName === "getEarnPositions"
                  ? (options.positions.tickIds ?? [selectedId])
                  : options.positions.use
                    ? [1n]
                    : [],
            }),
          };
        if (decoded.functionName === "getEarnPosition")
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: protocolAbi,
              functionName: "getEarnPosition",
              result: provider,
            }),
          };
      }
      if (decoded.functionName === "multicall") {
        let virtualPair = pair;
        const virtualTicks = new Map(ticks),
          results: Hex[] = [];
        for (const sub of decoded.args[0]) {
          const action = decodeFunctionData({ abi: protocolAbi, data: sub });
          if (action.functionName === "createPair") {
            virtualPair = true;
            results.push(
              encodeFunctionResult({
                abi: protocolAbi,
                functionName: "createPair",
                result: pairId,
              }),
            );
          } else if (action.functionName === "createTick") {
            const [pid, direction, priceTick, days] = action.args;
            const id = tickIdFor(pid, direction as 0 | 1, priceTick, days);
            virtualTicks.set(id, {
              asset: direction === 0 ? a : b,
              quote: direction === 0 ? b : a,
              durationDays: days,
              priceX128: priceAtTick(priceTick),
              availableSupply: 10n ** 18n,
            });
            results.push(
              encodeFunctionResult({
                abi: protocolAbi,
                functionName: "createTick",
                result: id,
              }),
            );
          } else if (options.positions && action.functionName === "withdraw") {
            state.simulations.push("withdraw");
            const amount = action.args[1],
              available = (amount * 4n) / 10n;
            results.push(
              tupleResult("withdraw", {
                providerPrincipal: provider.activePrincipal,
                principalAmount: amount,
                availableAssetOut: available,
                workingToExit: amount - available,
                remainingActivePrincipal: provider.activePrincipal - amount,
                resolvingPrincipal: amount - available,
              }),
            );
          } else if (options.positions && action.functionName === "collect") {
            state.simulations.push("collect");
            if (state.settlement)
              virtualTicks.set(selectedId, {
                ...virtualTicks.get(selectedId),
                settleCursor: 1n,
              });
            results.push(
              tupleResult("collect", {
                totalAssetOut:
                  provider.claimableExitAsset +
                  provider.claimableActiveYieldAsset +
                  provider.claimableExitYieldAsset,
                totalQuoteOut:
                  provider.claimableActiveQuote + provider.claimableExitQuote,
                resolvingPrincipal: provider.resolvingPrincipal,
              }),
            );
          } else if (options.positions && action.functionName === "repay") {
            state.simulations.push("repay");
            const term = use.maturity - use.openedAt,
              elapsed =
                state.timestamp > use.openedAt
                  ? state.timestamp - use.openedAt
                  : 1n;
            const accrued =
              (use.fullTermYieldAsset * elapsed + term - 1n) / term;
            results.push(
              tupleResult("repay", {
                positionId: 1n,
                tickId: selectedId,
                assetPrincipal: use.assetAmount,
                grossYieldAsset: accrued,
                totalAssetIn: use.assetAmount + accrued,
                quotePrincipalUnlocked: use.quotePrincipal,
              }),
            );
          } else if (options.positions && action.functionName === "close") {
            state.simulations.push("close");
            results.push(
              tupleResult("close", {
                positionId: 1n,
                tickId: selectedId,
                closeFee: use.closeFee,
                providerSwapProceeds: use.quotePrincipal - use.closeFee,
              }),
            );
          } else if (action.functionName === "swap") {
            const [tickId, assetAmount] = action.args;
            const quotePrincipal =
              tickId === bid7
                ? (assetAmount * 10n ** 12n) / 3000n
                : (assetAmount * 3000n) / 10n ** 12n;
            const swapFee = quotePrincipal / 100n;
            results.push(
              tupleResult("swap", {
                assetAmount,
                quotePrincipal,
                swapFee,
                providerSwapProceeds: quotePrincipal - swapFee,
              }),
            );
          } else if (action.functionName === "supply") results.push("0x");
          else if (action.functionName === "use")
            results.push(
              encodeFunctionResult({
                abi: protocolAbi,
                functionName: "use",
                result: 1n,
              }),
            );
          else if (action.functionName === "getEarnPosition")
            results.push(
              encodeFunctionResult({
                abi: protocolAbi,
                functionName: "getEarnPosition",
                result: options.positions
                  ? provider
                  : (Object.fromEntries(
                      providerAbi.outputs[0].components.map((c) => [
                        c.name,
                        c.name === "activePrincipal" ? 10n ** 18n : 0n,
                      ]),
                    ) as never),
              }),
            );
          else {
            const result = call(sub, virtualPair, virtualTicks);
            if (!result.success) return result;
            results.push(result.returnData);
          }
        }
        return state.fail
          ? {
              success: false,
              returnData: encodeErrorResult({
                abi: protocolAbi,
                errorName: "Slippage",
              }),
            }
          : {
              success: true,
              returnData: encodeFunctionResult({
                abi: protocolAbi,
                functionName: "multicall",
                result: results,
              }),
            };
      }
    } catch {}
    return contractCall(data, pair, ticks);
  }
  await page.route("https://mainnet.base.org", async (route) => {
    const respond = (item: {
      id: number;
      method: string;
      params: unknown[];
    }) => {
      let result: unknown;
      const error = (message: string, code = 4001, data?: Hex) => ({
        id: item.id,
        jsonrpc: "2.0",
        error: { code, message, data },
      });
      if (item.method === "wallet_getCapabilities") {
        if (!options.atomic || options.atomic === "missing")
          return error("Method not found", -32601);
        result =
          options.atomic === "other-chain-only"
            ? {
                "0x1": { atomic: { status: "supported" } },
              }
            : {
                "0x2105":
                  options.atomic === "safe"
                    ? { atomicBatch: { supported: true } }
                    : { atomic: { status: options.atomic } },
              };
      } else if (item.method === "wallet_sendCalls") {
        if (options.sendUnsupported)
          return error("Atomicity not supported", 5760);
        if (state.reject) {
          state.reject = false;
          return error("User rejected batch");
        }
        const batch = item.params[0] as {
          atomicRequired?: boolean;
          calls: { to: string; data: Hex }[];
        };
        state.batches.push(batch);
        state.writes.push(
          batch.calls.flatMap((c) => {
            try {
              const approval = decodeFunctionData({
                abi: erc20Abi,
                data: c.data,
              });
              if (approval.functionName !== "approve") throw new Error();
              return ["approve"];
            } catch {
              const decoded = decodeFunctionData({
                abi: protocolAbi,
                data: c.data,
              });
              return decoded.functionName === "multicall"
                ? decoded.args[0].map(
                    (data) =>
                      decodeFunctionData({ abi: protocolAbi, data })
                        .functionName,
                  )
                : [];
            }
          }),
        );
        result = { id: "wallet-batch-1" };
      } else if (item.method === "wallet_getCallsStatus")
        result = {
          version: options.atomic === "safe" ? "1.0" : "2.0.0",
          id: "wallet-batch-1",
          chainId: "0x2105",
          ...(options.atomic === "safe" ? {} : { atomic: true }),
          status: state.batchPending ? 100 : state.batchReverted ? 500 : 200,
          receipts: state.batchPending
            ? []
            : [
                {
                  transactionHash: txHash,
                  blockNumber: "0x989680",
                  blockHash: `0x${"34".repeat(32)}`,
                  status: state.batchReverted ? "0x0" : "0x1",
                  gasUsed: "0x493e0",
                  logs: [],
                },
              ],
        };
      else if (item.method === "eth_simulateV1") {
        if (options.simulationUnsupported)
          return error("Method not found", -32601);
        const params = item.params[0] as {
          blockStateCalls: { calls: { data?: Hex }[] }[];
        };
        const actualAllowance = state.allowance;
        result = params.blockStateCalls.map((block) => ({
          number: "0x989680",
          timestamp: `0x${state.timestamp.toString(16)}`,
          hash: `0x${"34".repeat(32)}`,
          transactions: [],
          calls: block.calls.map((c) => {
            const value = c.data
              ? call(c.data)
              : { success: true, returnData: "0x" };
            if (c.data && value.success) {
              try {
                const token = decodeFunctionData({
                  abi: erc20Abi,
                  data: c.data,
                });
                if (token.functionName === "approve")
                  state.allowance = token.args[1];
              } catch {}
            }
            return {
              status: value.success ? "0x1" : "0x0",
              returnData: value.returnData,
              gasUsed: "0x493e0",
              logs: [],
            };
          }),
        }));
        state.allowance = actualAllowance;
      } else if (item.method === "eth_getCode") result = protocolRuntime;
      else if (item.method === "eth_chainId") result = "0x2105";
      else if (item.method === "eth_blockNumber") {
        if (
          state.blockNumber > 10000000n &&
          state.pendingAllowance !== undefined
        ) {
          state.allowance = state.pendingAllowance;
          state.pendingAllowance = undefined;
        }
        result = `0x${state.blockNumber.toString(16)}`;
      } else if (item.method === "eth_getBlockByNumber")
        result = {
          number: "0x989680",
          timestamp: `0x${state.timestamp.toString(16)}`,
          hash: `0x${"34".repeat(32)}`,
          transactions: [],
          baseFeePerGas: "0x1",
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          size: "0x1",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          extraData: "0x",
        };
      else if (item.method === "eth_call") {
        const { data, to } = item.params[0] as { data: Hex; to: string };
        let response = tokenContractCall(data, to as typeof a);
        try {
          const decoded = decodeFunctionData({ abi: multicall3Abi, data });
          if (decoded.functionName === "aggregate3")
            response = {
              success: true,
              returnData: encodeFunctionResult({
                abi: multicall3Abi,
                functionName: "aggregate3",
                result: decoded.args[0].map(
                  (c) =>
                    tokenContractCall(c.callData, c.target as typeof a) ??
                    call(c.callData),
                ),
              }),
            };
        } catch {}
        response ??= call(data);
        if (!response.success)
          return error("execution reverted", 3, response.returnData);
        result = response.returnData;
      } else if (item.method === "eth_estimateGas") result = "0x493e0";
      else if (item.method === "eth_sendTransaction") {
        const data = (item.params[0] as { data: Hex }).data;
        const approval = (() => {
          try {
            return decodeFunctionData({ abi: erc20Abi, data });
          } catch {
            return undefined;
          }
        })();
        if (approval?.functionName === "approve") {
          if (state.reject) {
            state.reject = false;
            return error("User rejected approval");
          }
          state.pendingAllowance = approval.args[1];
          state.writes.push(["approve"]);
        } else {
          const decoded = decodeFunctionData({ abi: protocolAbi, data });
          if (decoded.functionName !== "multicall")
            throw new Error("Expected atomic batch");
          for (const data of decoded.args[0]) {
            const action = decodeFunctionData({ abi: protocolAbi, data });
            if (action.functionName === "withdraw")
              state.withdrawals.push(action.args);
            if (action.functionName === "swap")
              state.swaps.push([
                action.args[0],
                action.args[1],
                action.args[2],
              ]);
          }
          state.writes.push(
            decoded.args[0].map(
              (data) =>
                decodeFunctionData({ abi: protocolAbi, data }).functionName,
            ),
          );
        }
        result = txHash;
      } else if (item.method === "eth_getTransactionByHash")
        result = {
          hash: txHash,
          blockNumber: "0x989680",
          blockHash: `0x${"34".repeat(32)}`,
          transactionIndex: "0x0",
          from: "0x0000000000000000000000000000000000000001",
          to: deploymentFor("eip155:8453").address,
          nonce: "0x0",
          input: "0x",
          value: "0x0",
          gas: "0x493e0",
          gasPrice: "0x1",
          type: "0x0",
        };
      else if (item.method === "eth_getTransactionReceipt")
        result = {
          transactionHash: txHash,
          blockNumber: "0x989680",
          blockHash: `0x${"34".repeat(32)}`,
          transactionIndex: "0x0",
          from: "0x0000000000000000000000000000000000000001",
          to: deploymentFor("eip155:8453").address,
          status: "0x1",
          gasUsed: "0x493e0",
          cumulativeGasUsed: "0x493e0",
          effectiveGasPrice: "0x1",
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          type: "0x2",
        };
      else return error(`Unsupported test RPC ${item.method}`, -32601);
      return { id: item.id, jsonrpc: "2.0", result };
    };
    const body = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(body) ? body.map(respond) : respond(body),
      ),
    });
  });
  await injectWallets(page, true);
  await page.goto(`/market/base/${key}`);
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByRole("button", { name: "MetaMask", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "0x0000…0001", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as { testWallet: { chain: (chain: string) => void } }
    ).testWallet.chain("0x2105");
  });
  if (options.positions)
    return Object.assign(state, { ticks: overrides, provider, use });
  await openProvidePreview(page, selectedId);
  return Object.assign(state, { ticks: overrides, provider, use });
}
for (const direction of [0, 1] as const) {
  for (const [pair, tick] of [
    [true, true],
    [true, false],
    [false, false],
  ]) {
    test(`Provide uses one preview and one wallet transaction (Pair ${pair}, Tick ${tick}, direction ${direction})`, async ({
      page,
    }) => {
      const state = await transactionRpc(page, { pair, tick, direction });
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
      ).toBeVisible();
      expect(state.writes).toHaveLength(0);
      await dialog
        .getByRole("button", { name: "Confirm Provide", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeVisible();
      expect(state.writes).toEqual([
        [
          ...(!pair ? ["createPair"] : []),
          ...(!tick ? ["createTick"] : []),
          "supply",
        ],
      ]);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
    });
  }
}
test("approval rejection and zero-first approval recover inside the same preview", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: false,
    tick: false,
    allowance: 1n,
    reject: true,
    zeroFirst: true,
  });
  const dialog = page.getByRole("dialog");
  await expect(
    dialog
      .getByRole("status")
      .filter({ hasText: /Approve the token to simulate/ }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Approve WETH", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Approve WETH", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Approve WETH", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["approve"], ["approve"]]);
  await dialog
    .getByRole("button", { name: "Confirm Provide", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([
    ["approve"],
    ["approve"],
    ["createPair", "createTick", "supply"],
  ]);
});
test("failed simulation preserves the input and recovers without another Preview click", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    fail: true,
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.writes).toHaveLength(0);
  state.fail = false;
  await dialog
    .getByRole("button", { name: "Retry Provide", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
});

test("concurrent initialization refreshes the same preview and requires confirmation of the updated batch", async ({
  page,
}) => {
  const state = await transactionRpc(page, { pair: false, tick: false });
  const dialog = page.getByRole("dialog"),
    confirm = dialog.getByRole("button", {
      name: "Confirm Provide",
      exact: true,
    });
  await expect(confirm).toBeVisible();
  state.pair = true;
  state.ticks.set(id7, {});
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "preview has been refreshed",
  );
  expect(state.writes).toHaveLength(0);
  await confirm.click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["supply"]]);
});
test("Rent and Swap Max use the selected level's exact available amount", async ({
  page,
}) => {
  await rpc(
    page,
    true,
    new Map([
      [id7, { availableSupply: 2123456789012345678n }],
      [bid7, { availableSupply: 8765432n }],
    ]),
  );
  await page.goto(`/market/base/${key}`);
  for (const [id, expected] of [
    [id7, "2.123456789012345678"],
    [bid7, "8.765432"],
  ] as const) {
    await showMarketSection(page, "Yield Book");
    await page
      .getByLabel("Yield Book", { exact: true })
      .getByRole("tab", { name: id === bid7 ? "Buy" : "Sell", exact: true })
      .click();
    await page.locator(`[data-tick-id="${id}"]`).click();
    await showMarketSection(page, "Use");
    for (const mode of ["Rent", "Swap"] as const) {
      await page.getByRole("tab", { name: mode, exact: true }).click();
      const panel = page.getByLabel("Yield Order", { exact: true });
      await panel.getByRole("textbox", { name: /^Amount$/ }).fill("0.1");
      await panel.getByRole("button", { name: "Max", exact: true }).click();
      await expect(
        panel.getByRole("textbox", { name: /^Amount$/ }),
      ).toHaveValue(expected);
      await expect(
        panel.getByLabel("Wallet balance", { exact: true }),
      ).toHaveCount(0);
    }
  }
});

test("Provide Max fills the exact wallet balance for the selected token", async ({
  page,
  isMobile,
}, testInfo) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    balance: 2123456789012345678n,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const supply = page.getByLabel("Limit order", { exact: true });
  const input = supply.getByLabel("Amount", { exact: true });
  for (const [side, , displayBalance, exactBalance] of [
    ["Ask", "WETH", "2.123456", "2.123456789012345678"],
    ["Bid", "USDC", "2,123,456,789,012.345678", "2123456789012.345678"],
  ] as const) {
    await page
      .getByLabel("Yield Book", { exact: true })
      .getByRole("tab", { name: side === "Bid" ? "Buy" : "Sell", exact: true })
      .click();
    const balance = supply.getByLabel("Wallet balance", { exact: true });
    await expect(balance).toBeVisible();
    await expect(balance).toHaveText(displayBalance);
    const max = supply.getByRole("button", { name: "Max", exact: true });
    await expect(max).toBeEnabled();
    if (!isMobile) {
      await expect(max).toHaveCSS("color", "rgb(142, 152, 159)");
      await max.hover();
      await expect(max).toHaveCSS("color", "rgb(231, 185, 77)");
    }
    await max.click();
    await expect(input).toHaveValue(exactBalance);
    const [balanceBox, inputBox, labelBox] = await Promise.all([
      balance.boundingBox(),
      input.boundingBox(),
      supply.getByText("Amount", { exact: true }).boundingBox(),
    ]);
    expect(balanceBox!.y + balanceBox!.height).toBeLessThanOrEqual(inputBox!.y);
    expect(balanceBox!.x).toBeGreaterThan(labelBox!.x);
  }
  await supply.screenshot({ path: testInfo.outputPath("balance-max.png") });
  expect(state.writes).toEqual([]);
});

test("Provide hides wallet balance when disconnected and disables Max for zero balance", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await showMarketSection(page, "Provide");
  const supply = page.getByLabel("Limit order", { exact: true });
  await expect(
    supply.getByLabel("Wallet balance", { exact: true }),
  ).toHaveCount(0);
  await expect(
    supply.getByRole("button", { name: "Max", exact: true }),
  ).toHaveCount(0);
  await transactionRpc(page, {
    pair: true,
    tick: true,
    balance: 0n,
    positions: {},
  });
  await showMarketSection(page, "Provide");
  await expect(supply.getByLabel("Wallet balance", { exact: true })).toHaveText(
    "0",
  );
  await expect(
    supply.getByRole("button", { name: "Max", exact: true }),
  ).toBeDisabled();
});

test("Provide preview shows APY without a yield switch", async ({ page }) => {
  const state = await transactionRpc(page, { pair: true, tick: true });
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Estimated APY", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("3.7161%", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("switch")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("final simulation failure keeps the reviewed preview and retries only after confirmation", async ({
  page,
}) => {
  const state = await transactionRpc(page, { pair: true, tick: true });
  const dialog = page.getByRole("dialog"),
    confirm = dialog.getByRole("button", {
      name: "Confirm Provide",
      exact: true,
    });
  await expect(confirm).toBeVisible();
  state.fail = true;
  await confirm.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByText("Estimated APY", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
  state.fail = false;
  await confirm.click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["supply"]]);
});
for (const change of ["account", "network"]) {
  test(`wallet ${change} change invalidates the current preview without submission`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, { pair: true, tick: true });
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm Provide", exact: true }),
    ).toBeVisible();
    await page.evaluate((change) => {
      const wallet = (
        window as unknown as {
          testWallet: {
            account: (address: string) => void;
            chain: (chain: string) => void;
          };
        }
      ).testWallet;
      if (change === "account")
        wallet.account("0x0000000000000000000000000000000000000003");
      else wallet.chain("0x1");
    }, change);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
  });
}

test("position cards share a compact responsive layout on Market and Orders", async ({
  page,
  isMobile,
}) => {
  await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: { tickIds: [id7, bid7] },
  });
  for (const path of [`/market/base/${key}`, "/orders"]) {
    await page.goto(path);
    const positions =
      path === "/orders"
        ? page.getByRole("main")
        : page.getByLabel("Your positions", { exact: true });
    const cards = positions.locator('[data-slot="position-card"]');
    await expect(cards).toHaveCount(2);
    const card = cards.first();
    await expect(card.getByText("Available", { exact: true })).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Preview Withdraw" }),
    ).toBeEnabled();
    await expect(card.getByText("Active Asset")).toBeHidden();
    expect(
      await card.evaluate((node) => node.getBoundingClientRect().height),
    ).toBeLessThan(isMobile ? 400 : 260);
    expect(
      await card.evaluate(
        (node) =>
          node.parentElement!.getBoundingClientRect().width -
          node.getBoundingClientRect().width,
      ),
    ).toBeLessThan(2);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const details = card.locator("summary");
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(card.getByText("Active Asset")).toBeVisible();
    await expect(card.getByText(a, { exact: true })).toBeVisible();
    await details.press("Enter");
    await expect(card.getByText("Active Asset")).toBeHidden();
    await page.evaluate(() => {
      (
        window as unknown as { testWallet: { chain: (chain: string) => void } }
      ).testWallet.chain("0x1");
    });
    const switchNetwork = positions.getByRole("button", {
      name: "Switch network",
    });
    await expect(switchNetwork).toHaveCount(1);
    await expect(
      positions.getByText("Your wallet is on Ethereum."),
    ).toHaveCount(1);
    await expect(
      card.getByRole("button", { name: "Preview Withdraw" }),
    ).toBeDisabled();
    await expect(
      card.getByRole("button", { name: "Preview Collect" }),
    ).toBeDisabled();
    await switchNetwork.click();
    await expect(switchNetwork).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Preview Withdraw" }),
    ).toBeEnabled();
  }
});

for (const rentalsOnly of [false, true]) {
  test(`market positions switch between Provide and Use tabs (rentals only: ${rentalsOnly})`, async ({
    page,
  }) => {
    await transactionRpc(page, {
      pair: true,
      tick: true,
      positions: { tickIds: rentalsOnly ? [] : [id7], use: {} },
    });
    await page.goto(`/market/base/${key}`);
    const positions = page.getByLabel("Your positions", { exact: true });
    const provide = positions.getByRole("tab", {
      name: `Provide (${rentalsOnly ? 0 : 1})`,
      exact: true,
    });
    const use = positions.getByRole("tab", { name: "Use (1)", exact: true });
    await expect(rentalsOnly ? use : provide).toHaveAttribute(
      "aria-selected",
      "true",
    );
    if (rentalsOnly) {
      await expect(
        positions.getByText("Rented Asset", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        positions.getByText("Rented Asset", { exact: true }),
      ).toBeHidden();
      await expect(
        positions.getByRole("button", { name: "Preview Withdraw" }),
      ).toBeVisible();
    }
    await use.click();
    await expect(use).toHaveAttribute("aria-selected", "true");
    await expect(
      positions.getByText("Rented Asset", { exact: true }),
    ).toBeVisible();
    await expect(
      positions.getByRole("button", { name: "Preview Repay" }),
    ).toBeVisible();
    await expect(
      positions.getByRole("button", { name: "Preview Withdraw" }),
    ).toHaveCount(0);
    await use.press("ArrowLeft");
    await expect(provide).toBeFocused();
    await provide.press("Enter");
    await expect(provide).toHaveAttribute("aria-selected", "true");
    await expect(
      positions.getByText("Rented Asset", { exact: true }),
    ).toBeHidden();
    if (rentalsOnly) {
      await expect(
        positions.getByText("No Provide positions in this market."),
      ).toBeVisible();
    }

    await page.goto("/orders");
    const orderProvide = page.getByRole("tab", {
      name: `Provide (${rentalsOnly ? 0 : 1})`,
      exact: true,
    });
    const orderUse = page.getByRole("tab", { name: "Use (1)", exact: true });
    await expect(rentalsOnly ? orderUse : orderProvide).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await orderProvide.click();
    await expect(orderProvide).toHaveAttribute("aria-selected", "true");
    await orderUse.click();
    await expect(orderUse).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Rented Asset", { exact: true })).toBeVisible();
  });
}

test("all withdrawal percentages use fresh principal and submit zero minimum immediate Asset", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: {},
  });
  await page.goto("/orders");
  const card = page.locator('[data-slot="position-card"]').first();
  await expect(card).toBeVisible();
  // Change the onchain value after the portfolio snapshot has rendered.
  state.provider.activePrincipal = 101n;
  for (const percentage of [25, 50, 75, 100]) {
    await card
      .getByRole("button", {
        name: percentage === 100 ? "Max" : `${percentage}%`,
        exact: true,
      })
      .click();
    await expect(
      card.getByRole("button", {
        name: percentage === 100 ? "Max" : `${percentage}%`,
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    const simulations = state.simulations.length;
    await card.getByRole("button", { name: "Preview Withdraw" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Confirm Withdraw", exact: true }),
    ).toBeVisible();
    for (const label of [
      "Withdraw Asset",
      "Receive Asset now",
      "Move to Resolving",
      "Unvested Yield",
    ])
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    expect(state.simulations.length - simulations).toBe(1);
    await dialog
      .getByRole("button", { name: "Confirm Withdraw", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    expect(state.withdrawals.at(-1)?.slice(0, 3)).toEqual([
      id7,
      (101n * BigInt(percentage)) / 100n,
      0n,
    ]);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
});

test("rounding disables zero withdrawals but leaves a one-unit Max accessible", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: {
      provider: { activePrincipal: 1n, activeAvailable: 1n, activeWorking: 0n },
    },
  });
  await page.goto("/orders");
  const card = page.locator('[data-slot="position-card"]').first();
  for (const percentage of [25, 50, 75]) {
    await card
      .getByRole("button", { name: `${percentage}%`, exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "Preview Withdraw" }),
    ).toBeDisabled();
  }
  await card.getByRole("button", { name: "Max", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Preview Withdraw" }),
  ).toBeEnabled();
  state.provider.activePrincipal = 0n;
  await card.getByRole("button", { name: "Preview Withdraw" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "No transferable principal",
  );
  expect(state.simulations).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("claim-only and Resolving positions remain accessible and empty Collect is blocked", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: {
      provider: {
        activePrincipal: 0n,
        activeAvailable: 0n,
        activeWorking: 0n,
        resolvingPrincipal: 10n,
        exitPrincipalX36: 10n ** 37n,
      },
    },
  });
  await page.goto("/orders");
  const card = page.locator('[data-slot="position-card"]').first();
  await expect(
    card.getByRole("button", { name: "Preview Withdraw" }),
  ).toBeDisabled();
  await card.getByRole("button", { name: "Preview Collect" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText(
    "Nothing to collect yet",
  );
  await expect(
    dialog.getByRole("button", { name: "Confirm Collect" }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
  // A zero-output Collect can still progress automatic settlement past a cursor gap.
  state.settlement = true;
  await dialog.getByRole("button", { name: "Retry Collect" }).click();
  await dialog.getByRole("button", { name: "Confirm Collect" }).click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["collect"]]);
  state.settlement = false;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.provider.resolvingPrincipal = 0n;
  state.provider.exitPrincipalX36 = 0n;
  state.provider.claimableExitAsset = 1n;
  await page.reload();
  await card.getByRole("button", { name: "Preview Collect" }).click();
  await dialog.getByRole("button", { name: "Confirm Collect" }).click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["collect"], ["collect"]]);
});

test("Use shows accrued Yield without balance or approval, then keeps approval and Repay in one flow", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: { use: {} },
    allowance: 0n,
  });
  await page.goto("/orders");
  await page.getByRole("tab", { name: /^Use \(/ }).click();
  const card = page.locator('[data-slot="position-card"]').first();
  await expect(card.getByText("Accrued Yield")).toBeVisible();
  await expect(card.getByText("5 WETH", { exact: true })).toBeVisible();
  expect(state.simulations).toEqual([]);
  expect(state.writes).toEqual([]);
  await card.getByRole("button", { name: "Preview Repay" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Approve WETH", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Confirm Repay" }),
  ).toBeVisible();
  expect(state.writes).toEqual([["approve"]]);
  await dialog.getByRole("button", { name: "Confirm Repay" }).click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["approve"], ["repay"]]);
});

test("Use retains its estimate with insufficient Asset and changes to Close at maturity", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: { use: {} },
    allowance: 0n,
    balance: 0n,
  });
  await page.goto("/orders");
  await page.getByRole("tab", { name: /^Use \(/ }).click();
  const card = page.locator('[data-slot="position-card"]').first();
  await expect(card.getByText("5 WETH", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Preview Repay" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Insufficient balance");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.timestamp = state.use.maturity;
  await page.reload();
  await page.getByRole("tab", { name: /^Use \(/ }).click();
  await expect(card.getByText("Matured", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Preview Repay" })).toHaveCount(
    0,
  );
  await card.getByRole("button", { name: "Preview Close" }).click();
  await dialog.getByRole("button", { name: "Confirm Close" }).click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["close"]]);
});

test("reopening Withdraw prepares fresh principal and simulates again before confirming", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: {},
  });
  await page.goto("/orders");
  const withdraw = page.getByRole("button", {
    name: "Preview Withdraw",
    exact: true,
  });
  await withdraw.click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Confirm Withdraw", exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .locator("dl")
      .filter({ has: page.getByText("Withdraw Asset", { exact: true }) })
      .locator("dd"),
  ).toHaveText("100 WETH");
  const simulations = state.simulations.length;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.provider.activePrincipal = 50n * 10n ** 18n;
  await withdraw.click();
  await expect(
    dialog
      .locator("dl")
      .filter({ has: page.getByText("Withdraw Asset", { exact: true }) })
      .locator("dd"),
  ).toHaveText("50 WETH");
  await expect(
    dialog.getByRole("button", { name: "Confirm Withdraw", exact: true }),
  ).toBeVisible();
  expect(state.simulations.length - simulations).toBe(1);
  expect(state.writes).toEqual([]);
});

test("reopening clears stale previews, approval state and errors before refreshing", async ({
  page,
}) => {
  const state = await transactionRpc(page, { pair: true, tick: true });
  const dialog = page.getByRole("dialog");
  const reopen = page.getByRole("button", {
    name: /^(Buy|Sell) and Earn$/,
    exact: true,
  });
  await expect(
    dialog.getByText("Estimated APY", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.allowance = 0n;
  await reopen.click();
  await expect(
    dialog.getByRole("button", { name: "Approve WETH", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("Estimated APY", { exact: true })).toHaveCount(
    0,
  );
  state.reject = true;
  await dialog
    .getByRole("button", { name: "Approve WETH", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.allowance = 10n ** 30n;
  // Hold the refresh so cleared state is also checked while the simulation is in flight.
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://mainnet.base.org", async (route) => {
    const body = route.request().postDataJSON();
    const requests = Array.isArray(body) ? body : [body];
    if (
      requests.some((r: { method: string }) => r.method === "eth_estimateGas")
    )
      await ready;
    await route.fallback();
  });
  await reopen.click();
  await expect(
    dialog.getByText("Preparing transaction preview…", { exact: true }),
  ).toBeVisible();
  const spinner = dialog
    .getByRole("status")
    .filter({
      hasText: "Preparing transaction preview…",
    })
    .locator("svg");
  await expect(spinner).toHaveCSS("animation-name", "spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(spinner).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator("dl")).toHaveCount(0);
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Approve WETH", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
  ).toHaveCount(0);
  release();
  await expect(
    dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
  ).toBeVisible();
  await expect(spinner).toHaveCount(0);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for (const submitted of ["approval", "transaction"] as const) {
  test(`${submitted} waits for two confirmations before continuing`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, {
      pair: true,
      tick: true,
      allowance: submitted === "approval" ? 0n : 10n ** 30n,
    });
    state.blockNumber = 10000000n;
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", {
        name: submitted === "approval" ? "Approve WETH" : "Confirm Provide",
        exact: true,
      })
      .click();
    await expect(
      dialog.getByText("Waiting for onchain confirmation…", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toHaveCount(0);
    expect(state.writes).toEqual([
      [submitted === "approval" ? "approve" : "supply"],
    ]);
    state.blockNumber = 10000001n;
    await expect(
      submitted === "approval"
        ? dialog.getByRole("button", { name: "Confirm Provide", exact: true })
        : dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    expect(state.writes).toHaveLength(1);
  });
}

test("amount input accepts decimal editing and rejects invalid text", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await showMarketSection(page, "Provide");
  const input = page.getByLabel("Amount", { exact: true });
  await expect(input).toHaveAttribute("inputmode", "decimal");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "none");
  await expect(input).toHaveAttribute("spellcheck", "false");
  await input.pressSequentially("ds vdsveE+-");
  await expect(input).toHaveValue("");
  for (const value of [
    "0",
    "0.",
    "0,",
    ".5",
    ",5",
    "1.",
    "1,",
    "1,000",
    "0.000000000000000001",
    "0,000000000000000001",
    "9007199254740993.123456789123456789",
    "9007199254740993,123456789123456789",
    "",
  ]) {
    await input.fill(value);
    await expect(input).toHaveValue(value.replaceAll(",", "."));
  }
  for (const separator of [".", ","]) {
    await input.fill("");
    await input.pressSequentially(`12${separator}34`);
    await expect(input).toHaveValue("12.34");
  }
  // Replacing the value also exercises input from paste, without silently stripping text.
  for (const invalid of [
    "abc",
    "1 WETH",
    "1e3",
    "1E3",
    "-1",
    "+1",
    "1.2.3",
    "1,2,3",
    "1.2,3",
    "1,2.3",
    " 42 ",
    "NaN",
    "Infinity",
  ]) {
    await input.fill(invalid);
    await expect(input).toHaveValue("12.34");
  }
  await input.pressSequentially("abcE+-.,");
  await expect(input).toHaveValue("12.34");
  await input.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(0, 2),
  );
  await page.keyboard.insertText("5");
  await expect(input).toHaveValue("5.34");
  await input.fill("1.");
  await input.press("End");
  await input.press("Backspace");
  await expect(input).toHaveValue("1");
  await input.press("Backspace");
  await expect(input).toHaveValue("");
});

test("Yield slippage accepts percentages and disables autocomplete", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await page
    .getByLabel("Yield Book", { exact: true })
    .getByRole("tab", { name: "Sell", exact: true })
    .click();
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await showMarketSection(page, "Use");
  await page.getByText("Yield slippage", { exact: true }).click();
  const input = page.getByLabel("Yield slippage", { exact: true });
  await expect(input).toHaveValue("0.5");
  await expect(input.locator("..")).toContainText("%");
  await expect(input).toHaveAttribute("inputmode", "decimal");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "none");
  await expect(input).toHaveAttribute("spellcheck", "false");
  for (const invalid of [
    "abc",
    "1.2.3",
    "1,2,3",
    "1.2,3",
    "1,2.3",
    "1e2",
    "-1",
    "+1",
    "0.5%",
    "0,5%",
    " 0,5 ",
  ]) {
    await input.fill(invalid);
    await expect(input).toHaveValue("0.5");
  }
  await input.fill("");
  await expect(input).toHaveValue("");
  for (const separator of [".", ","]) {
    await input.fill("");
    await input.pressSequentially(`0${separator}25abcE+-.,`);
    await expect(input).toHaveValue("0.25");
  }
  await input.fill("0");
  await expect(input).toHaveValue("0");
  for (const value of [
    "0.01",
    "0,01",
    "0.29",
    "0,29",
    "1.",
    "1,",
    ".5",
    ",5",
    "10",
  ]) {
    await input.fill(value);
    await expect(input).toHaveValue(value.replaceAll(",", "."));
    await expect(
      page.getByRole("alert").filter({ hasText: "Yield slippage must be" }),
    ).toHaveCount(0);
  }
  for (const value of [
    "",
    ".",
    ",",
    "10.01",
    "10,01",
    "333",
    "0.001",
    "0,001",
    "1,000",
  ]) {
    await input.fill(value);
    await expect(input).toHaveValue(value.replaceAll(",", "."));
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Yield slippage must be 0–10%" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Preview Rent", exact: true }),
    ).toBeDisabled();
  }
});

test("Rent converts Yield slippage to exact basis-point caps", async ({
  page,
}) => {
  await transactionRpc(page, { pair: true, tick: true });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await showMarketSection(page, "Use");
  await page.getByText("Yield slippage", { exact: true }).click();
  await page.getByRole("textbox", { name: /^Amount$/ }).fill("1,0");
  await expect(page.getByRole("textbox", { name: /^Amount$/ })).toHaveValue(
    "1.0",
  );
  for (const [percent, expectedCap] of [
    ["0.5", "0.01005 WETH"],
    ["0,5", "0.01005 WETH"],
    ["0.29", "0.010029 WETH"],
    ["0,29", "0.010029 WETH"],
    ["0.01", "0.010001 WETH"],
    ["0,01", "0.010001 WETH"],
    ["0", "0.01 WETH"],
    ["10", "0.011 WETH"],
  ]) {
    await page.getByLabel("Yield slippage", { exact: true }).fill(percent);
    await page
      .getByRole("button", { name: "Preview Rent", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Confirm Rent", exact: true }),
    ).toBeVisible();
    await dialog.getByText("Transaction details", { exact: true }).click();
    await expect(
      dialog.getByText("Maximum accepted Yield", { exact: true }).locator(".."),
    ).toContainText(expectedCap);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
});

for (const direction of [0, 1] as const) {
  test(`Swap submits the exact contract Quote in direction ${direction} regardless of Rent Yield slippage`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, {
      pair: true,
      tick: true,
      direction,
    });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await showMarketSection(page, "Use");
    await page.getByRole("textbox", { name: /^Amount$/ }).fill("1");
    for (const percent of ["10", ""]) {
      await page.getByText("Yield slippage", { exact: true }).click();
      await page.getByLabel("Yield slippage", { exact: true }).fill(percent);
      await page.getByRole("tab", { name: "Swap", exact: true }).click();
      await page.getByRole("textbox", { name: /^Amount$/ }).fill("1");
      await expect(
        page.getByText("Yield slippage", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Preview Swap", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Confirm Swap", exact: true }),
      ).toBeVisible();
      const payment = direction === 0 ? "3,000 USDC" : "0.000333 WETH";
      for (const label of ["You provide", "Maximum Quote payment"])
        await expect(
          dialog.getByText(label, { exact: true }).locator(".."),
        ).toContainText(payment);
      await dialog
        .getByRole("button", { name: "Confirm Swap", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeVisible();
      expect(state.swaps.at(-1)).toEqual([
        direction === 0 ? id7 : bid7,
        direction === 0 ? 10n ** 18n : 10n ** 6n,
        direction === 0 ? 3000n * 10n ** 6n : 333333333333333n,
      ]);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("tab", { name: "Rent", exact: true }).click();
      await page.getByRole("textbox", { name: /^Amount$/ }).fill("1");
    }
  });
}

for (const atomic of ["supported", "safe"] as const) {
  test(`${atomic === "safe" ? "Safe legacy capabilities" : "smart account capabilities"} uses one atomic approve and Provide submission`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, {
      pair: false,
      tick: false,
      allowance: 0n,
      atomic,
    });
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Approve & Provide", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    expect(state.batches).toHaveLength(1);
    expect(state.batches[0].atomicRequired).toBe(true);
    expect(state.writes).toEqual([
      ["approve", "createPair", "createTick", "supply"],
    ]);
    expect(state.batches[0]).not.toHaveProperty("experimental_fallback");
  });
}
for (const atomic of ["missing", "unsupported"] as const) {
  test(`${atomic} capabilities uses sequential approval and confirmation in one preview`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, {
      pair: true,
      tick: true,
      allowance: 0n,
      atomic,
    });
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Approve WETH", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
    ).toBeVisible();
    expect(state.writes).toEqual([["approve"]]);
    await dialog
      .getByRole("button", { name: "Confirm Provide", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    expect(state.writes).toEqual([["approve"], ["supply"]]);
    expect(state.batches).toEqual([]);
  });
}
for (const mode of ["Rent", "Swap"] as const) {
  test(`${mode} preview keeps consequences and safety limits with collapsible transaction details`, async ({
    page,
  }) => {
    await transactionRpc(page, { pair: true, tick: true });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await showMarketSection(page, "Use");
    if (mode === "Swap")
      await page.getByRole("tab", { name: "Swap", exact: true }).click();
    const explanation =
      mode === "Rent"
        ? "Repay WETH + Yield to unlock USDC, or it will be swapped at term end."
        : "Swaps are instant and final.";
    await page.getByRole("textbox", { name: /^Amount$/ }).fill("1");
    await page
      .getByRole("button", { name: `Preview ${mode}`, exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: `Confirm ${mode}`, exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(explanation, { exact: true })).toBeVisible();
    const info = dialog.getByRole("status").filter({ hasText: explanation });
    await expect(info).toHaveCSS("font-size", "12px");
    await expect(info.locator('[data-slot="alert-description"]')).toHaveCSS(
      "font-size",
      "12px",
    );
    await expect(
      dialog.locator('[data-slot="dialog-description"]'),
    ).toContainText("Base");
    for (const label of [
      "Network",
      "Account",
      "Execution deadline",
      ...(mode === "Rent" ? ["Maximum accepted Yield"] : []),
    ])
      await expect(dialog.getByText(label, { exact: true })).toBeHidden();
    if (mode === "Swap")
      await expect(
        dialog.getByText("Maximum Quote payment", { exact: true }),
      ).toBeVisible();
    await dialog.getByText("Transaction details", { exact: true }).click();
    for (const label of [
      "Network",
      "Account",
      "Execution deadline",
      ...(mode === "Rent" ? ["Maximum accepted Yield"] : []),
    ])
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
  });
}

test("Rent advances to Confirm Rent after two approval confirmations", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    allowance: 0n,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await showMarketSection(page, "Use");
  await page.getByRole("textbox", { name: /^Amount$/ }).fill("1");
  await page.getByRole("button", { name: "Preview Rent", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Approve USDC", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Confirm Rent", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    dialog.getByRole("button", { name: "Approve USDC", exact: true }),
  ).toHaveCount(0);
  expect(state.writes).toEqual([["approve"]]);
  await dialog
    .getByRole("button", { name: "Confirm Rent", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["approve"], ["use"]]);
});
test("pending atomic batch waits for wallet execution", async ({ page }) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    allowance: 0n,
    atomic: "safe",
  });
  state.batchPending = true;
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Approve & Provide", exact: true })
    .click();
  await expect(
    dialog.getByText("Waiting for onchain confirmation…", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  expect(state.batches).toHaveLength(1);
  state.batchPending = false;
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible({
    timeout: 10000,
  });
  expect(state.batches).toHaveLength(1);
});
test("batch rejection permits a deliberate retry and reverted batch requires a new preview", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    allowance: 0n,
    atomic: "supported",
    reject: true,
  });
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Approve & Provide", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.batches).toHaveLength(0);
  state.batchReverted = true;
  await dialog
    .getByRole("button", { name: "Approve & Provide", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Retry Provide", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toHaveCount(0);
  expect(state.batches).toHaveLength(1);
});
test("atomic zero-first approval resets then approves exactly once in the wallet batch", async ({
  page,
}) => {
  const state = await transactionRpc(page, {
    pair: true,
    tick: true,
    allowance: 1n,
    atomic: "supported",
    zeroFirst: true,
  });
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Approve & Provide", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeVisible();
  expect(state.writes).toEqual([["approve", "approve", "supply"]]);
  const amounts = state.batches[0].calls
    .slice(0, -1)
    .map((c) => decodeFunctionData({ abi: erc20Abi, data: c.data }).args?.[1]);
  expect(amounts).toEqual([0n, 10n ** 18n]);
});

for (const failure of ["simulationUnsupported", "sendUnsupported"] as const) {
  test(`${failure} returns to explicit sequential approval without a non-atomic sendCalls fallback`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, {
      pair: true,
      tick: true,
      allowance: 0n,
      atomic: "supported",
      [failure]: true,
    });
    const dialog = page.getByRole("dialog");
    if (failure === "sendUnsupported")
      await dialog
        .getByRole("button", { name: "Approve & Provide", exact: true })
        .click();
    await expect(
      dialog.getByRole("button", { name: "Approve WETH", exact: true }),
    ).toBeVisible();
    expect(state.writes).toEqual([]);
    await dialog
      .getByRole("button", { name: "Approve WETH", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirm Provide", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    expect(state.writes).toEqual([["approve"], ["supply"]]);
    expect(state.batches).toEqual([]);
  });
}
for (const atomic of [undefined, "supported"] as const) {
  test(`duplicate clicks submit only one ${atomic ? "atomic batch" : "transaction"}`, async ({
    page,
  }) => {
    const state = await transactionRpc(page, {
      pair: true,
      tick: true,
      allowance: atomic ? 0n : 10n ** 30n,
      atomic,
    });
    const dialog = page.getByRole("dialog");
    const confirm = dialog.getByRole("button", {
      name: atomic ? "Approve & Provide" : "Confirm Provide",
      exact: true,
    });
    await confirm.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(
      dialog.getByRole("button", { name: "Done", exact: true }),
    ).toBeVisible();
    expect(state.writes).toHaveLength(1);
  });
}
test("fresh review resets atomic fallback and attempts batching again", async ({
  page,
}) => {
  const options = {
    pair: true,
    tick: true,
    allowance: 0n,
    atomic: "supported" as const,
    simulationUnsupported: true,
  };
  const state = await transactionRpc(page, options);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Approve WETH", exact: true }),
  ).toBeVisible();
  options.simulationUnsupported = false;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /^(Buy|Sell) and Earn$/ }).click();
  await expect(
    dialog.getByRole("button", { name: "Approve & Provide", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Atomic simulation is unavailable/),
  ).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("token discovery prioritizes configured identities without reading decimals for the full list", async ({
  page,
}) => {
  const discovered = Array.from({ length: 99 }, (_, i) => ({
    address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    symbol: `DISC${i}`,
    name: `Discovered ${i}`,
  }));
  await page.route("**/api/tokens?**", (route) =>
    route.fulfill({
      json: {
        tokens: [
          {
            address: a.toUpperCase().replace("0X", "0x"),
            symbol: "CACHEDWETH",
            name: "Cached Ether",
          },
          ...discovered,
        ],
      },
    }),
  );
  const decimals = new Set<string>();
  await page.route("https://mainnet.base.org", async (route) => {
    const payload = route.request().postDataJSON();
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      if (item.method !== "eth_call") continue;
      const call = item.params[0] as { data: Hex; to: string };
      try {
        const batch = decodeFunctionData({
          abi: multicall3Abi,
          data: call.data,
        });
        if (batch.functionName === "aggregate3")
          for (const entry of batch.args[0]) {
            if (entry.callData.startsWith("0x313ce567"))
              decimals.add(entry.target.toLowerCase());
          }
      } catch {
        if (call.data.startsWith("0x313ce567"))
          decimals.add(call.to.toLowerCase());
      }
    }
    await route.fallback();
  });
  await page.goto("/market/open");
  await expect(
    page.getByRole("combobox", { name: "Token A selection" }),
  ).toContainText("Import custom token");
  await expect(
    page.getByRole("textbox", { name: "Token A address" }),
  ).toBeEmpty();
  await page.getByRole("combobox", { name: "Token A selection" }).click();
  const options = page.getByRole("option");
  const tokenCount = new Set([
    ...configuredAddresses,
    ...discovered.map((token) => token.address),
  ]).size;
  await expect(options).toHaveCount(tokenCount + 1); // Includes the custom-address option.
  for (const [index, address] of configuredAddresses.entries()) {
    await expect(options.nth(index + 1)).toHaveText(
      tokenFixture(address).symbol,
    );
  }
  await expect(
    page.getByRole("option", { name: "WETH", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("option", { name: "CACHEDWETH", exact: true }),
  ).toHaveCount(0);
  expect([...decimals]).toEqual([b]);
  await page.getByRole("option", { name: "DISC0", exact: true }).click();
  await expect.poll(() => decimals.has(discovered[0].address)).toBe(true);
  expect(decimals.size).toBe(2);
  await page.getByRole("combobox", { name: "Token A selection" }).click();
  await page
    .getByRole("option", { name: "Import custom token", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Token A address" })
    .fill("0x1111111111111111111111111111111111111111");
  await expect
    .poll(() => decimals.has("0x1111111111111111111111111111111111111111"))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "View Market →" }),
  ).toBeVisible();
});

test("metadata requests use the environment's configured browser endpoint", async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (metadataRoute.test(request.url())) requests.push(request.url());
  });
  await page.goto(`/market/base/${key}`);
  await expect(
    page.getByRole("heading", { name: "WETH / USDC" }),
  ).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  const proxy =
    process.env.PLAYWRIGHT_SERVER === "development" ||
    process.env.VERCEL_ENV === "preview";
  expect(
    requests.every((url) =>
      url.startsWith(
        proxy ? `${baseURL}/api/md/tokens?` : "https://md.yld.cx/tokens?",
      ),
    ),
  ).toBe(true);
});

for (const scenario of [
  "supported",
  "safe",
  "unsupported",
  "ready",
  "rejected",
  "expired",
  "already-approved",
  "permit-only",
  "wrong-pair",
  "batch-unsupported",
  "wrong-chain",
  "allowance-changed",
  "other-chain-only",
] as const) {
  const atomic =
    scenario === "safe"
      ? "safe"
      : scenario === "other-chain-only"
        ? "other-chain-only"
        : scenario === "unsupported"
          ? "unsupported"
          : scenario === "ready"
            ? "ready"
            : "supported";
  test(`Market Swap ${scenario} wallet batches Permit2 without offchain signatures`, async ({
    page,
  }) => {
    const router = swapNetwork(8453).router;
    let authorized = scenario === "already-approved";
    const approved =
      scenario === "already-approved" || scenario === "permit-only";
    const state = await transactionRpc(page, {
      pair: true,
      tick: true,
      allowance: approved ? 10n ** 18n : 0n,
      atomic,
      permitAllowance: () => [
        authorized ? 10n ** 30n : 0n,
        Math.floor(Date.now() / 1000) + 86400,
        0,
      ],
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    let quoteRequests = 0;
    const submitted: { to: string; data: Hex }[][] = [];
    const rpcMethods: string[] = [];
    await page.route("https://mainnet.base.org", async (route) => {
      const request = route.request().postDataJSON() as {
        id: number;
        method: string;
        params: unknown[];
      };
      if (Array.isArray(request)) return route.fallback();
      rpcMethods.push(request.method);
      let result: unknown;
      if (request.method === "wallet_sendCalls") {
        if (scenario === "rejected" || scenario === "batch-unsupported") {
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: scenario === "rejected" ? 4001 : 5760,
                message:
                  scenario === "rejected"
                    ? "User rejected batch"
                    : "Atomicity not supported",
              },
            }),
          });
        }
        const batch = request.params[0] as {
          atomicRequired: boolean;
          calls: { to: string; data: Hex }[];
        };
        expect(batch.atomicRequired).toBe(true);
        submitted.push(batch.calls);
        state.allowance = 0n;
        authorized = true;
        result = { id: "wallet-batch-1" };
      } else if (request.method === "eth_sendTransaction") {
        const call = request.params[0] as { to: string; data: Hex };
        submitted.push([call]);
        if (call.to.toLowerCase() === a) state.allowance = 10n ** 18n;
        if (call.to.toLowerCase() === PERMIT2.toLowerCase()) authorized = true;
        result = `0x${"12".repeat(32)}`;
      } else return route.fallback();
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      });
    });
    await page.route("**/api/swap/**", async (route) => {
      const input = route.request().postDataJSON() as {
        swapper: string;
        amount: string;
      };
      const transaction = {
        to: router,
        data: "0x12345678",
        value: "0",
        chainId: 8453,
      };
      expect(route.request().url().endsWith("/quote")).toBe(true);
      quoteRequests++;
      const result = {
        mode: "wallet-router",
        chainId: 8453,
        tokenIn: scenario === "wrong-pair" ? b : a,
        tokenOut: scenario === "wrong-pair" ? a : b,
        amountIn: input.amount,
        estimatedAmountOut: "3000000000",
        minimumAmountOut: "2985000000",
        routing: "CLASSIC",
        routeVersion: "2.1.2",
        quotedAt: Date.now(),
        expiresAt: Date.now() + (scenario === "expired" ? -1 : 45000),
        routeId: "browser-test",
        transaction,
        ...(!authorized
          ? {
              permitTransaction: {
                to: PERMIT2,
                chainId: 8453,
                value: "0",
                data: encodeFunctionData({
                  abi: permit2Abi,
                  functionName: "approve",
                  args: [
                    a,
                    router,
                    BigInt(input.amount),
                    Math.floor(Date.now() / 1000) + 86400,
                  ],
                }),
              },
            }
          : {}),
      };
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    });
    await page
      .getByLabel("Yield Book", { exact: true })
      .getByRole("tab", { name: "Sell", exact: true })
      .click();
    await showMarketSection(page, "Swap");
    const form = page.getByLabel("Market swap", { exact: true });
    await form.getByLabel("Amount", { exact: true }).fill("1");
    await expect(
      page.getByRole("button", { name: "Get swap quote", exact: true }),
    ).toHaveCount(0);
    if (scenario === "wrong-pair" || scenario === "expired") {
      await expect(form.getByRole("alert")).toContainText(
        scenario === "wrong-pair"
          ? "Swap quote no longer matches this order"
          : "Swap changed or expired",
      );
      await expect(
        form.getByRole("button", { name: "Swap", exact: true }),
      ).toBeDisabled();
      expect(submitted).toEqual([]);
      expect(quoteRequests).toBe(1);
      return;
    }
    await expect(
      form.getByText("You receive", { exact: true }).locator(".."),
    ).toContainText("3,000 USDC");
    expect(quoteRequests).toBe(1);
    if (scenario === "wrong-chain") {
      await page.evaluate(() =>
        (
          window as unknown as {
            testWallet: { chain: (chain: string) => void };
          }
        ).testWallet.chain("0x1"),
      );
      await expect(
        page.getByRole("button", { name: "Swap", exact: true }),
      ).toBeDisabled();
      expect(submitted).toEqual([]);
      return;
    }
    await form.getByRole("button", { name: "Swap", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Minimum received", { exact: true }),
    ).toBeVisible();
    expect(quoteRequests).toBe(2);
    if (
      scenario === "rejected" ||
      scenario === "allowance-changed" ||
      scenario === "batch-unsupported"
    ) {
      if (scenario === "allowance-changed") state.allowance = 10n ** 18n;
      await dialog
        .getByRole("button", { name: "Approve & Swap", exact: true })
        .click();
      await expect(
        dialog.getByText(
          scenario === "rejected"
            ? "Wallet request declined. You can try again."
            : scenario === "allowance-changed"
              ? "Allowance changed. Review a fresh quote."
              : "Atomic batching is unavailable. Approve separately and review the swap.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(submitted).toEqual([]);
      expect(rpcMethods).not.toContain("eth_sendTransaction");
      if (scenario !== "batch-unsupported") return;
    }
    if (scenario === "already-approved") {
      await dialog
        .getByRole("button", { name: "Confirm Swap", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeVisible();
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toHaveLength(1);
      expect(submitted[0][0].to.toLowerCase()).toBe(router.toLowerCase());
      expect(rpcMethods).not.toContain("wallet_sendCalls");
      return;
    }
    if (
      scenario === "supported" ||
      scenario === "safe" ||
      scenario === "permit-only"
    ) {
      await dialog
        .getByRole("button", { name: "Approve & Swap", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeVisible();
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toHaveLength(scenario === "permit-only" ? 2 : 3);
    } else {
      await dialog
        .getByRole("button", { name: "Approve WETH", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Authorize Permit2", exact: true }),
      ).toBeVisible();
      expect(submitted).toHaveLength(1);
      await dialog
        .getByRole("button", { name: "Authorize Permit2", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Confirm Swap", exact: true }),
      ).toBeVisible();
      expect(submitted).toHaveLength(2);
      await dialog
        .getByRole("button", { name: "Confirm Swap", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Done", exact: true }),
      ).toBeVisible();
      expect(submitted).toHaveLength(3);
    }
    if (scenario === "permit-only") {
      expect(submitted[0][0].to).toBe(PERMIT2);
      expect(
        decodeFunctionData({
          abi: permit2Abi,
          data: submitted[0][0].data,
        }).args?.slice(0, 3),
      ).toEqual([a, router, 10n ** 18n]);
      return;
    }
    expect(submitted[0][0].to.toLowerCase()).toBe(a);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: submitted[0][0].data }).args,
    ).toEqual([PERMIT2, 10n ** 18n]);
    expect(submitted.at(-1)!.at(-1)!.to.toLowerCase()).toBe(
      router.toLowerCase(),
    );
    expect(rpcMethods.some((method) => /signTypedData/i.test(method))).toBe(
      false,
    );
  });
}

test("Market Swap quotes the payment token automatically and ignores superseded quotes", async ({
  page,
}) => {
  const state = await transactionRpc(page, { pair: true, tick: true });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const requests: {
    tokenIn: string;
    tokenOut: string;
    amount: string;
    slippage: number;
  }[] = [];
  await page.route("**/api/swap/quote", async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
    const index = requests.length;
    if (index === 1) await first;
    await route.fulfill({
      json: {
        mode: "wallet-router",
        chainId: 8453,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amount,
        estimatedAmountOut:
          input.tokenOut === a
            ? (BigInt(index) * 10n ** 17n).toString()
            : "3000000000",
        minimumAmountOut: "1",
        routing: "CLASSIC",
        routeVersion: "2.1.2",
        quotedAt: Date.now(),
        expiresAt: Date.now() + 45000,
        routeId: "automatic-test",
        transaction: {
          to: swapNetwork(8453).router,
          data: "0x12345678",
          value: "0",
          chainId: 8453,
        },
      },
    });
  });
  try {
    const book = page.getByLabel("Yield Book", { exact: true });
    await book.getByRole("tab", { name: "Buy", exact: true }).click();
    await showMarketSection(page, "Swap");
    const form = page.getByLabel("Market swap", { exact: true });
    await expect(form).not.toContainText(
      /Swap through|Market swaps do not|→|Token spender/,
    );
    const amount = form.getByLabel("Amount", { exact: true });
    await amount.fill("12.5");
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({
      tokenIn: b,
      tokenOut: a,
      amount: "12500000",
    });
    await expect(
      form.getByText("You provide", { exact: true }).locator(".."),
    ).toContainText("12.5 USDC");
    await amount.fill("20");
    await expect(
      form.getByText("You receive", { exact: true }).locator(".."),
    ).toContainText("0.2 WETH");
    releaseFirst();
    await expect(
      form.getByText("You receive", { exact: true }).locator(".."),
    ).toContainText("0.2 WETH");
    await expect(
      form.getByRole("button", { name: "Swap", exact: true }),
    ).toBeEnabled();
    await form.getByText("Swap slippage", { exact: true }).click();
    await form.getByLabel("Swap slippage", { exact: true }).fill("2");
    await expect(form.getByRole("alert")).toContainText("at most 1%");
    await expect(
      form.getByRole("button", { name: "Swap", exact: true }),
    ).toBeDisabled();
    expect(requests).toHaveLength(2);
    await form.getByLabel("Swap slippage", { exact: true }).fill("1");
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2]).toMatchObject({
      tokenIn: b,
      amount: "20000000",
      slippage: 1,
    });
    await book.getByRole("tab", { name: "Sell", exact: true }).click();
    await amount.fill("0.01");
    await expect.poll(() => requests.length).toBe(4);
    expect(requests[3]).toMatchObject({
      tokenIn: a,
      tokenOut: b,
      amount: "10000000000000000",
    });
    expect(state.writes).toEqual([]);
  } finally {
    releaseFirst();
  }
});

test("simplified home explores markets without pair, tick or AMM requests", async ({
  page,
}) => {
  const rpcRequests: string[] = [];
  page.on("request", (request) => {
    if (/mainnet\.base\.org|api\/market-price|api\/swap/.test(request.url()))
      rpcRequests.push(request.url());
  });
  await page.goto("/");
  const table = page.getByRole("table");
  await expect(
    table.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveCount(2);
  await expect(
    page.getByRole("combobox", { name: "Market duration" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Markets yield display" }),
  ).toHaveCount(0);
  await page.getByLabel("Search markets").fill("WETH");
  await expect(table.getByRole("link")).toHaveCount(1);
  expect(rpcRequests).toEqual([]);
});

test("simplified Trending recovers from an empty discovery response", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/markets?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("tag") !== "trending")
      return route.fallback();
    await route.fulfill({
      json: { markets: ++requests === 1 ? [] : configuredMarkets },
    });
  });
  await page.goto("/?tag=trending&network=base");
  await expect(
    page.getByText("No matching markets", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "YieldList", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Trending", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
});

test("market header shows reference price, APY and animated OTC and action colors", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  const book = page.getByLabel("Yield Book", { exact: true });
  const banner = page.getByRole("region", { name: "Market overview" });
  const order = page.getByLabel("Yield Order", { exact: true });
  await expect(banner.getByText("Open market", { exact: true })).toBeVisible();
  const [marketLabelBox, statusBox, bannerBox, titleBox] = await Promise.all([
    banner.getByText("Yield market · Base", { exact: true }).boundingBox(),
    banner.getByText("Open market", { exact: true }).boundingBox(),
    banner.boundingBox(),
    banner
      .getByRole("heading", { name: "WETH / USDC", exact: true })
      .boundingBox(),
  ]);
  expect(statusBox!.y + statusBox!.height / 2).toBeCloseTo(
    marketLabelBox!.y + marketLabelBox!.height / 2,
    0,
  );
  expect(marketLabelBox!.y - bannerBox!.y).toBeCloseTo(40, 0);
  expect(
    titleBox!.y - (marketLabelBox!.y + marketLabelBox!.height),
  ).toBeLessThanOrEqual(4);
  await expect(
    banner.getByText("Term", { exact: true }).locator(".."),
  ).toHaveText("Term7 days");
  await expect(banner.getByText("7D", { exact: true })).toHaveCount(0);
  const reference = banner
    .getByText("Reference price", { exact: true })
    .locator("..");
  await expect(reference).toContainText("~ 3K USDC");
  await expect(
    book.getByRole("button", { name: /Market · AMM/ }),
  ).toContainText("~ 3,000 USDC");
  await expect(banner.getByText("BID APY", { exact: true })).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "About APY", exact: true }),
  ).toBeVisible();
  await expect(banner).not.toContainText(/USDC \/ WETH|Indicative/i);
  await expect(book.getByText("Yield", { exact: true })).toBeVisible();
  await expect(book.locator(".otc-badge")).toHaveCSS(
    "color",
    "rgb(0, 255, 76)",
  );
  expect(
    await book
      .locator(".otc-badge")
      .evaluate(
        (element) => getComputedStyle(element, "::before").animationName,
      ),
  ).toBe("otc-border-orbit");
  await expect(
    book.getByRole("button", { name: "Refresh discovery", exact: true }),
  ).toHaveText("");
  await expect(
    book.getByRole("button", { name: "Back to market", exact: true }),
  ).toHaveCount(0);
  await expect(book).not.toContainText("Amounts in");
  await expect(order.getByRole("heading", { name: /Buy.*Earn/ })).toHaveCount(
    0,
  );
  for (const [action, color] of [
    ["Limit", "rgb(231, 185, 77)"],
    ["Swap", "rgb(241, 244, 247)"],
    ["Rent", "rgb(211, 195, 255)"],
  ]) {
    const tab = order.getByRole("tab", { name: action, exact: true });
    await tab.click();
    await expect(tab).toHaveCSS("color", color);
  }
  await book.getByRole("tab", { name: "Sell", exact: true }).click();
  await expect(banner.getByText("ASK APY", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expect(reference).toContainText("~ 0.000333333 WETH");
});

for (const side of ["BID", "ASK"] as const)
  for (const inverted of [false, true]) {
    test(`book navigation follows ${side} row order (inverted ${inverted})`, async ({
      page,
    }) => {
      await page.goto(`/market/base/${key}`);
      if (inverted)
        await page
          .getByRole("button", { name: /^Invert displayed pair/ })
          .click();
      const book = page.getByLabel("Yield Book", { exact: true });
      await book
        .getByRole("tab", {
          name: side === "BID" ? "Buy" : "Sell",
          exact: true,
        })
        .click();
      const rows = book.locator("[data-tick-id]");
      await expect(rows).toHaveCount(10);
      const initialIds = await rows.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-tick-id")),
      );
      const lastPrice = Number(
        (await rows.last().locator("span").first().innerText()).replaceAll(
          ",",
          "",
        ),
      );
      const navigation = book.getByRole("group", {
        name: "Price level navigation",
        exact: true,
      });
      await expect(navigation.getByRole("button")).toHaveCount(2);
      await expect(navigation).toHaveText("");
      await navigation
        .getByRole("button", { name: "Next price levels", exact: true })
        .click();
      await expect
        .poll(() => rows.first().getAttribute("data-tick-id"))
        .not.toBe(initialIds[0]);
      const nextIds = await rows.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-tick-id")),
      );
      expect(new Set([...initialIds, ...nextIds]).size).toBe(20);
      const nextPrice = Number(
        (await rows.first().locator("span").first().innerText()).replaceAll(
          ",",
          "",
        ),
      );
      if (side === "BID") expect(nextPrice).toBeLessThan(lastPrice);
      else expect(nextPrice).toBeGreaterThan(lastPrice);
      await navigation
        .getByRole("button", { name: "Previous price levels", exact: true })
        .click();
      await expect
        .poll(() => rows.first().getAttribute("data-tick-id"))
        .toBe(initialIds[0]);
    });
  }

test("simplified book preserves the selected limit price and amount across ten-level pages", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto(`/market/base/${key}`);
  const book = page.getByLabel("Yield Book", { exact: true });
  const order = page.getByLabel("Yield Order", { exact: true });
  const rows = book.locator("[data-tick-id]");
  await expect(rows).toHaveCount(10);
  await expect(
    book.getByRole("tab", { name: "Buy", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    order.getByRole("tab", { name: "Limit", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(order.getByText("Provide", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "Market sections" }),
  ).toHaveCount(0);
  const firstIds = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-tick-id")),
  );
  const missing = book.locator('[data-status="missing"]').first();
  await missing.click();
  const selectedId = await missing.getAttribute("data-tick-id");
  await order.getByLabel("Amount", { exact: true }).fill("12");
  const price = await order
    .locator("dl")
    .filter({ has: page.getByText("Price", { exact: true }) })
    .textContent();
  await book
    .getByRole("button", { name: "Previous price levels", exact: true })
    .click();
  await expect
    .poll(() => rows.first().getAttribute("data-tick-id"))
    .not.toBe(firstIds[0]);
  const nextIds = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-tick-id")),
  );
  expect(new Set([...firstIds, ...nextIds]).size).toBe(20);
  await expect(order.getByLabel("Amount", { exact: true })).toHaveValue("12");
  await expect(
    order
      .locator("dl")
      .filter({ has: page.getByText("Price", { exact: true }) }),
  ).toHaveText(price!);
  await book.getByRole("button", { name: /Market · AMM/ }).click();
  await expect
    .poll(() => rows.first().getAttribute("data-tick-id"))
    .toBe(firstIds[0]);
  await expect(
    order.getByRole("tab", { name: "Swap", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await order.getByRole("tab", { name: "Limit", exact: true }).click();
  await expect(book.locator(`[data-tick-id="${selectedId}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const bookBounds = await book.boundingBox(),
    orderBounds = await order.boundingBox();
  expect(bookBounds && orderBounds).toBeTruthy();
  if (isMobile)
    expect(orderBounds!.y).toBeGreaterThan(
      bookBounds!.y + bookBounds!.height - 1,
    );
  else expect(orderBounds!.y).toBeCloseTo(bookBounds!.y, 0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("simplified-market.png"),
    fullPage: true,
  });
});

test("market waits for a user-selected price and aligns the panel tabs", async ({
  page,
  isMobile,
}) => {
  await page.goto(`/market/base/${key}`);
  const book = page.getByLabel("Yield Book", { exact: true });
  const order = page.getByLabel("Yield Order", { exact: true });
  const selectedRows = book.locator('[data-tick-id][aria-pressed="true"]');
  await expect(book.locator("[data-tick-id]")).toHaveCount(10);
  await expect(selectedRows).toHaveCount(0);
  await expect(order.getByText("Not selected", { exact: true })).toBeVisible();
  await expect(
    order.getByRole("button", { name: "Buy and Earn", exact: true }),
  ).toBeDisabled();
  const ammPrice = book
    .getByRole("button", { name: /Market · AMM/ })
    .locator("span.col-span-3");
  await expect(ammPrice).toHaveText("~ 3,000 USDC");
  await expect(ammPrice).toHaveCSS("color", "rgb(142, 152, 159)");
  const bookTabs = await book
    .getByRole("tablist", { name: "Book side" })
    .boundingBox();
  const orderTabs = await order
    .getByRole("tablist", { name: "Order action" })
    .boundingBox();
  expect(bookTabs!.height).toBe(orderTabs!.height);
  expect(bookTabs!.width).toBe(orderTabs!.width);
  if (!isMobile) expect(bookTabs!.y).toBeCloseTo(orderTabs!.y, 1);
  const tabSize = await order
    .getByRole("tab", { name: "Limit", exact: true })
    .boundingBox();
  for (const panel of [book, order]) {
    const tabs = await panel.getByRole("tab").all();
    const first = await tabs[0].boundingBox();
    for (const tab of tabs) {
      const size = await tab.boundingBox();
      expect(size!.width).toBeCloseTo(first!.width, 0);
      expect(size!.height).toBe(tabSize!.height);
    }
  }
  for (const action of ["Swap", "Rent"]) {
    await order.getByRole("tab", { name: action, exact: true }).click();
    await expect(
      order.getByText("Choose your price", { exact: true }),
    ).toBeVisible();
    await expect(selectedRows).toHaveCount(0);
  }
  await book.getByRole("tab", { name: "Sell", exact: true }).click();
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await book
    .getByRole("button", { name: "Next price levels", exact: true })
    .click();
  await expect(selectedRows).toHaveCount(0);
  await book.getByRole("button", { name: /Market · AMM/ }).click();
  await order.getByRole("tab", { name: "Limit", exact: true }).click();
  await expect(order.getByText("Not selected", { exact: true })).toBeVisible();
  await expect(selectedRows).toHaveCount(0);
});

test("simplified selection maps tick and AMM taker directions and restores Limit", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  const book = page.getByLabel("Yield Book", { exact: true }),
    order = page.getByLabel("Yield Order", { exact: true });
  await expect(book.locator('[data-tick-id][aria-pressed="true"]')).toHaveCount(
    0,
  );
  await book.locator(`[data-tick-id="${bid7}"]`).click();
  await expect(book.locator(`[data-tick-id="${bid7}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await order.getByRole("tab", { name: "Swap", exact: true }).click();
  await expect(order.getByRole("textbox", { name: /^Amount$/ })).toBeVisible();
  await expect(order.getByText("Use", { exact: true })).toBeVisible();
  await order.getByRole("tab", { name: "Rent", exact: true }).click();
  await expect(order.getByLabel("Amount", { exact: true })).toBeVisible();
  await expect(order.getByText("USDC", { exact: true }).first()).toBeVisible();
  await book.getByRole("button", { name: /Market · AMM/ }).click();
  await expect(
    order.getByRole("tab", { name: "Swap", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    order.getByText("You provide", { exact: true }).locator(".."),
  ).toContainText("USDC");
  await book.getByRole("tab", { name: "Sell", exact: true }).click();
  await expect(
    order.getByText("You provide", { exact: true }).locator(".."),
  ).toContainText("WETH");
  await order.getByRole("tab", { name: "Limit", exact: true }).click();
  await expect(book.locator(`[data-tick-id="${id7}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expect(
    book.getByRole("tab", { name: "Buy", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(book.locator(`[data-tick-id="${id7}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "USDC / WETH", exact: true }),
  ).toBeVisible();
});

test("Limit and Market AMM remain selectable without an AMM reference", async ({
  page,
}) => {
  await page.route("**/api/market-price?**", (route) =>
    route.fulfill({
      json: {
        status: "unavailable",
        source: null,
        timestamp: Date.now(),
        ammAvailable: false,
      },
    }),
  );
  await page.goto(`/market/base/${key}`);
  const book = page.getByLabel("Yield Book", { exact: true });
  const market = book.getByRole("button", { name: /Market · AMM/ });
  await expect(market).toBeEnabled();
  await expect(market).toContainText("—");
  await expect(
    page
      .getByRole("region", { name: "Market overview" })
      .getByText("Reference price", { exact: true })
      .locator(".."),
  ).toHaveText("Reference price—");
  await expect(book.locator("[data-tick-id]")).toHaveCount(10);
  await expect(page.getByLabel("Amount", { exact: true })).toBeVisible();
  await market.click();
  await expect(market).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByLabel("Yield Order", { exact: true })
      .getByRole("tab", { name: "Swap", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Market swap", { exact: true })).toBeVisible();
});

test("market startup RPC requests stay batched", async ({ page }, testInfo) => {
  await transactionRpc(page, {
    pair: true,
    tick: true,
    positions: { tickIds: [id7, bid7], use: {} },
  });
  await expect(page.locator('[data-slot="position-card"]')).toHaveCount(3);
  const requests: { methods: string[]; contracts: string[][] }[] = [];
  function functions(data: Hex): string[] {
    try {
      const aggregate = decodeFunctionData({ abi: multicall3Abi, data });
      if (aggregate.functionName === "aggregate3")
        return aggregate.args[0].flatMap((call) => functions(call.callData));
    } catch {}
    for (const abi of [protocolAbi, erc20Abi]) {
      try {
        return [decodeFunctionData({ abi, data }).functionName];
      } catch {}
    }
    return ["unknown"];
  }
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== "https://mainnet.base.org") return;
    const body = request.postDataJSON();
    const items = Array.isArray(body) ? body : [body];
    const reads = items.filter(
      (item: { method: string }) =>
        item.method.startsWith("eth_") && item.method !== "eth_sendTransaction",
    );
    if (!reads.length) return;
    requests.push({
      methods: reads.map((item: { method: string }) => item.method),
      contracts: reads.map(
        (item: { method: string; params: [{ data?: Hex }] }) =>
          item.method === "eth_call" && item.params[0].data
            ? functions(item.params[0].data)
            : [],
      ),
    });
  });
  await page.reload();
  await expect(page.locator('[data-slot="position-card"]')).toHaveCount(3);
  await expect(
    page
      .getByLabel("Yield Book", { exact: true })
      .locator('[data-status="exists"]'),
  ).toHaveCount(1);
  await expect(
    page
      .getByLabel("Limit order", { exact: true })
      .getByRole("button", { name: "Max", exact: true }),
  ).toBeEnabled();
  const summary = {
    httpRequests: requests.length,
    rpcMethods: requests.reduce(
      (sum, request) => sum + request.methods.length,
      0,
    ),
    requests,
  };
  console.log("MARKET_STARTUP_RPC", JSON.stringify(summary));
  await testInfo.attach("market-startup-rpc.json", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.length).toBeLessThanOrEqual(5);
  expect(requests.some((request) => request.methods.length > 1)).toBe(true);
  expect(
    requests
      .flatMap((request) => request.contracts)
      .some(
        (calls) =>
          calls.length === 10 && calls.every((name) => name === "getTick"),
      ),
  ).toBe(true);
});

test("home keeps complete row skeletons until metadata and images are ready", async ({
  page,
}) => {
  let releaseMetadata!: () => void;
  let releaseImage!: () => void;
  const metadataReady = new Promise<void>((resolve) => {
    releaseMetadata = resolve;
  });
  const imageReady = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  const imageUrl = "https://coin-images.coingecko.com/test-token.png";
  const [imageAddress] = configuredPairs[0].split(":");
  await page.route(metadataRoute, async (route) => {
    await metadataReady;
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json: {
        tokens: params
          .get("addresses")!
          .split(",")
          .map((address) => ({
            chainId: Number(params.get("chainId")),
            address,
            status: "available",
            ...tokenFixture(address),
            imageUrl: address === imageAddress ? imageUrl : undefined,
          })),
      },
    });
  });
  await page.route(imageUrl, async (route) => {
    await imageReady;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34"><circle cx="17" cy="17" r="17" fill="gold"/></svg>',
    });
  });
  try {
    await page.goto("/");
    const row = page.locator(
      `tr[data-market-key="eip155:8453/${configuredPairs[0]}"]`,
    );
    const link = page.locator(`a[href="/market/base/${configuredPairs[0]}"]`);
    await expect(row).toBeAttached();
    await expect(link).toHaveCount(0);
    await expect(row.locator("img")).toHaveCount(0);
    await expect(row.locator('[data-slot="skeleton"]')).toHaveCount(5);
    const before = await row.boundingBox();
    const imageRequested = page.waitForRequest(imageUrl);
    releaseMetadata();
    await imageRequested;
    await expect(link).toHaveCount(0);
    await expect(row.locator('[data-slot="skeleton"]')).toHaveCount(5);
    expect(await row.boundingBox()).toEqual(before);
    releaseImage();
    await expect(link).toBeVisible();
    const image = link.locator(`img[src="${imageUrl}"]`);
    await expect(image).toHaveCSS("opacity", "1");
    await expect(link.locator('img[src="/token.svg"]')).toHaveCount(1);
    await expect(row.locator('[data-slot="skeleton"]')).toHaveCount(0);
    expect(await row.boundingBox()).toEqual(before);
  } finally {
    releaseMetadata();
    releaseImage();
  }
});
