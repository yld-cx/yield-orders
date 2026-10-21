import type { NetworkId, TokenReference } from "@yld-cx/sdk";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import { isAddress } from "viem";

export const METADATA_ORIGIN = "https://md.yld.cx";
// GeckoTerminal token logos are served by these image CDNs. Keep server fetches
// and browser CSP aligned; untrusted hosts always use the universal fallback.
export const TOKEN_IMAGE_ORIGINS = [
  "https://coin-images.coingecko.com",
  "https://assets.coingecko.com",
  "https://assets.geckoterminal.com",
];
export function tokenImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (
      TOKEN_IMAGE_ORIGINS.includes(url.origin) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* Missing or invalid image. */
  }
}
export interface TokenMetadata extends TokenReference {
  symbol: string;
  name: string;
  imageUrl?: string;
  priceUsd?: string;
  status: "available" | "unknown" | "unavailable";
  fetchedAt?: number;
  retryAfter?: number;
  stale?: boolean;
  coingeckoCoinId?: string;
}
export function fallbackToken(
  network: NetworkId,
  address: string,
): TokenMetadata {
  return {
    network,
    address: address.toLowerCase(),
    symbol: `${address.slice(0, 6)}…${address.slice(-4)}`,
    name: "Token",
    status: "unavailable",
  };
}
export function compactToken(
  value: unknown,
  network: NetworkId,
): TokenMetadata | undefined {
  if (!value || typeof value !== "object") return;
  const meta = value as Record<string, unknown>;
  if (
    meta.chainId !== getNetwork(network).chain.id ||
    typeof meta.address !== "string" ||
    !isAddress(meta.address, { strict: false })
  )
    return;
  const address = meta.address.toLowerCase();
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
  const gecko = meta.geckoTerminal as
    { attributes?: { price_usd?: unknown } } | undefined;
  const price = gecko?.attributes?.price_usd;
  return {
    ...fallbackToken(network, address),
    status:
      meta.status === "available" || meta.status === "unknown"
        ? meta.status
        : "unavailable",
    symbol: text(meta.symbol, 64) ?? fallbackToken(network, address).symbol,
    name: text(meta.name, 256) ?? "Token",
    imageUrl: tokenImageUrl(meta.imageUrl),
    priceUsd:
      typeof price === "string" &&
      price.length <= 128 &&
      /^\d+(\.\d+)?$/.test(price) &&
      Number(price) > 0 &&
      Number.isFinite(Number(price))
        ? price
        : undefined,
    fetchedAt: typeof meta.fetchedAt === "number" ? meta.fetchedAt : undefined,
    retryAfter:
      typeof meta.retryAfter === "number" ? meta.retryAfter : undefined,
    stale: meta.stale === true,
    coingeckoCoinId: text(meta.coingeckoCoinId, 256),
  };
}

export async function fetchTokenMetadata(
  network: NetworkId,
  addresses: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<TokenMetadata[]> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(
    (a) => isAddress(a, { strict: false }),
  );
  const chainId = getNetwork(network).chain.id;
  const endpoint =
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_METADATA_PROXY === "true"
      ? "/api/md"
      : METADATA_ORIGIN;
  const groups = Array.from({ length: Math.ceil(unique.length / 30) }, (_, i) =>
    unique.slice(i * 30, i * 30 + 30),
  );
  return (
    await Promise.all(
      groups.map(async (group) => {
        try {
          const response = await fetcher(
            `${endpoint}/tokens?${new URLSearchParams({ chainId: String(chainId), addresses: group.join(",") })}`,
            { signal: AbortSignal.timeout(6000), cache: "no-store" },
          );
          if (!response.ok) throw new Error("Metadata unavailable");
          const body = (await response.json()) as { tokens?: unknown[] };
          if (!Array.isArray(body.tokens))
            throw new Error("Invalid metadata response");
          const tokens = body.tokens
            .map((row) => compactToken(row, network))
            .filter((t): t is TokenMetadata => !!t);
          return group.map(
            (address) =>
              tokens.find((t) => t.address === address) ??
              fallbackToken(network, address),
          );
        } catch {
          return group.map((address) => fallbackToken(network, address));
        }
      }),
    )
  ).flat();
}

// Coalesce simultaneous per-token queries (market pairs, Orders, selectors) into
// Worker batches. Only TanStack Query retains results; this queue holds in-flight work.
type PendingToken = {
  promise: Promise<TokenMetadata>;
  resolve: (token: TokenMetadata) => void;
};
const pending = new Map<NetworkId, Map<string, PendingToken>>();
const inFlight = new Map<string, Promise<TokenMetadata>>();
export function loadTokenMetadata(
  network: NetworkId,
  address: string,
): Promise<TokenMetadata> {
  const normalized = address.toLowerCase();
  const key = `${network}/${normalized}`;
  const active = inFlight.get(key);
  if (active) return active;
  let batch = pending.get(network);
  if (!batch) {
    batch = new Map();
    pending.set(network, batch);
    const queued = batch;
    setTimeout(async () => {
      pending.delete(network);
      const addresses = [...queued.keys()];
      const tokens = await fetchTokenMetadata(network, addresses);
      for (const address of addresses) {
        inFlight.delete(`${network}/${address}`);
        queued
          .get(address)!
          .resolve(
            tokens.find((t) => t.address === address) ??
              fallbackToken(network, address),
          );
      }
    }, 0);
  }
  const existing = batch.get(normalized);
  if (existing) return existing.promise;
  let resolve!: (token: TokenMetadata) => void;
  const promise = new Promise<TokenMetadata>((done) => {
    resolve = done;
  });
  batch.set(normalized, { promise, resolve });
  inFlight.set(key, promise);
  return promise;
}

export function selectorTokens(
  configured: readonly TokenReference[],
  discovered: readonly TokenMetadata[],
  metadata: readonly TokenMetadata[] = [],
): TokenMetadata[] {
  const result = new Map<string, TokenMetadata>();
  for (const token of [
    ...configured.map(
      (ref) =>
        metadata.find(
          (t) =>
            t.network === ref.network &&
            t.address.toLowerCase() === ref.address.toLowerCase() &&
            t.status === "available",
        ) ??
        discovered.find(
          (t) =>
            t.network === ref.network &&
            t.address === ref.address.toLowerCase(),
        ) ??
        fallbackToken(ref.network, ref.address),
    ),
    ...discovered,
  ]) {
    const key = `${token.network}/${token.address.toLowerCase()}`;
    if (!result.has(key))
      result.set(key, { ...token, address: token.address.toLowerCase() });
  }
  return [...result.values()];
}
