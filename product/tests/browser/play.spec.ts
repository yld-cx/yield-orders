import { expect, test, type Page } from "@playwright/test";
import {
  decodePlayStrategy,
  encodePlayStrategy,
  playPath,
  PlayStrategy,
  readPlayPath,
} from "../../lib/play";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  type Hex,
} from "viem";
import { tokenFixture } from "./token-fixtures";

const token = "0x42000000000000000000000000000000000000aa";
const quote = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const sunToken = "0x42000000000000000000000000000000000000bb";
const trending = [
  { address: token, symbol: "MOON", name: "Moon Token" },
  {
    address: sunToken,
    symbol: "SUN",
    name: "Sun Token",
  },
  { address: quote, symbol: "USDC", name: "USD Coin" },
];

test.beforeEach(async ({ context }) => {
  await context.route(/https:\/\/mainnet\.base\.org\/?$/, async (route) => {
    const tokenCall = (address: string, data: Hex) => {
      try {
        const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
        if (
          functionName === "decimals" ||
          functionName === "symbol" ||
          functionName === "name"
        ) {
          return encodeFunctionResult({
            abi: erc20Abi,
            functionName,
            result: tokenFixture(address)[functionName],
          });
        }
      } catch {
        return undefined;
      }
    };
    type Call = {
      id: number;
      method: string;
      params: [{ to: string; data: Hex }];
    };
    const respond = ({ id, method, params }: Call) => {
      const response = { id, jsonrpc: "2.0" };
      if (method !== "eth_call") return { ...response, result: "0x0" };
      const [{ to, data }] = params;
      if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
        const call = decodeFunctionData({ abi: multicall3Abi, data });
        if (call.functionName !== "aggregate3")
          throw new Error("Unexpected multicall");
        const result = encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: call.args[0].map(({ target, callData }) => {
            const result = tokenCall(target, callData);
            return {
              success: result !== undefined,
              returnData: result ?? "0x",
            };
          }),
        });
        return { ...response, result };
      }
      const result = tokenCall(to, data);
      return result === undefined
        ? { ...response, error: { code: 3, message: "execution reverted" } }
        : { ...response, result };
    };
    const calls = route.request().postDataJSON() as Call | Call[];
    await route.fulfill({
      json: Array.isArray(calls) ? calls.map(respond) : respond(calls),
    });
  });
  await context.route(/\/api\/tokens\?chainId=/, async (route) => {
    await route.fulfill({
      json: {
        tokens:
          new URL(route.request().url()).searchParams.get("chainId") === "8453"
            ? trending
            : [],
      },
    });
  });
  await context.route(
    /(?:https:\/\/md\.yld\.cx|\/api\/md)\/tokens\?/,
    (route) => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: {
          tokens: (params.get("addresses") ?? "")
            .split(",")
            .flatMap((address) => {
              const metadata = trending.find(
                (item) => item.address === address,
              );
              return metadata
                ? [
                    {
                      ...metadata,
                      chainId: 8453,
                      status: "available",
                      geckoTerminal:
                        metadata.symbol === "SUN"
                          ? undefined
                          : {
                              attributes: {
                                price_usd: address === quote ? "1" : "10",
                              },
                            },
                    },
                  ]
                : [];
            }),
        },
      });
    },
  );
});

function openScenario(page: Page, id: PlayStrategy, address = token) {
  return page.goto(
    playPath("base", encodePlayStrategy({ id, token: address })),
  );
}

function instructions(page: Page) {
  return page.locator("details").filter({ hasText: "How to play" });
}

test("Home Explorer opens Play and filters trending tokens", async ({
  page,
}) => {
  let showTokens!: () => void;
  const tokensReady = new Promise<void>((resolve) => {
    showTokens = resolve;
  });
  await page.route(/\/api\/tokens\?chainId=/, async (route) => {
    await tokensReady;
    await route.fallback();
  });
  await page.goto("/?network=base");
  const categories = page.getByRole("group", { name: "Token categories" });
  const explorer = categories.getByRole("link", {
    name: "Explorer",
    exact: true,
  });
  await expect(categories.locator(":scope > :first-child")).toHaveAttribute(
    "href",
    "/play",
  );
  await explorer.click();
  await expect(page).toHaveURL(/\/play$/);
  await expect(
    page.getByRole("heading", { name: "Yield Explorer." }),
  ).toBeVisible();

  const strategyDescription = page.getByText("Choose your strategy to play", {
    exact: true,
  });
  await expect(strategyDescription).toBeVisible();
  const long = page.getByRole("link", { name: /^Long/ });
  await expect(
    long.getByText("Bullish on tokens", { exact: true }),
  ).toBeVisible();
  await long.click();
  const strategyPath = playPath(
    "base",
    encodePlayStrategy({ id: PlayStrategy.Long }),
  );
  await expect(page).toHaveURL(strategyPath);
  const search = page.getByRole("searchbox", {
    name: "Search trending tokens",
  });
  const skeleton = page
    .getByRole("status")
    .locator('[data-slot="skeleton"]')
    .first();
  try {
    await expect(skeleton).toBeVisible();
  } finally {
    showTokens();
  }
  await expect(page.getByRole("button", { name: /Sun Token/ })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  await expect(strategyDescription).toHaveCount(0);
  await expect(page.getByRole("button", { name: /USD Coin/ })).toHaveCount(0);
  await search.fill("zebra");
  await expect(page.getByRole("status")).toHaveText("No matching tokens.");
  await search.fill(token.slice(-6));
  await expect(page.getByRole("button", { name: /Sun Token/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Moon Token/ }).click();
  await expect(
    page.getByRole("heading", { name: "Bullish on MOON" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(strategyPath);
  await expect(search).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Bullish on MOON" }),
  ).toBeVisible();
});

test("Long restores the shared simulation and keeps the strategy when switching networks", async ({
  page,
  context,
}) => {
  await openScenario(page, PlayStrategy.Long);
  await expect(
    page.getByRole("heading", { name: "Bullish on MOON", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Bullish on MOON · Yield Explorer | yld.cx");
  await expect(page.getByText("Long", { exact: true })).toBeVisible();
  const explanation = instructions(page);
  const howToPlay = explanation.getByText("How to play", { exact: true });
  const steps = explanation.locator("li");
  await expect(steps.first()).toBeHidden();
  await howToPlay.press("Enter");
  await expect(steps).toHaveText([
    "Lock MOON and rent USDC",
    "Market swap USDC for MOON",
    "Place a limit sell for MOON at your target price",
    "Repay USDC + Yield before expiry to unlock MOON",
  ]);
  for (const [index, icon] of [
    "hourglass",
    "arrow-left-right",
    "droplets",
  ].entries()) {
    await expect(steps.nth(index).locator("svg")).toHaveClass(
      new RegExp(`\\blucide-${icon}\\b`),
    );
  }
  await expect(steps.first()).toBeVisible();
  await howToPlay.press("Enter");
  await expect(steps.first()).toBeHidden();
  const entry = page.getByRole("textbox", { name: "Entry price" });
  await expect(entry).toHaveValue("10");
  const amount = page.getByRole("textbox", { name: "Rent amount" });
  const rate = page.getByRole("textbox", { name: "7-day rental cost" });
  const inputGroups = page.locator('[data-slot="input-group"]');
  await expect(inputGroups.filter({ has: amount })).toContainText("USDC");
  await expect(inputGroups.filter({ has: entry })).toContainText("USDC");
  await expect(inputGroups.filter({ has: rate })).toContainText("%");
  await expect(rate).toHaveValue("0.07");
  const target = page.getByRole("slider", { name: "Target price" });
  await expect(target).toHaveAttribute("step", "100");
  await expect(target).toHaveValue("-249300");
  await expect(target).toHaveAttribute("aria-valuetext", "14.9135 USDC");
  await expect(
    page.getByText("+490.65103 USDC", { exact: true }),
  ).toBeVisible();
  await amount.fill("2500");
  await target.press("ArrowLeft");
  await rate.fill("2");
  await expect(
    page.getByText("+1,141.2814 USDC", { exact: true }),
  ).toBeVisible();

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async ({ url }: ShareData) => {
        document.body.dataset.sharedUrl = url;
      },
    });
  });
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-shared-url",
    page.url(),
  );
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(page.url());
  await expect(page.getByText("Link copied", { exact: true })).toHaveCount(0);
  const shared = new URL(page.url());
  expect(shared.search).toBe("");
  const route = readPlayPath(shared.pathname);
  expect(route?.network).toBe("base");
  expect(decodePlayStrategy(route?.strategy)).toEqual({
    id: "long",
    token,
    amount: "2500",
    entry: "10",
    target: "14.7651257629",
    targetTick: -249400,
    rate: "2",
  });
  await page.reload();
  await expect(target).toHaveValue("-249400");
  await expect(
    page.getByText("+1,141.2814 USDC", { exact: true }),
  ).toBeVisible();

  await page.getByRole("combobox", { name: "Network", exact: true }).click();
  await page.getByRole("option", { name: "Ethereum", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Long · Choose a token" }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    playPath("ethereum", encodePlayStrategy({ id: PlayStrategy.Long })),
  );
  await expect(page).toHaveTitle("Yield Explorer | yld.cx");
});

test("Use Liquidity switches the rented and locked tokens", async ({
  page,
}) => {
  await openScenario(page, PlayStrategy.UseLiquidity);
  const entry = page.getByRole("textbox", { name: "Entry price" });
  const inputGroups = page.locator('[data-slot="input-group"]');
  const explanation = instructions(page);
  const howToPlay = explanation.locator("summary");
  const steps = explanation.locator("li");
  const accessCopy = "Rent USDC with MOON";
  await expect(
    page.getByRole("heading", { name: accessCopy, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(page.getByText("1,000.7 USDC", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Estimated quote · 100 MOON", { exact: true }),
  ).toBeVisible();
  const rentalAmount = page.getByRole("textbox", { name: "Rent amount" });
  await expect(entry).toHaveValue("10");
  await expect(inputGroups.filter({ has: entry })).toHaveText("USDC");
  await expect(inputGroups.filter({ has: rentalAmount })).toContainText("USDC");
  await howToPlay.click();
  await expect(steps.first()).toHaveText("Lock MOON and rent USDC");
  await expect(steps.last()).toHaveText(
    "If the rental expires, locked MOON will be swapped",
  );

  await entry.fill("20");
  await expect(
    page.getByText("Estimated quote · 50 MOON", { exact: true }),
  ).toBeVisible();
  const switchButton = page
    .getByRole("heading", { name: accessCopy, exact: true })
    .locator("..")
    .getByRole("button", { name: "Switch tokens", exact: true });
  await switchButton.click();
  const reversedCopy = "Rent MOON with USDC";
  await expect(
    page.getByRole("heading", { name: reversedCopy, exact: true }),
  ).toBeVisible();
  await expect(entry).toHaveValue("20");
  await expect(rentalAmount).toHaveValue("50");
  await expect(inputGroups.filter({ has: entry })).toHaveText("USDC");
  await expect(inputGroups.filter({ has: rentalAmount })).toContainText("MOON");
  await expect(page.getByText("50.035 MOON", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Estimated quote · 1,000 USDC", { exact: true }),
  ).toBeVisible();
  await howToPlay.click();
  await expect(steps.first()).toHaveText("Lock USDC and rent MOON");
  await expect(steps.last()).toHaveText(
    "If the rental expires, locked USDC will be swapped",
  );
  const route = readPlayPath(new URL(page.url()).pathname);
  expect(decodePlayStrategy(route?.strategy)).toMatchObject({
    id: "use-liquidity",
    token,
    rentSelectedToken: true,
    amount: "50",
    entry: "20",
    rate: "0.07",
  });

  await page.reload();
  await expect(page.getByText("50.035 MOON", { exact: true })).toBeVisible();
});

test("Short starts at the lowest target and charges yield in the rented token", async ({
  page,
}) => {
  await openScenario(page, PlayStrategy.Short);
  const entry = page.getByRole("textbox", { name: "Entry price" });
  const rentalAmount = page.getByRole("textbox", { name: "Rent amount" });
  const rate = page.getByRole("textbox", { name: "7-day rental cost" });
  const target = page.getByRole("slider", { name: "Target price" });
  const inputGroups = page.locator('[data-slot="input-group"]');
  const explanation = instructions(page);
  const howToPlay = explanation.locator("summary");
  const steps = explanation.locator("li");
  await expect(
    page.getByRole("heading", { name: "Bearish on MOON" }),
  ).toBeVisible();
  await howToPlay.click();
  await expect(steps).toHaveText([
    "Lock USDC and rent MOON",
    "Market swap MOON for USDC",
    "Place a limit buy for MOON at your target price",
    "Repay MOON + Yield before expiry to unlock USDC",
  ]);
  await expect(inputGroups.filter({ has: rentalAmount })).toContainText("MOON");
  await expect(inputGroups.filter({ has: entry })).toContainText("USDC");
  await expect(entry).toHaveValue("10");
  await expect(rentalAmount).toHaveValue("100");
  await expect(target).toHaveValue("-260200");
  await expect(target).toHaveAttribute("aria-valuetext", "5.0144 USDC");
  await rentalAmount.fill("4");
  await rate.fill("1");
  await expect(
    page.getByText("+19.741657 USDC", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("+49.354142%", { exact: true })).toBeVisible();
});

test("Limit strategies use the expected defaults and display their outcomes", async ({
  page,
}) => {
  const inputGroups = page.locator('[data-slot="input-group"]');
  const explanation = instructions(page);
  const howToPlay = explanation.locator("summary");
  const steps = explanation.locator("li");
  for (const scenario of [
    {
      id: PlayStrategy.BuyTheDip,
      unit: "USDC",
      initialAmount: "1000",
      initialOrderTick: "-264800",
      orderKey: "Home",
      result: "3.9904014 MOON",
      firstStep: "Place a limit buy for MOON at your order price",
    },
    {
      id: PlayStrategy.TakeProfit,
      unit: "MOON",
      initialAmount: "100",
      initialOrderTick: "-249800",
      orderKey: "End",
      result: "79.722144 USDC",
      firstStep: "Place a limit sell for MOON at your order price",
    },
    {
      id: PlayStrategy.HoldAndEarn,
      unit: "MOON",
      initialAmount: "100",
      initialOrderTick: "-246400",
      netYield: "2",
      result: "0.08 MOON",
      firstStep: "Place a limit sell for MOON at high price",
    },
  ]) {
    await openScenario(page, scenario.id);
    const provideAmount = page.getByRole("textbox", { name: "Provide amount" });
    await expect(inputGroups.filter({ has: provideAmount })).toContainText(
      scenario.unit,
    );
    await expect(provideAmount).toHaveValue(scenario.initialAmount);
    const orderPrice = page.getByRole("slider", { name: "Order price" });
    await expect(orderPrice).toHaveValue(scenario.initialOrderTick);
    await provideAmount.fill("4");
    if (scenario.orderKey) await orderPrice.press(scenario.orderKey);
    if (scenario.netYield) {
      await expect(orderPrice).toHaveAttribute("max", "-246400");
      await expect(orderPrice).toHaveAttribute(
        "aria-valuetext",
        "19.9305 USDC",
      );
      const netYield = page.getByRole("textbox", { name: "7-day net yield" });
      await expect(netYield).toHaveValue("0.0693");
      await expect(
        page.getByText("0.002772 MOON", { exact: true }),
      ).toBeVisible();
      await netYield.fill(scenario.netYield);
    }
    await expect(
      page.getByText(scenario.result, { exact: true }),
    ).toBeVisible();
    await howToPlay.click();
    await expect(steps.first()).toHaveText(scenario.firstStep);
    await expect(steps).toHaveCount(scenario.netYield ? 2 : 3);
  }
});

test("A manual entry price supplies a default amount until the user overrides it", async ({
  page,
}) => {
  await openScenario(page, PlayStrategy.Short, sunToken);
  const entry = page.getByRole("textbox", { name: "Entry price" });
  const rentalAmount = page.getByRole("textbox", { name: "Rent amount" });
  await expect(
    page.getByRole("heading", { name: "Bearish on SUN" }),
  ).toBeVisible();
  await expect(entry).toHaveValue("");
  await expect(rentalAmount).toHaveValue("");
  await entry.pressSequentially("20");
  await expect(rentalAmount).toHaveValue("50");
  await rentalAmount.fill("3");
  const exactPrice = ".0003741863826";
  await entry.fill(exactPrice);
  await rentalAmount.focus();
  await expect(entry).toHaveValue("0.000374186");
  const route = readPlayPath(new URL(page.url()).pathname);
  expect(decodePlayStrategy(route?.strategy)?.entry).toBe(exactPrice);
  await expect(rentalAmount).toHaveValue("3");
  await page.reload();
  await expect(rentalAmount).toHaveValue("3");
  await expect(entry).toHaveValue("0.000374186");
  await entry.focus();
  await expect(entry).toHaveValue(exactPrice);
});
