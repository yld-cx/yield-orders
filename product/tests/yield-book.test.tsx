import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PRODUCT_MARKET,
  QUERY_TIMING,
  type Market,
  type TickState,
} from "@yld-cx/sdk";
import {
  priceAtTick,
  tickCandidates,
  type DiscoveryResult,
} from "@yld-cx/sdk/ethereum";
import { useYieldBook, type BookLevel } from "@/hooks/use-yield-book";
import { YieldBook } from "@/components/markets/yield-book";
import { SupplyForm } from "@/components/markets/supply-form";
import { UseForm } from "@/components/markets/use-form";
import { bookWindow, initialBookWindow } from "@/lib/market-selection";
import { discoveryBaseTick } from "@/lib/market-values";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  discover: vi.fn(),
  flow: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
vi.mock("@/lib/rpc", () => ({ getSdk: () => ({ discover: mocks.discover }) }));
vi.mock("wagmi", () => ({ useConnection: () => ({}) }));
vi.mock("@/components/transactions/transaction-flow", () => ({
  TransactionFlow: (props: { label: string }) => {
    mocks.flow(props);
    return <button>{props.label}</button>;
  },
}));
const a = "0x4200000000000000000000000000000000000006",
  b = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const market: Market = {
  network: "eip155:8453",
  key: `${a}:${b}`,
  baseTick: -196000,
  stepTicks: PRODUCT_MARKET.stepTicks,
  defaultDuration: 7,
  token0: {
    network: "eip155:8453",
    address: a,
    symbol: "WETH",
    name: "Ether",
    decimals: 18,
    listed: true,
  },
  token1: {
    network: "eip155:8453",
    address: b,
    symbol: "USDC",
    name: "USD",
    decimals: 6,
    listed: true,
  },
};
const display = [market.token0, market.token1] as const;
const window = bookWindow(initialBookWindow(market.baseTick));
const identities = window
  .flatMap((tick) => tickCandidates(42n, tick, 100, 0))
  .filter((t) => t.direction === 1 && t.durationDays === 7);
const state: TickState = {
  asset: b,
  quote: a,
  priceX128: priceAtTick(identities[0].priceTick),
  durationDays: 7n,
  availableSupply: 500n,
  workingSupply: 0n,
  exitWorking: 0n,
  activeWorking: 0n,
  activePrincipal: 500n,
  settleCursor: 0n,
};
const result: DiscoveryResult = {
  blockNumber: 1n,
  radius: 10,
  complete: false,
  reads: identities.map((identity, i) =>
    i === 0
      ? { identity, status: "exists", tick: { ...identity, state } }
      : i === 1
        ? { identity, status: "failed", error: "RPC timeout" }
        : { identity, status: "missing" },
  ),
};
function readBook(data: DiscoveryResult | undefined = result, error?: Error) {
  mocks.query.mockReturnValue({
    data,
    isError: !!error,
    error,
    isFetching: false,
    isPending: false,
    refetch: vi.fn(),
  });
  let book!: ReturnType<typeof useYieldBook>;
  function Harness() {
    book = useYieldBook(market, 42n, window, 1);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return book;
}
function supply(
  level?: BookLevel,
  duration: 7 = 7,
  assetAddress = level?.asset ?? b,
) {
  return renderToStaticMarkup(
    <SupplyForm
      market={market}
      display={display}
      duration={duration}
      selectedTick={level}
      assetAddress={assetAddress}
    />,
  );
}
beforeEach(() => vi.clearAllMocks());
describe("single-side discovery", () => {
  it("reads only ten exact canonical levels in the selected side and 7D", async () => {
    const book = readBook(),
      options = mocks.query.mock.calls[0][0];
    await options.queryFn();
    expect(mocks.discover).toHaveBeenCalledWith(42n, {
      canonicalTicks: window,
      direction: 1,
      duration: 7,
      stepTicks: 100,
    });
    expect(options.refetchInterval).toBe(QUERY_TIMING.liveRefresh);
    expect(book.levels).toHaveLength(10);
    expect(book.ticks).toHaveLength(1);
    expect(book.levels[1]).toMatchObject({
      status: "failed",
      error: "RPC timeout",
    });
    expect(book.levels[2]).toMatchObject({ status: "missing", asset: b });
    expect(options).not.toHaveProperty("placeholderData");
  });
  it.each([undefined, result])(
    "fails safely even with cached discovery data %s",
    (data) => {
      const book = readBook(data, new Error("RPC unavailable"));
      expect(book.failed).toBe(10);
      expect(book.missing).toBe(0);
      expect(book.ticks).toHaveLength(0);
    },
  );
  it("renders missing levels, failed reads, Yield and the original animated OTC controls", () => {
    const book = readBook();
    const html = renderToStaticMarkup(
      <YieldBook
        display={display}
        side="bid"
        onSideChange={vi.fn()}
        selection={{ kind: "tick", canonicalTick: market.baseTick }}
        onSelect={vi.fn()}
        onMarket={vi.fn()}
        marketAvailable
        referencePrice="3K"
        book={book}
        onNavigate={vi.fn()}
        canHigher
        canLower
      />,
    );
    expect(html).toContain('data-status="missing"');
    expect(html).toContain("0 <small>USDC</small>");
    expect(html).toContain("Read failed");
    expect(html.indexOf("Market · AMM")).toBeLessThan(html.indexOf("Price ·"));
    expect(html).toContain(">Yield</span>");
    expect(html).toContain("otc-badge");
    expect(html).toContain("~ 3K USDC");
    expect(html).toContain('aria-label="Refresh discovery"');
    expect(html).not.toContain("Back to market");
    expect(html).not.toContain("Amounts in");
    expect(html).not.toContain("30D");
  });
});
describe("Limit execution", () => {
  it.each([0, 1] as const)(
    "prepares initialization of a missing tick in direction %s",
    async (direction) => {
      readBook();
      const identity = tickCandidates(42n, market.baseTick, 100, 0).find(
        (t) => t.direction === direction && t.durationDays === 7,
      )!;
      const level: BookLevel = {
        ...identity,
        status: "missing",
        asset: direction === 0 ? a : b,
        priceX128: priceAtTick(identity.priceTick),
      };
      const html = supply(level);
      const flow = mocks.flow.mock.calls[0][0];
      expect(flow.label).toBe("Preview Provide");
      expect(flow.triggerLabel).toBe(
        direction === 0 ? "Sell and Earn" : "Buy and Earn",
      );
      expect(await flow.prepare()).toEqual({
        kind: "supply",
        tickId: identity.id,
        amount: 0n,
        initialize: {
          tokenA: a,
          tokenB: b,
          direction,
          priceTick: identity.priceTick,
          durationDays: 7,
        },
      });
      expect(html).toContain("7D");
      expect(html).not.toContain("Supply side");
      expect(html).not.toContain('role="combobox"');
    },
  );
  it("blocks failed reads and incompatible side/duration", () => {
    const book = readBook();
    supply(book.levels[1]);
    expect(mocks.flow.mock.calls[0][0].disabled).toBe(true);
    mocks.flow.mockClear();
    supply({ ...book.levels[0], durationDays: 30 });
    supply(book.levels[0], 7, a);
    expect(mocks.flow).not.toHaveBeenCalled();
  });
});
describe("Rent and tick Swap", () => {
  function render(
    level?: BookLevel,
    mode: "use" | "swap" = "use",
    pending = false,
  ) {
    mocks.query.mockReturnValue({ isError: false });
    return renderToStaticMarkup(
      <UseForm
        market={market}
        display={display}
        tick={level}
        mode={mode}
        isPending={pending}
        isIncomplete={level?.status === "failed"}
      />,
    );
  }
  it.each(["use", "swap"] as const)(
    "requires confirmed liquidity for %s",
    (mode) => {
      const book = readBook();
      expect(render(book.levels[2], mode)).toContain("No liquidity yet");
      expect(render(book.levels[1], mode)).toContain("Liquidity unavailable");
      expect(mocks.flow).not.toHaveBeenCalled();
      const html = render(book.levels[0], mode);
      expect(html).toContain("Amount");
      expect(mocks.flow.mock.calls[0][0].label).toBe(
        mode === "use" ? "Preview Rent" : "Preview Swap",
      );
      expect(html.includes('aria-label="Yield slippage"')).toBe(mode === "use");
    },
  );
  it("distinguishes loading from missing levels", () => {
    const pending = render(undefined, "use", true);
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain('data-slot="skeleton"');
    expect(pending).not.toContain("Reading market");
    expect(render()).toContain("Choose your price");
  });
});
it("validates canonical URL centers against the product grid", () => {
  for (const value of [
    null,
    "",
    " ",
    "1.5",
    "-195001",
    "887273",
    "Infinity",
    "1e3",
    "+1000",
  ])
    expect(discoveryBaseTick(value, market)).toBe(market.baseTick);
  expect(discoveryBaseTick("-195900", market)).toBe(-195900);
});
