import manifest from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import { mainnet, base, robinhood } from "viem/chains";
import type { Chain } from "viem";
import { address, integer, type Env, HttpError } from "./shared.ts";

// Operational defaults only. Chain IDs and contract addresses come from the package.
const defaults: Record<
  string,
  {
    chain: Chain;
    rpcUrls: readonly string[];
    confirmations: number;
    overlap: number;
    gecko?: string;
  }
> = {
  ethereum: {
    chain: mainnet,
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://gateway.tenderly.co/public/mainnet",
    ],
    confirmations: 12,
    overlap: 16,
    gecko: "eth",
  },
  base: {
    chain: base,
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    confirmations: 64,
    overlap: 32,
    gecko: "base",
  },
  robinhood: {
    chain: robinhood,
    rpcUrls: [
      "https://rpc.mainnet.chain.robinhood.com",
      "https://robinhood-rpc.publicnode.com",
    ],
    confirmations: 64,
    overlap: 32,
    gecko: "robinhood",
  },
};

export const supportedNetworks = Object.entries(manifest.networks).map(
  ([name, chainId]) => {
    const d = defaults[name];
    if (!d || d.chain.id !== chainId)
      throw new Error(`Missing operational defaults for ${name}`);
    return { name, chainId, address: address(manifest.address), ...d };
  },
);

export type SupportedNetwork = (typeof supportedNetworks)[number];
export type Network = SupportedNetwork & {
  startBlock?: bigint;
  confirmations: number;
  overlap: number;
  rangeLimit: number;
  chunkSize: number;
};

export function networkFor(value: string | null): SupportedNetwork {
  if (value === null) throw new HttpError(400, "chainId is required");
  const n = supportedNetworks.find(
    (n) => n.chainId === integer(value, "chainId", 1),
  );
  if (!n) throw new HttpError(400, "Unsupported chainId");
  return n;
}

export function indexingNetwork(env: Env, n: SupportedNetwork): Network {
  const configs = JSON.parse(env.NETWORK_CONFIG ?? "{}") as Record<
    string,
    Record<string, unknown>
  >;
  const c = configs[String(n.chainId)] ?? {};
  const number = (key: string, fallback: number, min = 0, max = 100_000) =>
    c[key] === undefined ? fallback : integer(String(c[key]), key, min, max);
  const startBlock =
    c.startBlock === undefined
      ? undefined
      : BigInt(integer(String(c.startBlock), "startBlock"));
  const urls = JSON.parse(env.RPC_URLS ?? "{}") as Record<string, unknown>;
  const configured = urls[String(n.chainId)] ?? urls[n.name] ?? n.rpcUrls;
  if (!Array.isArray(configured) || configured.length === 0)
    throw new Error("Invalid RPC URLs");
  const rpcUrls = configured.map((value: unknown) => {
    try {
      if (
        typeof value !== "string" ||
        !["http:", "https:"].includes(new URL(value).protocol)
      )
        throw new Error();
      return value;
    } catch {
      throw new Error("Invalid RPC URL");
    }
  });
  const rangeLimit = number("rangeLimit", 1000, 1, 2000);
  return {
    ...n,
    rpcUrls,
    startBlock,
    confirmations: number("confirmations", n.confirmations, 1),
    overlap: number("overlap", n.overlap, 1),
    rangeLimit,
    chunkSize: Math.min(number("chunkSize", rangeLimit, 1, 2000), rangeLimit),
  };
}
