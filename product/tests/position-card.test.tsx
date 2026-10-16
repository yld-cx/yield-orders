import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import type {
  ProviderPosition,
  TickState,
  Token,
  UsePosition,
} from "@yld-cx/sdk";
import { protocolAbi, type Preview } from "@yld-cx/sdk/ethereum";
import { ProviderCard, UseCard } from "@/components/orders/position-card";
import { OrdersScreen } from "@/components/orders/orders-screen";
import { MarketPositions } from "@/components/markets/market-positions";
import { TransactionPreview } from "@/components/transactions/transaction-preview";
import type { TransactionFlow } from "@/components/transactions/transaction-flow";
import { registry } from "@/lib/registry";

type Flow = ComponentProps<typeof TransactionFlow>;
const mocks = vi.hoisted(() => ({
  flow: vi.fn(),
  token: vi.fn(),
  portfolio: vi.fn(),
  principal: vi.fn(),
  tick: vi.fn(),
  preview: vi.fn(),
  block: vi.fn(),
}));
vi.mock("wagmi", () => ({
  useConnection: () => ({
    address: "0x0000000000000000000000000000000000000001",
    chainId: 8453,
  }),
}));
vi.mock("@/hooks/use-market", () => ({ useToken: mocks.token }));
vi.mock("@/hooks/use-portfolio", () => ({ usePortfolio: mocks.portfolio }));
vi.mock("@/components/layout/providers", () => ({
  useNetwork: () => ({ network: "base" }),
}));
vi.mock("@/components/wallet/wallet-connect", () => ({
  WalletConnect: () => null,
}));
vi.mock("@/lib/rpc", () => ({
  getSdk: () => ({
    getEarnPosition: mocks.principal,
    getTick: mocks.tick,
    preview: mocks.preview,
    publicClient: { getBlock: mocks.block },
  }),
}));
vi.mock("@/components/transactions/transaction-flow", () => ({
  TransactionFlow: (props: Flow) => {
    mocks.flow(props);
    return <button disabled={props.disabled}>{props.label}</button>;
  },
}));
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const asset: Token = {
  network: "eip155:8453",
  address: a,
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
  listed: true,
};
const quote: Token = {
  network: "eip155:8453",
  address: b,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  listed: true,
};
const tick: TickState = {
  asset: a,
  quote: b,
  durationDays: 7n,
  priceX128: 1n << 128n,
  activePrincipal: 100n,
  activeWorking: 60n,
  availableSupply: 40n,
  workingSupply: 60n,
  exitWorking: 0n,
  settleCursor: 0n,
};
const providerFields = protocolAbi.find(
  (f) => f.type === "function" && f.name === "getEarnPosition",
)!.outputs[0].components;
const empty = Object.fromEntries(
  providerFields.map((field) => [field.name, 0n]),
) as ProviderPosition;
const provider: ProviderPosition = {
  ...empty,
  activePrincipal: 100n,
  activePrincipalX36: 100n * 10n ** 36n,
  activeAvailable: 40n,
  activeWorking: 60n,
};
const use: UsePosition = {
  tickId: 1n,
  tickSeq: 0n,
  user: a,
  assetAmount: 100n,
  quotePrincipal: 200n,
  fullTermYieldAsset: 11n,
  closeFee: 2n,
  openedAt: 100n,
  maturity: 200n,
  status: 1,
};
function provide(position = provider, state = tick) {
  return renderToStaticMarkup(
    <ProviderCard
      network="base"
      tickId={1n}
      position={position}
      tick={state}
    />,
  );
}
function using(timestamp: bigint, position = use) {
  return renderToStaticMarkup(
    <UseCard
      network="base"
      positionId={2n}
      position={position}
      tick={tick}
      timestamp={timestamp}
    />,
  );
}
function flow(label: string): Flow {
  return mocks.flow.mock.calls.find(([props]) => props.label === label)![0];
}
function collectPreview(assetOut = 0n, quoteOut = 0n, cursor = 0n): Preview {
  return {
    action: { kind: "collect", tickId: 1n },
    plan: { calls: [] },
    account: a,
    chainId: 8453,
    blockNumber: 9n,
    timestamp: 100n,
    gas: 1n,
    tick: { ...tick, settleCursor: cursor },
    collect: {
      exitAsset: assetOut,
      activeYieldAsset: 0n,
      exitYieldAsset: 0n,
      activeQuote: quoteOut,
      exitQuote: 0n,
      totalAssetOut: assetOut,
      totalQuoteOut: quoteOut,
      resolvingPrincipal: 0n,
      outstandingActiveYieldAsset: 0n,
      outstandingExitYieldAsset: 0n,
      vestingRemainingSeconds: 0n,
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockImplementation((_network, address) => ({
    data: address === a ? asset : quote,
  }));
  mocks.principal.mockResolvedValue(provider);
  mocks.block.mockResolvedValue({ timestamp: 100n });
  mocks.tick.mockResolvedValue(tick);
  mocks.portfolio.mockReturnValue({
    data: {
      pages: [
        {
          providers: [{ tickId: 1n, position: provider, tick }],
          uses: [{ positionId: 2n, position: use, tick }],
          timestamp: 150n,
        },
      ],
    },
    isSuccess: true,
  });
});

describe("compact shared position cards", () => {
  it.each(["provide", "use"] as const)(
    "uses quote-priority pair and price for Ask and Bid %s orders",
    (kind) => {
      const q128 = 1n << 128n;
      for (const bid of [false, true]) {
        const state: TickState = {
          ...tick,
          asset: bid ? b : a,
          quote: bid ? a : b,
          priceX128: bid
            ? (q128 * 10n ** 12n) / 3000n
            : (q128 * 3000n) / 10n ** 12n,
        };
        const html = renderToStaticMarkup(
          kind === "provide" ? (
            <ProviderCard
              network="base"
              tickId={1n}
              position={provider}
              tick={state}
            />
          ) : (
            <UseCard
              network="base"
              positionId={2n}
              position={use}
              tick={state}
              timestamp={150n}
            />
          ),
        );
        expect(html).toContain('aria-label="View WETH / USDC market"');
        expect(html).toContain(`${bid ? "Bid" : "Ask"} · 3,000 USDC per WETH`);
        expect(html).not.toContain("WETH per USDC");
        const action = flow(
          kind === "provide" ? "Preview Withdraw" : "Preview Repay",
        );
        expect(action.asset?.address).toBe(state.asset);
        expect(action.quote?.address).toBe(state.quote);
        mocks.flow.mockClear();
      }
    },
  );
  it("renders the shared card on both Orders and Market pages", () => {
    const market = registry.getMarket("eip155:8453", a, b)!;
    for (const html of [
      renderToStaticMarkup(<OrdersScreen />),
      renderToStaticMarkup(<MarketPositions market={market} />),
    ]) {
      expect(html).toContain('data-slot="position-card"');
      expect(html).toContain("grid grid-cols-1 gap-4");
      expect(html).not.toContain("md:grid-cols-2");
      expect(html).toContain("Withdraw percentage");
    }
    expect(using(150n)).toContain('data-slot="position-card"');
  });
  it("has accessible percentages and Details without removed controls", () => {
    const html = provide();
    for (const label of ["25%", "50%", "75%", "Max"])
      expect(html).toContain(label);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Details</summary>");
    expect(html).toContain("Total Active principal");
    expect(html).not.toMatch(
      /Settle|More actions|checkbox|Allow any immediate|Remaining liquidity/,
    );
    expect(mocks.flow.mock.calls.map(([p]) => p.label)).toEqual([
      "Preview Withdraw",
      "Preview Collect",
    ]);
  });
  it("reads fresh onchain principal and prepares an unrestricted withdrawal without an extra simulation", async () => {
    provide();
    mocks.principal.mockResolvedValue({ ...provider, activePrincipal: 7n });
    expect(await flow("Preview Withdraw").prepare()).toEqual({
      kind: "withdraw",
      tickId: 1n,
      amount: 7n,
      minImmediateAssetOut: 0n,
      deadline: 400n,
    });
    expect(mocks.principal).toHaveBeenCalledWith(
      "0x0000000000000000000000000000000000000001",
      1n,
    );
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("blocks a withdrawal if fresh principal has rounded down to zero", async () => {
    provide();
    mocks.principal.mockResolvedValue({ ...provider, activePrincipal: 0n });
    await expect(flow("Preview Withdraw").prepare()).rejects.toThrow(
      "No transferable principal",
    );
    expect(mocks.block).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it.each([
    { ...empty, resolvingPrincipal: 5n, exitPrincipalX36: 5n * 10n ** 36n },
    { ...empty, claimableExitAsset: 1n },
    { ...empty, claimableExitYieldAsset: 1n },
    { ...empty, claimableActiveQuote: 1n },
    { ...empty, outstandingExitYieldAsset: 1n },
  ])(
    "keeps zero Active positions accessible with remaining claims or Resolving",
    (position) => {
      mocks.portfolio.mockReturnValue({
        data: {
          pages: [
            {
              providers: [{ tickId: 1n, position, tick }],
              uses: [],
              timestamp: 150n,
            },
          ],
        },
        isSuccess: true,
      });
      expect(renderToStaticMarkup(<OrdersScreen />)).toContain(
        'data-slot="position-card"',
      );
      expect(flow("Preview Withdraw").disabled).toBe(true);
    },
  );
  it("disables Collect for idle liquidity with no collectible amounts", () => {
    provide({ ...provider, activeWorking: 0n }, { ...tick, workingSupply: 0n });
    expect(flow("Preview Collect").disabled).toBe(true);
  });
  it("leaves Collect available to advance settlement for fractional Resolving positions", () => {
    provide({ ...empty, exitPrincipalX36: 1n });
    expect(flow("Preview Collect").disabled).toBe(false);
  });
  it("blocks a zero-output Collect with no settlement progress", async () => {
    provide();
    await expect(
      flow("Preview Collect").validatePreview!(collectPreview()),
    ).rejects.toThrow("Nothing to collect yet");
    expect(mocks.tick).toHaveBeenCalledWith(1n, 9n);
  });
  it.each([
    [1n, 0n, 0n],
    [0n, 1n, 0n],
    [0n, 0n, 1n],
  ])(
    "allows Collect with Asset %s, Quote %s, cursor %s",
    async (assetOut, quoteOut, cursor) => {
      provide();
      await expect(
        flow("Preview Collect").validatePreview!(
          collectPreview(assetOut, quoteOut, cursor),
        ),
      ).resolves.toBeUndefined();
    },
  );
  it("propagates failed settlement reads instead of accepting a zero-output Collect", async () => {
    provide();
    mocks.tick.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(
      flow("Preview Collect").validatePreview!(collectPreview()),
    ).rejects.toThrow("RPC unavailable");
  });
  it.each([provide, () => using(150n)])(
    "keeps unlisted-token warnings outside collapsed Details",
    (render) => {
      mocks.token.mockImplementation((_network, address) => ({
        data: address === a ? { ...asset, listed: false } : quote,
      }));
      const html = render();
      expect(html.indexOf("Unlisted token")).toBeLessThan(
        html.indexOf("<details"),
      );
      expect(html).toContain('role="note"');
    },
  );
  it("shows exact small balances in Details", () => {
    expect(provide()).toContain("0.0000000000000001 WETH");
  });
});

describe("Use information without execution simulation", () => {
  it.each([
    [99n, 1n],
    [100n, 1n],
    [101n, 1n],
    [150n, 6n],
    [199n, 11n],
    [200n, 11n],
    [201n, 11n],
  ])(
    "estimates contract-rounded Yield at timestamp %s",
    (timestamp, accrued) => {
      const html = using(timestamp, { ...use, fullTermYieldAsset: 11n });
      expect(html).toContain("Accrued Yield (estimated)");
      // Use a zero-decimal Asset so a single-unit rounding difference is visible.
      mocks.token.mockImplementation((_network, address) => ({
        data: address === a ? { ...asset, decimals: 0 } : quote,
      }));
      expect(using(timestamp)).toContain(`>${accrued} WETH</dd>`);
      expect(mocks.preview).not.toHaveBeenCalled();
    },
  );
  it.each([199n, 200n, 201n])(
    "switches Repay to Close at maturity %s",
    async (timestamp) => {
      const html = using(timestamp);
      const mature = timestamp >= use.maturity;
      expect(
        await flow(mature ? "Preview Close" : "Preview Repay").prepare(),
      ).toEqual(
        mature
          ? { kind: "close", positionId: 2n }
          : {
              kind: "repay",
              positionId: 2n,
              maxYieldAsset: use.fullTermYieldAsset,
            },
      );
      expect(html).toContain(mature ? "Matured" : "remaining");
      expect(html.indexOf("Full-term Yield")).toBeGreaterThan(
        html.indexOf("<details"),
      );
      expect(html.indexOf("Exact maturity")).toBeGreaterThan(
        html.indexOf("<details"),
      );
      expect(html).not.toContain("Requires approval");
    },
  );
});

it("keeps withdrawal outcomes and forfeited Yield in the transaction preview", () => {
  const preview: Preview = {
    ...collectPreview(),
    action: {
      kind: "withdraw",
      tickId: 1n,
      amount: 10n,
      minImmediateAssetOut: 0n,
      deadline: 400n,
    },
    withdraw: {
      providerPrincipal: 10n,
      remainingActivePrincipal: 0n,
      principalAmount: 10n,
      availableAssetOut: 4n,
      workingToExit: 6n,
      yieldAssetOut: 1n,
      unvestedYield: 2n,
      resolvingPrincipal: 6n,
    },
  };
  const html = renderToStaticMarkup(
    <TransactionPreview preview={preview} asset={asset} quote={quote} />,
  );
  for (const label of [
    "Withdraw principal",
    "Receive principal now",
    "Move to Resolving",
    "Unvested Yield forfeited",
  ])
    expect(html).toContain(label);
});
