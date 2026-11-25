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

export function rpcHttpOptions(signal?: AbortSignal, fetchFn?: typeof fetch) {
  return {
    batch: { batchSize: 100 },
    maxResponseBodySize: 4 * 1024 * 1024,
    fetchOptions: { signal, redirect: "manual" as const },
    fetchFn,
  };
}

export const rpcFallbackOptions = { retryCount: 1 } as const;

const errorMessages: ReadonlyMap<string, string> = new Map([
  ["TypeError", "Network or response processing failed"],
  ["SyntaxError", "Invalid RPC response"],
  ["AbortError", "RPC request aborted"],
  ["TimeoutError", "RPC request timed out"],
  ["HttpRequestError", "RPC HTTP request failed"],
  ["ResponseBodyTooLargeError", "RPC response exceeds the size limit"],
  ["RpcRequestError", "Provider returned a JSON-RPC error"],
  ["UnknownRpcError", "RPC request failed"],
  ["InvalidInputRpcError", "Provider rejected the input"],
  ["InvalidParamsRpcError", "Provider rejected the parameters"],
  ["InternalRpcError", "Provider reported an internal error"],
  ["ResourceUnavailableRpcError", "Provider resource unavailable"],
  ["LimitExceededRpcError", "Provider request limit exceeded"],
  ["CapacityError", "Chunk exceeds processing capacity"],
]);

interface RpcErrorDetails {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  cause?: RpcErrorDetails;
}

export function rpcErrorDetails(error: unknown): RpcErrorDetails {
  function describe(error: unknown, depth: number): RpcErrorDetails {
    const e = error as {
      name?: string;
      code?: unknown;
      status?: unknown;
      cause?: unknown;
    } | null;
    const known = errorMessages.get(e?.name ?? "");
    const status = typeof e?.status === "number" ? e.status : undefined;
    const code =
      typeof e?.code === "number" ||
      (typeof e?.code === "string" &&
        /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(
          e.code,
        ))
        ? e.code
        : undefined;
    const message =
      status === 429 || code === 429
        ? "RPC rate limited"
        : (known ?? "RPC request failed");
    return {
      name: (known && e?.name) || "Error",
      message,
      code,
      status,
      cause: e?.cause && depth > 0 ? describe(e.cause, depth - 1) : undefined,
    };
  }
  return describe(error, 3);
}
