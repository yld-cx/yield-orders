import type { MetadataRoute } from "next";
import { registry, marketPath, ORIGIN } from "@/lib/registry";
import { networks } from "@yld-cx/sdk/ethereum";
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: ORIGIN, changeFrequency: "daily", priority: 1 },
    { url: `${ORIGIN}/market/open`, changeFrequency: "monthly", priority: 0.5 },
    ...networks.flatMap((n) =>
      registry.getMarkets(n.id).map((m) => ({
        url: `${ORIGIN}${marketPath(m)}`,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
    ),
  ];
}
