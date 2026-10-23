import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
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
  snappedPrice,
  humanPrice,
  tickCandidates,
  deploymentFor,
} from "../../packages/sdk/src/ethereum/index.js";
import {
  DISCOVERY_DEFAULTS,
  MAX_TICK,
  DURATIONS,
  QUERY_TIMING,
  YIELD_BOOK_LAYOUT,
} from "../../packages/sdk/src/constants.js";
import type {
  ProviderPosition,
  UsePosition,
  TickState,
} from "../../packages/sdk/src/types/index.js";
type TickOverrides = Map<bigint, Partial<TickState> | null>;
const metadataRoute = /(?:https:\/\/md\.yld\.cx|\/api\/md)\/tokens\?/;
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  key = `${a}:${b}`;
const configuredAddresses = [
  ...new Set(
    Object.keys(yieldList.markets["eip155:8453"]).flatMap((pair) =>
      pair.split(":"),
    ),
  ),
];
const directId = tickIdFor(pairIdFor(a, b), 0, -196123, 7);
const pairId = pairIdFor(a, b),
  id7 = tickIdFor(pairId, 0, -196000, 7),
  id30 = tickIdFor(pairId, 0, -196000, 30),
  bid7 = tickIdFor(pairId, 1, 196000, 7),
  bid30 = tickIdFor(pairId, 1, 196000, 30);
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
  await page.addInitScript(() => {
    const events: string[] = [];
    Object.assign(window, { testCspEvents: events });
    document.addEventListener("securitypolicyviolation", (event) =>
      events.push(event.violatedDirective),
    );
  });
  await rpc(page);
});
test("Trending reads only the ten visible USD* markets", async ({ page }) => {
  const discovered = Array.from({ length: 23 }, (_, i) => {
    const address = `0x${(i + 1).toString(16).padStart(40, "0")}`;
    return { address, ...tokenFixture(address) };
  });
  await page.route("**/api/tokens?**", (route) =>
    route.fulfill({
      json: {
        tokens:
          new URL(route.request().url()).searchParams.get("chainId") === "8453"
            ? [discovered[0], { address: b, ...tokenFixture(b) }, ...discovered]
            : [],
      },
    }),
  );
  const pairs = new Set<string>();
  const decimals = new Set<string>();
  const metadataAddresses: string[] = [];
  page.on("request", (request) => {
    if (metadataRoute.test(request.url()))
      metadataAddresses.push(
        ...new URL(request.url()).searchParams.get("addresses")!.split(","),
      );
    if (!request.url().startsWith("https://mainnet.base.org")) return;
    const payload = request.postDataJSON();
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      if (item.method !== "eth_call") continue;
      const call = item.params[0] as { data: Hex; to: string };
      let calls = [{ callData: call.data, target: call.to }];
      try {
        const batch = decodeFunctionData({
          abi: multicall3Abi,
          data: call.data,
        });
        if (batch.functionName === "aggregate3") calls = [...batch.args[0]];
      } catch {}
      for (const entry of calls) {
        if (entry.callData.startsWith("0x313ce567"))
          decimals.add(entry.target.toLowerCase());
        try {
          const decoded = decodeFunctionData({
            abi: protocolAbi,
            data: entry.callData,
          });
          if (decoded.functionName === "getPair")
            pairs.add(decoded.args.join(":").toLowerCase());
        } catch {}
      }
    }
  });
  await page.goto("/?tag=trending&network=base&ref=keep#markets");
  await expect(
    page.getByRole("button", { name: "Trending", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const links = page.getByRole("table").getByRole("link", { name: /^Open / });
  const pagination = page.getByRole("navigation", {
    name: "Market pagination",
  });
  await expect(links).toHaveCount(10);
  await expect(page.locator('table [data-slot="skeleton"]')).toHaveCount(0);
  await expect(pagination).toContainText("1–10 of 23 markets");
  await expect(
    pagination.getByRole("button", { name: "Previous" }),
  ).toBeDisabled();
  expect(
    await links.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("href")),
    ),
  ).toEqual(
    discovered
      .slice(0, 10)
      .map(({ address }) => `/market/base/${address}:${b}`),
  );
  expect([...pairs]).toEqual(
    discovered.slice(0, 10).map(({ address }) => `${address}:${b}`),
  );
  expect([...decimals].sort()).toEqual(
    [...discovered.slice(0, 10).map(({ address }) => address), b].sort(),
  );
  expect([...metadataAddresses].sort()).toEqual(
    [...discovered.map(({ address }) => address), b].sort(),
  );

  await pagination.getByRole("button", { name: "Next" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(pagination).toContainText("11–20 of 23 markets");
  await expect(page.locator('table [data-slot="skeleton"]')).toHaveCount(0);
  expect(pairs.size).toBe(20);
  expect(decimals.size).toBe(21);
  expect(metadataAddresses).toHaveLength(discovered.length + 1);
  await page.reload();
  await expect(pagination).toContainText("Page 2 of 3");
  await pagination.getByRole("button", { name: "Next" }).click();
  await expect(pagination).toContainText("21–23 of 23 markets");
  await expect(links).toHaveCount(3);
  await expect(pagination.getByRole("button", { name: "Next" })).toBeDisabled();
  await page.goBack();
  await expect(pagination).toContainText("Page 2 of 3");

  await page.getByLabel("Search markets").fill(discovered[22].symbol);
  await expect(links).toHaveCount(1);
  await expect(pagination).toContainText("Page 1 of 1");
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  expect(new URL(page.url()).searchParams.get("ref")).toBe("keep");
  expect(new URL(page.url()).hash).toBe("#markets");
  await page.getByLabel("Search markets").clear();
  await pagination.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "YieldList", exact: true }).click();
  await expect(links).toHaveCount(6);
  await expect(pagination).toContainText("Page 1 of 1");
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);

  await page.getByRole("button", { name: "Trending", exact: true }).click();
  await pagination.getByRole("button", { name: "Next" }).click();
  await page
    .getByRole("combobox", { name: "Market duration", exact: true })
    .click();
  await page.getByRole("option", { name: "30D", exact: true }).click();
  await expect(pagination).toContainText("Page 1 of 3");
  await pagination.getByRole("button", { name: "Next" }).click();
  await page.getByRole("combobox", { name: "Network", exact: true }).click();
  await page.getByRole("option", { name: "Robinhood", exact: true }).click();
  await expect(
    page.getByText("No matching markets", { exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
});

for (const tag of ["all", "trending"]) {
  test(`${tag} searches shared metadata by symbol, name, address and pair`, async ({
    page,
  }) => {
    await page.route("**/api/tokens?**", (route) =>
      route.fulfill({
        json: {
          tokens: [
            { address: a, symbol: "DISCOVERY", name: "Discovery identity" },
          ],
        },
      }),
    );
    await page.goto(`/?tag=${tag}&network=base&search=WETH%2FUSDC`);
    const link = page.getByRole("link", {
      name: "Open WETH / USDC",
      exact: true,
    });
    await expect(link).toBeVisible();
    for (const search of [
      "weth",
      "USDC | WETH",
      "Wrapped Ether USD Coin",
      a,
      key,
    ]) {
      await page.getByLabel("Search markets").fill(search);
      await expect(link).toBeVisible();
    }
    await expect(link).toHaveAttribute("href", `/market/base/${key}`);
  });

  test(`${tag} uses standard metadata fallback for search and onchain data in visible rows`, async ({
    page,
  }) => {
    await page.route(metadataRoute, (route) => route.fulfill({ status: 503 }));
    await page.route("**/api/tokens?**", (route) =>
      route.fulfill({ json: { tokens: [{ address: a }] } }),
    );
    await page.goto(`/?tag=${tag}&network=base&search=${a}`);
    const link = page.getByRole("link", {
      name: "Open WETH / USDC",
      exact: true,
    });
    await expect(link).toBeVisible();
    for (const search of [
      key,
      `${a.slice(0, 6)}…${a.slice(-4)}/${b.slice(0, 6)}…${b.slice(-4)}`,
    ]) {
      await page.getByLabel("Search markets").fill(search);
      await expect(link).toBeVisible();
    }
  });
}

test("Trending keeps the requested page while loading and offers retry on discovery failure", async ({
  page,
}) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  let unavailable = true;
  await page.route("**/api/tokens?**", async (route) => {
    await ready;
    await route.fulfill(
      unavailable
        ? { status: 503, json: { tokens: [] } }
        : { json: { tokens: [{ address: a, ...tokenFixture(a) }] } },
    );
  });
  await page.goto("/?tag=trending&page=99&network=base");
  await expect(
    page.getByRole("status").filter({ hasText: "Loading trending markets…" }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("page")).toBe("99");
  release();
  await expect(
    page.getByText("Trending markets unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("page")).toBe("99");
  unavailable = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Market pagination" }),
  ).toContainText("Page 1 of 1");
  await expect
    .poll(() => new URL(page.url()).searchParams.has("page"))
    .toBe(false);
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
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  const ask = page.getByRole("group", { name: "Ask price levels" });
  await ask.evaluate((element) => {
    element.scrollTop = 0;
  });
  bookReady = new Promise<void>((resolve) => (releaseBook = resolve));
  await page.getByRole("button", { name: "Refresh discovery" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh discovery" }),
  ).toBeDisabled();
  await expect(loading).toHaveCount(0);
  await expect(
    page.getByLabel("Provide liquidity", { exact: true }),
  ).toContainText(humanPrice(priceAtTick(-196000), 18, 6));
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
  releaseBook();
  await expect(
    page.getByRole("button", { name: "Refresh discovery" }),
  ).toBeEnabled();
  expect(await ask.evaluate((element) => element.scrollTop)).toBe(0);
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
  const description = page.getByText("Creating a market unlocks liquidity", {
    exact: false,
  });
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
  const pairs: string[] = [],
    ticks: bigint[] = [];
  const requests: string[][] = [];
  page.on("request", (request) => {
    if (
      request.url() !== "https://mainnet.base.org/" &&
      request.url() !== "https://mainnet.base.org"
    )
      return;
    const payload = request.postDataJSON();
    const items = Array.isArray(payload) ? payload : [payload];
    requests.push(items.map((item) => item.method));
    for (const item of items) {
      if (item.method !== "eth_call") continue;
      const data = item.params[0].data as Hex;
      let calls = [data];
      try {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName === "aggregate3")
          calls = decoded.args[0].map((call) => call.callData);
      } catch {}
      for (const data of calls) {
        try {
          const call = decodeFunctionData({ abi: protocolAbi, data });
          if (call.functionName === "getPair") pairs.push(call.args.join(":"));
          if (call.functionName === "getTick") ticks.push(call.args[0]);
        } catch {}
      }
    }
  });
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
  await expect(page.locator('table [data-slot="skeleton"]')).toHaveCount(0);
  const configured = Object.entries(yieldList.markets["eip155:8453"]);
  expect(requests.flat()).not.toContain("eth_getCode");
  expect(pairs).toHaveLength(configured.length);
  expect(new Set(pairs).size).toBe(configured.length);
  const expected = (duration: 7 | 30) =>
    configured
      .flatMap(([key, config]) => {
        const [tokenA, tokenB] = key.split(":") as [typeof a, typeof b];
        return tickCandidates(
          pairIdFor(tokenA, tokenB),
          "baseTick" in config ? config.baseTick : 0,
          config.stepTicks,
        )
          .filter((tick) => tick.durationDays === duration)
          .map((tick) => tick.id);
      })
      .sort();
  expect([...ticks].sort()).toEqual(expected(7));
  ticks.length = 0;
  await page
    .getByRole("combobox", { name: "Market duration", exact: true })
    .click();
  await page.getByRole("option", { name: "30D", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Market duration", exact: true }),
  ).toContainText("30D");
  await expect.poll(() => ticks.length).toBe(expected(30).length);
  await expect(page.locator('table [data-slot="skeleton"]')).toHaveCount(0);
  expect([...ticks].sort()).toEqual(expected(30));
  expect(pairs).toHaveLength(configured.length);
});

test("market search, tags, network isolation and responsive layout", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "YieldList", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
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
  const memePairs = Object.entries(yieldList.markets["eip155:8453"])
    .filter(([, config]) => config.tags.includes("meme"))
    .map(([pair]) => `/market/base/${pair}`);
  const memeMarkets = page
    .getByRole("region", { name: "Markets", exact: true })
    .getByRole("link", { name: /^Open / });
  await expect(memeMarkets).toHaveCount(memePairs.length);
  expect(
    await memeMarkets.evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")),
    ),
  ).toEqual(memePairs);
  await page.getByLabel("Search markets").fill("WETH");
  await expect(page.getByText("No matching markets")).toBeVisible();
  await page.getByRole("button", { name: "YieldList", exact: true }).click();
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
    {
      name: "yld.network",
      value: "ethereum",
      url: testInfo.project.use.baseURL!,
    },
  ]);
  await page.goto("/?search=WETH&tag=blue-chip&duration=30&network=base");
  const network = page.getByRole("combobox", { name: "Network", exact: true });
  const search = page.getByRole("textbox", { name: "Search markets" });
  const duration = page.getByRole("combobox", {
    name: "Market duration",
    exact: true,
  });
  await expect(network).toContainText("Base");
  await expect(search).toHaveValue("WETH");
  await expect(duration).toContainText("30D");
  await expect(
    page.getByRole("button", { name: "Blue-chip", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("link", { name: "Open WETH / USDC", exact: true }),
  ).toHaveAttribute("href", /market\/base\//);
  await page.reload();
  await expect(network).toContainText("Base");
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
  for (const [title, color] of [
    ["01 · Provide liquidity", "rgb(231, 185, 77)"],
    ["02 · Rent or swap", "rgb(211, 195, 255)"],
    ["03 · Earn or trade", "rgb(0, 255, 76)"],
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
  await page.getByRole("option", { name: "Ethereum", exact: true }).click();
  await expect(page).toHaveURL(/network=ethereum/);
  await expect(duration).toContainText("30D");
  await page.goBack();
  await expect(network).toContainText("Base");
});

for (const rememberedWallet of [false, true]) {
  test(`Safe auto-connects after a delayed handshake${rememberedWallet ? " over a remembered browser wallet" : " on first visit"}`, async ({
    page,
    baseURL,
    context,
  }) => {
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
  });
}

test("wallet options hide unavailable browser and Safe providers", async ({
  page,
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
});

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
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await expect(
    page
      .getByLabel("Provide liquidity", { exact: true })
      .getByRole("button", { name: "Switch network" }),
  ).toBeVisible();
  await page
    .getByLabel("Provide liquidity", { exact: true })
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
  await page.goto(
    "/?network=ethereum&search=WETH&duration=30&ref=test#markets",
  );
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
  ).toContainText("30D");
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

async function chooseBaseTick(page: Page, tick: number) {
  await page.getByRole("combobox", { name: "Base tick", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(7);
  await page.getByRole("option", { name: String(tick), exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Base tick", exact: true }),
  ).toContainText(String(tick));
}
async function expectDiscoveryGrid(
  page: Page,
  center: number,
  pair = pairId,
  duration: (typeof DURATIONS)[number] = DURATIONS[0],
) {
  const identities = tickCandidates(pair, center, DISCOVERY_DEFAULTS.stepTicks);
  const visible = identities
    .filter((tick) => tick.durationDays === duration)
    .map((tick) => tick.id.toString())
    .sort();
  await expect
    .poll(async () =>
      page
        .locator(".yield-book [data-tick-id]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-tick-id")!).sort(),
        ),
    )
    .toEqual(visible);
  await expect(
    page.getByText(`${identities.length} ticks checked`, { exact: false }),
  ).toBeVisible();
}

test("Base tick drives the compact reference price, preserves selection and refresh scroll, and keeps inversion canonical", async ({
  page,
}, testInfo) => {
  const overrides: TickOverrides = new Map();
  await rpc(page, true, overrides);
  await page.clock.install();
  await page.goto(`/market/base/${key}?ref=keep&tag=all#book`);
  const center = -196000,
    next = center + DISCOVERY_DEFAULTS.stepTicks;
  await expectDiscoveryGrid(page, center);
  const referenceRow = page.getByRole("group", {
    name: "Reference price and base tick",
    exact: true,
  });
  const overview = page.getByRole("region", { name: "Market overview" });
  await expect(referenceRow).toContainText("3.08K USDC");
  await expect(overview).toContainText("3.08K USDC");
  const otherLevel = page
    .getByRole("group", { name: "Ask price levels" })
    .getByRole("button")
    .first();
  await otherLevel.click();
  await expect(referenceRow).toContainText("3.08K USDC");
  await expect(overview).toContainText("3.08K USDC");
  await page.evaluate(() =>
    Object.assign(window, { baseTickNavigationMarker: true }),
  );
  const selector = page.getByRole("combobox", {
    name: "Base tick",
    exact: true,
  });
  await selector.click();
  await expect(page.getByRole("option")).toHaveText([
    String(center - DISCOVERY_DEFAULTS.stepTicks * 100),
    String(center - DISCOVERY_DEFAULTS.stepTicks * 10),
    String(center - DISCOVERY_DEFAULTS.stepTicks),
    String(center),
    String(next),
    String(center + DISCOVERY_DEFAULTS.stepTicks * 10),
    String(center + DISCOVERY_DEFAULTS.stepTicks * 100),
  ]);
  await page.getByRole("option", { name: String(center), exact: true }).click();
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await page.getByLabel("Amount", { exact: true }).fill("2");
  await chooseBaseTick(page, next);
  await expectDiscoveryGrid(page, next);
  await expect(referenceRow).toContainText("3.4K USDC");
  await expect(overview).toContainText("3.4K USDC");
  const url = new URL(page.url());
  expect(url.searchParams.get("baseTick")).toBe(String(next));
  expect(url.searchParams.get("ref")).toBe("keep");
  expect(url.searchParams.get("tag")).toBe("all");
  expect(url.hash).toBe("#book");
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { baseTickNavigationMarker: boolean })
          .baseTickNavigationMarker,
    ),
  ).toBe(true);
  await expect(page.locator(`[data-tick-id="${id7}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("2");
  const groups = [
    page.getByRole("group", { name: "Ask price levels" }),
    page.getByRole("group", { name: "Bid price levels" }),
  ];
  for (const group of groups)
    await group.evaluate((element) => {
      element.scrollTop = 0;
    });
  overrides.set(id7, { availableSupply: 500n * 10n ** 18n });
  await page.clock.fastForward(QUERY_TIMING.liveRefresh + 1000);
  await expect(page.locator(`[data-tick-id="${id7}"]`)).toContainText(
    "500 WETH",
  );
  await expectDiscoveryGrid(page, next);
  for (const group of groups)
    expect(await group.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(page.locator(`[data-tick-id="${id7}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expect(selector).toContainText(String(next));
  await expect(referenceRow).toContainText("0.000293981 WETH");
  await expect(overview).toContainText("0.000293981 WETH");
  expect(new URL(page.url()).searchParams.get("baseTick")).toBe(String(next));
  await expect(page.locator(`[data-tick-id="${id7}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await page
    .locator(".yield-book")
    .screenshot({ path: testInfo.outputPath("yield-book-base-tick.png") });
  await page
    .getByRole("group", { name: "Reference price and base tick", exact: true })
    .screenshot({ path: testInfo.outputPath("base-tick-reference.png") });
  await page
    .getByRole("group", { name: "Book term" })
    .getByRole("button", { name: "30D", exact: true })
    .click();
  await expectDiscoveryGrid(page, next, pairId, DURATIONS[1]);
  await expect(page.getByText("Not selected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Term", exact: true }),
  ).toContainText("30D");
  await expect(referenceRow).toContainText("3.4K USDC");
  await expect(overview).toContainText("3.4K USDC");
});

test("Base tick shifts by one step, removes the default override and follows Back/Forward, reload and shared URLs", async ({
  page,
}) => {
  const center = -196000,
    step = DISCOVERY_DEFAULTS.stepTicks;
  await page.goto(`/market/base/${key}?ref=keep`);
  await chooseBaseTick(page, center + step);
  await expectDiscoveryGrid(page, center + step);
  await chooseBaseTick(page, center);
  await expectDiscoveryGrid(page, center);
  expect(new URL(page.url()).searchParams.has("baseTick")).toBe(false);
  expect(new URL(page.url()).searchParams.get("ref")).toBe("keep");
  await page.goBack();
  await expectDiscoveryGrid(page, center + step);
  await expect(
    page.getByRole("combobox", { name: "Base tick", exact: true }),
  ).toContainText(String(center + step));
  await page.goForward();
  await expectDiscoveryGrid(page, center);
  await chooseBaseTick(page, center - step);
  await expectDiscoveryGrid(page, center - step);
  const sharedUrl = page.url();
  await page.reload();
  await expectDiscoveryGrid(page, center - step);
  await page.goto(`/market/base/${key}`);
  await expectDiscoveryGrid(page, center);
  await page.goto(sharedUrl);
  await expectDiscoveryGrid(page, center - step);
});

for (const direction of [0, 1] as const) {
  test(`Base tick clears an out-of-range direction ${direction} selection without resurrecting it on Back`, async ({
    page,
  }) => {
    const center = -196000,
      step = DISCOVERY_DEFAULTS.stepTicks;
    const canonicalEdge = center - DISCOVERY_DEFAULTS.radius * step;
    const id = tickIdFor(
      pairId,
      direction,
      direction === 0 ? canonicalEdge : -canonicalEdge,
      DURATIONS[0],
    );
    await page.goto(`/market/base/${key}`);
    await page.locator(`[data-tick-id="${id}"]`).click();
    await chooseBaseTick(page, center + step);
    await expectDiscoveryGrid(page, center + step);
    await expect(page.getByText("Not selected", { exact: true })).toBeVisible();
    await page.goBack();
    await expectDiscoveryGrid(page, center);
    await expect(page.locator(`[data-tick-id="${id}"]`)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
}

test("markets without a reference price show the warning only at the default discovery center", async ({
  page,
}) => {
  const btc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
  const noReferencePair = `${b}:${btc}`,
    pair = pairIdFor(b, btc),
    center = DISCOVERY_DEFAULTS.baseTick,
    step = DISCOVERY_DEFAULTS.stepTicks;
  await page.goto(`/market/base/${noReferencePair}`);
  await expectDiscoveryGrid(page, center, pair);
  const warning = page.getByText(
    /^⚠️ Unlisted token · Review token compatibility before interacting\.?$/,
  );
  await expect(warning).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Base tick", exact: true }),
  ).toContainText(String(center));
  await chooseBaseTick(page, center + step);
  await expectDiscoveryGrid(page, center + step, pair);
  await expect(warning).toHaveCount(0);
  await chooseBaseTick(page, center);
  await expectDiscoveryGrid(page, center, pair);
  expect(new URL(page.url()).searchParams.has("baseTick")).toBe(false);
  await page.goto(
    `/market/base/${noReferencePair}?baseTick=${step * 3}&ref=shared`,
  );
  await expectDiscoveryGrid(page, step * 3, pair);
  await page.reload();
  await expectDiscoveryGrid(page, step * 3, pair);
});

test("an off-grid URL falls back safely and grid bounds disable invalid neighbor options", async ({
  page,
}) => {
  // The complete invalid-input matrix belongs to the URL parser unit tests.
  await page.goto(`/market/base/${key}?baseTick=-195001&ref=keep`);
  await expectDiscoveryGrid(page, -196000);
  await expect(
    page.getByRole("combobox", { name: "Base tick", exact: true }),
  ).toContainText("-196000");
  const step = DISCOVERY_DEFAULTS.stepTicks,
    upper = Math.floor(MAX_TICK / step) * step;
  for (const center of [upper, -upper]) {
    await page.goto(`/market/base/${key}?baseTick=${center}`);
    await expectDiscoveryGrid(page, center);
    await page
      .getByRole("combobox", { name: "Base tick", exact: true })
      .click();
    await expect(page.getByRole("option")).toHaveCount(7);
    await expect(
      page.getByRole("option", {
        name: String(center + (center > 0 ? step : -step)),
        exact: true,
      }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
  }
});

test("Yield Book shows five rows and scrolls best Ask and Bid next to the reference price", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  const ask = page.getByRole("group", { name: "Ask price levels" });
  const bid = page.getByRole("group", { name: "Bid price levels" });
  await expectDiscoveryGrid(page, -196000);
  const expectPriceOrder = async () => {
    for (const side of [ask, bid]) {
      const prices = await side
        .getByRole("button")
        .evaluateAll((rows) =>
          rows.map((row) =>
            Number(row.firstElementChild!.textContent!.replaceAll(",", "")),
          ),
        );
      expect(prices).toEqual([...prices].sort((a, b) => b - a));
    }
  };
  await expectPriceOrder();
  const expectViewport = async (askId: bigint, bidId: bigint) => {
    for (const [index, side] of [ask, bid].entries()) {
      const viewport = await side.evaluate(
        (element, id) => {
          const row = element.querySelector(`[data-tick-id="${id}"]`)!;
          const bounds = element.getBoundingClientRect(),
            rowBounds = row.getBoundingClientRect();
          return {
            height: element.clientHeight,
            rowHeight: rowBounds.height,
            top: rowBounds.top - bounds.top,
            bottom: rowBounds.bottom - bounds.top,
            available: row.getAttribute("data-available"),
          };
        },
        (index === 0 ? askId : bidId).toString(),
      );
      expect(viewport.height / viewport.rowHeight).toBe(
        YIELD_BOOK_LAYOUT.visibleRows,
      );
      expect(viewport.available).toBe("true");
      expect(index === 0 ? viewport.bottom : viewport.top).toBeCloseTo(
        index === 0 ? viewport.height : 0,
      );
    }
  };
  await expectViewport(id7, bid7);
  const refresh = page.getByRole("button", { name: "Refresh discovery" });
  await expect(refresh.locator("svg")).toBeVisible();
  await expect(refresh).toHaveText("");
  for (const side of [ask, bid])
    await side.evaluate((element) => {
      element.scrollTop = 0;
    });
  await page
    .getByRole("group", { name: "Book term" })
    .getByRole("button", { name: "30D", exact: true })
    .click();
  await expectViewport(id30, bid30);
  await expectPriceOrder();
  await page.locator(`[data-tick-id="${id30}"]`).click();
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expectViewport(bid30, id30);
  await expectPriceOrder();
  await expect(page.locator(`[data-tick-id="${id30}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

for (const empty of ["ask", "bid", "both", "missing"] as const) {
  test(`Yield Book scrolls ${empty} to the end when no executable liquidity is available`, async ({
    page,
  }) => {
    const overrides: TickOverrides = new Map();
    if (empty !== "bid")
      overrides.set(id7, { availableSupply: 0n, activeWorking: 10n ** 18n });
    if (empty !== "ask")
      overrides.set(bid7, { availableSupply: 0n, activeWorking: 10n ** 6n });
    await rpc(page, empty !== "missing", overrides);
    await page.goto(`/market/base/${key}`);
    await expect(page.locator(`[data-tick-id="${id7}"]`)).toHaveCount(1);
    for (const [side, id] of [
      ["ask", id7],
      ["bid", bid7],
    ] as const) {
      const group = page.getByRole("group", {
        name: `${side === "ask" ? "Ask" : "Bid"} price levels`,
      });
      const position = await group.evaluate((element, id) => {
        const row = element.querySelector(`[data-tick-id="${id}"]`)!;
        return {
          scroll: element.scrollTop,
          end: element.scrollHeight - element.clientHeight,
          top:
            row.getBoundingClientRect().top -
            element.getBoundingClientRect().top,
          bottom:
            row.getBoundingClientRect().bottom -
            element.getBoundingClientRect().top,
          height: element.clientHeight,
        };
      }, id.toString());
      if (empty === "both" || empty === "missing" || empty === side)
        expect(position.scroll).toBe(position.end);
      else
        expect(side === "ask" ? position.bottom : position.top).toBeCloseTo(
          side === "ask" ? position.height : 0,
        );
    }
  });
}

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
  await expect(
    page.getByRole("button", { name: "Preview Create Market" }),
  ).toHaveCount(0);
});

test("empty edge levels select exact Ask and Bid identities, while off-grid access stays outside the app", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  const edgeTick =
    -196000 + DISCOVERY_DEFAULTS.radius * DISCOVERY_DEFAULTS.stepTicks;
  const emptyAsk = tickIdFor(pairId, 0, edgeTick, 7);
  const emptyBid = tickIdFor(pairId, 1, -edgeTick, 30);
  const supply = page.getByLabel("Provide liquidity", { exact: true });
  await page.locator(`[data-tick-id="${emptyAsk}"]`).click();
  await expect(page.locator(`[data-tick-id="${emptyAsk}"]`)).toHaveAttribute(
    "data-status",
    "missing",
  );
  await expect(page.locator(`[data-tick-id="${emptyAsk}"]`)).toContainText(
    "0 WETH",
  );
  await expect(supply).toContainText(humanPrice(priceAtTick(edgeTick), 18, 6));
  await expect(
    supply.getByRole("button", { name: "Preview Provide", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("You receive")).toHaveCount(0);
  await page
    .getByRole("group", { name: "Book term" })
    .getByRole("button", { name: "30D", exact: true })
    .click();
  await page.locator(`[data-tick-id="${emptyBid}"]`).click();
  await expect(
    page.getByRole("tab", { name: "Bid · USDC", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(supply).toContainText(
    humanPrice(priceAtTick(-edgeTick), 6, 18, true),
  );
  await page.getByText("Price details", { exact: true }).click();
  await expect(
    supply.getByText(String(-edgeTick), { exact: true }),
  ).toBeVisible();
  await expect(
    supply.getByText(emptyBid.toString(), { exact: true }),
  ).toBeVisible();
  await expect(page.locator(`[data-tick-id="${directId}"]`)).toHaveCount(0);
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
  await expect(
    page
      .getByLabel("Provide liquidity", { exact: true })
      .getByText("Price", { exact: true }),
  ).toBeVisible();
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

test("market overview and inversion preserve canonical economics", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  const canonical = await page
    .locator('link[rel="canonical"]')
    .getAttribute("href");
  const overview = page.getByRole("region", { name: "Market overview" });
  await expect(
    overview.getByText("Provide or rent WETH or USDC at your price."),
  ).toBeVisible();
  await expect(overview.getByLabel("WETH crowned token")).toBeVisible();
  await expect(overview.getByText("1,000 WETH", { exact: true })).toBeVisible();
  await expect(overview.getByText("1,000 USDC", { exact: true })).toBeVisible();
  await expect(overview.getByText("0.07%", { exact: true })).toBeVisible();
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.getByText("Price details", { exact: true }).click();
  await expect(
    page
      .getByLabel("Provide liquidity", { exact: true })
      .getByText("-196000", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expect(overview.getByLabel("USDC crowned token")).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    canonical!,
  );
  await expect(
    page.getByRole("tab", { name: "Bid · WETH", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1");
  await expect(
    page
      .getByLabel("Provide liquidity", { exact: true })
      .getByText("-196000", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expect(
    page.getByLabel("Provide liquidity", { exact: true }),
  ).toContainText(humanPrice(priceAtTick(-196000), 18, 6));
  await page.getByRole("tab", { name: "Bid · USDC", exact: true }).click();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page.locator(`[data-tick-id="${bid7}"]`).click();
  await page.getByText("Price details", { exact: true }).click();
  await expect(page.getByText("196000", { exact: true })).toBeVisible();
  await page.getByLabel("Amount", { exact: true }).fill("12.123456");
  await page.getByRole("tab", { name: "Swap now", exact: true }).click();
  await page.getByLabel("You receive").fill("20");
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
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

test("direction and term changes clear incompatible selections and amounts", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
  await page.locator(`[data-tick-id="${id7}"]`).click();
  const amount = page.getByLabel("Amount", { exact: true });
  await amount.fill("2");
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await expect(amount).toHaveValue("2");
  await page.getByRole("tab", { name: "Bid · USDC", exact: true }).click();
  await expect(amount).toHaveValue("");
  await expect(page.locator(`[data-tick-id="${id7}"]`)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByText("Not selected", { exact: true })).toBeVisible();
  await page.locator(`[data-tick-id="${bid7}"]`).click();
  await amount.fill("0.0000001");
  await expect(
    page.getByRole("alert").filter({ hasText: "6 decimal places" }),
  ).toBeVisible();
  await amount.fill("100");
  await page.getByRole("combobox", { name: "Term", exact: true }).click();
  await page.getByRole("option", { name: "30D", exact: true }).click();
  await expect(amount).toHaveValue("");
  await expect(page.getByText("Not selected", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Book term" })
      .getByRole("button", { name: "30D", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("row utilization, gold borders and overview Yield follow the selected side and tabs", async ({
  page,
  isMobile,
}, testInfo) => {
  await rpc(
    page,
    true,
    new Map([
      [
        id7,
        {
          availableSupply: 750n * 10n ** 18n,
          activeWorking: 250n * 10n ** 18n,
        },
      ],
      [
        bid7,
        { availableSupply: 250n * 10n ** 6n, activeWorking: 750n * 10n ** 6n },
      ],
    ]),
  );
  await page.goto(`/market/base/${key}`);
  const overview = page.getByRole("region", { name: "Market overview" });
  const ask = page.locator(`[data-tick-id="${id7}"]`);
  const bid = page.locator(`[data-tick-id="${bid7}"]`);
  for (const [row, percentage, side] of [
    [ask, 25, "ask"],
    [bid, 75, "bid"],
  ] as const) {
    const fill = row.locator('span[aria-hidden="true"]');
    await expect(fill).toHaveCSS("right", "0px");
    await expect
      .poll(() =>
        fill.evaluate((element) => {
          const parent = element.parentElement!;
          return (
            (element.getBoundingClientRect().width / parent.clientWidth) * 100
          );
        }),
      )
      .toBeCloseTo(percentage, 1);
    await expect(fill).toHaveAttribute(
      "style",
      new RegExp(`var\\(--${side}-surface\\)`),
    );
    if (!isMobile) {
      await row.hover();
      await expect(row).toHaveCSS("border-color", "rgb(231, 185, 77)");
      await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");
    await expect(row).toHaveCSS("border-color", "rgb(231, 185, 77)");
    await expect(row).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(
      overview.getByText(`${side === "ask" ? "Ask" : "Bid"} Yield · 7D`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      overview.getByText(side === "ask" ? "0.1782%" : "2.9935%", {
        exact: true,
      }),
    ).toBeVisible();
  }
  const empty = page
    .getByRole("group", { name: "Bid price levels" })
    .getByRole("button")
    .last();
  await empty.click();
  await expect(empty.locator('span[aria-hidden="true"]')).toHaveCount(0);
  await expect(overview.getByText("—", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Ask · WETH", exact: true }).click();
  await expect(empty).toHaveAttribute("aria-pressed", "false");
  await expect(
    overview.getByText("Ask Yield · 7D", { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText("0.1782%", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Bid · USDC", exact: true }).click();
  await expect(
    overview.getByText("Bid Yield · 7D", { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText("2.9935%", { exact: true })).toBeVisible();
  await bid.click();
  await page.getByRole("button", { name: /^Invert displayed pair/ }).click();
  await expect(
    overview.getByText("Ask Yield · 7D", { exact: true }),
  ).toBeVisible();
  await expect(overview.getByText("2.9935%", { exact: true })).toBeVisible();
  await expect(bid.locator('span[aria-hidden="true"]')).toHaveAttribute(
    "style",
    /var\(--ask-surface\)/,
  );
  await ask.scrollIntoViewIfNeeded();
  await bid.scrollIntoViewIfNeeded();
  await page
    .locator(".yield-book")
    .screenshot({ path: testInfo.outputPath("yield-book-utilization.png") });
});

test("selected ticks refresh availability and Yield without losing entered amounts", async ({
  page,
}) => {
  const overrides: TickOverrides = new Map();
  await rpc(page, true, overrides);
  await page.clock.install();
  await page.goto(`/market/base/${key}`);
  await page
    .locator('.yield-book button[data-status="exists"]')
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
});

test("selected missing levels become available for Supply after discovery refresh without losing amounts", async ({
  page,
}) => {
  const newTick = -197000;
  const newId = tickIdFor(pairId, 0, newTick, 7);
  const overrides: TickOverrides = new Map([[newId, null]]);
  await rpc(page, true, overrides);
  await page.clock.install();
  await page.goto(`/market/base/${key}`);
  const row = page.locator(`[data-tick-id="${newId}"]`);
  await row.click();
  await expect(row).toContainText("0 WETH");
  await page.getByLabel("Amount", { exact: true }).fill("3");
  await expect(
    page.getByRole("button", { name: "Preview Provide", exact: true }),
  ).toBeVisible();
  overrides.set(newId, {
    priceX128: priceAtTick(newTick),
    availableSupply: 25n * 10n ** 18n,
  });
  await page.clock.fastForward(QUERY_TIMING.liveRefresh + 1000);
  await expect(row).toHaveAttribute("data-status", "exists");
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(row).toContainText("25 WETH");
  await expect(
    page.getByRole("button", { name: "Preview Provide", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("3");
});

test("home branding and market overview", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Liquidity, on your terms." }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "yld.cx", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Open. Permissionless. Immutable.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Telegram", exact: true }),
  ).toHaveAttribute("href", "https://t.me/yld_cx");
  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundImage,
  );
  expect(background.match(/linear-gradient/g)).toHaveLength(2);
  await page.screenshot({
    path: testInfo.outputPath("home.png"),
    fullPage: true,
  });
  await page.goto(`/market/base/${key}`);
  await expect(
    page
      .getByRole("region", { name: "Market overview" })
      .getByText("1,000 WETH", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("market.png"),
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
  const failedRow = page.locator(`[data-tick-id="${id7}"]`);
  await expect(failedRow).toHaveAttribute("data-status", "failed");
  await expect(failedRow).toContainText("Read failed");
  await expect(failedRow).not.toContainText("0 WETH");
  await failedRow.click();
  await expect(
    page.getByRole("button", { name: "Preview Provide", exact: true }),
  ).toBeDisabled();
  const overview = page.getByRole("region", { name: "Market overview" });
  // The selected configured price remains known even when its liquidity read fails.
  await expect(overview.getByText("Incomplete", { exact: true })).toHaveCount(
    3,
  );
  await expect(
    page.getByText("New · No liquidity", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("No liquidity yet", { exact: true })).toHaveCount(
    0,
  );
});

test("new markets allow Provide directly and retain standalone Create Market", async ({
  page,
}) => {
  await rpc(page, false);
  await page.goto(`/market/base/${key}`);
  const overview = page.getByRole("region", { name: "Market overview" });
  await expect(
    overview.getByText("An open market, ready for its first provider."),
  ).toBeVisible();
  await expect(overview.getByText("3.08K USDC", { exact: true })).toBeVisible();
  await expect(
    overview.getByText("Preview market", { exact: true }),
  ).toBeVisible();
  await expect(
    overview.getByText("New · No liquidity", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Provide liquidity" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Choose your price" }),
  ).toBeVisible();
  const count = DISCOVERY_DEFAULTS.radius * 2 + 1;
  const ask = page.getByRole("group", { name: "Ask price levels" });
  const bid = page.getByRole("group", { name: "Bid price levels" });
  await expect(ask.getByRole("button")).toHaveCount(count);
  await expect(bid.getByRole("button")).toHaveCount(count);
  await expect(page.locator('.yield-book [data-status="missing"]')).toHaveCount(
    count * 2,
  );
  await expect(
    page.getByText(`${count * 2 * DURATIONS.length} ticks checked`, {
      exact: false,
    }),
  ).toBeVisible();
  const empty = ask.getByRole("button").last();
  await empty.click();
  await expect(empty).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "No liquidity yet" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Telegram group", exact: true }),
  ).toHaveAttribute("href", "https://t.me/yld_group");
  await expect(
    page.getByLabel("Provide liquidity", { exact: true }),
  ).not.toContainText("Not selected");
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await expect(
    page.getByRole("button", { name: "Preview Provide", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Preview Create Market", exact: true }),
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

// Runtime fixture includes the deployed FEE_TO immutable. Verification stays enabled.
const protocolRuntime = readFileSync(
  new URL("../fixtures/protocol-runtime.hex", import.meta.url),
  "utf8",
).trim() as Hex;
async function openProvidePreview(page: Page, selectedId = id7) {
  await page.locator(`[data-tick-id="${selectedId}"]`).click();
  await page.getByLabel("Amount", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Preview Provide", exact: true })
    .click();
}
async function transactionRpc(
  page: Page,
  options: {
    pair: boolean;
    tick: boolean;
    direction?: 0 | 1;
    allowance?: bigint;
    reject?: boolean;
    fail?: boolean;
    positions?: {
      provider?: Partial<ProviderPosition>;
      use?: Partial<UsePosition>;
    };
    balance?: bigint;
    atomic?: "supported" | "unsupported" | "missing" | "safe";
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
                  ? [selectedId]
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
              tickId === bid7 || tickId === bid30
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
        result = {
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
        dialog.getByRole("button", { name: "Confirm Provide", exact: true }),
      ).toBeVisible();
      expect(state.writes).toHaveLength(0);
      await dialog
        .getByRole("button", { name: "Confirm Provide", exact: true })
        .click();
      await expect(
        dialog.getByText("Confirmed ✅", { exact: true }),
      ).toBeVisible();
      expect(state.writes).toEqual([
        [
          ...(!pair ? ["createPair"] : []),
          ...(!tick ? ["createTick"] : []),
          "supply",
        ],
      ]);
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([["supply"]]);
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
    dialog.getByText("Estimated Yield", { exact: true }),
  ).toBeVisible();
  expect(state.writes).toHaveLength(0);
  state.fail = false;
  await confirm.click();
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
  await transactionRpc(page, { pair: true, tick: true, positions: {} });
  for (const path of [`/market/base/${key}`, "/orders"]) {
    await page.goto(path);
    const card = page.locator('[data-slot="position-card"]').first();
    await expect(card.getByText("Available", { exact: true })).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Preview Withdraw" }),
    ).toBeEnabled();
    await expect(card.getByText("Total Active principal")).toBeHidden();
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
    await expect(card.getByText("Total Active principal")).toBeVisible();
    await expect(card.getByText(a, { exact: true })).toBeVisible();
    await details.press("Enter");
    await expect(card.getByText("Total Active principal")).toBeHidden();
    await page.evaluate(() => {
      (
        window as unknown as { testWallet: { chain: (chain: string) => void } }
      ).testWallet.chain("0x1");
    });
    const switchNetwork = card.getByRole("button", { name: "Switch network" });
    await expect(switchNetwork).toHaveCount(1);
    await expect(card.getByText("Your wallet is on Ethereum.")).toHaveCount(1);
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
      "Withdraw principal",
      "Receive principal now",
      "Move to Resolving",
      "Unvested Yield forfeited",
    ])
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    expect(state.simulations.length - simulations).toBe(1);
    await dialog
      .getByRole("button", { name: "Confirm Withdraw", exact: true })
      .click();
    await expect(
      dialog.getByText("Confirmed ✅", { exact: true }),
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([["collect"]]);
  state.settlement = false;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.provider.resolvingPrincipal = 0n;
  state.provider.exitPrincipalX36 = 0n;
  state.provider.claimableExitAsset = 1n;
  await page.reload();
  await card.getByRole("button", { name: "Preview Collect" }).click();
  await dialog.getByRole("button", { name: "Confirm Collect" }).click();
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
      .filter({ has: page.getByText("Withdraw principal", { exact: true }) })
      .locator("dd"),
  ).toHaveText("100 WETH");
  const simulations = state.simulations.length;
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.provider.activePrincipal = 50n * 10n ** 18n;
  await withdraw.click();
  await expect(
    dialog
      .locator("dl")
      .filter({ has: page.getByText("Withdraw principal", { exact: true }) })
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
    name: "Preview Provide",
    exact: true,
  });
  await expect(
    dialog.getByText("Estimated Yield", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  state.allowance = 0n;
  await reopen.click();
  await expect(
    dialog.getByRole("button", { name: "Approve WETH", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Estimated Yield", { exact: true }),
  ).toHaveCount(0);
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
    dialog.getByText("Reading and simulating current state…", { exact: true }),
  ).toBeVisible();
  const spinner = dialog
    .getByRole("status")
    .filter({
      hasText: "Reading and simulating current state…",
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
    await expect(dialog.getByText("Confirmed ✅", { exact: true })).toHaveCount(
      0,
    );
    expect(state.writes).toEqual([
      [submitted === "approval" ? "approve" : "supply"],
    ]);
    state.blockNumber = 10000001n;
    await expect(
      submitted === "approval"
        ? dialog.getByRole("button", { name: "Confirm Provide", exact: true })
        : dialog.getByText("Confirmed ✅", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    expect(state.writes).toHaveLength(1);
  });
}

test("amount input accepts decimal editing and rejects invalid text", async ({
  page,
}) => {
  await page.goto(`/market/base/${key}`);
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
    ".5",
    "1.",
    "0.000000000000000001",
    "9007199254740993.123456789123456789",
    "",
  ]) {
    await input.fill(value);
    await expect(input).toHaveValue(value);
  }
  await input.pressSequentially("12.34");
  await expect(input).toHaveValue("12.34");
  // Replacing the value also exercises input from paste, without silently stripping text.
  for (const invalid of [
    "abc",
    "1 WETH",
    "1e3",
    "1E3",
    "-1",
    "+1",
    "1.2.3",
    "1,000",
    " 42 ",
    "NaN",
    "Infinity",
  ]) {
    await input.fill(invalid);
    await expect(input).toHaveValue("12.34");
  }
  await input.pressSequentially("abcE+-.");
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
  await page.locator(`[data-tick-id="${id7}"]`).click();
  await page.getByText("Yield slippage", { exact: true }).click();
  const input = page.getByLabel("Yield slippage", { exact: true });
  await expect(input).toHaveValue("0.5");
  await expect(input.locator("..")).toContainText("%");
  await expect(input).toHaveAttribute("inputmode", "decimal");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "none");
  await expect(input).toHaveAttribute("spellcheck", "false");
  for (const invalid of ["abc", "1.2.3", "1e2", "-1", "+1", "0.5%", "1,000"]) {
    await input.fill(invalid);
    await expect(input).toHaveValue("0.5");
  }
  await input.fill("");
  await expect(input).toHaveValue("");
  await input.pressSequentially("0.25abcE+-");
  await expect(input).toHaveValue("0.25");
  await input.fill("0");
  await expect(input).toHaveValue("0");
  for (const value of ["0.01", "0.29", "1.", ".5", "10"]) {
    await input.fill(value);
    await expect(input).toHaveValue(value);
    await expect(
      page.getByRole("alert").filter({ hasText: "Yield slippage must be" }),
    ).toHaveCount(0);
  }
  for (const value of ["", ".", "10.01", "333", "0.001"]) {
    await input.fill(value);
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
  await page.getByText("Yield slippage", { exact: true }).click();
  await page.getByLabel("You receive", { exact: true }).fill("1");
  for (const [percent, expectedCap] of [
    ["0.5", "0.01005 WETH"],
    ["0.29", "0.010029 WETH"],
    ["0.01", "0.010001 WETH"],
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
    await page.getByLabel("You receive", { exact: true }).fill("1");
    for (const percent of ["10", ""]) {
      await page.getByText("Yield slippage", { exact: true }).click();
      await page.getByLabel("Yield slippage", { exact: true }).fill(percent);
      await page.getByRole("tab", { name: "Swap now", exact: true }).click();
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
      for (const label of ["Pay Quote", "Maximum Quote payment"])
        await expect(
          dialog.getByText(label, { exact: true }).locator(".."),
        ).toContainText(payment);
      await dialog
        .getByRole("button", { name: "Confirm Swap", exact: true })
        .click();
      await expect(
        dialog.getByText("Confirmed ✅", { exact: true }),
      ).toBeVisible();
      expect(state.swaps.at(-1)).toEqual([
        direction === 0 ? id7 : bid7,
        direction === 0 ? 10n ** 18n : 10n ** 6n,
        direction === 0 ? 3000n * 10n ** 6n : 333333333333333n,
      ]);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("tab", { name: "Rent", exact: true }).click();
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
      dialog.getByText("Confirmed ✅", { exact: true }),
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
      dialog.getByText("Confirmed ✅", { exact: true }),
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
    if (mode === "Swap")
      await page.getByRole("tab", { name: "Swap now", exact: true }).click();
    const explanation =
      mode === "Rent"
        ? "Repay WETH + Yield to unlock USDC, or it will be swapped at term end."
        : "Swaps are instant and final.";
    await page.getByLabel("You receive", { exact: true }).fill("1");
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
  await page.getByLabel("You receive", { exact: true }).fill("1");
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toHaveCount(
    0,
  );
  expect(state.batches).toHaveLength(1);
  state.batchPending = false;
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible({
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toHaveCount(
    0,
  );
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
  await expect(dialog.getByText("Confirmed ✅", { exact: true })).toBeVisible();
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
      dialog.getByText("Confirmed ✅", { exact: true }),
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
      dialog.getByText("Confirmed ✅", { exact: true }),
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
  await page
    .getByRole("button", { name: "Preview Provide", exact: true })
    .click();
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
  ).toContainText("WETH");
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
  expect([...decimals].sort()).toEqual([a, b]);
  await page.getByRole("option", { name: "DISC0", exact: true }).click();
  await expect.poll(() => decimals.has(discovered[0].address)).toBe(true);
  expect(decimals.size).toBe(3);
  await page.getByRole("combobox", { name: "Token A selection" }).click();
  await page
    .getByRole("option", { name: "Custom token address…", exact: true })
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

test("Worker reference prices initialize discovery and refresh without moving the selected center", async ({
  page,
}) => {
  let price = "5000",
    symbol = "WETH";
  let requests = 0;
  await page.route(metadataRoute, async (route) => {
    requests++;
    const url = new URL(route.request().url());
    await route.fulfill({
      json: {
        tokens: url.searchParams
          .get("addresses")!
          .split(",")
          .map((address) => ({
            chainId: 8453,
            address,
            status: "available",
            symbol: address === a ? symbol : "USDC",
            name: "Worker token",
            geckoTerminal: {
              attributes: {
                price_usd: address === a ? price : "1",
                decimals: 99,
              },
            },
          })),
      },
    });
  });
  const center = snappedPrice(
    "5000",
    18,
    6,
    DISCOVERY_DEFAULTS.stepTicks,
  ).priceTick;
  await page.goto(`/market/base/${key}`);
  await expectDiscoveryGrid(page, center);
  const identity = tickIdFor(pairId, 0, center, 7);
  await page.locator(`[data-tick-id="${identity}"]`).click();
  const before = requests;
  price = "10000";
  symbol = "WETH2";
  await page.clock.setFixedTime(
    new Date(Date.now() + QUERY_TIMING.tokenMetadataStale + 1000),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => requests).toBeGreaterThan(before);
  await expect(
    page.getByRole("heading", { name: "WETH2 / USDC" }),
  ).toBeVisible();
  await expectDiscoveryGrid(page, center);
  await expect(page.locator(`[data-tick-id="${identity}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(new URL(page.url()).searchParams.has("baseTick")).toBe(false);
});

test("metadata and image failures preserve onchain interactions and the universal icon", async ({
  page,
}) => {
  await page.route(metadataRoute, (route) => route.fulfill({ status: 429 }));
  await page.route("**/api/tokens?**", (route) =>
    route.fulfill({ status: 503, json: { tokens: [] } }),
  );
  await page.goto(`/market/base/${key}`);
  await expect(
    page.getByRole("heading", { name: "WETH / USDC" }),
  ).toBeVisible();
  await expectDiscoveryGrid(page, -196000);
  await expect(
    page.getByRole("img", { name: "WETH logo" }).first(),
  ).toHaveAttribute("src", "/token.svg");
  await page.route(metadataRoute, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      json: {
        tokens: url.searchParams
          .get("addresses")!
          .split(",")
          .map((address) => ({
            chainId: 8453,
            address,
            status: "available",
            symbol: tokenFixture(address).symbol,
            name: tokenFixture(address).name,
            imageUrl: "https://coin-images.coingecko.com/missing.png",
          })),
      },
    });
  });
  await page.route("https://coin-images.coingecko.com/**", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.reload();
  const icon = page.getByRole("img", { name: "WETH logo" }).first();
  await expect(icon).toHaveAttribute("src", "/token.svg");
  await expect(icon).toHaveJSProperty("complete", true);
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
