import {
  coinbaseOwnerBytes,
  coinbaseWalletAbi,
  coinbaseWalletDeployment,
  coinbaseWalletFactoryAbi,
  inspectCoinbaseWallets,
  isCoinbaseOwner,
  verifyCoinbaseWallet,
} from "@yld-cx/sdk/coinbase";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  multicall3Abi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import { MCP_ORIGIN } from "./endpoints";

// Changing the factory or namespace changes all derived Agent Wallet addresses.
const { factory } = coinbaseWalletDeployment;
const namespace = "yld.cx/agents/v1";
export const agentWalletLimit = 32;
const ownerResult = encodeAbiParameters([{ type: "bool" }], [true]);

export interface AgentWallet {
  address: Address;
  index: number;
}

function creationArgs(main: Address, index: number) {
  const nonce = BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "string" }, { type: "uint256" }],
        [namespace, BigInt(index)],
      ),
    ),
  );
  return [[coinbaseOwnerBytes(main)], nonce] as const;
}

export async function discoverAgentWallets(rpc: PublicClient, main: Address) {
  const [chainId, blockNumber] = await Promise.all([
    rpc.getChainId(),
    rpc.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (chainId !== base.id) throw new Error("Agent Wallets require Base");
  const addresses = await rpc.multicall({
    contracts: Array.from({ length: agentWalletLimit }, (_, index) => ({
      address: factory,
      abi: coinbaseWalletFactoryAbi,
      functionName: "getAddress" as const,
      args: creationArgs(main, index),
    })),
    allowFailure: false,
    batchSize: 0,
    blockNumber,
  });
  const ownerCall = encodeFunctionData({
    abi: coinbaseWalletAbi,
    functionName: "isOwnerAddress",
    args: [main],
  });
  const probes = await rpc.readContract({
    address: base.contracts.multicall3.address,
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [
      addresses.map((target) => ({
        target,
        callData: ownerCall,
        allowFailure: true,
      })),
    ],
    blockNumber,
  });
  const candidates = addresses.flatMap((address, index) =>
    probes[index].success && probes[index].returnData === ownerResult
      ? [{ address, index }]
      : [],
  );
  const [inspected, next] = await Promise.all([
    inspectCoinbaseWallets(
      rpc,
      candidates.map(({ address }) => address),
      blockNumber,
    ),
    firstUndeployedWallet(rpc, addresses, probes, blockNumber),
  ]);
  return {
    blockNumber,
    wallets: candidates.filter(
      (_, index) => inspected[index].status === "verified",
    ),
    next,
  };
}

async function firstUndeployedWallet(
  rpc: PublicClient,
  addresses: readonly Address[],
  probes: readonly { success: boolean; returnData: Hex }[],
  blockNumber: bigint,
) {
  for (const [index, address] of addresses.entries()) {
    if (probes[index].success && probes[index].returnData !== "0x") continue;
    const code = await rpc.getCode({ address, blockNumber });
    if (!code || code === "0x") return { address, index };
  }
}

export function deployAgentWallet(main: Address, index: number) {
  return {
    to: factory,
    value: 0n,
    data: encodeFunctionData({
      abi: coinbaseWalletFactoryAbi,
      functionName: "createAccount",
      args: creationArgs(main, index),
    }),
  };
}

export function wasAgentWalletCreated(
  logs: TransactionReceipt["logs"],
  wallet: AgentWallet,
  main: Address,
) {
  const [owners, nonce] = creationArgs(main, wallet.index);
  return parseEventLogs({
    abi: coinbaseWalletFactoryAbi,
    eventName: "AccountCreated",
    logs: logs.filter(({ address }) => isAddressEqual(address, factory)),
  }).some(
    ({ args }) =>
      isAddressEqual(args.account, wallet.address) &&
      args.nonce === nonce &&
      args.owners.length === 1 &&
      args.owners[0].toLowerCase() === owners[0].toLowerCase(),
  );
}

export async function requireMainOwner(
  rpc: PublicClient,
  account: Address,
  main: Address,
) {
  const { blockNumber } = await verifyCoinbaseWallet(rpc, account);
  if (!(await isCoinbaseOwner(rpc, account, main, blockNumber))) {
    throw new Error("The connected wallet is not an authorized owner");
  }
  return blockNumber;
}

export async function readAgentSigner(
  rpc: PublicClient,
  account: Address,
  main: Address,
  blockNumber: bigint,
) {
  const [count, next] = await rpc.multicall({
    contracts: [
      { address: account, abi: coinbaseWalletAbi, functionName: "ownerCount" },
      {
        address: account,
        abi: coinbaseWalletAbi,
        functionName: "nextOwnerIndex",
      },
    ],
    allowFailure: false,
    blockNumber,
  });
  if (count === 1n) return null;
  if (count !== 2n)
    throw new Error("This Agent Wallet has multiple additional owners");
  const mainOwner = coinbaseOwnerBytes(main).toLowerCase();
  const earliest = next > 256n ? next - 256n : 0n;
  for (let start = next - 1n; start >= earliest; start -= 16n) {
    const indices: bigint[] = [];
    for (let index = start; index > start - 16n && index >= earliest; index--)
      indices.push(index);
    const owners = await rpc.multicall({
      contracts: indices.map((index) => ({
        address: account,
        abi: coinbaseWalletAbi,
        functionName: "ownerAtIndex" as const,
        args: [index] as const,
      })),
      allowFailure: false,
      blockNumber,
    });
    const result = owners.findIndex(
      (value) => value !== "0x" && value.toLowerCase() !== mainOwner,
    );
    if (result >= 0) {
      const owner = owners[result];
      if (!/^0x0{24}[0-9a-f]{40}$/i.test(owner))
        throw new Error("The additional owner is a public key");
      const address = getAddress(`0x${owner.slice(-40)}`);
      const code = await rpc.getCode({ address, blockNumber });
      if (code && code !== "0x")
        throw new Error("The additional owner is a smart account");
      return { address, index: indices[result] };
    }
  }
  throw new Error("Could not find the agent signer");
}

export async function requestAgentSigner() {
  const response = await fetch(`${MCP_ORIGIN}/signer`, {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error("Agent signer generation is unavailable");
  const { address, secret } = await response.json();
  if (
    typeof address !== "string" ||
    !isAddress(address) ||
    typeof secret !== "string" ||
    !/^v1\.[0-9A-Za-z_-]{80}$/.test(secret)
  )
    throw new Error("Invalid agent signer response");
  return { address, secret };
}
