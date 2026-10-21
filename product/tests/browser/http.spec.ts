import { test, expect } from "@playwright/test";

const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  key = `${a}:${b}`;

test("Safe manifest and icon are public and allow cross-origin discovery", async ({
  request,
}) => {
  const response = await request.get("/manifest.json", {
    headers: { Origin: "https://app.safe.global" },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  expect(response.headers()["access-control-allow-origin"]).toBe("*");
  expect(response.headers()["access-control-allow-methods"]).toBe("GET");
  expect(response.headers()["access-control-allow-headers"]).toBe(
    "X-Requested-With, content-type, Authorization",
  );
  const manifest = await response.json();
  expect(manifest.name.length).toBeLessThanOrEqual(50);
  expect(manifest.description.length).toBeLessThanOrEqual(200);
  const icon = await request.get(`/${manifest.iconPath}`);
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  expect(await icon.text()).toContain('width="128" height="128"');
  const app = await request.get("/");
  expect(app.headers()["x-frame-options"]).toBeUndefined();
  expect(app.headers()["content-security-policy"]).toContain(
    "frame-ancestors 'self' https://app.safe.global https://safe.global",
  );
});

test("canonical redirect, server metadata and OG without wallet or RPC", async ({
  request,
}) => {
  const response = await request.get(`/market/BASE/${b}:${a}`, {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(308);
  expect(response.headers().location).toBe(`/market/base/${key}`);
  const page = await request.get(`/market/base/${key}`);
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain(`https://yld.cx/market/base/${key}/og`);
  const csp = page.headers()["content-security-policy"];
  expect(csp).toContain("nonce-");
  const scripts = csp.split("; ").find((d) => d.startsWith("script-src"))!;
  expect(scripts).not.toContain("unsafe-inline");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(scripts.includes("unsafe-eval")).toBe(
    process.env.PLAYWRIGHT_SERVER === "development",
  );
  const og = await request.get(`/market/base/${key}/og`);
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toContain("image/png");
  expect((await og.body()).length).toBeGreaterThan(10000);
  expect(og.headers()["cache-control"]).toContain("s-maxage=86400");
  const favicon = await request.get("/icon.svg");
  expect(favicon.status()).toBe(200);
  expect(await favicon.text()).toContain("👑");
  const generic = await request.get("/opengraph-image");
  expect(generic.status()).toBe(200);
  expect(generic.headers()["content-type"]).toContain("image/png");
});
