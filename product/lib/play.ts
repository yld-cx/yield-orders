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
