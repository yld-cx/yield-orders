import { RPC_TIMEOUT_MS } from "@yld-cx/sdk";
import {
  createRpcFallbackTransport,
  createRpcHttpTransport,
  rpcMulticallBatch,
} from "@yld-cx/sdk/ethereum/rpc";
import {
  createPublicClient,
  fallback,
  http,
  type Chain,
  type PublicClient,
} from "viem";

export function createSkillsClient(
  chain: Chain,
  rpcUrl?: string,
): PublicClient {
  const endpoint = rpcUrl ? new URL(rpcUrl) : undefined;
  const local =
    endpoint && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    endpoint &&
    endpoint.protocol !== "https:" &&
    !(local && endpoint.protocol === "http:")
  )
    throw new Error("YLD_RPC_URL requires HTTPS or a local HTTP endpoint");

  if (local)
    return createPublicClient({
      chain,
      transport: createRpcHttpTransport(http, endpoint.href, {
        batch: false,
        timeout: RPC_TIMEOUT_MS,
        retryCount: 0,
      }),
    });

  const defaultUrl = new URL(chain.rpcUrls.default.http[0]).href;
  const urls = [
    ...new Set(endpoint ? [endpoint.href, defaultUrl] : [defaultUrl]),
  ];
  return createPublicClient({
    chain,
    transport: createRpcFallbackTransport({ http, fallback }, urls, {
      timeout: RPC_TIMEOUT_MS,
      signal: AbortSignal.timeout(2 * RPC_TIMEOUT_MS),
    }),
    batch: rpcMulticallBatch,
  });
}
