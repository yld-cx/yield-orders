import test from "node:test";
import assert from "node:assert/strict";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  TimeoutError,
  encodeErrorResult,
  parseAbi,
} from "viem";
import { errorDetails, log, type Env } from "../src/shared.ts";

const env = {} as Env;
function executionError(cause: BaseError) {
  return new ContractFunctionExecutionError(cause, {
    abi: [],
    functionName: "execute",
  });
}

test("error logs expose HTTP failure details without secrets or request data", (t) => {
  const key = `0x${"ab".repeat(32)}` as const;
  const apiKey = "gateway-credential+/=";
  const rpc = "https://user:password@rpc.test/private-api-key?token=secret";
  const http = new HttpRequestError({
    url: rpc,
    status: 429,
    details: `Upstream rate limit reached ${rpc} ${key} ${apiKey} ${encodeURIComponent(apiKey)}`,
    headers: new Headers({ Authorization: "Bearer secret-token" }),
    body: { privateKey: key, marker: "request-body-must-not-be-logged" },
  });
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  log({
    type: "resolver_chain_failed",
    stage: "final_simulation",
    ...errorDetails(
      executionError(new BaseError("Call failed", { cause: http })),
      {
        ...env,
        RESOLVER_SIGNING_KEY: key,
        UNISWAP_API_KEY: apiKey,
      },
    ),
  });
  const result = JSON.parse(lines[0]);
  assert.equal(result.error, "ContractFunctionExecutionError");
  assert.equal(result.cause.name, "HttpRequestError");
  assert.match(result.message, /Upstream rate limit reached/);
  assert.match(result.cause.message, /Upstream rate limit reached/);
  assert.equal(result.status, 429);
  for (const secret of [
    key,
    apiKey,
    encodeURIComponent(apiKey),
    rpc,
    "rpc.test",
    "private-api-key",
    "secret-token",
    "request-body-must-not-be-logged",
  ])
    assert.equal(lines[0].includes(secret), false);
});

test("error diagnostics identify custom reverts and expose standard revert reasons", () => {
  const abi = parseAbi(["error UnsafeBatch(string reason)"]);
  const revert = new ContractFunctionRevertedError({
    abi,
    functionName: "execute",
    data: encodeErrorResult({
      abi,
      errorName: "UnsafeBatch",
      args: ["hidden-argument"],
    }),
  });
  const result = errorDetails(executionError(revert), env);
  assert.equal(result.cause?.name, "ContractFunctionRevertedError");
  assert.equal(result.revert, "UnsafeBatch");
  assert.equal(JSON.stringify(result).includes("hidden-argument"), false);
  const reason = new ContractFunctionRevertedError({
    abi: [],
    functionName: "execute",
    data: encodeErrorResult({
      abi: parseAbi(["error Error(string reason)"]),
      args: ["insufficient profit"],
    }),
  });
  assert.match(
    errorDetails(executionError(reason), env).cause!.message!,
    /insufficient profit/,
  );
});

test("error diagnostics expose timeout and network messages", () => {
  const timeout = new TimeoutError({
    url: "https://rpc.test/private-key",
    body: {},
  });
  const result = errorDetails(executionError(timeout), env);
  assert.equal(result.cause?.name, "TimeoutError");
  assert.match(result.cause!.message!, /timed out/);
  const http = new HttpRequestError({
    url: "https://rpc.test",
    status: 503,
    cause: new Error("connect ECONNRESET; Authorization: Bearer credential"),
  });
  const network = errorDetails(http, env);
  assert.equal(network.status, 503);
  assert.match(network.cause!.message!, /ECONNRESET/);
  assert.equal(JSON.stringify(network).includes("Bearer credential"), false);
  assert.equal(errorDetails(undefined, env).error, "UnknownError");
});

test("nested errors with the same name retain their distinct messages", () => {
  const result = errorDetails(
    new Error("outer operation failed", {
      cause: new Error("inner connection failed"),
    }),
    env,
  );
  assert.equal(result.error, "Error");
  assert.equal(result.message, "outer operation failed");
  assert.equal(result.cause?.name, "Error");
  assert.equal(result.cause?.message, "inner connection failed");
});
