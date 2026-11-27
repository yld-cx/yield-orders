interface RpcHttpOptions {
  batch?: boolean;
  batchWait?: number;
  timeout?: number;
  retryCount?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  beforeRequest?: () => void;
}

function rpcHttpOptions(options: RpcHttpOptions) {
  return {
    batch:
      options.batch === false
        ? false
        : { batchSize: 100, wait: options.batchWait },
    maxResponseBodySize: 4 * 1024 * 1024,
    fetchOptions: { signal: options.signal, redirect: "manual" as const },
    fetchFn: options.fetchFn,
    onFetchRequest: options.beforeRequest,
    timeout: options.timeout,
    retryCount: options.retryCount,
  };
}

type HttpFactory<T> = (
  url: string,
  options: ReturnType<typeof rpcHttpOptions>,
) => T;

// Inject viem's factories so Workers can use their own installed viem version.
export function createRpcHttpTransport<T>(
  http: HttpFactory<T>,
  url: string,
  options: RpcHttpOptions = {},
): T {
  return http(url, rpcHttpOptions(options));
}

interface RpcFallbackOptions extends RpcHttpOptions {
  noRetryMethods?: readonly string[];
  onFailure?: (method: string, hostname: string, error: Error) => void;
}

interface FallbackRpc {
  request(
    args: { method: string; params?: unknown },
    options?: { retryCount?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  value?: {
    onResponse(
      listener: (
        result: {
          method: string;
          transport: { value?: { url?: string } };
        } & ({ status: "success" } | { status: "error"; error: Error }),
      ) => void,
    ): void;
  };
}

type FallbackFactory<T> = (
  transports: T[],
  options: { retryCount: number },
) => (config: never) => FallbackRpc;

export function createRpcFallbackTransport<
  T,
  Fallback extends FallbackFactory<NoInfer<T>>,
>(
  {
    http,
    fallback,
  }: {
    http: HttpFactory<T>;
    fallback: Fallback;
  },
  urls: readonly string[],
  {
    retryCount = 1,
    noRetryMethods,
    onFailure,
    ...options
  }: RpcFallbackOptions = {},
): ReturnType<Fallback> {
  if (!urls.length) throw new Error("Provide at least one RPC endpoint");
  const transport = fallback(
    urls.map((url) =>
      createRpcHttpTransport(http, url, { ...options, retryCount: 0 }),
    ),
    { retryCount },
  );
  // Keep the caller's viem transport types when decorating its request function.
  return ((config: never) => {
    const rpc = transport(config);
    if (onFailure)
      rpc.value?.onResponse((result) => {
        if (result.status !== "error") return;
        const url = result.transport.value?.url;
        onFailure(
          result.method,
          url ? new URL(url).hostname : "unknown",
          result.error,
        );
      });
    if (!options.signal && !noRetryMethods?.length) return rpc;
    const request: FallbackRpc["request"] = (args, requestOptions) =>
      rpc.request(args, {
        ...requestOptions,
        ...(options.signal && { signal: options.signal }),
        ...(noRetryMethods?.includes(args.method) && { retryCount: 0 }),
      });
    return { ...rpc, request };
  }) as ReturnType<Fallback>;
}

export const rpcMulticallBatch = { multicall: { wait: 10 } } as const;
