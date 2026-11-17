import "server-only";
import {
  UniswapClient,
  boundedJson,
  parseSwapInput,
  SwapError,
} from "@yld-cx/sdk/uniswap";
import { walletSwapAvailable } from "@/lib/swap-availability";

const windows = new Map<string, { count: number; expires: number }>();
function rateLimit(key: string, limit: number) {
  const now = Date.now();
  for (const [k, v] of windows) if (v.expires <= now) windows.delete(k);
  const item = windows.get(key) ?? { count: 0, expires: now + 60000 };
  if (++item.count > limit || windows.size > 10000)
    throw new SwapError("Too many swap requests", 429);
  windows.set(key, item);
}
export async function POST(request: Request) {
  try {
    rateLimit("global", 120);
    const origin = request.headers.get("origin");
    if (origin !== new URL(request.url).origin)
      throw new SwapError("Same-origin request required", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new SwapError("JSON required", 415);
    const input = parseSwapInput(
      await boundedJson(new Response(request.body), 4096),
    );
    rateLimit(input.swapper, 20);
    if (input.mode !== "wallet-router")
      throw new SwapError(
        "Only wallet swaps are supported by this endpoint",
        403,
      );
    if (!walletSwapAvailable(input.chainId, input.tokenIn, input.tokenOut))
      throw new SwapError("Token pair is not in Yieldlist", 400);
    const service = new UniswapClient({
      apiKey: process.env.UNISWAP_API_KEY ?? "",
    });
    const result = await service.quote(input);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof SwapError
            ? error.message
            : "Swap service unavailable",
      },
      {
        status: error instanceof SwapError ? error.status : 502,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
