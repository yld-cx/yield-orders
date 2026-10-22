import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DISCOVERY_DEFAULTS,
  QUERY_TIMING,
  Duration,
  type Market,
  type TickState,
  type EconomicAction,
} from "@yld-cx/sdk";
import {
  tickCandidates,
  priceAtTick,
  type DiscoveryResult,
} from "@yld-cx/sdk/ethereum";
import { useYieldBook, type BookLevel } from "@/hooks/use-yield-book";
import { SupplyForm } from "@/components/markets/supply-form";
import { UseForm } from "@/components/markets/use-form";
import { YieldBook } from "@/components/markets/yield-book";
import { discoveryBaseTick } from "@/lib/market-values";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  discover: vi.fn(),
  flow: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: mocks.query,
  keepPreviousData: (data: unknown) => data,
}));
vi.mock("@/lib/rpc", () => ({ getSdk: () => ({ discover: mocks.discover }) }));
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
  stepTicks: DISCOVERY_DEFAULTS.stepTicks,
  defaultDuration: Duration.Weekly,
  token0: {
    network: "eip155:8453",
    address: a,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    listed: true,
  },
  token1: {
    network: "eip155:8453",
    address: b,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    listed: true,
  },
};
const pairId = 42n;
const identities = tickCandidates(pairId, market.baseTick, market.stepTicks);
const identity = identities[0];
const state: TickState = {
  asset: a,
  quote: b,
  priceX128: priceAtTick(identity.priceTick),
  durationDays: BigInt(identity.durationDays),
  availableSupply: 500n,
  workingSupply: 0n,
  exitWorking: 0n,
  activeWorking: 0n,
  activePrincipal: 500n,
  settleCursor: 0n,
};
const result: DiscoveryResult = {
  blockNumber: 1n,
  radius: DISCOVERY_DEFAULTS.radius,
  complete: false,
  reads: identities.map((identity, i) =>
    i === 0
      ? { identity, status: "exists", tick: { ...identity, state } }
      : i === 1
        ? { identity, status: "failed", error: "RPC timeout" }
        : { identity, status: "missing" },
  ),
};
function readBook(
  data: DiscoveryResult | null = result,
  error?: Error,
  baseTick = market.baseTick,
) {
  mocks.query.mockReturnValue({
    data: data ?? undefined,
    isError: !!error,
    error,
    isFetching: false,
    refetch: vi.fn(),
  });
  let book!: ReturnType<typeof useYieldBook>;
  function Harness() {
    book = useYieldBook(market, pairId, baseTick);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  return book;
}
function supply(
  level?: BookLevel,
  duration = level?.durationDays ?? market.defaultDuration,
  assetAddress = level?.asset ?? market.token0.address,
) {
  return renderToStaticMarkup(
    <SupplyForm
      market={market}
      display={[market.token0, market.token1]}
      duration={duration}
      selectedTick={level}
      assetAddress={assetAddress}
      onAssetChange={vi.fn()}
      onDurationChange={vi.fn()}
    />,
  );
}
beforeEach(() => vi.clearAllMocks());

describe("URL discovery center", () => {
  it.each([
    null,
    "",
    " ",
    "1.5",
    "-195001",
    "887273",
    "-887273",
    "Infinity",
    "NaN",
    "1e3",
    "+1000",
    "9007199254740993",
  ])("safely ignores invalid base tick %s", (value) => {
    expect(discoveryBaseTick(value, market)).toBe(market.baseTick);
  });
  it.each(["-195000", "1000", "0", "887000", "-887000"])(
    "uses valid aligned canonical base tick %s",
    (value) => {
      expect(discoveryBaseTick(value, market)).toBe(Number(value));
    },
  );
  it("uses the market's stepTicks for URL validation", () => {
    expect(discoveryBaseTick("1500", { baseTick: 0, stepTicks: 500 })).toBe(
      1500,
    );
    expect(discoveryBaseTick("1501", { baseTick: 0, stepTicks: 500 })).toBe(0);
  });
});

describe("configured Yield Book", () => {
  it("discovers the entire shared grid with active ticks refreshed every 15 seconds", async () => {
    const book = readBook();
    const options = mocks.query.mock.calls[0][0];
    expect(options.refetchInterval).toBe(QUERY_TIMING.liveRefresh);
    expect(options).not.toHaveProperty("enabled");
    await options.queryFn();
    expect(mocks.discover).toHaveBeenCalledWith(pairId, {
      baseTick: market.baseTick,
      stepTicks: market.stepTicks,
    });
    expect(book.levels).toHaveLength(identities.length);
    expect(book.ticks).toHaveLength(1);
    expect(book.levels[0].state).toBe(state);
    expect(book.levels[1]).toMatchObject({
      status: "failed",
      error: "RPC timeout",
    });
    expect(book.levels[2]).toMatchObject({
      ...identities[2],
      status: "missing",
      asset: b,
      priceX128: priceAtTick(identities[2].priceTick),
    });
    expect(book.levels[2].state).toBeUndefined();
  });
  it("uses the effective center in discovery, cache keys and failed-read candidates", async () => {
    const center = market.baseTick + market.stepTicks;
    const book = readBook(null, new Error("RPC unavailable"), center);
    const options = mocks.query.mock.calls[0][0];
    await options.queryFn();
    expect(mocks.discover).toHaveBeenCalledWith(pairId, {
      baseTick: center,
      stepTicks: market.stepTicks,
    });
    expect(options.queryKey).toContain(center);
    expect(options.queryKey).not.toContain(market.baseTick);
    const expected = tickCandidates(pairId, center, market.stepTicks);
    expect(book.levels.map(({ id }) => id)).toEqual(
      expected.map(({ id }) => id),
    );
    expect(book.levels).toHaveLength(84);
    expect(book.failed).toBe(84);
    expect(book.baseTick).toBe(center);
    expect(
      new Set(book.levels.map(({ durationDays }) => durationDays)),
    ).toEqual(new Set([Duration.Weekly, Duration.Monthly]));
  });
  it("renders confirmed missing ticks as zero and failed reads as unavailable", () => {
    const book = readBook();
    const html = renderToStaticMarkup(
      <YieldBook
        referencePrice="3.08K"
        stepTicks={market.stepTicks}
        onBaseTickChange={vi.fn()}
        display={[market.token0, market.token1]}
        duration={Duration.Monthly}
        book={book}
        onSelect={vi.fn()}
        onDurationChange={vi.fn()}
      />,
    );
    expect(html).toContain('data-status="missing"');
    expect(html).toContain("0 <small>USDC</small>");
    expect(html).toContain("Read failed");
  });
  it.each([null, result])(
    "never turns a failed discovery into confirmed empty levels (cached data: %s)",
    (data) => {
      const book = readBook(data, new Error("RPC unavailable"));
      expect(book.levels).toHaveLength(identities.length);
      expect(book.levels.every((level) => level.status === "failed")).toBe(
        true,
      );
      expect(book.missing).toBe(0);
      expect(book.failed).toBe(identities.length);
      expect(book.ticks).toHaveLength(0);
    },
  );
});

describe("selected price Rent or Swap", () => {
  function renderUse(
    level?: BookLevel,
    isPending = false,
    isIncomplete = false,
  ) {
    mocks.query.mockReturnValue({ isError: false });
    return renderToStaticMarkup(
      <UseForm
        market={market}
        display={[market.token0, market.token1]}
        tick={level}
        isPending={isPending}
        isIncomplete={isIncomplete}
      />,
    );
  }
  it.each([0n, 1n])(
    "uses the selected tick's available supply (%s)",
    (availableSupply) => {
      const html = renderUse({
        ...identity,
        asset: a,
        priceX128: state.priceX128,
        status: "exists",
        state: { ...state, availableSupply },
      });
      if (availableSupply > 0n) {
        expect(html).toContain("You receive");
        expect(html).toContain('aria-label="Yield slippage"');
        expect(html).toContain('value="0.5"');
        expect(mocks.flow.mock.calls[0][0].label).toBe("Preview Rent");
      } else {
        expect(html).toContain("No liquidity yet");
        expect(html).toContain("https://t.me/yld_group");
        expect(mocks.flow).not.toHaveBeenCalled();
      }
    },
  );
  it("distinguishes no selection, a missing level, loading and failed reads", () => {
    expect(renderUse()).toContain(
      "Select a Yield Book price to rent or swap tokens.",
    );
    const missing: BookLevel = {
      ...identity,
      asset: a,
      priceX128: state.priceX128,
      status: "missing",
    };
    expect(renderUse(missing)).toContain("No liquidity yet");
    expect(renderUse(undefined, true)).toContain("Reading market…");
    const failed = renderUse(
      { ...missing, status: "failed", error: "RPC timeout" },
      false,
      true,
    );
    expect(failed).toContain("Liquidity unavailable");
    expect(failed).not.toContain("No liquidity yet");
    expect(mocks.flow).not.toHaveBeenCalled();
  });
});

describe("selected price Supply", () => {
  it.each([0, 1] as const)(
    "previews Provide for missing direction %s with its exact initialization identity",
    async (direction) => {
      const level = readBook().levels.find(
        (level) =>
          level.status === "missing" &&
          level.direction === direction &&
          level.durationDays === Duration.Monthly,
      )!;
      const html = supply(level);
      expect(html).toContain(">Price</dt>");
      expect(mocks.flow).toHaveBeenCalledTimes(1);
      const props = mocks.flow.mock.calls[0][0];
      expect(props.label).toBe("Preview Provide");
      expect(await props.prepare()).toEqual({
        kind: "supply",
        tickId: level.id,
        amount: 0n,
        initialize: {
          tokenA: a,
          tokenB: b,
          direction: level.direction,
          priceTick: level.priceTick,
          durationDays: level.durationDays,
        },
      });
    },
  );
  it("supplies an existing selected ID directly", async () => {
    supply(readBook().levels[0]);
    const props = mocks.flow.mock.calls[0][0];
    expect(props.label).toBe("Preview Provide");
    expect(await props.prepare()).toEqual({
      kind: "supply",
      tickId: identity.id,
      amount: 0n,
      initialize: {
        tokenA: a,
        tokenB: b,
        direction: identity.direction,
        priceTick: identity.priceTick,
        durationDays: identity.durationDays,
      },
    } satisfies EconomicAction);
    expect(props.disabled).toBe(true);
  });
  it("requires selection and blocks failed or incompatible identities", () => {
    const book = readBook();
    expect(supply()).toContain("Not selected");
    supply(book.levels[1]);
    expect(mocks.flow).toHaveBeenCalledTimes(1);
    expect(mocks.flow.mock.calls[0][0].disabled).toBe(true);
    mocks.flow.mockClear();
    supply(book.levels[0], Duration.Monthly);
    supply(book.levels[0], Duration.Weekly, b);
    expect(mocks.flow).not.toHaveBeenCalled();
  });
});
