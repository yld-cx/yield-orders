import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  zeroAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import hre from "hardhat";
import { TEST_FEE_TO, YLD_CHECK_ONLY, YLD_NETWORK } from "../hardhat.config.js";
import {
  assertManifest,
  CREATE_X_ABI,
  CREATE_X_ADDRESS,
  CREATE_X_RUNTIME_HASH,
  NETWORKS,
  predict,
  readArtifact,
  readManifest,
} from "./deployment.js";

const artifact = await readArtifact();
const manifest = await readManifest();
const prediction = predict(artifact, manifest.feeTo, manifest.rawSalt);
assertManifest(manifest, prediction);
if (getAddress(`0x${manifest.rawSalt.slice(2, 42)}`) === zeroAddress)
  throw new Error("CreateX raw salt cannot use the zero-address prefix");

function clientFor(name: keyof typeof NETWORKS) {
  const network = NETWORKS[name];
  const chain = defineChain({
    id: network.chainId,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [network.rpc] } },
  });
  return { chain, publicClient: createPublicClient({ chain, transport: http(network.rpc) }) };
}
const clients = {
  ethereum: clientFor("ethereum"),
  base: clientFor("base"),
  robinhood: clientFor("robinhood"),
};

// All three networks must pass preflight before a transaction is sent on any one network.
for (const [name, network] of Object.entries(NETWORKS)) {
  const { publicClient } = clients[name as keyof typeof NETWORKS];
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== network.chainId) throw new Error(`${name} RPC reports chain ${actualChainId}`);
  const factoryCode = await publicClient.getCode({ address: CREATE_X_ADDRESS });
  if (!factoryCode || keccak256(factoryCode) !== CREATE_X_RUNTIME_HASH)
    throw new Error(`${name} CreateX factory missing or bytecode mismatch`);
  const existing = await publicClient.getCode({ address: prediction.address });
  if (existing && keccak256(existing) !== prediction.runtimeCodeHash)
    throw new Error(`${name} protocol address occupied by unexpected code`);
  console.log(
    `${name}: factory verified; expected protocol ${prediction.address}; ${existing ? "already deployed" : "vacant"}`,
  );
}

if (YLD_CHECK_ONLY) process.exit(0);
if (manifest.feeTo.toLowerCase() === TEST_FEE_TO.toLowerCase())
  throw new Error("Temporary FEE_TO cannot be used for production deployment");
const target = YLD_NETWORK as keyof typeof NETWORKS | undefined;
if (!target || !(target in NETWORKS)) throw new Error("Set YLD_NETWORK to ethereum, base, or robinhood");
const accounts = hre.config.networks[target].accounts;
const firstAccount = Array.isArray(accounts) ? accounts[0] : undefined;
if (!firstAccount || !("_type" in firstAccount) || firstAccount._type !== "ResolvedConfigurationVariable")
  throw new Error("YLD_DEPLOYER is required");
const key = (await firstAccount.getHexString()) as Hex;
const { chain, publicClient } = clients[target];
const account = privateKeyToAccount(key);
if (getAddress(`0x${manifest.rawSalt.slice(2, 42)}`) === account.address)
  throw new Error("CreateX raw salt prefix equals deployer; guarded-salt prediction would change");
const wallet = createWalletClient({ account, chain, transport: http(NETWORKS[target].rpc) });
const existing = await publicClient.getCode({ address: prediction.address });
if (existing) {
  console.log(`Existing correct implementation at ${prediction.address}`);
  process.exit(0);
}
const hash = await wallet.writeContract({
  address: CREATE_X_ADDRESS,
  abi: CREATE_X_ABI,
  functionName: "deployCreate2",
  args: [manifest.rawSalt, prediction.initCode],
  chain,
  account,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
if (receipt.status !== "success") throw new Error(`Deployment reverted: ${hash}`);
const runtime = await publicClient.getCode({ address: prediction.address });
if (!runtime || keccak256(runtime) !== prediction.runtimeCodeHash)
  throw new Error("Post-deployment runtime bytecode mismatch");
console.log(`${target} deployed ${prediction.address}; runtime verified; tx ${hash}`);
