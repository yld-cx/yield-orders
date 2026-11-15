import { networks } from "@yld-cx/sdk/ethereum";
import { discoverTokens } from "@/lib/server/token-discovery";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const network = networks.find(
    (n) => String(n.chain.id) === params.get("chainId"),
  );
  if (!network || params.getAll("chainId").length !== 1)
    return Response.json(
      { tokens: [], error: "Unsupported chain" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const tokens = await discoverTokens(network.slug);
    return Response.json(
      { tokens },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=86400",
          "Vercel-CDN-Cache-Control": "public, s-maxage=86400",
        },
      },
    );
  } catch {
    return Response.json(
      { tokens: [], error: "Token discovery unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
