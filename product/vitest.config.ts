import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      // Vitest executes these modules in Node, outside Next's server compiler.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
      "@yld-cx/ui": fileURLToPath(
        new URL("./packages/ui/src", import.meta.url),
      ),
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "@yld-cx/sdk/ethereum/rpc": fileURLToPath(
        new URL("./packages/sdk/src/ethereum/rpc.ts", import.meta.url),
      ),
      "@yld-cx/sdk/ethereum": fileURLToPath(
        new URL("./packages/sdk/src/ethereum/index.ts", import.meta.url),
      ),
      "@yld-cx/sdk/coinbase": fileURLToPath(
        new URL("./packages/sdk/src/coinbase.ts", import.meta.url),
      ),
      "@yld-cx/sdk/registry": fileURLToPath(
        new URL("./packages/sdk/src/registry/index.ts", import.meta.url),
      ),
      "@yld-cx/sdk/uniswap": fileURLToPath(
        new URL("./packages/sdk/src/uniswap/index.ts", import.meta.url),
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
