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
import { YieldBook } from "@/components/markets/yield-book";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  discover: vi.fn(),
  flow: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
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
function readBook(data: DiscoveryResult | null = result, error?: Error) {
  mocks.query.mockReturnValue({
    data: data ?? undefined,
    isError: !!error,
    error,
    isFetching: false,
    refetch: vi.fn(),
  });
  let book!: ReturnType<typeof useYieldBook>;
  function Harness() {
    book = useYieldBook(market, pairId);
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
      pairExists
    />,
  );
}
beforeEach(() => vi.clearAllMocks());

describe("configured Yield Book", () => {
  it("discovers the entire shared grid with active ticks refreshed every 15 seconds", async () => {
    const book = readBook();
    const options = mocks.query.mock.calls[0][0];
    expect(options.refetchInterval).toBe(QUERY_TIMING.liveRefresh);
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
  it("renders confirmed missing ticks as zero and failed reads as unavailable", () => {
    const book = readBook();
    const html = renderToStaticMarkup(
      <YieldBook
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
    expect(html).not.toContain("Load more price levels");
    expect(html).not.toContain("Exact Tick ID");
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

describe("selected price Supply", () => {
  it.each([0, 1] as const)(
    "creates a missing direction %s Tick from its exact identity without onchain state",
    async (direction) => {
      const level = readBook().levels.find(
        (level) =>
          level.status === "missing" &&
          level.direction === direction &&
          level.durationDays === Duration.Monthly,
      )!;
      const html = supply(level);
      expect(html).toContain("Selected price");
      expect(html).not.toContain("Posted price");
      expect(mocks.flow).toHaveBeenCalledTimes(1);
      const props = mocks.flow.mock.calls[0][0];
      expect(props.label).toBe("Create Tick");
      expect(await props.prepare()).toEqual({
        kind: "createTick",
        pairId: level.pairId,
        direction: level.direction,
        priceTick: level.priceTick,
        durationDays: level.durationDays,
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
    } satisfies EconomicAction);
    expect(props.disabled).toBe(true);
  });
  it("requires selection and blocks failed or incompatible identities", () => {
    const book = readBook();
    expect(supply()).toContain("Select a price level in the Yield Book");
    supply(book.levels[1]);
    supply(book.levels[0], Duration.Monthly);
    supply(book.levels[0], Duration.Weekly, b);
    expect(mocks.flow).not.toHaveBeenCalled();
  });
});
