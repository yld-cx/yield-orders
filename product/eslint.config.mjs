import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next/core-web-vitals";
import ts from "eslint-config-next/typescript";
export default defineConfig([
  ...next,
  ...ts,
  globalIgnores([
    ".next/**",
    "**/.turbo/**",
    "packages/sdk/dist/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);
