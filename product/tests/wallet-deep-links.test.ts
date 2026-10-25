import { describe, expect, it } from "vitest";
import { MOBILE_WALLETS } from "@/lib/deep-links";
import { ORIGIN } from "@/lib/registry";

describe("wallet browser links", () => {
  it("opens yld.cx in Phantom with the required encoded app reference", () => {
    const url = new URL(MOBILE_WALLETS.Phantom.browseUrl);
    expect(url.origin).toBe("https://phantom.com");
    expect(decodeURIComponent(url.pathname.slice("/ul/browse/".length))).toBe(
      ORIGIN,
    );
    expect(url.searchParams.get("ref")).toBe(ORIGIN);
  });

  it("opens yld.cx in MetaMask without the scheme", () => {
    expect(MOBILE_WALLETS.MetaMask.browseUrl).toBe(
      "https://link.metamask.io/dapp/yld.cx",
    );
  });
});
