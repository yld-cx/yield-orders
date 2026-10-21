import type { NextConfig } from "next";
import path from "node:path";
const metadataProxy =
  process.env.NODE_ENV === "development" ||
  process.env.VERCEL_ENV === "preview";
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@yld-cx/sdk", "@yld-cx/ui"],
  outputFileTracingRoot: path.resolve(process.cwd()),
  turbopack: { root: path.resolve(process.cwd()) },
  images: { remotePatterns: [] },
  // Use the same build-time switch for the browser endpoint and its rewrite.
  env: { NEXT_PUBLIC_METADATA_PROXY: String(metadataProxy) },
  async rewrites() {
    return metadataProxy
      ? [{ source: "/api/md/:path*", destination: "https://md.yld.cx/:path*" }]
      : [];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET" },
          {
            key: "Access-Control-Allow-Headers",
            value: "X-Requested-With, content-type, Authorization",
          },
        ],
      },
      {
        source: "/yieldlist.json",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=300, stale-while-revalidate=3600",
          },
        ],
      },
    ];
  },
};
config.experimental = { optimizePackageImports: ["viem/chains"] };
export default config;
