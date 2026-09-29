import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256 } from "viem";
import {
  assertManifest,
  CREATE_X_ABI,
  CREATE_X_ADDRESS,
  CREATE_X_RUNTIME_HASH,
  NETWORKS,
  predict,
  readArtifact,
  readManifest,
} from "../scripts/deployment.js";

describe("same-address CreateX deployment on a supported-chain fork", async () => {
  const { viem, networkName } = await network.create();
  const target = networkName.replace("Fork", "") as keyof typeof NETWORKS;
  if (!(target in NETWORKS)) throw new Error(`Select ethereumFork, baseFork, or robinhoodFork: ${networkName}`);
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const manifest = await readManifest();
  const prediction = predict(await readArtifact(), manifest.feeTo, manifest.rawSalt);
  assertManifest(manifest, prediction);

  it("checks the factory and exact pinned runtime at the 0x0000 address", async () => {
    assert.equal(await publicClient.getChainId(), NETWORKS[target].chainId);
    const factory = await publicClient.getCode({ address: CREATE_X_ADDRESS });
    assert.ok(factory);
    assert.equal(keccak256(factory), CREATE_X_RUNTIME_HASH);
    assert.ok(prediction.address.toLowerCase().startsWith("0x0000"));
    const before = await publicClient.getCode({ address: prediction.address });
    if (before) {
      assert.equal(keccak256(before), manifest.runtimeCodeHash);
      return;
    }
    const hash = await wallet.writeContract({
      address: CREATE_X_ADDRESS,
      abi: CREATE_X_ABI,
      functionName: "deployCreate2",
      args: [manifest.rawSalt, prediction.initCode],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    const runtime = await publicClient.getCode({ address: prediction.address });
    assert.ok(runtime);
    assert.equal(keccak256(runtime), prediction.runtimeCodeHash);
  });
});
