import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { createWorker } from "../src/index.ts";

export const testKey = btoa(
  String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
);
export const testEnv = {
  SIGNER_ENCRYPTION_KEY: testKey,
  MCP_RATE_LIMIT: { limit: async () => ({ success: true }) },
  SIGNER_RATE_LIMIT: { limit: async () => ({ success: true }) },
};

export type Worker = ReturnType<typeof createWorker>;

export const handlerFetch =
  (worker: Worker, env: Parameters<Worker["fetch"]>[1] = testEnv) =>
  async (url: string | URL | Request, init?: RequestInit) =>
    worker.fetch(new Request(url, init), env);

export async function modernClient(
  fetch: ReturnType<typeof handlerFetch>,
  path = "/",
  approve?: (message: string) => boolean,
) {
  const client = new Client(
    { name: "yld-workflow-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: "auto" },
      capabilities: approve ? { elicitation: { form: {} } } : {},
    },
  );
  if (approve)
    client.setRequestHandler("elicitation/create", async (request) => ({
      action: "accept",
      content: { confirm: approve(request.params.message) },
    }));
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, "https://mcp.yld.cx"), {
      fetch,
    }),
  );
  return client;
}

export async function legacyClient(
  fetch: ReturnType<typeof handlerFetch>,
  path = "/",
) {
  const client = new LegacyClient({
    name: "yld-legacy-test",
    version: "1.0.0",
  });
  await client.connect(
    new LegacyTransport(new URL(path, "https://mcp.yld.cx"), { fetch }),
  );
  return client;
}

export async function newSigner(fetch: ReturnType<typeof handlerFetch>) {
  const response = await fetch("https://mcp.yld.cx/signer", { method: "POST" });
  if (response.status !== 201)
    throw new Error(
      `Could not create local test signer (HTTP ${response.status})`,
    );
  return response.json() as Promise<{ address: `0x${string}`; secret: string }>;
}
