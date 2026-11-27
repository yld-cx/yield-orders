import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";

// Published Coinbase Smart Wallet v1.1 deployment, verified against Base.
export const coinbaseWalletDeployment = {
  factory: "0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842",
  implementation: "0x00000110dCdEdC9581cb5eCB8467282f2926534d",
  implementationCodeHash:
    "0x136185896fc519277ec953c0b3d048fc0c9f607b8d04022e60f23ef8dbc6c4d5",
} as const;

const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const { implementation, implementationCodeHash } = coinbaseWalletDeployment;
const implementationWord = encodeAbiParameters(
  [{ type: "address" }],
  [implementation],
);
const proxyHash =
  "0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d";

export const coinbaseWalletFactoryAbi = parseAbi([
  "function getAddress(bytes[] owners, uint256 nonce) view returns (address)",
  "function createAccount(bytes[] owners, uint256 nonce) payable returns (address)",
  "event AccountCreated(address indexed account, bytes[] owners, uint256 nonce)",
]);

export const coinbaseWalletAbi = parseAbi([
  "function isOwnerAddress(address account) view returns (bool)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls) payable",
  "function addOwnerAddress(address owner)",
  "function removeOwnerAtIndex(uint256 index, bytes owner)",
  "function nextOwnerIndex() view returns (uint256)",
  "function ownerCount() view returns (uint256)",
  "function ownerAtIndex(uint256 index) view returns (bytes)",
]);

export async function verifyCoinbaseWallet(
  client: PublicClient,
  account: Address,
) {
  const [chainId, blockNumber] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (chainId !== base.id)
    throw new Error("Coinbase Agent Wallets require Base");
  const [wallet] = await inspectCoinbaseWallets(client, [account], blockNumber);
  if (wallet.status !== "verified") throw new Error(wallet.reason);
  return { implementation: wallet.implementation, blockNumber };
}

type CoinbaseWalletInspection =
  | { address: Address; status: "verified"; implementation: Address }
  | { address: Address; status: "undeployed" | "unsupported"; reason: string };

export async function inspectCoinbaseWallets(
  client: PublicClient,
  addresses: readonly Address[],
  blockNumber: bigint,
) {
  const wallets = await Promise.all(
    addresses.map(async (address): Promise<CoinbaseWalletInspection> => {
      const code = await client.getCode({ address, blockNumber });
      if (!code || code === "0x")
        return {
          address,
          status: "undeployed",
          reason: "Coinbase Smart Wallet is not deployed",
        };
      if (keccak256(code) !== proxyHash)
        return {
          address,
          status: "unsupported",
          reason: "Unsupported Coinbase Smart Wallet proxy",
        };
      const slot = await client.getStorageAt({
        address,
        slot: implementationSlot,
        blockNumber,
      });
      if (!slot || !/^0x0{24}[0-9a-f]{40}$/i.test(slot))
        return {
          address,
          status: "unsupported",
          reason: "Unsupported Coinbase Smart Wallet proxy",
        };
      if (slot.toLowerCase() !== implementationWord)
        return {
          address,
          status: "unsupported",
          reason: "Unsupported Coinbase Smart Wallet implementation",
        };
      return { address, status: "verified", implementation };
    }),
  );
  if (!wallets.some((wallet) => wallet.status === "verified")) return wallets;
  const code = await client.getCode({ address: implementation, blockNumber });
  if (code && keccak256(code) === implementationCodeHash) return wallets;

  return wallets.map((wallet): CoinbaseWalletInspection =>
    wallet.status === "verified"
      ? {
          address: wallet.address,
          status: "unsupported",
          reason: "Coinbase Smart Wallet implementation code did not match",
        }
      : wallet,
  );
}

export function isCoinbaseOwner(
  client: PublicClient,
  account: Address,
  owner: Address,
  blockNumber?: bigint,
) {
  return client.readContract({
    address: account,
    abi: coinbaseWalletAbi,
    functionName: "isOwnerAddress",
    args: [owner],
    blockNumber,
  });
}

export function coinbaseBatch(
  calls: ReadonlyArray<{ to: Address; value: bigint; data: Hex }>,
) {
  return encodeFunctionData({
    abi: coinbaseWalletAbi,
    functionName: "executeBatch",
    args: [calls.map(({ to, value, data }) => ({ target: to, value, data }))],
  });
}

export function coinbaseOwnerBytes(owner: Address) {
  return encodeAbiParameters([{ type: "address" }], [owner]);
}
