import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { experimental_readRawConfig } from "wrangler";
import { encodeAbiParameters, encodeFunctionResult, multicall3Abi } from "viem";
import { modernClient, newSigner, testKey } from "./client.ts";

const config = experimental_readRawConfig({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
}).rawConfig;

function runtime(options) {
  return new Miniflare(
    convertV4MiniflareOptions({
      name: "mcp",
      modules: true,
      scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      ratelimits: Object.fromEntries(
        config.ratelimits.map(({ name, ...limit }) => [name, limit]),
      ),
      bindings: { ...config.vars, SIGNER_ENCRYPTION_KEY: testKey },
      ...options,
    }),
  );
}

test("the Wrangler bundle works in workerd and excludes bearer credentials from logs and caches", async () => {
  assert.equal(config.observability.enabled, false);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.deepEqual(config.secrets.required, ["SIGNER_ENCRYPTION_KEY"]);
  const logs = [];
  const mf = runtime({
    handleStructuredLogs: (entry) => logs.push(entry.message),
  });
  try {
    const worker = await mf.getWorker();
    const fetch = (url, init) => worker.fetch(new Request(url, init));
    const credential = await newSigner(fetch);
    const path = `/0x0000000000000000000000000000000000000001/${credential.secret}`;
    const client = await modernClient(fetch, path);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some(({ name }) => name === "execute"));
      const response = await client.callTool({
        name: "protocol",
        arguments: {},
      });
      assert.equal(response.structuredContent.name, "Yield Orders");
      const disallowed = await fetch(`https://mcp.yld.cx${path}`, {
        method: "DELETE",
      });
      assert.match(disallowed.headers.get("Cache-Control"), /no-store/);
      assert.doesNotMatch(
        await disallowed.text(),
        new RegExp(credential.secret),
      );
    } finally {
      await client.close();
    }
    assert.ok(!JSON.stringify(logs).includes(credential.secret));
  } finally {
    await mf.dispose();
  }
});

test("MCP reads prefer the private RPC and fall back to the configured public endpoint", async () => {
  const privateRpc = "https://private-rpc.invalid/";
  const publicRpc = "https://public-rpc.invalid/";
  let privateAvailable = true;
  const attempted = [];
  const mf = runtime({
    bindings: {
      ...config.vars,
      RPC_URLS: JSON.stringify({ base: [publicRpc] }),
      PRIVATE_RPC_BASE: privateRpc,
    },
    outboundService: async (request) => {
      attempted.push(request.url);
      if (request.url === privateRpc && !privateAvailable)
        return new Response(null, { status: 503 });
      const payload = await request.json();
      const balance = encodeAbiParameters(
        [{ type: "uint256" }],
        [request.url === privateRpc ? 1n : 2n],
      );
      const multicall = encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: [{ success: true, returnData: balance }],
      });
      const answer = ({ id, method }) => {
        assert.ok(["eth_chainId", "eth_call"].includes(method));
        return {
          jsonrpc: "2.0",
          id,
          result: method === "eth_chainId" ? "0x2105" : multicall,
        };
      };
      return Response.json(
        Array.isArray(payload) ? payload.map(answer) : answer(payload),
      );
    },
  });
  try {
    const worker = await mf.getWorker();
    const client = await modernClient((url, init) =>
      worker.fetch(new Request(url, init)),
    );
    try {
      const balances = () =>
        client.callTool({
          name: "balances",
          arguments: {
            chain: "base",
            account: "0x0000000000000000000000000000000000000001",
          },
        });
      const primary = await balances();
      assert.equal(
        primary.isError ?? false,
        false,
        JSON.stringify({ primary, attempted }),
      );
      assert.equal(primary.structuredContent?.native?.raw, "1");
      assert.deepEqual(attempted, [privateRpc, privateRpc]);
      privateAvailable = false;
      attempted.length = 0;
      const fallback = await balances();
      assert.equal(
        fallback.isError ?? false,
        false,
        JSON.stringify({ fallback, attempted }),
      );
      assert.equal(fallback.structuredContent?.native?.raw, "2");
      assert.deepEqual(attempted, [
        privateRpc,
        publicRpc,
        privateRpc,
        publicRpc,
      ]);
    } finally {
      await client.close();
    }
  } finally {
    await mf.dispose();
  }
});
