import { writeFile } from "node:fs/promises";
import { network } from "hardhat";
import { keccak256, type Address, type Hex } from "viem";
import core from "../deployments/config.json" with { type: "json" };
import resolverManifest from "../deployments/resolver.json" with { type: "json" };

const { viem, networkName } = await network.create();
if (!["base", "ethereum", "robinhood"].includes(networkName)) throw new Error("Select a production deployment network");
const client = await viem.getPublicClient();
const chainId = await client.getChainId();
const config = resolverManifest.chains[String(chainId) as keyof typeof resolverManifest.chains];
if (!config || core.networks[networkName as keyof typeof core.networks] !== chainId) throw new Error("Chain mismatch");
if (config.resolver) throw new Error("A resolver is already recorded; do not redeploy implicitly");
if (networkName !== "base" && !resolverManifest.chains["8453"].resolver)
  throw new Error("Deploy and canary-test Base first");
const code = await client.getCode({ address: core.address as Address });
if (!code || keccak256(code) !== core.runtimeCodeHash) throw new Error("Canonical YLD runtime mismatch");
for (const target of [config.morpho, config.router, config.permit2])
  if (!(await client.getCode({ address: target as Address }))) throw new Error("Dependency not deployed");
const resolver = await viem.deployContract("YieldResolver", [
  core.address as Address,
  config.morpho as Address,
  config.router as Address,
  config.permit2 as Address,
]);
const runtime = await client.getCode({ address: resolver.address });
if (!runtime) throw new Error("Resolver deployment has no code");
const updated = resolverManifest as unknown as {
  chains: Record<string, { resolver: Address | null; resolverCodeHash: Hex | null }>;
};
updated.chains[String(chainId)].resolver = resolver.address;
updated.chains[String(chainId)].resolverCodeHash = keccak256(runtime);
await writeFile(
  new URL("../deployments/resolver.json", import.meta.url),
  `${JSON.stringify(resolverManifest, null, 2)}\n`,
);
console.log(JSON.stringify({ chainId, resolver: resolver.address, runtimeCodeHash: keccak256(runtime) }));
