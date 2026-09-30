import { readFile } from "node:fs/promises";

const limit = 24_576;
const artifact = JSON.parse(
  await readFile(new URL("../artifacts/contracts/YieldOrders.sol/YieldOrders.json", import.meta.url)),
);
const bytecode = artifact.deployedBytecode;
if (typeof bytecode !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(bytecode)) {
  throw new Error("YieldOrders production artifact has invalid runtime bytecode");
}
const bytes = (bytecode.length - 2) / 2;
console.log(`YieldOrders runtime bytecode: ${bytes.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} bytes`);
console.log(`EIP-170 headroom: ${(limit - bytes).toLocaleString("en-US")} bytes`);
if (bytes > limit) process.exitCode = 1;
