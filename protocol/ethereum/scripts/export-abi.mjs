import { mkdir, readFile, writeFile } from "node:fs/promises";

const protocolArtifact = JSON.parse(
  await readFile(new URL("../artifacts/contracts/YieldOrders.sol/YieldOrders.json", import.meta.url)),
);
await writeFile(
  new URL("../abi/YieldOrders.json", import.meta.url),
  `${JSON.stringify(protocolArtifact.abi, null, 2)}\n`,
);
await mkdir(new URL("../test/abi/", import.meta.url), { recursive: true });

const mockArtifacts = {
  mockERC20: "../artifacts/contracts/test/MockERC20.sol/MockERC20.json",
  feeOnTransferToken: "../artifacts/contracts/test/MockERC20.sol/FeeOnTransferToken.json",
  reentrantToken: "../artifacts/contracts/test/MockERC20.sol/ReentrantToken.json",
};
let mocks = "// Generated test fixtures; not part of the public protocol ABI.\n";
for (const [name, path] of Object.entries(mockArtifacts)) {
  const artifact = JSON.parse(await readFile(new URL(path, import.meta.url)));
  mocks += `export const ${name}Abi = ${JSON.stringify(artifact.abi)} as const;\n`;
}
await writeFile(new URL("../test/abi/mocks.ts", import.meta.url), mocks);
