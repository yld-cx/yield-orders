import { RPC_TIMEOUT_MS, RPC_RETRY_COUNT } from "@yld-cx/sdk";
import { createPublicClient, http, type PublicClient } from "viem";
import { EthereumClient, networks, getNetwork } from "@yld-cx/sdk/ethereum";
export const rpcUrls = {
  ethereum:
    process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL ??
    "https://ethereum-rpc.publicnode.com",
  base: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org",
  robinhood:
    process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ??
    "https://rpc.mainnet.chain.robinhood.com",
};
for (const value of Object.values(rpcUrls)) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("RPC endpoints must use HTTPS");
  if (url.username || url.password)
    throw new Error("Do not place credentials in RPC URLs");
}
const clients = new Map<string, EthereumClient>();
export function getSdk(network: string): EthereumClient {
  const n = getNetwork(network);
  let sdk = clients.get(n.id);
  if (!sdk) {
    sdk = new EthereumClient(
      createPublicClient({
        chain: n.chain,
        transport: http(rpcUrls[n.slug], {
          timeout: RPC_TIMEOUT_MS,
          retryCount: RPC_RETRY_COUNT,
        }),
        batch: { multicall: true },
      }) as PublicClient,
      n.id,
    );
    clients.set(n.id, sdk);
  }
  return sdk;
}
export const chains = networks.map((n) => n.chain);
