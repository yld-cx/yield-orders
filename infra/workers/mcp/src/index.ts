import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  McpServer,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import {
  createRpcFallbackTransport,
  createRpcHttpTransport,
  rpcMulticallBatch,
} from "@yld-cx/sdk/ethereum/rpc";
import {
  agentError,
  commandInputs,
  createSkills,
  descriptions,
  jsonSafe,
  type Command,
  type CommandInput,
  type SkillsOptions,
} from "@yld-cx/skills";
import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  isAddressEqual,
  zeroAddress,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { z } from "zod";
import { rpcUrls, type NetworkName, type RpcEnv } from "../../rpc.ts";
import {
  createSigner,
  EncryptionKeyError,
  readAuthorization,
  readSigner,
  sealAuthorization,
} from "./credentials.ts";
import {
  broadcastExecution,
  confirmationState,
  simulateExecution,
  walletStatus,
  type ConnectedWallet,
} from "./execution.ts";

interface Env extends RpcEnv {
  MCP_RATE_LIMIT: RateLimit;
  SIGNER_RATE_LIMIT: RateLimit;
  SIGNER_ENCRYPTION_KEY: string;
  EXECUTION_ENABLED?: string;
}

const appOrigin = "https://yld.cx";
const confirmation = z.strictObject({ confirm: z.boolean() });
const instructions =
  "Yield Orders has Limit (Provide), immediate Swap, and fixed-term Rent. Use protocol for mechanics, networks and markets for discovery, book for bid and ask liquidity, quote for costs, balances and portfolio for account state, then prepare and simulate with the actual sender. Status verifies receipts. Repay Asset plus accrued yield before maturity to recover locked Quote. A rental that expires forfeits the locked Quote. Connected Coinbase Sub Accounts use a separate EOA signer for gas.";

function secure(response: Response, origin?: string) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, private, max-age=0");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  if (origin === appOrigin) {
    headers.set("Access-Control-Allow-Origin", appOrigin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.append("Vary", "Origin");
  }
  return new Response(response.body, { status: response.status, headers });
}

function result(value: object): CallToolResult {
  const content = jsonSafe(value) as CallToolResult["structuredContent"];
  return {
    structuredContent: content,
    content: [{ type: "text", text: JSON.stringify(content) }],
  };
}

function failure(error: unknown): CallToolResult {
  const message =
    error instanceof z.ZodError
      ? error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join(", ")
      : agentError(error);
  return { ...result({ error: message }), isError: true };
}

const names: Record<number, NetworkName> = {
  1: "ethereum",
  8453: "base",
  4663: "robinhood",
};
function readClient(
  env: Env,
  chain: Parameters<NonNullable<SkillsOptions["client"]>>[0],
) {
  const urls = rpcUrls(env, names[chain.id], chain.id);
  return createPublicClient({
    chain,
    transport: createRpcFallbackTransport({ http, fallback }, urls, {
      timeout: 10000,
    }),
    batch: rpcMulticallBatch,
  });
}
function executionClient(env: Env) {
  const [url] = rpcUrls(env, "base", base.id);
  return createPublicClient({
    chain: base,
    transport: createRpcHttpTransport(http, url, {
      batch: false,
      timeout: 15000,
      retryCount: 0,
    }),
  }) as PublicClient;
}

async function rateLimited(request: Request, limiter: RateLimit) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return !(await limiter.limit({ key: ip })).success;
}

function createServer(
  env: Env,
  modern: boolean,
  client: SkillsOptions["client"],
  wallet?: ConnectedWallet,
  useExecutionClient?: PublicClient,
) {
  const api = createSkills({ client, account: wallet?.account });
  const server = new McpServer(
    { name: "Yield Orders", version: "0.1.0" },
    {
      instructions,
      requestState: {
        verify: async (state) => {
          try {
            return confirmationState.parse(
              await readAuthorization(env.SIGNER_ENCRYPTION_KEY, state),
            );
          } catch {
            throw new Error("Invalid execution confirmation");
          }
        },
      },
    },
  );
  for (const name of Object.keys(commandInputs) as Command[]) {
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: commandInputs[name],
        annotations: {
          readOnlyHint: true,
          openWorldHint: !["protocol", "networks"].includes(name),
        },
      },
      async (input: CommandInput<Command>) => {
        try {
          const output = await api[name](input as never);
          return result(output as object);
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
  if (!wallet) return server;
  const baseRead = () => client?.(base) ?? readClient(env, base);
  server.registerTool(
    "wallet",
    {
      description:
        "Inspect the connected Coinbase Sub Account and the separate EOA signer's onchain authorization and Base ETH gas balance.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return result({
          ...(await walletStatus(baseRead(), wallet)),
          broadcastingEnabled: env.EXECUTION_ENABLED === "true" && modern,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "execute",
    {
      description:
        "Request an authorized atomic Base transaction for a Yield Orders operation. Preview and approval are required. If broadcasting is unavailable, use prepare and simulate.",
      inputSchema: commandInputs.prepare,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) => {
      try {
        const capabilities = server.server.getClientCapabilities();
        if (
          env.EXECUTION_ENABLED !== "true" ||
          !modern ||
          !capabilities?.elicitation?.form
        ) {
          return result({
            status: "preparation_only",
            message:
              env.EXECUTION_ENABLED !== "true"
                ? "MCP broadcasting is disabled. Use a compatible external wallet."
                : "This MCP client lacks the required transaction confirmation flow. Use a compatible external wallet.",
            prepared: await api.prepare(input),
          });
        }
        const state =
          ctx.mcpReq.requestState<z.infer<typeof confirmationState>>();
        if (
          state &&
          acceptedContent(ctx.mcpReq.inputResponses, "authorize", confirmation)
            ?.confirm !== true
        )
          return result({
            status: "declined",
            message: "Transaction authorization was declined or missing.",
          });
        const rpc = useExecutionClient ?? executionClient(env);
        const executionApi = createSkills({
          client: () => rpc,
          account: wallet.account,
        });
        const current = await simulateExecution(
          rpc,
          wallet,
          executionApi,
          input as CommandInput<"prepare">,
        );
        if (state) {
          if (ctx.mcpReq.signal.aborted) return result({ status: "cancelled" });
          return result(await broadcastExecution(rpc, wallet, current, state));
        }
        const cost = String((current.cost * 12n + 9n) / 10n);
        return inputRequired({
          requestState: await sealAuthorization(env.SIGNER_ENCRYPTION_KEY, {
            account: wallet.account,
            signer: wallet.signer.address,
            nonce: current.nonce,
            planHash: current.planHash,
            maxEstimatedCost: cost,
            expiresAt: Date.now() + 90_000,
          }),
          inputRequests: {
            authorize: inputRequired.elicit({
              message: [
                `Authorize this Base ${current.prepared.operation} through Sub Account ${wallet.account}?`,
                `Asset ${current.prepared.market.asset.symbol} (${current.prepared.market.asset.address}), Quote ${current.prepared.market.quote.symbol} (${current.prepared.market.quote.address}).`,
                `Operation amounts and caps in raw token units: ${JSON.stringify(current.prepared.details)}.`,
                current.prepared.inputs
                  ? `Required input: ${current.prepared.inputs.required.amount} ${current.prepared.inputs.required.token.symbol}. Approval cap: ${current.prepared.inputs.approvalCap.amount}.`
                  : "",
                `Estimated gas budget: ${cost} wei of Base ETH paid by signer ${wallet.signer.address}.`,
              ]
                .filter(Boolean)
                .join("\n"),
              requestedSchema: {
                type: "object",
                properties: {
                  confirm: {
                    type: "boolean",
                    title: "Authorize this transaction",
                  },
                },
                required: ["confirm"],
              },
            }),
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

export function createWorker(
  options: {
    client?: SkillsOptions["client"];
    executionClient?: PublicClient;
  } = {},
) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const origin = request.headers.get("Origin");
      const respond = (body: object, status: number, cors?: string) =>
        secure(Response.json(body, { status }), cors);
      if (
        url.protocol !== "https:" &&
        url.hostname !== "localhost" &&
        url.hostname !== "127.0.0.1"
      )
        return respond({ error: "HTTPS required" }, 400);
      if (origin && origin !== appOrigin && origin !== url.origin)
        return respond({ error: "Origin is not allowed" }, 403);
      if (url.search) return respond({ error: "Unexpected query string" }, 400);
      if (url.pathname === "/signer") {
        try {
          if (request.method === "OPTIONS" && origin === appOrigin)
            return secure(new Response(null, { status: 204 }), origin);
          if (request.method !== "POST")
            return respond(
              { error: "Use POST /signer" },
              405,
              origin ?? undefined,
            );
          const contentLength = request.headers.get("Content-Length");
          if (contentLength && contentLength !== "0")
            return respond(
              { error: "Signer generation takes no request body" },
              400,
              origin ?? undefined,
            );
          if (await rateLimited(request, env.SIGNER_RATE_LIMIT))
            return respond(
              { error: "Signer rate limit reached" },
              429,
              origin ?? undefined,
            );
          return respond(
            await createSigner(env.SIGNER_ENCRYPTION_KEY),
            201,
            origin ?? undefined,
          );
        } catch {
          return respond(
            { error: "Signer generation unavailable" },
            503,
            origin ?? undefined,
          );
        }
      }
      try {
        if (await rateLimited(request, env.MCP_RATE_LIMIT))
          return respond({ error: "MCP rate limit reached" }, 429);
        let wallet: ConnectedWallet | undefined;
        if (url.pathname !== "/") {
          const path = /^\/(0x[0-9a-fA-F]{40})\/(v1\.[0-9A-Za-z_-]{80})$/.exec(
            url.pathname,
          );
          if (!path)
            return respond(
              { error: "Unknown MCP endpoint or invalid credential" },
              404,
            );
          const account = getAddress(path[1].toLowerCase());
          let signer;
          try {
            signer = await readSigner(env.SIGNER_ENCRYPTION_KEY, path[2]);
          } catch (error) {
            if (error instanceof EncryptionKeyError)
              return respond({ error: "Signer credentials unavailable" }, 503);
            return respond({ error: "Invalid signer credential" }, 401);
          }
          if (
            isAddressEqual(account, signer.address) ||
            account === zeroAddress
          )
            return respond(
              { error: "Use the Coinbase Sub Account address" },
              400,
            );
          wallet = { account, signer };
        }
        const client =
          options.client ?? ((chain) => readClient(env, chain) as PublicClient);
        const handler = createMcpHandler(
          ({ era }) =>
            createServer(
              env,
              era === "modern",
              client,
              wallet,
              options.executionClient,
            ),
          {
            maxRequestBodySize: 24 * 1024,
            maxSubscriptions: 0,
            onerror: () => {},
          },
        );
        // Keep the credential-bearing URL outside the SDK and strip tracing inputs.
        const headers = new Headers(request.headers);
        for (const header of [
          "Referer",
          "Traceparent",
          "Tracestate",
          "Baggage",
          "Authorization",
        ])
          headers.delete(header);
        const body = request.body;
        const sanitized = new Request(new URL("/", url), {
          method: request.method,
          headers,
          signal: request.signal,
          body,
          ...(body && { duplex: "half" }),
        });
        return secure(await handler.fetch(sanitized));
      } catch {
        return respond({ error: "MCP request unavailable" }, 503);
      }
    },
  };
}

export default createWorker();
