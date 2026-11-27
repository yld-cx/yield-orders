import { isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const address = z
  .string()
  .refine(
    (value): value is Address => isAddress(value, { strict: false }),
    "Expected an EVM address",
  );
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .refine((value): value is Hex => true);
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .refine((value) => BigInt(value) < 2n ** 256n, "Value exceeds uint256");
const decimal = z
  .string()
  .max(160)
  .regex(
    /^(?:\d+(?:\.\d+)?|\.\d+)$/,
    "Expected a token amount as a decimal string",
  );
const integer = z.number().int();
const chain = z
  .string()
  .max(32)
  .default("base")
  .describe("Network slug or CAIP-2 ID. Defaults to base.");
const account = address
  .optional()
  .describe(
    "Actual sending or portfolio address. Required without a connected wallet.",
  );
const pair = {
  tokenA: address.describe("One ERC-20 address in the pair"),
  tokenB: address.describe("The other ERC-20 address in the pair"),
};
const tickId = uint.describe(
  "Tick ID from book or portfolio, as a decimal string",
);
const amount = decimal.describe("Human-readable amount of the Tick Asset");
const durationDays = integer
  .min(1)
  .max(106751991167300)
  .describe("Rental term in days");
const deadline = integer
  .positive()
  .optional()
  .describe("Unix seconds. Defaults to five minutes from chain time.");
const operation = {
  operation: z.enum([
    "provide",
    "rent",
    "swap",
    "repay",
    "withdraw",
    "collect",
    "close",
    "settle",
  ]),
  tickId: tickId.optional(),
  positionId: uint.optional().describe("Rental position ID from portfolio"),
  amount: amount.optional(),
  tokenA: pair.tokenA.optional(),
  tokenB: pair.tokenB.optional(),
  asset: address
    .optional()
    .describe(
      "Deposited ERC-20 for a new Limit level. Must belong to the pair.",
    ),
  price: decimal
    .optional()
    .describe(
      "New Limit level price in Quote per deposited Asset. Snaps to the nearest tick.",
    ),
  durationDays: durationDays.optional(),
  deadline,
  maxQuoteIn: decimal
    .optional()
    .describe("Required for Swap. Maximum human-readable Quote input."),
  maxFullTermYieldAsset: decimal
    .optional()
    .describe("Required for Rent. Maximum total yield in Asset units."),
  maxYieldAsset: decimal
    .optional()
    .describe("Required for Repay. Maximum accrued yield in Asset units."),
  minImmediateAssetOut: decimal
    .optional()
    .describe(
      "Required for Withdraw. Minimum immediate Asset returned, possibly zero.",
    ),
};
export const commandInputs = {
  protocol: z.strictObject({}),
  networks: z.strictObject({}),
  markets: z.strictObject({
    chain,
    token: address.optional(),
    offset: integer.min(0).default(0),
    limit: integer.min(1).max(20).default(10),
  }),
  book: z.strictObject({
    chain,
    ...pair,
    durationDays: durationDays.default(7),
    centerTick: integer
      .min(-887272)
      .max(887272)
      .optional()
      .describe(
        "Canonical price tick. Use the market's configured center when omitted.",
      ),
    referencePrice: decimal
      .optional()
      .describe(
        "Center the book on an indicative price expressed in market Quote per market base token. Use instead of centerTick.",
      ),
    stepTicks: integer
      .min(1)
      .max(887272)
      .optional()
      .describe(
        "Discovery tick spacing, defaults to the configured market grid",
      ),
    radius: integer
      .min(0)
      .max(48)
      .default(10)
      .describe("Number of steps on either side of the center"),
  }),
  balances: z.strictObject({
    chain,
    account,
    tokens: z
      .array(address)
      .max(20)
      .default([])
      .describe(
        "ERC-20 addresses. Native ETH is always included on Base and Ethereum.",
      ),
  }),
  portfolio: z.strictObject({
    chain,
    account,
    offset: integer.min(0).default(0),
    limit: integer.min(1).max(30).default(10),
    blockNumber: uint.optional(),
  }),
  quote: z.strictObject({
    chain,
    operation: z.enum(["provide", "rent", "swap", "repay"]),
    tickId: tickId.optional(),
    positionId: uint.optional(),
    amount: amount.optional(),
    tokenA: pair.tokenA.optional(),
    tokenB: pair.tokenB.optional(),
    asset: operation.asset,
    price: operation.price,
    durationDays: operation.durationDays,
  }),
  prepare: z.strictObject({ chain, account, ...operation }),
  simulate: z.strictObject({
    chain,
    account,
    ...operation,
    atomic: z
      .boolean()
      .default(false)
      .describe(
        "Use eth_simulateV1 to include unsigned ERC-20 approval calls in the simulation.",
      ),
  }),
  status: z.strictObject({
    chain,
    hash: hash.describe("Transaction hash from the submitting wallet"),
  }),
};

export type Command = keyof typeof commandInputs;
export type CommandInput<K extends Command> = z.input<
  (typeof commandInputs)[K]
>;
export type ParsedInput<K extends Command> = z.output<
  (typeof commandInputs)[K]
>;
export const descriptions: Record<Command, string> = {
  protocol:
    "Understand Yield Orders, execution constraints and how positions resolve.",
  networks:
    "List supported chains, deployment addresses and expected runtime code hashes.",
  markets:
    "Page through YieldList markets and onchain token metadata. Filter by an optional token address.",
  book: "Read current Bid and Ask liquidity on a bounded price grid for a token pair.",
  balances: "Read native and requested ERC-20 balances for an address.",
  portfolio:
    "Read paginated Limit and rental positions, claimable amounts, maturity and repayment requirements.",
  quote:
    "Quote Provide, Swap, Rent or Repay using protocol state. For a new Provide level, use tokenA, tokenB, asset and price.",
  prepare:
    "Prepare unsigned calls for Provide, Rent, Swap, Repay, Withdraw, Collect, Close or Settle. Explicit caps protect cost and output.",
  simulate:
    "Prepare and dry-run an operation with the actual sender. Include approvals if the RPC supports eth_simulateV1.",
  status:
    "Read a transaction receipt and protocol events, or check whether its hash is pending or unknown.",
};
