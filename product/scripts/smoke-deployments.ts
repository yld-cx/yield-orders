import { createPublicClient, http, keccak256, type PublicClient } from "viem";
import {
  networks,
  deploymentFor,
  EthereumClient,
} from "../packages/sdk/src/ethereum/index.js";
for (const network of networks) {
  const url =
    process.env[`${network.slug.toUpperCase()}_RPC_URL`] ||
    network.chain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({
    chain: network.chain,
    transport: http(url, { timeout: 15000, retryCount: 0 }),
  });
  const expected = deploymentFor(network.id);
  try {
    const chainId = await publicClient.getChainId();
    const code = await publicClient.getCode({ address: expected.address });
    if (
      chainId !== network.chain.id ||
      !code ||
      code === "0x" ||
      keccak256(code) !== expected.runtimeCodeHash
    )
      throw new Error(
        `Deployment mismatch: chain=${chainId}, code=${!!code && code !== "0x"}, hash=${code && code !== "0x" ? keccak256(code) : "absent"}`,
      );
    const sdk = new EthereumClient(publicClient as PublicClient, network.id);
    await sdk.verifyDeployment();
    console.log(`${network.name}: chain ${chainId}, runtime hash verified.`);
  } catch (error) {
    console.error(
      `${network.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
