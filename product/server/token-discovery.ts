import "server-only";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { compactToken } from "@/lib/token-metadata";

export async function discoverTokens(slug: NetworkSlug) {
  const network = getNetwork(slug);
  const chainId = String(network.chain.id);
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = process.env.YLD_D1_DATABASE_ID;
  const token = process.env.YLD_D1_READ_TOKEN;
  if (!account || !database || !token)
    throw new Error("Token discovery unavailable");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql: "SELECT meta FROM tokens WHERE id LIKE ? AND json_extract(meta, '$.status') = 'available' AND json_extract(meta, '$.symbol') IS NOT NULL AND json_extract(meta, '$.geckoTerminal.attributes.price_usd') IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 100",
        params: [`${chainId}:%`],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error("Token discovery unavailable");
  const body = (await response.json()) as {
    success?: boolean;
    result?: { success?: boolean; results?: { meta: string }[] }[];
  };
  const result = body.result?.[0];
  if (!body.success || !result?.success || !Array.isArray(result.results))
    throw new Error("Token discovery unavailable");
  const seen = new Set<string>();
  const tokens = result.results.slice(0, 100).flatMap((row) => {
    try {
      const token = compactToken(JSON.parse(row.meta), network.id);
      if (
        !token ||
        token.status !== "available" ||
        !token.priceUsd ||
        seen.has(token.address)
      )
        return [];
      seen.add(token.address);
      // Discovery is identity only. Prices come exclusively from the Worker.
      return [
        {
          address: token.address,
          symbol: token.symbol,
          name: token.name,
          imageUrl: token.imageUrl,
          coingeckoCoinId: token.coingeckoCoinId,
        },
      ];
    } catch {
      return [];
    }
  });
  return tokens;
}
