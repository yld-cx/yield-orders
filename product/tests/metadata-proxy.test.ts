import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("metadata proxy configuration", () => {
  it.each([
    { mode: "development", deployment: "development", proxy: true },
    { mode: "production", deployment: "preview", proxy: true },
    { mode: "production", deployment: "production", proxy: false },
    { mode: "production", deployment: "", proxy: false },
  ] as const)(
    "keeps browser routing and rewrites aligned for $mode / $deployment",
    async ({ mode, deployment, proxy }) => {
      vi.stubEnv("NODE_ENV", mode);
      vi.stubEnv("VERCEL_ENV", deployment);
      vi.resetModules();
      const { default: config } = await import("../next.config");
      expect(config.env?.NEXT_PUBLIC_METADATA_PROXY).toBe(String(proxy));
      expect(await config.rewrites!()).toEqual(
        proxy
          ? [
              {
                source: "/api/md/:path*",
                destination: "https://md.yld.cx/:path*",
              },
            ]
          : [],
      );
    },
  );
});
