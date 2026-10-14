import type { MetadataRoute } from "next";
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/orders" },
    sitemap: "https://yld.cx/sitemap.xml",
    host: "https://yld.cx",
  };
}
