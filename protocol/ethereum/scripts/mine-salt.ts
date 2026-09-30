import { writeFile } from "node:fs/promises";
import { getAddress, getCreate2Address, keccak256, zeroAddress } from "viem";
import { YLD_FEE_TO } from "../hardhat.config.js";
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
const feeTo = getAddress(YLD_FEE_TO || currentManifest.feeTo);
if (feeTo === zeroAddress) throw new Error("YLD_FEE_TO cannot be zero");
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
    feeTo,
    saltNamespace,
    rawSalt,
    guardedSalt: result.guardedSalt,
    address: result.address,
    creationCodeHash: result.creationCodeHash,
    runtimeCodeHash: result.runtimeCodeHash,
    compiler: "solc 0.8.36; cancun; optimizer 200; viaIR",
    networks: Object.fromEntries(Object.entries(NETWORKS).map(([name, config]) => [name, config.chainId])),
  };
  await writeFile(new URL("../deployments/config.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Mined salt at nonce ${nonce}: ${result.address}`);
  found = true;
  break;
}
if (!found) throw new Error("No 0x0000 salt found within two million candidates");
