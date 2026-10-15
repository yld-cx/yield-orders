import { NextRequest, NextResponse } from "next/server";
import { contentSecurityPolicy } from "@/lib/csp";
import { rpcUrls } from "@/lib/rpc";
import { parseMarketRoute } from "@/lib/registry";
export function proxy(request: NextRequest) {
  const market = request.nextUrl.pathname.match(/^\/market\/([^/]+)\/([^/]+)$/);
  if (market) {
    try {
      const route = parseMarketRoute(market[1], market[2]);
      if (
        decodeURIComponent(request.nextUrl.pathname) !== route.canonicalPath
      ) {
        const target = request.nextUrl.clone();
        target.pathname = route.canonicalPath;
        return NextResponse.redirect(target, 308);
      }
    } catch {
      /* Invalid inputs are handled by the market page's notFound boundary. */
    }
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(
    nonce,
    Object.values(rpcUrls).map((value) => new URL(value).origin),
    process.env.NODE_ENV === "development",
  );
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}
export const config = {
  matcher: [
    "/((?!_next/|tokens/|icon.svg|manifest.json|yieldlist.json|robots.txt|sitemap.xml|opengraph-image|.*?/og).*)",
  ],
};
