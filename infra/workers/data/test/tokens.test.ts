import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getTokens,
  normalizeUpstream,
  TOKEN_TTL,
  tokenRequest,
} from "../src/tokens.ts";
import {
  A,
  B,
  C,
  TestDatabase,
  environment,
  fetchJson,
  gecko,
} from "./helpers.ts";

const params = (addresses = A) =>
  new URLSearchParams({ chainId: "8453", addresses });
const fail: typeof fetch = async () => {
  throw new Error("Upstream unavailable");
};
const providerFailures: Record<string, typeof fetch> = {
  "network error": fail,
  timeout: async () => {
    throw new DOMException("Request timed out", "TimeoutError");
  },
  "HTTP error": async () => new Response("rate limit", { status: 429 }),
  "invalid JSON": async () => new Response("not JSON"),
  "invalid response": fetchJson({ bad: true }),
};

test("successful GeckoTerminal responses never call CoinGecko, including partial and empty results", async (t) => {
  for (const addresses of [[A, B], [A], []]) {
    await t.test(`${addresses.length} tokens returned`, async () => {
      const env = { ...environment(), COINGECKO_API_KEY: "test-demo-key" };
      let calls = 0;
      const fetcher: typeof fetch = async (input, init) => {
        calls++;
        assert.equal(
          String(input),
          `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${A},${B}`,
        );
        assert.equal(
          new Headers(init?.headers).has("x-cg-demo-api-key"),
          false,
        );
        return fetchJson(gecko(addresses))(input, init);
      };
      const result = await getTokens(params(`${A},${B}`), env, fetcher, 100);
      assert.equal(calls, 1);
      assert.equal(result.upstream, "ok");
      assert.deepEqual(
        result.tokens.map((token) => token.status),
        [A, B].map((a) => (addresses.includes(a) ? "available" : "unknown")),
      );
    });
  }
});

test("GeckoTerminal failures fall back to authenticated CoinGecko and cache normalized results", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const [name, failure] of Object.entries(providerFailures)) {
    await t.test(name, async () => {
      const env = { ...environment(), COINGECKO_API_KEY: "test-demo-key" };
      const payload = gecko([A, B]);
      const signals: (AbortSignal | null | undefined)[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        signals.push(init?.signal);
        const fallback = signals.length === 2;
        assert.equal(
          String(input),
          fallback
            ? `https://api.coingecko.com/api/v3/onchain/networks/base/tokens/multi/${A},${B}`
            : `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${A},${B}`,
        );
        assert.equal(
          new Headers(init?.headers).get("accept"),
          "application/json",
        );
        assert.equal(
          new Headers(init?.headers).get("x-cg-demo-api-key"),
          fallback ? env.COINGECKO_API_KEY : null,
        );
        assert.ok(init?.signal);
        return (fallback ? fetchJson(payload) : failure)(input, init);
      };
      const result = await getTokens(params(`${A},${B}`), env, fetcher, 100);
      assert.equal(signals.length, 2);
      assert.notEqual(signals[0], signals[1]);
      assert.equal(result.upstream, "ok");
      assert.deepEqual(
        result.tokens,
        [...normalizeUpstream(payload, 8453, 100).values()].map((meta) => ({
          id: `8453:${meta.address}`,
          ...meta,
          stale: false,
        })),
      );
      const cached = await getTokens(params(`${A},${B}`), env, fetcher, 200);
      assert.equal(cached.upstream, "cache");
      assert.deepEqual(cached.tokens, result.tokens);
      assert.equal(signals.length, 2);
    });
  }
});

test("both providers failing preserves stale snapshots and the existing failure cache", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  for (const [name, failure] of Object.entries(providerFailures)) {
    await t.test(name, async () => {
      const env = { ...environment(), COINGECKO_API_KEY: "test-demo-key" };
      const original = await getTokens(params(), env, fetchJson(gecko()), 100);
      let calls = 0;
      const fetcher: typeof fetch = async (input, init) => {
        calls++;
        if (calls === 1) throw new Error(env.COINGECKO_API_KEY);
        assert.equal(
          String(input),
          `https://api.coingecko.com/api/v3/onchain/networks/base/tokens/multi/${A},${B}`,
        );
        return failure(input, init);
      };
      const expiredAt = 100 + TOKEN_TTL;
      const result = await getTokens(
        params(`${A},${B}`),
        env,
        fetcher,
        expiredAt,
      );
      assert.equal(calls, 2);
      assert.equal(result.upstream, "unavailable");
      assert.deepEqual(result.tokens[0], {
        ...original.tokens[0],
        stale: true,
        retryAfter: expiredAt + 300,
      });
      assert.deepEqual(result.tokens[1], {
        id: `8453:${B}`,
        chainId: 8453,
        address: B,
        source: "geckoterminal",
        status: "unavailable",
        fetchedAt: expiredAt,
        retryAfter: expiredAt + 300,
        stale: false,
      });
      const cached = await getTokens(
        params(`${A},${B}`),
        env,
        fetcher,
        expiredAt + 1,
      );
      assert.equal(cached.upstream, "cache");
      assert.deepEqual(cached.tokens, result.tokens);
      assert.equal(calls, 2);
      assert.equal(
        JSON.stringify(result).includes(env.COINGECKO_API_KEY),
        false,
      );
      assert.equal(
        JSON.stringify(logs.mock.calls).includes(env.COINGECKO_API_KEY),
        false,
      );
    });
  }
});

test("addresses are validated, normalized and deduplicated, with request limits", () => {
  assert.deepEqual(
    tokenRequest(params(`${A.toUpperCase().replace("0X", "0x")},${A},${B}`))
      .addresses,
    [A, B],
  );
  for (const value of ["", "0x123", Array(31).fill(A).join(",")])
    assert.throws(() => tokenRequest(params(value)));
  for (const chainId of ["", "999", "1.2", "-1"])
    assert.throws(() =>
      tokenRequest(new URLSearchParams({ chainId, addresses: A })),
    );
  assert.throws(() =>
    tokenRequest(new URLSearchParams(`chainId=8453&chainId=1&addresses=${A}`)),
  );
});

test("preserves the entire GeckoTerminal resource and numeric string precision", () => {
  const payload = gecko([A], {
    future_field: { example: true },
    market_cap_usd: null,
  });
  const meta = normalizeUpstream(payload, 8453, 100).get(A)!;
  assert.deepEqual(meta.geckoTerminal, payload.data[0]);
  assert.equal(
    (meta.geckoTerminal!.attributes as Record<string, unknown>).price_usd,
    "1.234567890123456789",
  );
  assert.equal(meta.imageUrl, "https://example.com/token.png");
});

test("partial names do not cause loss of raw token data", () => {
  const data = gecko([A], { name: null, symbol: null });
  assert.deepEqual(
    normalizeUpstream(data, 8453, 100).get(A)!.geckoTerminal,
    data.data[0],
  );
});

test("batches and persists complete token snapshots, serves seven-day cache hits, then refreshes together", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    assert.ok(String(input).endsWith(`${A},${B}`));
    return fetchJson(gecko([A, B], calls === 1 ? {} : { price_usd: "2.5" }))(
      input,
    );
  };
  const first = await getTokens(params(`${A},${B}`), env, fetcher, 100);
  assert.equal(first.tokens.length, 2);
  assert.equal(first.upstream, "ok");
  assert.equal(db.rows("SELECT * FROM tokens").length, 2);
  const cached = await getTokens(
    params(`${B},${A}`),
    env,
    fail,
    100 + TOKEN_TTL - 1,
  );
  assert.equal(cached.upstream, "cache");
  assert.deepEqual(
    cached.tokens.map((token) => token.address),
    [B, A],
  );
  assert.equal(calls, 1);
  assert.equal(cached.tokens[0]!.stale, false);
  assert.equal(cached.tokens[0]!.fetchedAt, 100);
  assert.equal(
    (cached.tokens[0]!.geckoTerminal!.attributes as Record<string, unknown>)
      .price_usd,
    "1.234567890123456789",
  );
  const result = await getTokens(
    params(`${A},${B}`),
    env,
    fetcher,
    100 + TOKEN_TTL,
  );
  assert.equal(result.upstream, "ok");
  assert.equal(calls, 2);
  for (const token of result.tokens) {
    assert.equal(token.stale, false);
    assert.equal(token.fetchedAt, 100 + TOKEN_TTL);
    assert.equal(
      (token.geckoTerminal!.attributes as Record<string, unknown>).price_usd,
      "2.5",
    );
  }
});

test("unknown tokens and partial responses receive negative caching", async () => {
  const env = environment();
  const first = await getTokens(
    params(`${A},${B}`),
    env,
    fetchJson(gecko([A])),
    100,
  );
  assert.deepEqual(
    first.tokens.map((t) => t.status),
    ["available", "unknown"],
  );
  const unknown = await getTokens(params(B), env, fail, 200);
  assert.equal(unknown.upstream, "cache");
  const recovered = await getTokens(
    params(B),
    env,
    fetchJson(gecko([B])),
    3700,
  );
  assert.equal(recovered.tokens[0]!.status, "available");
});

test("failed seven-day refresh preserves the complete stale snapshot and suppresses retries", async () => {
  const env = environment();
  const original = await getTokens(params(), env, fetchJson(gecko()), 100);
  const expiredAt = 100 + TOKEN_TTL;
  const result = await getTokens(params(), env, fail, expiredAt);
  assert.deepEqual(
    result.tokens[0]!.geckoTerminal,
    original.tokens[0]!.geckoTerminal,
  );
  assert.equal(result.tokens[0]!.stale, true);
  assert.equal(result.tokens[0]!.fetchedAt, 100);
  assert.equal(
    (await getTokens(params(), env, fail, expiredAt + 100)).upstream,
    "cache",
  );
  const recovered = await getTokens(
    params(),
    env,
    fetchJson(gecko([A], { price_usd: "2.5" })),
    expiredAt + 300,
  );
  assert.equal(recovered.upstream, "ok");
  assert.equal(recovered.tokens[0]!.stale, false);
  assert.equal(recovered.tokens[0]!.fetchedAt, expiredAt + 300);
});

test("successful partial refresh does not erase previously known token data", async () => {
  const env = environment();
  await getTokens(params(), env, fetchJson(gecko()), 100);
  const result = await getTokens(
    params(),
    env,
    fetchJson({ data: [] }),
    100 + TOKEN_TTL,
  );
  assert.equal(result.tokens[0]!.status, "available");
  assert.equal(result.tokens[0]!.stale, true);
  assert.ok(result.tokens[0]!.geckoTerminal);
});

test("HTTP failures and malformed upstream responses are retried after the bounded failure TTL", async () => {
  for (const fetcher of [
    fail,
    fetchJson({ bad: true }),
    (async () => new Response("rate limit", { status: 429 })) as typeof fetch,
  ]) {
    const env = environment();
    assert.equal(
      (await getTokens(params(), env, fetcher, 100)).tokens[0]!.status,
      "unavailable",
    );
    assert.equal((await getTokens(params(), env, fail, 200)).upstream, "cache");
    assert.equal(
      (await getTokens(params(), env, fetchJson(gecko()), 400)).tokens[0]!
        .status,
      "available",
    );
  }
});

test("global atomic budget bounds public cache misses across different addresses", async () => {
  const env = { ...environment(), TOKEN_UPSTREAM_PER_MINUTE: "1" };
  await getTokens(params(), env, fetchJson(gecko()), 120);
  const denied = await getTokens(params(B), env, fail, 121);
  assert.equal(denied.upstream, "rate_limited");
  assert.equal(
    (await getTokens(params(B), env, fetchJson(gecko([B])), 180)).upstream,
    "ok",
  );
});

test("concurrent cache-miss requests cannot exceed the upstream budget", async () => {
  const env = { ...environment(), TOKEN_UPSTREAM_PER_MINUTE: "1" };
  const results = await Promise.all(
    [A, B, C].map((a) => getTokens(params(a), env, fetchJson(gecko([a])), 120)),
  );
  assert.equal(results.filter((r) => r.upstream === "ok").length, 1);
});

test("slower failed refresh cannot overwrite a newer successful token record", async () => {
  const db = new TestDatabase(),
    env = environment(db);
  await getTokens(params(), env, fetchJson(gecko()), 100);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: typeof fetch = async () => {
    await gate;
    throw new Error("failure");
  };
  const expiredAt = 100 + TOKEN_TTL;
  const oldRequest = getTokens(params(), env, slow, expiredAt);
  await Promise.resolve();
  await Promise.resolve();
  await getTokens(
    params(),
    env,
    fetchJson(gecko([A], { price_usd: "99" })),
    expiredAt + 1,
  );
  release();
  await oldRequest;
  const result = await getTokens(params(), env, fail, expiredAt + 2);
  assert.equal(
    (result.tokens[0]!.geckoTerminal!.attributes as Record<string, unknown>)
      .price_usd,
    "99",
  );
});
