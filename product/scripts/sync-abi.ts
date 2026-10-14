import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const source = JSON.parse(
  await readFile(
    require.resolve("@yld-cx/ethereum-protocol/abi/YieldOrders.json"),
    "utf8",
  ),
) as unknown;
const contents = `// Generated from @yld-cx/ethereum-protocol by scripts/sync-abi.ts. Do not edit.\nexport const protocolAbi = ${JSON.stringify(source)} as const;\n`;
const target = new URL(
  "../packages/sdk/src/ethereum/abi.generated.ts",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  // Formatting is intentionally irrelevant to ABI equivalence.
  const { protocolAbi } =
    await import("../packages/sdk/src/ethereum/abi.generated.js");
  if (JSON.stringify(protocolAbi) !== JSON.stringify(source))
    throw new Error(
      "Generated ABI differs from protocol package. Run npm run sync:abi.",
    );
} else {
  await writeFile(target, contents);
}
