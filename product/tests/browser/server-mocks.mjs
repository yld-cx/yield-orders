// Server-side metadata requests cannot be intercepted by page.route. Keep SEO
// and OG browser coverage independent of live Worker, D1 and image services.
import { tokenFixture } from "./token-fixtures.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (url.origin === "https://md.yld.cx") {
    const chainId = Number(url.searchParams.get("chainId"));
    return Response.json({
      tokens: (url.searchParams.get("addresses") ?? "")
        .split(",")
        .map((address) => ({
          chainId,
          address,
          status: "available",
          fetchedAt: Math.floor(Date.now() / 1000),
          symbol: tokenFixture(address).symbol,
          name: tokenFixture(address).name,
        })),
    });
  }
  if (url.origin === "https://api.cloudflare.com")
    return Response.json({
      success: true,
      result: [{ success: true, results: [] }],
    });
  return originalFetch(input, init);
};
