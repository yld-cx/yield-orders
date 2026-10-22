import { z } from "zod";
import {
  DEFAULT_DURATION,
  DURATIONS,
  DISCOVERY_DEFAULTS,
  MIN_TICK,
  MAX_TICK,
} from "../constants.ts";
// Avoid even the caught eval-capability probe in nonce-only browser CSPs.
z.config({ jitless: true });
import { canonicalPair, decodeBase58 } from "../registry/addresses.ts";
import { Category, type NetworkId } from "../types/index.ts";
export const categorySchema = z.enum([
  Category.BlueChip,
  Category.Stable,
  Category.Meme,
  Category.Defi,
  Category.Stock,
  Category.Rwa,
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
export const marketMetadataSchema = z
  .strictObject({
    tags: z
      .array(categorySchema)
      .max(categorySchema.options.length)
      .refine((v) => new Set(v).size === v.length, "Duplicate tags")
      .default([]),
    defaultDuration: z.literal(DURATIONS).default(DEFAULT_DURATION),
    stepTicks: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(DISCOVERY_DEFAULTS.stepTicks),
    baseTick: z.number().int().min(MIN_TICK).max(MAX_TICK).optional(),
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
    (v) => v.baseTick === undefined || v.baseTick % v.stepTicks === 0,
    "baseTick must align to stepTicks",
  );
export const yieldListSchema = z
  .strictObject({
    version: z.literal(1),
    markets: z.record(
      networkSchema,
      z.record(z.string(), marketMetadataSchema),
    ),
  })
  .superRefine((list, ctx) => {
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
