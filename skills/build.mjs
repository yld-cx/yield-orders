import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const common = {
  bundle: true,
  format: "esm",
  target: "es2023",
  external: ["viem", "zod"],
  nodePaths: [
    fileURLToPath(new URL("../product/node_modules", import.meta.url)),
  ],
  logLevel: "info",
};
await Promise.all([
  build({
    ...common,
    platform: "neutral",
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
  build({
    ...common,
    platform: "node",
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    plugins: [
      {
        name: "shared-api",
        setup(build) {
          build.onResolve({ filter: /^\.\/index\.ts$/ }, () => ({
            path: "./index.js",
            external: true,
          }));
        },
      },
    ],
  }),
]);
await chmod("dist/cli.js", 0o755);
