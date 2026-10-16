import { z } from "zod";
import {
  DEFAULT_DURATION,
  DURATIONS,
  DISCOVERY_DEFAULTS,
  MIN_TICK,
  MAX_TICK,
  TOKEN_METADATA_LIMITS,
} from "../constants.ts";
// Avoid even the caught eval-capability probe in nonce-only browser CSPs.
z.config({ jitless: true });
import {
  canonicalPair,
  decodeBase58,
  normalizeAddress,
} from "../registry/addresses.ts";
import type { NetworkId } from "../types/index.ts";
export const categorySchema = z.enum([
  "blue-chip",
  "stable",
  "meme",
  "token",
  "stock",
  "rwa",
]);
export const networkSchema = z.string().refine((value) => {
  if (/^eip155:[1-9]\d*$/.test(value))
    return Number.isSafeInteger(Number(value.split(":")[1]));
  if (!/^solana:[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  // Solana CAIP-2 references use the first 32 Base58 characters of the genesis hash.
  try {
    decodeBase58(value.slice(7));
    return value.slice(7).length === 32;
  } catch {
    return false;
  }
}, "Expected a CAIP-2 EVM or Solana network identifier");
const logoSchema = z
  .string()
  .refine(
    (v) =>
      /^(?:https:\/\/yld\.cx)?\/tokens\/[a-z0-9-]+\.(?:svg|png|webp)$/.test(v),
    "Use a hosted token logo under /tokens",
  );
export const tokenMetadataSchema = z.strictObject({
  symbol: z.string().trim().min(1).max(TOKEN_METADATA_LIMITS.symbol),
  name: z.string().trim().min(1).max(TOKEN_METADATA_LIMITS.name),
  decimals: z.number().int().min(0).max(TOKEN_METADATA_LIMITS.decimals),
  logoURI: logoSchema.optional(),
  tags: z
    .array(categorySchema)
    .max(TOKEN_METADATA_LIMITS.tags)
    .refine((v) => new Set(v).size === v.length, "Duplicate tags")
    .optional(),
});
export const marketMetadataSchema = z
  .strictObject({
    defaultDuration: z.literal(DURATIONS).default(DEFAULT_DURATION),
    stepTicks: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(DISCOVERY_DEFAULTS.stepTicks),
    baseTick: z
      .number()
      .int()
      .min(MIN_TICK)
      .max(MAX_TICK)
      .default(DISCOVERY_DEFAULTS.baseTick),
    telegramPost: z
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          u.hostname === "t.me" &&
          !u.username &&
          !u.password &&
          /^\/[a-zA-Z0-9_]+\/\d+$/.test(u.pathname) &&
          !u.search &&
          !u.hash
        );
      }, "Expected an HTTPS Telegram post URL")
      .optional(),
  })
  .refine(
    (v) => v.baseTick % v.stepTicks === 0,
    "baseTick must align to stepTicks",
  );
export const yieldListSchema = z
  .strictObject({
    version: z.literal(1),
    tokens: z.record(networkSchema, z.record(z.string(), tokenMetadataSchema)),
    markets: z.record(
      networkSchema,
      z.record(z.string(), marketMetadataSchema),
    ),
  })
  .superRefine((list, ctx) => {
    for (const [network, tokens] of Object.entries(list.tokens))
      for (const address of Object.keys(tokens)) {
        try {
          if (normalizeAddress(network as NetworkId, address) !== address)
            throw new Error("EVM keys must be lowercase");
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: String(error),
            path: ["tokens", network, address],
          });
        }
      }
    for (const [network, markets] of Object.entries(list.markets))
      for (const key of Object.keys(markets)) {
        try {
          const parts = key.split(":");
          if (parts.length !== 2) throw new Error("Invalid pair key");
          if (
            canonicalPair(network as NetworkId, parts[0], parts[1]).join(
              ":",
            ) !== key
          )
            throw new Error("Pair must be normalized and canonically ordered");
          if (
            !list.tokens[network]?.[parts[0]] ||
            !list.tokens[network]?.[parts[1]]
          )
            throw new Error("Market references an unknown token");
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: String(error),
            path: ["markets", network, key],
          });
        }
      }
  });
export type YieldList = z.infer<typeof yieldListSchema>;
