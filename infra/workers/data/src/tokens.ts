import {
  address,
  errorKind,
  HttpError,
  log,
  setting,
  validateParams,
  type Env,
} from "./shared.ts";
import { networkFor } from "./networks.ts";

export const TOKEN_TTL = 7 * 86400;
const UNKNOWN_TTL = 3600;
const FAILURE_TTL = 300;
interface TokenMeta {
  chainId: number;
  address: string;
  status: "available" | "unknown" | "unavailable";
  name?: string;
  symbol?: string;
  imageUrl?: string;
  coingeckoCoinId?: string;
  source: "geckoterminal";
  fetchedAt: number;
  retryAfter?: number;
  geckoTerminal?: Record<string, unknown>;
}
interface TokenRow {
  id: string;
  meta: string;
  timestamp: number;
}

export function tokenRequest(params: URLSearchParams) {
  validateParams(params, ["chainId", "addresses"]);
  const network = networkFor(params.get("chainId"));
  const values = params.get("addresses")?.split(",");
  if (!values?.length || values.length > 30)
    throw new HttpError(400, "Provide 1–30 addresses");
  return { network, addresses: [...new Set(values.map(address))] };
}

// Global, atomic upstream budget in the existing state table. Unlike isolate counters,
// concurrent requests from different Cloudflare locations share this bound.
async function upstreamPermit(env: Env, now: number): Promise<boolean> {
  const cap = setting(env.TOKEN_UPSTREAM_PER_MINUTE, 20, 1, 25);
  const window = Math.floor(now / 60);
  const result = await env.DB.prepare(
    `
    INSERT INTO state(key, meta, timestamp) VALUES ('tokens:upstream-budget', json_object('window', ?, 'count', 1), ?)
    ON CONFLICT(key) DO UPDATE SET
      meta = json_object('window', ?, 'count', CASE WHEN json_extract(meta, '$.window') = ? THEN json_extract(meta, '$.count') + 1 ELSE 1 END),
      timestamp = excluded.timestamp
    WHERE json_extract(meta, '$.window') != ? OR json_extract(meta, '$.count') < ?
    RETURNING key`,
  )
    .bind(window, now, window, window, window, cap)
    .first();
  return result !== null;
}

function textField(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;
}

export function normalizeUpstream(
  payload: unknown,
  chainId: number,
  now: number,
): Map<string, TokenMeta> {
  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { data?: unknown }).data)
  )
    throw new Error("Invalid GeckoTerminal response");
  const result = new Map<string, TokenMeta>();
  for (const item of (payload as { data: unknown[] }).data) {
    if (!item || typeof item !== "object") continue;
    const a = (item as { attributes?: Record<string, unknown> }).attributes;
    if (!a || typeof a.address !== "string") continue;
    let normalized: string;
    try {
      normalized = address(a.address);
    } catch {
      continue;
    }
    const name = textField(a.name, 256),
      symbol = textField(a.symbol, 64);
    const imageUrl = textField(a.image_url, 2048);
    result.set(normalized, {
      chainId,
      address: normalized,
      source: "geckoterminal",
      status: "available",
      fetchedAt: now,
      name,
      symbol,
      imageUrl: imageUrl?.startsWith("https://") ? imageUrl : undefined,
      coingeckoCoinId: textField(a.coingecko_coin_id, 256),
      geckoTerminal: item as Record<string, unknown>,
    });
  }
  // Preserve the complete per-token resource, including prices and relationships.
  // Upstream decimals remain advisory; transaction construction must read decimals onchain.
  return result;
}

export async function getTokens(
  params: URLSearchParams,
  env: Env,
  fetcher: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000),
) {
  const { network, addresses } = tokenRequest(params);
  const ids = addresses.map((a) => `${network.chainId}:${a}`);
  const cached = await env.DB.prepare(
    `SELECT * FROM tokens WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<TokenRow>();
  const tokens = new Map(
    cached.results.map((row) => [row.id, JSON.parse(row.meta) as TokenMeta]),
  );
  const missing = addresses.filter((a) => {
    const meta = tokens.get(`${network.chainId}:${a}`);
    if (meta?.retryAfter && meta.retryAfter > now) return false;
    return (
      !meta ||
      now - meta.fetchedAt >=
        (meta.status === "available"
          ? TOKEN_TTL
          : meta.status === "unknown"
            ? UNKNOWN_TTL
            : FAILURE_TTL)
    );
  });
  let upstream = "cache";
  if (missing.length) {
    if (!network.gecko) upstream = "unsupported_network";
    else if (!(await upstreamPermit(env, now))) upstream = "rate_limited";
    else {
      let found: Map<string, TokenMeta> | undefined;
      for (const provider of ["geckoterminal", "coingecko"]) {
        const fallback = provider === "coingecko";
        if (fallback && !env.COINGECKO_API_KEY) break;
        try {
          const response = await fetcher(
            fallback
              ? `https://api.coingecko.com/api/v3/onchain/networks/${network.gecko}/tokens/multi/${missing.join(",")}`
              : `https://api.geckoterminal.com/api/v2/networks/${network.gecko}/tokens/multi/${missing.join(",")}`,
            {
              headers: {
                accept: "application/json",
                ...(fallback
                  ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY! }
                  : {}),
              },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Token metadata HTTP failure");
          }
          found = normalizeUpstream(
            await response.json(),
            network.chainId,
            now,
          );
          upstream = "ok";
          break;
        } catch (error) {
          upstream = "unavailable";
          log({
            type: "token_upstream_error",
            chainId: network.chainId,
            error: errorKind(error),
          });
        }
      }
      const writes: D1PreparedStatement[] = [];
      for (const a of missing) {
        const id = `${network.chainId}:${a}`;
        const previous = tokens.get(id);
        // Missing data never destroys a previously known token, even on partial 200 responses.
        const meta: TokenMeta =
          found?.get(a) ??
          (previous?.status === "available"
            ? {
                ...previous,
                retryAfter: now + (found ? UNKNOWN_TTL : FAILURE_TTL),
              }
            : {
                chainId: network.chainId,
                address: a,
                source: "geckoterminal",
                status: found ? "unknown" : "unavailable",
                fetchedAt: now,
                retryAfter: now + (found ? UNKNOWN_TTL : FAILURE_TTL),
              });
        tokens.set(id, meta);
        writes.push(
          env.DB.prepare(
            `INSERT INTO tokens(id, meta, timestamp) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET meta = excluded.meta, timestamp = excluded.timestamp
          WHERE excluded.timestamp >= tokens.timestamp
            AND json_extract(excluded.meta, '$.fetchedAt') >= json_extract(tokens.meta, '$.fetchedAt')
            AND NOT (json_extract(tokens.meta, '$.status') = 'available' AND json_extract(excluded.meta, '$.status') != 'available')`,
          ).bind(id, JSON.stringify(meta), now),
        );
      }
      // Each token has its own row/upsert. A single round trip, at most 30 statements.
      await env.DB.batch(writes);
    }
  }
  return {
    tokens: ids.map((id, index) => {
      const meta = tokens.get(id);
      const output: TokenMeta = meta ?? {
        chainId: network.chainId,
        address: addresses[index]!,
        status: "unavailable",
        source: "geckoterminal",
        fetchedAt: 0,
      };
      return {
        id,
        ...output,
        stale:
          meta?.status === "available" && now - meta.fetchedAt >= TOKEN_TTL,
      };
    }),
    upstream,
  };
}
