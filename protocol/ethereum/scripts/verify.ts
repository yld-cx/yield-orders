import hre from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { createPublicClient, defineChain, http, keccak256 } from "viem";
import { YLD_NETWORK } from "../hardhat.config.js";
import { assertManifest, NETWORKS, predict, readArtifact, readManifest } from "./deployment.js";

const target = YLD_NETWORK as keyof typeof NETWORKS | undefined;
if (!target || !(target in NETWORKS)) throw new Error("Set YLD_NETWORK to ethereum, base, or robinhood");
const network = NETWORKS[target];
const artifact = await readArtifact();
const manifest = await readManifest();
if (!manifest.feeTo || !manifest.rawSalt) throw new Error("production configuration is incomplete");
const prediction = predict(artifact, manifest.feeTo, manifest.rawSalt);
assertManifest(manifest, prediction);
const chain = defineChain({
  id: network.chainId,
  name: target,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [network.rpc] } },
});
const client = createPublicClient({ chain, transport: http(network.rpc) });
if ((await client.getChainId()) !== network.chainId) throw new Error("RPC chain mismatch");
const runtime = await client.getCode({ address: prediction.address });
if (!runtime || keccak256(runtime) !== prediction.runtimeCodeHash)
  throw new Error("Runtime bytecode does not match pinned implementation");
await verifyContract(
  {
    address: prediction.address,
    contract: "contracts/YieldOrders.sol:YieldOrders",
    constructorArgs: [manifest.feeTo],
    provider: "etherscan",
  },
  hre,
);
console.log(`${target}: verified ${prediction.address}`);
