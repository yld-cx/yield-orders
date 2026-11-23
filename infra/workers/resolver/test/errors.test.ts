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
import { errorDetails } from "../src/shared.ts";

function executionError(cause: BaseError) {
  return new ContractFunctionExecutionError(cause, {
    abi: [],
    functionName: "execute",
  });
}

test("RPC diagnostics retain HTTP status and omit provider-controlled credentials and request data", () => {
  const secrets = [
    "https://user:password@rpc.test/path-token",
    "path-token",
    "user:password",
    "api-secret",
    "body-marker",
    `0x${"ab".repeat(32)}`,
  ];
  const http = new HttpRequestError({
    url: secrets[0],
    status: 429,
    details: secrets.join(" "),
    body: { privateKey: secrets[5], marker: secrets[4] },
  });
  const result = errorDetails(
    executionError(new BaseError("Call failed", { cause: http })),
  );
  assert.equal(result.error, "ContractFunctionExecutionError");
  assert.equal(result.cause, "HttpRequestError");
  assert.equal(result.status, 429);
  for (const secret of secrets)
    assert.ok(!JSON.stringify(result).includes(secret));
});

test("RPC diagnostics retain custom revert names and timeout classifications", () => {
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
  const result = errorDetails(executionError(revert));
  assert.equal(result.cause, "ContractFunctionRevertedError");
  assert.equal(result.revert, "UnsafeBatch");
  assert.ok(!JSON.stringify(result).includes("hidden-argument"));
  const timeout = new TimeoutError({
    url: "https://rpc.test/private-key",
    body: {},
  });
  assert.equal(errorDetails(executionError(timeout)).cause, "TimeoutError");
});
