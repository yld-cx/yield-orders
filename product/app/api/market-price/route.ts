import { PRODUCT_MARKET } from "@yld-cx/sdk";
import { networks } from "@yld-cx/sdk/ethereum";
import { canonicalPair } from "@yld-cx/sdk/registry";
import { address } from "@yld-cx/sdk/uniswap";
import { getMarketPrice } from "@/server/market-price";
import type { Address } from "viem";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const network = networks.find(
    (n) => String(n.chain.id) === params.get("chainId"),
  );
  try {
    if (
      !network ||
      [...params.keys()].some(
        (key) =>
          !["chainId", "tokenA", "tokenB"].includes(key) ||
          params.getAll(key).length !== 1,
      )
    )
      throw new Error("Invalid reference request");
    const [a, b] = canonicalPair(
      network.id,
      address(params.get("tokenA")),
      address(params.get("tokenB")),
    ) as readonly [Address, Address];
    const reference = await getMarketPrice(network.slug, a, b);
    return Response.json(reference, {
      headers: {
        "Cache-Control": reference.price.amm
          ? `public, max-age=0, s-maxage=${PRODUCT_MARKET.referenceCacheSeconds}`
          : "no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Invalid or unavailable market reference" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
