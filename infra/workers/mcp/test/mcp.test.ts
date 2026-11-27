import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, erc20Abi, zeroAddress, type Address } from "viem";
import { createSigner, readSigner } from "../src/credentials.ts";
import { createWorker } from "../src/index.ts";
import { validatePlan } from "../src/execution.ts";
import {
  handlerFetch,
  legacyClient,
  modernClient,
  newSigner,
  testEnv,
  testKey,
} from "./client.ts";

test("official modern and legacy MCP clients discover and use the public tools", async () => {
  const fetch = handlerFetch(createWorker());
  for (const connect of [modernClient, legacyClient]) {
    const client = await connect(fetch);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map(({ name }) => name),
        [
          "protocol",
          "networks",
          "markets",
          "book",
          "balances",
          "portfolio",
          "quote",
          "prepare",
          "simulate",
          "status",
        ],
      );
      const book = tools.find(({ name }) => name === "book")!;
      assert.ok(book.inputSchema.required?.includes("tokenA"));
      const protocol = await client.callTool({
        name: "protocol",
        arguments: {},
      });
      assert.equal(
        (protocol.structuredContent as { name?: string } | undefined)?.name,
        "Yield Orders",
      );
      assert.match(
        JSON.stringify(protocol.structuredContent),
        /forfeits locked Quote/,
      );
      const networks = await client.callTool({
        name: "networks",
        arguments: {},
      });
      assert.match(JSON.stringify(networks.structuredContent), /8453/);
      const invalid = await client.callTool({
        name: "book",
        arguments: { forged: 1 },
      });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
    }
  }
});

test("signer credentials are randomized, authenticated, and rejected under a different or malformed key", async () => {
  const a = await createSigner(testKey);
  const b = await createSigner(testKey);
  assert.match(a.secret, /^v1\.[A-Za-z0-9_-]{80}$/);
  assert.notEqual(a.secret, b.secret);
  assert.equal((await readSigner(testKey, a.secret)).address, a.address);
  for (const credential of [
    a.secret.slice(0, -1),
    "v2." + a.secret.slice(3),
    "v1." + (a.secret[3] === "A" ? "B" : "A") + a.secret.slice(4),
    a.secret + "=",
  ])
    await assert.rejects(
      () => readSigner(testKey, credential),
      /Invalid credential/,
    );
  await assert.rejects(
    () => readSigner(btoa("\x00".repeat(32)), a.secret),
    /Invalid credential/,
  );
  for (const key of [
    undefined,
    "invalid",
    btoa("a".repeat(31)),
    btoa("a".repeat(33)),
  ])
    await assert.rejects(() => createSigner(key), /encryption unavailable/);
});

test("signer and authenticated MCP routes return no-store and fail closed", async () => {
  const worker = createWorker();
  const fetch = handlerFetch(worker);
  const account = "0x0000000000000000000000000000000000000001";
  const signerResponse = await fetch("https://mcp.yld.cx/signer", {
    method: "POST",
    headers: { Origin: "https://yld.cx" },
  });
  assert.equal(signerResponse.status, 201);
  assert.match(signerResponse.headers.get("Cache-Control")!, /no-store/);
  assert.equal(
    signerResponse.headers.get("Access-Control-Allow-Origin"),
    "https://yld.cx",
  );
  const signer = await newSigner(fetch);
  const path = `/${account}/${signer.secret}`;
  const client = await modernClient(fetch, path);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some(({ name }) => name === "wallet"));
    assert.ok(tools.some(({ name }) => name === "execute"));
    assert.doesNotMatch(
      JSON.stringify(tools),
      /privateKey|arbitrary calldata|addOwner/,
    );
  } finally {
    await client.close();
  }
  const invalid = await fetch(
    `https://mcp.yld.cx/${account}/v1.${"A".repeat(80)}`,
    { method: "POST" },
  );
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get("Cache-Control")!, /no-store/);
  assert.equal(
    (
      await handlerFetch(worker, { ...testEnv, SIGNER_ENCRYPTION_KEY: "" })(
        "https://mcp.yld.cx/signer",
        { method: "POST" },
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await fetch("https://mcp.yld.cx/signer", {
        method: "POST",
        headers: { Origin: "https://attacker.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch("https://mcp.yld.cx/signer?secret=ignored", {
        method: "POST",
      })
    ).status,
    400,
  );
  const limited = await handlerFetch(worker, {
    ...testEnv,
    SIGNER_RATE_LIMIT: { limit: async () => ({ success: false }) },
  })("https://mcp.yld.cx/signer", { method: "POST" });
  assert.equal(limited.status, 429);
});

test("execution firewall rejects arbitrary transfers, unsupported targets, and unlisted assets", () => {
  const deployment = "0x0000000000000000000000000000000000000001";
  const account: Address = "0x0000000000000000000000000000000000000002";
  const asset = {
    address: "0x0000000000000000000000000000000000000003" as Address,
    symbol: "X",
    name: "X",
    decimals: 18,
    listed: true,
  };
  const quote = {
    ...asset,
    address: "0x0000000000000000000000000000000000000004" as Address,
  };
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [zeroAddress, 1n],
  });
  const make = (to: Address, listed = true) => ({
    plan: { chainId: 8453, account, calls: [{ to, data, value: "0" }] },
    operation: "swap" as const,
    blockNumber: "1",
    timestamp: "1",
    execution: {
      atomicBatchRecommended: true,
      approvalCalls: 0,
      protocolCallsAtomic: true as const,
      steps: [],
    },
    market: { asset: { ...asset, listed }, quote },
    details: null,
  });
  assert.throws(
    () => validatePlan(make(asset.address), account, deployment),
    /validation/,
  );
  assert.throws(
    () => validatePlan(make(deployment, false), account, deployment),
    /validation/,
  );
  assert.throws(() => validatePlan(make(deployment), account, deployment));
});
