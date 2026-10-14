import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@yld-cx/ui": fileURLToPath(
        new URL("./packages/ui/src", import.meta.url),
      ),
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "@yld-cx/sdk/ethereum": fileURLToPath(
        new URL("./packages/sdk/src/ethereum/index.ts", import.meta.url),
      ),
      "@yld-cx/sdk/registry": fileURLToPath(
        new URL("./packages/sdk/src/registry/index.ts", import.meta.url),
      ),
      "@yld-cx/sdk": fileURLToPath(
        new URL("./packages/sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
  },
});
