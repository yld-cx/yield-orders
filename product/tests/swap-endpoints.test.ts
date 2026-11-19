import { describe, it, expect } from "vitest";
import { POST } from "../app/api/swap/quote/route.ts";
const input = {
  chainId: 8453,
  mode: "wallet-router",
  tokenIn: "0x4200000000000000000000000000000000000006",
  tokenOut: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  amount: "100",
  swapper: "0x1111111111111111111111111111111111111111",
  slippage: 0.5,
};
function request(body: unknown, origin = "https://yld.cx") {
  return new Request("https://yld.cx/api/swap/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}
describe("public swap boundary", () => {
  it("rejects cross-origin and unauthenticated machine requests", async () => {
    expect(
      (await POST(request(input, "https://attacker.example"))).status,
    ).toBe(403);
    expect(
      (
        await POST(
          new Request("https://yld.cx/api/swap/quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }),
        )
      ).status,
    ).toBe(403);
  });
  it.each([undefined, "Bearer arbitrary"])(
    "does not expose resolver quote mode with authorization %s",
    async (authorization) => {
      const resolverRequest = request({ ...input, mode: "resolver-router" });
      if (authorization)
        resolverRequest.headers.set("authorization", authorization);
      expect((await POST(resolverRequest)).status).toBe(403);
    },
  );
  it("caps streamed JSON and rejects client-supplied quote payloads", async () => {
    expect((await POST(request({ padding: "x".repeat(5000) }))).status).toBe(
      413,
    );
    expect(
      (
        await POST(
          request({
            ...input,
            quote: {},
            url: "https://internal.example/secret",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("rejects pairs outside Yieldlist before upstream requests", async () => {
    expect(
      (
        await POST(
          request({
            ...input,
            tokenOut: "0x2222222222222222222222222222222222222222",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("applies a global budget even to requests that rotate wallet identities", async () => {
    let status = 0;
    for (let i = 0; i < 121; i++)
      status = (await POST(request(input, "https://attacker.example"))).status;
    expect(status).toBe(429);
  });
});
