import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeDeployData, getCreate2Address, keccak256, type Address, type Hex } from "viem";
import {
  BASE_RPC_URL,
  COMPILER_DESCRIPTION,
  ETHEREUM_RPC_URL,
  PROTOCOL_VERSION,
  ROBINHOOD_RPC_URL,
  SALT_NAMESPACE,
} from "../hardhat.config.js";

export const CREATE_X_ADDRESS = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed" as const;
export const CREATE_X_RUNTIME_HASH = "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f" as const;
export const NETWORKS = {
  ethereum: { chainId: 1, rpc: ETHEREUM_RPC_URL },
  base: { chainId: 8453, rpc: BASE_RPC_URL },
  robinhood: { chainId: 4663, rpc: ROBINHOOD_RPC_URL },
} as const;

export type DeploymentManifest = {
  version: typeof PROTOCOL_VERSION;
  feeTo: Address | null;
  saltNamespace: string;
  rawSalt: Hex | null;
  guardedSalt: Hex | null;
  address: Address | null;
  creationCodeHash: Hex | null;
  runtimeCodeHash: Hex | null;
  compiler: string;
  networks: Record<keyof typeof NETWORKS, number>;
};

type Artifact = {
  abi: readonly unknown[];
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
};

export async function readArtifact(): Promise<Artifact> {
  return JSON.parse(
    await readFile(new URL("../artifacts/contracts/YieldOrders.sol/YieldOrders.json", import.meta.url), "utf8"),
  ) as Artifact;
}

export async function readManifest(): Promise<DeploymentManifest> {
  return JSON.parse(
    await readFile(new URL("../deployments/config.json", import.meta.url), "utf8"),
  ) as DeploymentManifest;
}

export function guardSalt(rawSalt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }], [rawSalt]));
}

export function candidateSalt(nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }], [SALT_NAMESPACE, nonce]));
}

export function creationCode(artifact: Artifact, feeTo: Address): Hex {
  return encodeDeployData({ abi: artifact.abi as any, bytecode: artifact.bytecode, args: [feeTo] });
}

export function expectedRuntimeCode(artifact: Artifact, feeTo: Address): Hex {
  let code = artifact.deployedBytecode.slice(2);
  const addressWord = feeTo.slice(2).toLowerCase().padStart(64, "0");
  const references = Object.values(artifact.immutableReferences).flat();
  if (references.length === 0) throw new Error("FEE_TO immutable references missing from artifact");
  for (const { start, length } of references) {
    if (length !== 32) throw new Error("Unexpected immutable reference length");
    code = code.slice(0, start * 2) + addressWord + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

export function predict(
  artifact: Artifact,
  feeTo: Address,
  rawSalt: Hex,
): {
  address: Address;
  guardedSalt: Hex;
  creationCodeHash: Hex;
  runtimeCodeHash: Hex;
  initCode: Hex;
} {
  const initCode = creationCode(artifact, feeTo);
  const guardedSalt = guardSalt(rawSalt);
  const creationCodeHash = keccak256(initCode);
  const runtimeCodeHash = keccak256(expectedRuntimeCode(artifact, feeTo));
  return {
    address: getCreate2Address({ from: CREATE_X_ADDRESS, salt: guardedSalt, bytecodeHash: creationCodeHash }),
    guardedSalt,
    creationCodeHash,
    runtimeCodeHash,
    initCode,
  };
}

export function assertManifest(manifest: DeploymentManifest, prediction: ReturnType<typeof predict>): void {
  if (!manifest.feeTo || !manifest.rawSalt) throw new Error("production configuration is incomplete");
  if (manifest.version !== PROTOCOL_VERSION) throw new Error("Wrong protocol version");
  if (manifest.saltNamespace !== SALT_NAMESPACE) throw new Error("Wrong salt namespace");
  if (manifest.compiler !== COMPILER_DESCRIPTION) throw new Error("Wrong compiler configuration");
  if (!manifest.networks || Object.keys(manifest.networks).sort().join(",") !== Object.keys(NETWORKS).sort().join(","))
    throw new Error("Wrong network entries");
  if (!prediction.address.toLowerCase().startsWith("0x0000"))
    throw new Error("Protocol address must start with 0x0000");
  for (const [name, config] of Object.entries(NETWORKS)) {
    if (manifest.networks[name as keyof typeof NETWORKS] !== config.chainId) throw new Error(`Wrong ${name} chain ID`);
    const onChainPrediction = getCreate2Address({
      from: CREATE_X_ADDRESS,
      salt: prediction.guardedSalt,
      bytecodeHash: prediction.creationCodeHash,
    });
    if (onChainPrediction.toLowerCase() !== prediction.address.toLowerCase())
      throw new Error(`${name} predicts a different address`);
  }
  for (const field of ["address", "guardedSalt", "creationCodeHash", "runtimeCodeHash"] as const) {
    if (manifest[field]?.toLowerCase() !== prediction[field].toLowerCase())
      throw new Error(`Pinned ${field} differs from local production build`);
  }
}

export const CREATE_X_ABI = [
  {
    type: "function",
    name: "deployCreate2",
    stateMutability: "payable",
    inputs: [
      { type: "bytes32", name: "salt" },
      { type: "bytes", name: "initCode" },
    ],
    outputs: [{ type: "address", name: "newContract" }],
  },
] as const;
