import { defineConfig, devices } from "@playwright/test";
const development = process.env.PLAYWRIGHT_SERVER === "development";
const port = development ? 3000 : 3100;
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: true,
  timeout: development ? 60000 : 30000,
  workers: development ? 1 : undefined,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [
    { name: "http", testMatch: "**/http.spec.ts" },
    {
      name: "desktop",
      testIgnore: "**/http.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile",
      testIgnore: "**/http.spec.ts",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=./tests/browser/server-mocks.mjs`,
    },
    command: `npm run ${development ? "dev" : "start"} -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: development,
    timeout: 60000,
  },
});
