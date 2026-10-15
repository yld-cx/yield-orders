import deployment from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { mainnet, base, robinhood } from "viem/chains";
import { isAddress, type Address, type Hex } from "viem";
import type { EvmNetwork } from "../types/index.ts";
export const networks = [
  { slug: "ethereum", id: "eip155:1", name: "Ethereum", chain: mainnet },
  { slug: "base", id: "eip155:8453", name: "Base", chain: base },
  { slug: "robinhood", id: "eip155:4663", name: "Robinhood", chain: robinhood },
] as const;
export type NetworkSlug = (typeof networks)[number]["slug"];
export function getNetwork(slugOrId: string) {
  const network = networks.find(
    (n) => n.slug === slugOrId || n.id === slugOrId,
  );
  if (!network) throw new Error("Unsupported network");
  return network;
}
export function deploymentFor(network: EvmNetwork): {
  address: Address;
  runtimeCodeHash: Hex;
} {
  const config = getNetwork(network);
  if (
    deployment.networks[config.slug] !== config.chain.id ||
    !isAddress(deployment.address)
  )
    throw new Error("Invalid deployment manifest");
  return {
    address: deployment.address as Address,
    runtimeCodeHash: deployment.runtimeCodeHash as Hex,
  };
}
