import { readFile } from "node:fs/promises";
import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { Registry } from "../packages/sdk/src/registry/index.js";
const raw = await readFile(
  new URL("../public/yieldlist.json", import.meta.url),
  "utf8",
);
const errors: ParseError[] = [];
const root = parseTree(raw, errors, {
  disallowComments: true,
  allowTrailingComma: false,
});
if (errors.length || !root)
  throw new Error("YieldList must be valid strict JSON");
function checkDuplicates(node: Node) {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const item of node.children ?? []) {
      const key = item.children?.[0]?.value as string;
      if (keys.has(key)) throw new Error(`Duplicate registry key: ${key}`);
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) checkDuplicates(child);
}
checkDuplicates(root);
const registry = new Registry(JSON.parse(raw));
console.log(
  `YieldList valid: ${Object.values(registry.data.markets).reduce((n, items) => n + Object.keys(items).length, 0)} markets.`,
);
