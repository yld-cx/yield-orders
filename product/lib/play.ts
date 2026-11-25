import { BASIS_POINTS, PERCENT_SCALE, PRODUCT_MARKET } from "@yld-cx/sdk";
import {
  formatRatio,
  marginalTermYieldRatio,
  type NetworkSlug,
} from "@yld-cx/sdk/ethereum";
import { isAddress } from "viem";
import { marketGridTick } from "./market-values";

export const enum PlayStrategy {
  Long = "long",
  Short = "short",
  BuyTheDip = "buy-the-dip",
  TakeProfit = "take-profit",
  HoldAndEarn = "hold-and-earn",
  UseLiquidity = "use-liquidity",
}

export const enum PlayStepAction {
  Limit = "limit",
  Swap = "swap",
  Rent = "rent",
}

type PlayStep = { action: PlayStepAction; text: string };

function rentalSteps(rented: string, locked: string): [PlayStep, PlayStep] {
  return [
    {
      action: PlayStepAction.Rent,
      text: `Lock ${locked} and rent ${rented}`,
    },
    {
      action: PlayStepAction.Rent,
      text: `Repay ${rented} + Yield before expiry to unlock ${locked}`,
    },
  ];
}

function buyTheDipStep(asset: string, price = "order"): PlayStep {
  return {
    action: PlayStepAction.Limit,
    text: `Place a limit buy for ${asset} at your ${price} price`,
  };
}

function takeProfitStep(asset: string, price = "your order price"): PlayStep {
  return {
    action: PlayStepAction.Limit,
    text: `Place a limit sell for ${asset} at ${price}`,
  };
}

function collectStep(token: string): PlayStep {
  return { action: PlayStepAction.Limit, text: `Collect ${token} if filled` };
}

function earnStep(token: string): PlayStep {
  return {
    action: PlayStepAction.Limit,
    text: `Earn Yield in ${token} if repaid`,
  };
}

function directionalRentalSteps(
  rented: string,
  locked: string,
  exit: PlayStep,
) {
  const [rent, repay] = rentalSteps(rented, locked);
  return [
    rent,
    {
      action: PlayStepAction.Swap,
      text: `Market swap ${rented} for ${locked}`,
    },
    exit,
    repay,
  ];
}

export const PLAY_STRATEGIES = [
  {
    id: PlayStrategy.Long,
    emoji: "🐂",
    title: "Long",
    description: (token = "tokens") => `Bullish on ${token}`,
    steps: (asset: string, quote: string) =>
      directionalRentalSteps(
        quote,
        asset,
        takeProfitStep(asset, "your target price"),
      ),
  },
  {
    id: PlayStrategy.Short,
    emoji: "🐻",
    title: "Short",
    description: (token = "tokens") => `Bearish on ${token}`,
    steps: (asset: string, quote: string) =>
      directionalRentalSteps(asset, quote, buyTheDipStep(asset, "target")),
  },
  {
    id: PlayStrategy.BuyTheDip,
    emoji: "🎯",
    title: "Buy the Dip",
    description: (token = "tokens") => `Accumulate ${token}`,
    steps: (asset: string, quote: string) => [
      buyTheDipStep(asset),
      collectStep(asset),
      earnStep(quote),
    ],
  },
  {
    id: PlayStrategy.TakeProfit,
    emoji: "💰",
    title: "Take Profit",
    description: (token = "tokens") => `Sell ${token} high`,
    steps: (asset: string, quote: string) => [
      takeProfitStep(asset),
      collectStep(quote),
      earnStep(asset),
    ],
  },
  {
    id: PlayStrategy.HoldAndEarn,
    emoji: "💎",
    title: "Hold & Earn",
    description: (token = "tokens") => `Put your ${token} to work`,
    steps: (asset: string) => [
      takeProfitStep(asset, "high price"),
      earnStep(asset),
    ],
  },
  {
    id: PlayStrategy.UseLiquidity,
    emoji: "⚡",
    title: "Use Liquidity",
    description: (asset?: string, quote?: string) =>
      asset && quote ? `Rent ${asset} with ${quote}` : "Rent tokens",
    steps: (asset: string, quote: string) => [
      ...rentalSteps(asset, quote),
      {
        action: PlayStepAction.Rent,
        text: `If the rental expires, locked ${quote} will be swapped`,
      },
    ],
  },
] as const;

export type PlayStrategyConfig = (typeof PLAY_STRATEGIES)[number];

export function playStrategy(value: string | null) {
  const id = value === "access-liquidity" ? PlayStrategy.UseLiquidity : value;
  return PLAY_STRATEGIES.find((strategy) => strategy.id === id);
}

export function playPageTitle(description?: string) {
  return description ? `${description} · Yield Explorer` : "Yield Explorer";
}

export function scenarioNumber(value: string, allowZero = false) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || value.length > 64)
    return undefined;
  const number = Number(value);
  return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0)
    ? number
    : undefined;
}

/** Indicative arithmetic only; no execution quotes or transaction sizing. */
export function playScenario(input: {
  strategy: Exclude<PlayStrategy, PlayStrategy.UseLiquidity>;
  amount: number;
  entry: number;
  target: number;
  order: number;
  rate?: number;
}) {
  const { strategy, amount, entry, target, order, rate } = input;
  if (
    ![amount, entry, target, order].every(Number.isFinite) ||
    amount <= 0 ||
    entry <= 0 ||
    target < 0 ||
    order <= 0 ||
    (rate !== undefined && (!Number.isFinite(rate) || rate < 0))
  )
    return undefined;

  const ratio = target / entry;
  const fee = (rate ?? 0) / 100;
  const assetAmount =
    playAmountUnit(strategy) === "asset" ? amount : amount / entry;
  // Long pays yield in rented quote; short repays yield in rented asset.
  const pnl =
    strategy === PlayStrategy.Long
      ? amount * (ratio - 1 - fee)
      : strategy === PlayStrategy.Short
        ? amount * (entry - target * (1 + fee))
        : strategy === PlayStrategy.BuyTheDip
          ? amount * (target / order - 1)
          : assetAmount * (order - target);
  // A provider's rental-repaid outcome is distinct from its filled outcome.
  const income =
    rate === undefined
      ? undefined
      : strategy === PlayStrategy.BuyTheDip
        ? amount * fee
        : assetAmount * fee * target;
  if (
    !Number.isFinite(pnl) ||
    (income !== undefined && !Number.isFinite(income))
  )
    return undefined;
  return { pnl, income };
}

export type PlaySettings = {
  id: PlayStrategy;
  token?: string;
  rentSelectedToken?: boolean;
  amount?: string;
  entry?: string;
  target?: string;
  targetTick?: number;
  rate?: string;
};

export type PlayValues = {
  amount: number;
  entry: number;
  target?: number;
  rate?: number;
};

function isDirectionalRental(strategy: PlayStrategy) {
  return strategy === PlayStrategy.Long || strategy === PlayStrategy.Short;
}

// The tick's marginal rate is lowest at zero utilization.
const minimumTermYield = marginalTermYieldRatio({
  availableSupply: 1n,
  activeWorking: 0n,
  durationDays: BigInt(PRODUCT_MARKET.duration),
});

function minimumYieldPercent(shareBps: bigint) {
  if (!minimumTermYield) return;
  const [numerator, denominator] = minimumTermYield;
  return formatRatio(
    numerator * BigInt(PERCENT_SCALE) * shareBps,
    denominator * BASIS_POINTS,
  );
}

const minimumRentalRate = minimumYieldPercent(BASIS_POINTS);
const repayFeeBps = 100n;
const minimumNetYield = minimumYieldPercent(BASIS_POINTS - repayFeeBps);

export function playRateInput(settings: PlaySettings) {
  if (settings.id === PlayStrategy.HoldAndEarn)
    return settings.rate ?? minimumNetYield;
  return (
    settings.rate ??
    (isDirectionalRental(settings.id) ||
    settings.id === PlayStrategy.UseLiquidity
      ? minimumRentalRate
      : undefined)
  );
}

export function playFieldLabels(strategy: PlayStrategy) {
  if (strategy === PlayStrategy.UseLiquidity) {
    return {
      amount: "Rent amount",
      entry: "Entry price",
      rate: `${PRODUCT_MARKET.duration}-day rental cost`,
    };
  }
  const rental = isDirectionalRental(strategy);
  return {
    amount: rental ? "Rent amount" : "Provide amount",
    entry: "Entry price",
    target: rental ? "Target price" : "Order price",
    rate: rental
      ? `${PRODUCT_MARKET.duration}-day rental cost`
      : strategy === PlayStrategy.HoldAndEarn
        ? `${PRODUCT_MARKET.duration}-day net yield`
        : undefined,
  };
}

function playAmountUnit(strategy: PlayStrategy) {
  return strategy === PlayStrategy.Long || strategy === PlayStrategy.BuyTheDip
    ? "quote"
    : "asset";
}

export function rentsStablecoin(
  settings: Pick<PlaySettings, "id" | "rentSelectedToken">,
) {
  return (
    settings.id === PlayStrategy.UseLiquidity && !settings.rentSelectedToken
  );
}

export function playFieldUnits(
  settings: Pick<PlaySettings, "id" | "rentSelectedToken">,
  asset: string,
  quote: string,
) {
  return {
    amount: playAmountUnit(settings.id) === "asset" ? asset : quote,
    entry: rentsStablecoin(settings) ? asset : quote,
  };
}

const HOLD_MAX_PRICE_CHANGE = 100;

export function playSlider(strategy: PlayStrategy) {
  switch (strategy) {
    case PlayStrategy.UseLiquidity:
      return undefined;
    case PlayStrategy.BuyTheDip:
      return { min: -90, max: 0, initial: -45 };
    case PlayStrategy.TakeProfit:
      return { min: 0, max: 100, initial: 50 };
    case PlayStrategy.HoldAndEarn:
      return {
        min: 0,
        max: HOLD_MAX_PRICE_CHANGE,
        initial: HOLD_MAX_PRICE_CHANGE,
      };
    case PlayStrategy.Long:
    case PlayStrategy.Short: {
      const min = -50;
      const max = 50;
      return {
        min,
        max,
        initial: strategy === PlayStrategy.Long ? max : min,
      };
    }
  }
}

export function playDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0) return "";
  return value.toLocaleString("en-US", {
    useGrouping: false,
    maximumSignificantDigits: 17,
  });
}

export function playTarget(entry: number, change: number) {
  return playDecimal(Number((entry * (1 + change / 100)).toPrecision(10)));
}

export function invertPlayPrice(input: string | undefined) {
  const price = scenarioNumber(input ?? "");
  return price === undefined ? input : playInput(playTarget(1 / price, 0));
}

// Convert between the displayed stablecoin price and the rental's Quote per Asset.
export function orientPlayPrice(
  settings: PlaySettings,
  input: string | undefined,
) {
  return rentsStablecoin(settings) ? invertPlayPrice(input) : input;
}

export function playFormat(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 8,
  }).format(value);
}

export function playSigned(value: number) {
  return (value > 0 ? "+" : value < 0 ? "−" : "") + playFormat(Math.abs(value));
}

export type PlayOutcome = {
  label: string;
  value?: number;
  unit: "asset" | "quote";
  signed: boolean;
  percent?: number;
  quotePrincipal?: number;
};

export function playOutcome(
  strategy: PlayStrategy,
  values: PlayValues,
): PlayOutcome | undefined {
  const { amount, entry, target, rate } = values;
  if (strategy === PlayStrategy.UseLiquidity) {
    const quotePrincipal = amount * entry;
    const value =
      rate === undefined ? undefined : amount + (amount * rate) / 100;
    if (
      amount <= 0 ||
      entry <= 0 ||
      !Number.isFinite(quotePrincipal) ||
      (rate !== undefined && (rate < 0 || !Number.isFinite(value)))
    )
      return;
    return {
      label: "Full-term repayment",
      value,
      unit: "asset",
      signed: false,
      quotePrincipal,
    };
  }
  if (target === undefined) return;
  const result = playScenario({ strategy, ...values, target, order: target });
  if (!result) return undefined;
  if (isDirectionalRental(strategy)) {
    const exposure = strategy === PlayStrategy.Short ? amount * entry : amount;
    return {
      label:
        rate === undefined
          ? "Potential PnL before rental cost"
          : "Potential PnL",
      value: result.pnl,
      unit: "quote" as const,
      signed: true,
      percent: (result.pnl / exposure) * 100,
    };
  }
  if (strategy === PlayStrategy.BuyTheDip)
    return {
      label: "Tokens if filled",
      value: amount / target,
      unit: "asset" as const,
      signed: false,
    };
  if (strategy === PlayStrategy.TakeProfit)
    return {
      label: "Proceeds if filled",
      value: amount * target,
      unit: "quote" as const,
      signed: false,
    };
  return {
    label: "Potential Yield if repaid",
    value: rate === undefined ? undefined : (amount * rate) / 100,
    unit: "asset" as const,
    signed: false,
  };
}

export function playOutcomeText(
  outcome: PlayOutcome | undefined,
  asset: string,
  quote: string,
) {
  if (outcome?.value === undefined) return "—";
  const value = outcome.signed
    ? playSigned(outcome.value)
    : playFormat(outcome.value);
  return `${value} ${outcome.unit === "asset" ? asset : quote}`;
}

export function playQuoteText(outcome: PlayOutcome | undefined, quote: string) {
  if (outcome?.quotePrincipal !== undefined)
    return `Estimated quote · ${playFormat(outcome.quotePrincipal)} ${quote}`;
}

export function playDefaultAmount(
  settings: Pick<PlaySettings, "id" | "rentSelectedToken" | "entry">,
) {
  const quoteAmount = 1000;
  if (playAmountUnit(settings.id) === "quote" || rentsStablecoin(settings))
    return String(quoteAmount);
  const price = scenarioNumber(settings.entry ?? "");
  return price === undefined
    ? undefined
    : playInput(playTarget(quoteAmount / price, 0));
}

export function readPlayValues(settings: PlaySettings): PlayValues | undefined {
  const amount = scenarioNumber(
    settings.amount ?? playDefaultAmount(settings) ?? "",
  );
  const entry = scenarioNumber(settings.entry ?? "");
  const target = scenarioNumber(settings.target ?? "");
  const rateInput = playRateInput(settings);
  const rate = scenarioNumber(rateInput ?? "", true);
  if (
    amount === undefined ||
    entry === undefined ||
    (settings.id !== PlayStrategy.UseLiquidity && target === undefined) ||
    (rateInput && rate === undefined)
  )
    return undefined;
  return { amount, entry, target, rate };
}

export function playInput(input: unknown): string | undefined {
  if (
    typeof input === "string" &&
    input.length <= 64 &&
    /^\d*\.?\d*$/.test(input)
  )
    return input;
}

export function decodePlayStrategy(
  value: string | null,
): PlaySettings | undefined {
  if (!value || value.length > 1024 || !/^[a-z0-9_-]+$/i.test(value)) return;
  try {
    const data: unknown = JSON.parse(
      atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const {
      id,
      token,
      amount,
      entry,
      target,
      targetTick,
      rate,
      rentSelectedToken,
    } = data as Record<string, unknown>;
    const strategy = typeof id === "string" ? playStrategy(id) : undefined;
    if (!strategy) return;
    if (token === undefined) return { id: strategy.id };
    if (typeof token !== "string" || !isAddress(token, { strict: false }))
      return;
    const settings: PlaySettings = {
      id: strategy.id,
      token: token.toLowerCase(),
      amount: playInput(amount),
      entry: playInput(entry),
      target: playInput(target),
      targetTick:
        typeof targetTick === "number"
          ? marketGridTick(String(targetTick), PRODUCT_MARKET.stepTicks)
          : undefined,
      rate: playInput(rate),
      rentSelectedToken:
        strategy.id === PlayStrategy.UseLiquidity
          ? rentSelectedToken === true
          : undefined,
    };
    if (strategy.id === PlayStrategy.HoldAndEarn) {
      const entryPrice = scenarioNumber(settings.entry ?? "");
      const targetPrice = scenarioNumber(settings.target ?? "");
      if (entryPrice !== undefined && targetPrice !== undefined) {
        const maxTarget = playTarget(entryPrice, HOLD_MAX_PRICE_CHANGE);
        if (targetPrice > Number(maxTarget)) settings.target = maxTarget;
      }
    }
    return settings;
  } catch {
    return undefined;
  }
}

export function playParams(network: NetworkSlug, settings?: PlaySettings) {
  const params = new URLSearchParams({ network });
  if (settings) {
    const value = btoa(JSON.stringify(settings))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    params.set("strategy", value);
  }
  return params;
}
