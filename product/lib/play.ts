export const PLAY_STRATEGIES = [
  { id: "long", emoji: "🐂", title: "Long", description: "Bullish on tokens" },
  { id: "short", emoji: "🐻", title: "Short", description: "Bearish on tokens" },
  { id: "buy-the-dip", emoji: "🎯", title: "Buy the Dip", description: "Accumulate at lower prices" },
  { id: "take-profit", emoji: "💰", title: "Take Profit", description: "Exit at higher prices" },
  { id: "hold-and-earn", emoji: "💎", title: "Hold & Earn", description: "Put your tokens to work" },
] as const;

export type PlayStrategy = (typeof PLAY_STRATEGIES)[number]["id"];

export function playStrategy(value: string | null) {
  return PLAY_STRATEGIES.find((strategy) => strategy.id === value);
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
  strategy: PlayStrategy;
  amount: number;
  entry: number;
  target: number;
  order: number;
  rate?: number;
}) {
  const { strategy, amount, entry, target, order, rate } = input;
  if (![amount, entry, target, order].every(Number.isFinite) ||
      amount <= 0 || entry <= 0 || target < 0 || order <= 0 ||
      (rate !== undefined && (!Number.isFinite(rate) || rate < 0)))
    return undefined;

  const ratio = target / entry;
  const fee = (rate ?? 0) / 100;
  const rentedTokens = amount / entry;
  // Long pays yield in rented quote; short repays yield in rented asset.
  const pnl = strategy === "long"
    ? amount * (ratio - 1 - fee)
    : strategy === "short"
      ? amount * (1 - ratio * (1 + fee))
      : strategy === "buy-the-dip"
        ? amount * (target / order - 1)
        : rentedTokens * (order - target);
  // A provider's rental-repaid outcome is distinct from its filled outcome.
  const income = rate === undefined ? undefined :
    strategy === "buy-the-dip" ? amount * fee : rentedTokens * fee * target;
  if (!Number.isFinite(pnl) || (income !== undefined && !Number.isFinite(income)))
    return undefined;
  return { pnl, income };
}

export const PLAY_SCENARIO_KEYS = ["amount", "entry", "target", "order", "rate", "tick"] as const;
export const PLAY_CLEAR_SCENARIO = Object.fromEntries(
  PLAY_SCENARIO_KEYS.map((key) => [key, null]),
);
export type PlayValues = {
  amount: number;
  entry: number;
  target: number;
  rate?: number;
};

export function isRentalPlay(strategy: PlayStrategy) {
  return strategy === "long" || strategy === "short";
}

export function playSlider(strategy: PlayStrategy) {
  switch (strategy) {
    case "buy-the-dip": return { min: -90, max: 0, step: 1, initial: 0 };
    case "take-profit": return { min: 0, max: 100, step: 1, initial: 0 };
    case "hold-and-earn": return { min: 0, max: 1000, step: 10, initial: 100 };
    default: return { min: -50, max: 50, step: 1, initial: 0 };
  }
}

export function playDecimal(value: number) {
  if (!Number.isFinite(value) || value < 0) return "";
  return value.toLocaleString("en-US", {
    useGrouping: false, maximumSignificantDigits: 17,
  });
}

export function playTarget(entry: number, change: number) {
  return playDecimal(Number((entry * (1 + change / 100)).toPrecision(10)));
}

export function playFormat(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumSignificantDigits: 8,
  }).format(value);
}

export function playSigned(value: number) {
  return (value > 0 ? "+" : value < 0 ? "−" : "") + playFormat(Math.abs(value));
}

// The exact same outcome model is used by the browser and the social image.
export type PlayOutcome = { label: string; value?: number; unit: "asset" | "quote"; signed: boolean; percent?: number };

export function playOutcome(strategy: PlayStrategy, values: PlayValues): PlayOutcome | undefined {
  const { amount, entry, target, rate } = values;
  if (!playScenario({ strategy, ...values, order: target })) return undefined;
  if (isRentalPlay(strategy)) {
    const result = playScenario({ strategy, ...values, order: target })!;
    return {
      label: rate === undefined ? "Potential PnL before rental cost" : "Potential PnL",
      value: result.pnl, unit: "quote" as const, signed: true,
      percent: result.pnl / amount * 100,
    };
  }
  if (strategy === "buy-the-dip")
    return { label: "Tokens if filled", value: amount / target, unit: "asset" as const, signed: false };
  if (strategy === "take-profit")
    return { label: "Proceeds if filled", value: amount / entry * target, unit: "quote" as const, signed: false };
  return {
    label: "Potential Yield if repaid",
    value: rate === undefined ? undefined : amount / entry * rate / 100,
    unit: "asset" as const, signed: false,
  };
}

export function readPlayValues(params: Pick<URLSearchParams, "get">): PlayValues | undefined {
  const amount = scenarioNumber(params.get("amount") ?? "");
  const entry = scenarioNumber(params.get("entry") ?? "");
  const target = scenarioNumber(params.get("target") ?? "");
  const rawRate = params.get("rate");
  const rate = scenarioNumber(rawRate ?? "", true);
  if (amount === undefined || entry === undefined || target === undefined ||
      (rawRate !== null && rawRate !== "" && rawRate !== "none" && rate === undefined))
    return undefined;
  return { amount, entry, target, rate };
}

export function playSnapshotParams(
  selection: { network: string; market: string; strategy: PlayStrategy },
  values?: PlayValues,
  tick?: number,
) {
  const params = new URLSearchParams(selection);
  if (values) {
    params.set("amount", playDecimal(values.amount));
    params.set("entry", playDecimal(values.entry));
    params.set("target", playDecimal(values.target));
    params.set("rate", values.rate === undefined ? "none" : playDecimal(values.rate));
    if (tick !== undefined) params.set("tick", String(tick));
  }
  return params;
}
