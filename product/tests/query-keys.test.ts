import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { pairIdFor } from "@yld-cx/sdk/ethereum";
import { QUERY_NAMES, queryKeys } from "@/lib/query-keys";

const a = "0x4200000000000000000000000000000000000006";
const b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const c = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const pair = `${a}:${b}`;
const reversed = `${b.toUpperCase().replace("0X", "0x")}:${a}`;

describe("shared RPC query keys", () => {
  it("invalidates each read group on the current network using shared key prefixes", async () => {
    const client = new QueryClient();
    const affected = [
      queryKeys.ticks("base", pair, 0, 1000, 7),
      queryKeys.ticks("base", `${b}:${c}`, 1000, 1000, 30),
      queryKeys.pair("base", pair),
      queryKeys.pair("base", `${b}:${c}`),
      queryKeys.portfolio("base", a),
      queryKeys.portfolio("base", b),
      queryKeys.quote("base", pair, 1n, 10n),
    ];
    const unaffected = [
      queryKeys.ticks("ethereum", pair),
      queryKeys.pair("ethereum", pair),
      queryKeys.portfolio("ethereum", a),
      queryKeys.quote("ethereum", pair, 1n, 10n),
      queryKeys.token("base", a),
      queryKeys.tokenMetadata("base", a),
      queryKeys.deployment("base"),
    ];
    for (const key of [...affected, ...unaffected])
      client.setQueryData(key, {});
    await Promise.all(
      [
        QUERY_NAMES.ticks,
        QUERY_NAMES.pair,
        QUERY_NAMES.portfolio,
        QUERY_NAMES.quote,
      ].map((name) =>
        client.invalidateQueries({ queryKey: [name, "eip155:8453"] }),
      ),
    );
    for (const key of affected)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unaffected)
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    client.clear();
  });
  it("shares concurrent pair reads across network aliases and display orientations", async () => {
    const client = new QueryClient();
    const read = vi.fn(async () => [pairIdFor(a, b), a, b, true]);
    const [first, second] = await Promise.all([
      client.fetchQuery({
        queryKey: queryKeys.pair("base", pair),
        queryFn: read,
      }),
      client.fetchQuery({
        queryKey: queryKeys.pair("eip155:8453", reversed),
        queryFn: read,
      }),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(queryKeys.token("base", b.toUpperCase())).toEqual(
      queryKeys.token("eip155:8453", b),
    );
    expect(queryKeys.tokenMetadata("base", b.toUpperCase())).toEqual(
      queryKeys.tokenMetadata("eip155:8453", b),
    );
    expect(queryKeys.portfolio("base", b.toUpperCase())).toEqual(
      queryKeys.portfolio("eip155:8453", b),
    );
    client.clear();
  });
  it("shares identical discovery reads while separating network, grid, duration and quote inputs", () => {
    const key = queryKeys.ticks("base", pair, 0, 1000, 7);
    expect(key).toEqual(queryKeys.ticks("eip155:8453", reversed, 0, 1000, 7));
    for (const other of [
      queryKeys.ticks("ethereum", pair, 0, 1000, 7),
      queryKeys.ticks("base", `${a}:${c}`, 0, 1000, 7),
      queryKeys.ticks("base", pair, 1000, 1000, 7),
      queryKeys.ticks("base", pair, 0, 500, 7),
      queryKeys.ticks("base", pair, 0, 1000, 30),
      queryKeys.ticks("base", pair, 0, 1000),
      queryKeys.ticks("base", pair, 0, 1000, 7, 1),
    ])
      expect(other).not.toEqual(key);
    expect(queryKeys.quote("base", pair, 1n, 10n)).toEqual(
      queryKeys.quote("eip155:8453", reversed, 1n, 10n),
    );
    expect(queryKeys.quote("base", pair, 1n, 10n)).not.toEqual(
      queryKeys.quote("base", pair, 1n, 11n),
    );
    expect(queryKeys.quote("base", pair, 1n, 10n)).not.toEqual(
      queryKeys.quote("base", pair, 2n, 10n),
    );
  });
});
