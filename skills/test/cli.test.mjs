import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPublicClient, custom } from "viem";
import { base } from "viem/chains";
import { createSkills } from "../dist/index.js";

const path = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [path, ...args], { encoding: "utf8" });

test("CLI help and protocol output are JSON with discoverable transaction arguments", () => {
  const help = JSON.parse(run("--help").stdout);
  assert.ok(help.commands.prepare);
  const options = JSON.parse(run("prepare", "--help").stdout).options;
  assert.ok(options["--operation"].required);
  assert.ok(options["--max-quote-in"].description);
  assert.equal(JSON.parse(run("protocol").stdout).name, "Yield Orders");
});

test("CLI rejects invalid flags and amounts without an RPC request", () => {
  const unknown = run("unknown");
  assert.equal(unknown.status, 2);
  assert.match(JSON.parse(unknown.stderr).error, /Unknown command/);
  const wrong = run("prepare", "--operation", "swap", "--amount=-1");
  assert.equal(wrong.status, 2);
  assert.ok(
    JSON.parse(wrong.stderr).issues.some(({ field }) => field === "amount"),
  );
});

test("public declarations and bundle have no private package imports", () => {
  for (const name of ["cli.js", "index.js", "index.d.ts", "inputs.d.ts"]) {
    const source = readFileSync(
      new URL(`../dist/${name}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\()["']@yld-cx\/(?:sdk|ethereum-protocol)/,
    );
  }
});

test("a custom RPC cannot return balances under the wrong network label", async () => {
  const client = createPublicClient({
    transport: custom({
      request: async ({ method }) => {
        assert.equal(method, "eth_chainId");
        return "0x2105";
      },
    }),
  });
  await assert.rejects(
    () =>
      createSkills({ client: () => client }).balances({
        chain: "ethereum",
        account: "0x0000000000000000000000000000000000000001",
      }),
    /RPC endpoint is not connected to Ethereum/,
  );
});

test("CLI batches remote reads, retries a failed fallback pass once, and keeps loopback pinned", () => {
  const defaultRpc = new URL(base.rpcUrls.default.http[0]).href;
  const primary = "https://private-rpc.invalid/";
  const account = "0x0000000000000000000000000000000000000001";
  const token = "0x4200000000000000000000000000000000000006";
  const mock = `
    import { decodeFunctionData, encodeFunctionResult, erc20Abi, multicall3Abi } from ${JSON.stringify(import.meta.resolve("viem"))};
    const attempts = [];
    let failDefault = true;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const payload = await request.json();
      attempts.push({ url: request.url, batch: Array.isArray(payload) });
      if (request.url !== ${JSON.stringify(defaultRpc)}) {
        return new Response(null, { status: 503 });
      }
      if (failDefault) {
        failDefault = false;
        return new Response(null, { status: 503 });
      }
      const results = { getEthBalance: 2n, symbol: "WETH", name: "Wrapped Ether", decimals: 18, balanceOf: 3n };
      return Response.json(payload.map(({ id, method, params }) => {
        const answer = { jsonrpc: "2.0", id, result: "0x2105" };
        if (method === "eth_chainId") return answer;
        const { args: [calls] } = decodeFunctionData({ abi: multicall3Abi, data: params[0].data });
        attempts.at(-1).multicallSize = calls.length;
        answer.result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: calls.map(({ target, callData }) => {
          const abi = target.toLowerCase() === ${JSON.stringify(token)} ? erc20Abi : multicall3Abi;
          const { functionName } = decodeFunctionData({ abi, data: callData });
          return { success: true, returnData: encodeFunctionResult({ abi, functionName, result: results[functionName] }) };
        }) });
        return answer;
      }));
    };
    process.on("exit", () => console.error(JSON.stringify(attempts)));
  `;
  const balances = (url) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(mock)}`,
        path,
        "balances",
        "--account",
        account,
        "--tokens",
        token,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, YLD_RPC_URL: url },
        timeout: 8000,
      },
    );
    return {
      ...result,
      attempts: JSON.parse(result.stderr.trim().split("\n").at(-1)),
    };
  };
  const remote = balances(primary);
  assert.equal(remote.status, 0, remote.stderr);
  const output = JSON.parse(remote.stdout);
  assert.equal(output.native.raw, "2");
  assert.equal(output.tokens[0].raw, "3");
  assert.deepEqual(
    remote.attempts,
    [primary, defaultRpc, primary, defaultRpc, primary, defaultRpc].map(
      (url, index) => ({
        url,
        batch: true,
        ...(index === 5 && { multicallSize: 5 }),
      }),
    ),
  );
  const defaultOnly = balances(undefined);
  assert.equal(defaultOnly.status, 0, defaultOnly.stderr);
  assert.equal(defaultOnly.attempts.length, 3);
  assert.ok(defaultOnly.attempts.every(({ url }) => url === defaultRpc));
  const local = balances("http://127.0.0.1:18545/");
  assert.equal(local.status, 1);
  assert.deepEqual(local.attempts, [
    { url: "http://127.0.0.1:18545/", batch: false },
  ]);
});
