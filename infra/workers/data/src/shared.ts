import { isAddress, type Address } from "viem";

export interface Env {
  DB: D1Database;
  CORS_ORIGINS?: string;
  NETWORK_CONFIG?: string;
  RPC_URLS?: string;
  MAX_SYNC_DURATION_MS?: string;
  MAX_CHUNKS?: string;
  MAX_RPC_REQUESTS?: string;
  MAX_D1_QUERIES?: string;
  EVENT_RETENTION_MONTHS?: string;
  CLEANUP_BATCH_SIZE?: string;
  MAX_CLEANUP_BATCHES?: string;
  RPC_TIMEOUT_MS?: string;
  TOKEN_UPSTREAM_PER_MINUTE?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function address(value: string): Address {
  if (!isAddress(value, { strict: false }))
    throw new HttpError(400, "Invalid EVM address");
  return value.toLowerCase() as Address;
}

export function integer(
  value: string,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new HttpError(400, `Invalid ${name}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function setting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return value === undefined
    ? fallback
    : integer(value, "configuration value", min, max);
}

export function json(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v))
      return v.toLowerCase();
    return v;
  });
}

export function log(data: Record<string, unknown>): void {
  console.log(json(data));
}

// Never log RPC error messages: Viem errors can include full credential-bearing URLs.
export function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function validateParams(
  params: URLSearchParams,
  allowed: readonly string[],
): void {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) {
      throw new HttpError(400, `Unknown or repeated parameter: ${key}`);
    }
  }
}
