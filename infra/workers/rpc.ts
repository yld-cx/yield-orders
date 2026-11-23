export interface RpcEnv {
  RPC_URLS?: string;
  PRIVATE_RPC_ETHEREUM?: string;
  PRIVATE_RPC_BASE?: string;
  PRIVATE_RPC_ROBINHOOD?: string;
}

const privateRpcKeys = {
  ethereum: "PRIVATE_RPC_ETHEREUM",
  base: "PRIVATE_RPC_BASE",
  robinhood: "PRIVATE_RPC_ROBINHOOD",
} as const;

export type NetworkName = keyof typeof privateRpcKeys;

export function rpcUrls(env: RpcEnv, name: NetworkName, chainId: number) {
  let configured: unknown;
  try {
    const urls = JSON.parse(env.RPC_URLS ?? "{}");
    configured = urls[String(chainId)] ?? urls[name];
  } catch {
    throw new Error("Invalid RPC URLs");
  }
  if (!Array.isArray(configured) || !configured.length || configured.length > 3)
    throw new Error("Invalid RPC URLs");
  const publicUrls = configured.map((url: unknown) => validateUrl(url));
  const privateUrl = env[privateRpcKeys[name]]?.trim();
  return [
    ...new Set(
      privateUrl ? [validateUrl(privateUrl), ...publicUrls] : publicUrls,
    ),
  ];
}

function validateUrl(url: unknown) {
  if (
    typeof url === "string" &&
    URL.canParse(url) &&
    new URL(url).protocol === "https:"
  )
    return url;
  throw new Error("Invalid RPC URL");
}

export function rpcHttpOptions(
  timeout: number,
  endpointCount: number,
  signal?: AbortSignal,
  fetchRpc: typeof fetch = fetch,
) {
  return {
    // Endpoints share a per-round timeout budget.
    timeout: Math.max(1, Math.floor(timeout / endpointCount)),
    retryCount: 0,
    batch: { batchSize: 100, wait: 10 },
    maxResponseBodySize: 4 * 1024 * 1024,
    fetchOptions: { signal, redirect: "manual" as const },
    fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetchRpc(input, init);
      if (response.ok || !response.headers.has("Retry-After")) return response;
      // Viem otherwise lets a provider's Retry-After override the fallback delay.
      const headers = new Headers(response.headers);
      headers.delete("Retry-After");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

export const rpcFallbackOptions = {
  rank: false,
  retryCount: 1,
  retryDelay: 300,
} as const;
