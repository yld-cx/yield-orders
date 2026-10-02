import { writeFile } from "node:fs/promises";
import { getAddress, getCreate2Address, keccak256, zeroAddress } from "viem";
import { COMPILER_DESCRIPTION, PROTOCOL_VERSION, TEST_FEE_TO, YLD_FEE_TO } from "../hardhat.config.js";
import {
  candidateSalt,
  CREATE_X_ADDRESS,
  creationCode,
  guardSalt,
  NETWORKS,
  predict,
  readArtifact,
  readManifest,
} from "./deployment.js";

const artifact = await readArtifact();
const currentManifest = await readManifest();
const { saltNamespace } = currentManifest;
if (!saltNamespace.trim()) throw new Error("Deployment saltNamespace cannot be empty");
if (
  currentManifest.rawSalt ||
  currentManifest.guardedSalt ||
  currentManifest.address ||
  currentManifest.creationCodeHash ||
  currentManifest.runtimeCodeHash
)
  throw new Error("Clear the previous deployment result before mining a new salt");
if (!YLD_FEE_TO) throw new Error(`Set final production YLD_FEE_TO before mining a v${PROTOCOL_VERSION} salt`);
const feeTo = getAddress(YLD_FEE_TO);
if (currentManifest.feeTo && currentManifest.feeTo.toLowerCase() !== feeTo.toLowerCase())
  throw new Error("YLD_FEE_TO differs from the manifest fee receiver");
if (feeTo === zeroAddress || feeTo.toLowerCase() === TEST_FEE_TO.toLowerCase())
  throw new Error("YLD_FEE_TO must be a nonzero frozen production receiver");
const creationCodeHash = keccak256(creationCode(artifact, feeTo));
let found = false;
for (let nonce = 0n; nonce < 2_000_000n; ++nonce) {
  const rawSalt = candidateSalt(nonce, saltNamespace);
  const address = getCreate2Address({
    from: CREATE_X_ADDRESS,
    salt: guardSalt(rawSalt),
    bytecodeHash: creationCodeHash,
  });
  if (!address.toLowerCase().startsWith("0x0000")) continue;
  const result = predict(artifact, feeTo, rawSalt);
  const manifest = {
    version: PROTOCOL_VERSION,
    feeTo,
    saltNamespace,
    rawSalt,
    guardedSalt: result.guardedSalt,
    address: result.address,
    creationCodeHash: result.creationCodeHash,
    runtimeCodeHash: result.runtimeCodeHash,
    compiler: COMPILER_DESCRIPTION,
    networks: Object.fromEntries(Object.entries(NETWORKS).map(([name, config]) => [name, config.chainId])),
  };
  await writeFile(new URL("../deployments/config.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Mined salt at nonce ${nonce}: ${result.address}`);
  found = true;
  break;
}
if (!found) throw new Error("No 0x0000 salt found within two million candidates");
