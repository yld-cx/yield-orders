import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderPosition, Token } from "@yld-cx/sdk";
import { protocolAbi, Q128, type Preview } from "@yld-cx/sdk/ethereum";
import { TransactionPreview } from "@/components/transactions/transaction-preview";

const asset: Token = {
  network: "eip155:8453",
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  listed: true,
};
const quote: Token = {
  ...asset,
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};
const providerFields = protocolAbi.find(
  (f) => f.type === "function" && f.name === "getEarnPosition",
)!.outputs[0].components;
const emptyProvider = Object.fromEntries(
  providerFields.map((field) => [field.name, 0n]),
) as ProviderPosition;
const base = {
  account: asset.address as `0x${string}`,
  chainId: 8453,
  plan: { calls: [] },
  blockNumber: 10n,
  timestamp: 100n,
  gas: 40000n,
} satisfies Partial<Preview>;

function render(preview: Preview, a = asset, q = quote) {
  const html = renderToStaticMarkup(
    <TransactionPreview preview={preview} asset={a} quote={q} />,
  );
  const [main, details] = html.split("<details");
  return { html, main, details };
}

describe("action previews", () => {
  it.each([
    {
      a: asset,
      q: quote,
      amount: 10n ** 18n,
      price: (3000n * Q128) / 10n ** 12n,
      expected: "3,000 USDC",
    },
    {
      a: quote,
      q: asset,
      amount: 3000n * 10n ** 6n,
      price: (Q128 * 10n ** 12n) / 3000n,
      expected: "1 WETH",
    },
    {
      a: { ...asset, decimals: 0 },
      q: { ...quote, decimals: 0 },
      amount: 1n,
      price: 100n * Q128 + 1n,
      expected: "101 USDC",
    },
    { a: asset, q: quote, amount: 1n, price: Q128, expected: "0.000001 USDC" },
  ])(
    "estimates full Supply Quote before fees as $expected",
    ({ a, q, amount, price, expected }) => {
      const { main } = render(
        {
          ...base,
          action: { kind: "supply", tickId: 1n, amount },
          tick: {
            asset: a.address as `0x${string}`,
            quote: q.address as `0x${string}`,
            priceX128: price,
            durationDays: 7n,
            availableSupply: amount,
            workingSupply: 0n,
            activeWorking: 0n,
            activePrincipal: amount,
            exitWorking: 0n,
            settleCursor: 0n,
          },
        },
        a,
        q,
      );
      expect(main).toContain(">Estimated Quote</dt>");
      expect(
        main.split(">Estimated Quote</dt>")[1].split("</dl>")[0],
      ).toContain(expected);
    },
  );

  it.each([false, true])(
    "shows additional provider liquidity only when it differs (existing: %s)",
    (existing) => {
      const { main, details } = render({
        ...base,
        action: { kind: "supply", tickId: 1n, amount: 10n ** 18n },
        provider: {
          ...emptyProvider,
          activePrincipal: (existing ? 2n : 1n) * 10n ** 18n,
        },
        tick: {
          asset: asset.address as `0x${string}`,
          quote: quote.address as `0x${string}`,
          priceX128: (1n << 128n) / 10n ** 12n,
          durationDays: 7n,
          availableSupply: 10n ** 18n,
          workingSupply: 0n,
          activeWorking: 0n,
          activePrincipal: 10n ** 18n,
          exitWorking: 0n,
          settleCursor: 0n,
        },
      });
      for (const label of [
        "Price",
        "Duration",
        "You supply",
        "Estimated Quote",
      ])
        expect(main).toContain(`>${label}</dt>`);
      expect(main).toContain("3.7161%");
      expect(main).toContain("Estimated APY");
      expect(main).toContain('aria-label="About APY"');
      expect(main).not.toContain("assumes reinvestment at the same rate");
      expect(main.includes("Your Active liquidity after")).toBe(existing);
      expect(main).toContain('data-slot="alert"');
      expect(main).toContain("lucide-info");
      expect(main).not.toContain("restarts vesting");
      expect(details).toContain(">Network</dt>");
      expect(details).toContain(">Base · 8453</dd>");
      expect(details).toContain(">Account</dt>");
      expect(details).toContain("Estimated gas units");
      expect(details).toContain("Preview block");
    },
  );

  it.each([
    "outstandingActiveYieldAsset",
    "outstandingExitYieldAsset",
  ] as const)("preserves the vesting warning for %s", (field) => {
    const { main } = render({
      ...base,
      action: { kind: "supply", tickId: 1n, amount: 1n },
      provider: { ...emptyProvider, activePrincipal: 1n, [field]: 1n },
    });
    expect(main).toContain("Supply restarts vesting of uncollected Yield.");
  });

  it.each([
    [asset, quote],
    [quote, asset],
  ])("shows renter amounts and consequences for $symbol", (a, q) => {
    const { main, details } = render(
      {
        ...base,
        action: {
          kind: "use",
          tickId: 1n,
          amount: 10n ** BigInt(a.decimals),
          maxFullTermYieldAsset: 2n * 10n ** BigInt(a.decimals),
          deadline: 200n,
        },
        position: {
          tickId: 1n,
          tickSeq: 0n,
          user: base.account,
          assetAmount: 10n ** BigInt(a.decimals),
          quotePrincipal: 3n * 10n ** BigInt(q.decimals),
          fullTermYieldAsset: 10n ** BigInt(a.decimals),
          closeFee: 20n,
          openedAt: 100n,
          maturity: 604900n,
          status: 1,
        },
      },
      a,
      q,
    );
    for (const label of [
      "Receive Asset",
      "Lock Quote",
      "Maximum term Yield",
      "Term end",
    ])
      expect(main).toContain(`>${label}</dt>`);
    expect(main).toContain(`1 ${a.symbol}`);
    expect(main).toContain(`3 ${q.symbol}`);
    expect(main).toContain(
      `Repay ${a.symbol} + Yield to unlock ${q.symbol}, or it will be swapped at term end.`,
    );
    expect(details).toContain("Maximum accepted Yield");
    expect(details).toContain(`2 ${a.symbol}`);
    expect(details).toContain("Execution deadline");
    expect(details).toContain("Account");
  });

  it.each([
    [asset, quote],
    [quote, asset],
  ])("keeps the executor's Swap payment limit for $symbol", (a, q) => {
    const { main } = render(
      {
        ...base,
        action: {
          kind: "swap",
          tickId: 1n,
          amount: 1n,
          maxQuoteIn: 4n * 10n ** BigInt(q.decimals),
          deadline: 200n,
        },
        swap: {
          assetAmount: 1n,
          quotePrincipal: 3n * 10n ** BigInt(q.decimals),
          swapFee: 1n,
          providerSwapProceeds: 2n,
        },
      },
      a,
      q,
    );
    for (const label of ["Receive Asset", "Pay Quote", "Maximum Quote payment"])
      expect(main).toContain(`>${label}</dt>`);
    expect(main).toContain(`3 ${q.symbol}`);
    expect(main).toContain(`4 ${q.symbol}`);
    expect(main).toContain(
      a.decimals === 18 ? `&lt;0.000001 ${a.symbol}` : `0.000001 ${a.symbol}`,
    );
    expect(main).toContain("Swaps are instant and final.");
  });

  it("keeps very small prices nonzero", () => {
    const { main } = render({
      ...base,
      action: { kind: "supply", tickId: 1n, amount: 1n },
      tick: {
        asset: base.account,
        quote: quote.address as `0x${string}`,
        priceX128: 1n,
        durationDays: 7n,
        availableSupply: 1n,
        workingSupply: 0n,
        activeWorking: 0n,
        activePrincipal: 1n,
        exitWorking: 0n,
        settleCursor: 0n,
      },
    });
    expect(main).toMatch(/0\.0+[1-9]\d* USDC \/ WETH/);
  });
});
