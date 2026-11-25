import { describe, expect, it } from "vitest";
import { PRODUCT_MARKET, type Token } from "@yld-cx/sdk";
import { priceAtTick } from "@yld-cx/sdk/ethereum";
import { tickPrice } from "@/lib/market-values";
import { playTickSlider } from "@/lib/play-market";
import {
  PlayStrategy,
  decodePlayStrategy,
  orientPlayPrice,
  playDefaultAmount,
  playFieldUnits,
  playParams,
  playScenario,
  playStrategy,
  scenarioNumber,
  playSlider,
  playTarget,
  playOutcome,
  readPlayValues,
} from "@/lib/play";

const base = { amount: 1000, entry: 100, target: 110, order: 100, rate: 1 };

describe("Yield Explorer scenario", () => {
  it("uses quote-denominated rental cost for longs", () => {
    expect(
      playScenario({ ...base, strategy: PlayStrategy.Long })?.pnl,
    ).toBeCloseTo(90);
    expect(
      playScenario({ ...base, strategy: PlayStrategy.Long, target: 90 })?.pnl,
    ).toBeCloseTo(-110);
  });
  it("uses asset-denominated repayment cost for shorts", () => {
    const short = {
      ...base,
      strategy: PlayStrategy.Short,
      amount: 10,
    } as const;
    expect(playScenario({ ...short, target: 90 })?.pnl).toBeCloseTo(91);
    expect(playScenario(short)?.pnl).toBeCloseTo(-111);
  });
  it("separates conditional fills from rental income", () => {
    const buy = playScenario({
      ...base,
      strategy: PlayStrategy.BuyTheDip,
      order: 90,
    });
    expect(buy?.pnl).toBeCloseTo(222.222222);
    expect(buy?.income).toBeCloseTo(10);
    const sell = playScenario({
      ...base,
      strategy: PlayStrategy.TakeProfit,
      amount: 10,
      order: 120,
    });
    expect(sell?.pnl).toBeCloseTo(100);
    expect(sell?.income).toBeCloseTo(11);
    const hold = playScenario({
      ...base,
      strategy: PlayStrategy.HoldAndEarn,
      amount: 10,
      order: 200,
      target: 250,
    });
    expect(hold?.pnl).toBeCloseTo(-500);
    expect(hold?.income).toBeCloseTo(25);
  });
  it("does not imply a rental rate when none was supplied", () => {
    expect(
      playScenario({
        ...base,
        strategy: PlayStrategy.HoldAndEarn,
        rate: undefined,
      })?.income,
    ).toBeUndefined();
  });
  it("validates user-supplied values and strategy names", () => {
    expect(playStrategy("long")?.id).toBe(PlayStrategy.Long);
    expect(playStrategy("unknown")).toBeUndefined();
    expect(scenarioNumber("1.25")).toBe(1.25);
    expect(scenarioNumber("0", true)).toBe(0);
    for (const value of ["", "-1", "NaN", "Infinity", "1e2", "0"])
      expect(scenarioNumber(value)).toBeUndefined();
    expect(
      playScenario({ ...base, strategy: PlayStrategy.Long, entry: 0 }),
    ).toBeUndefined();
  });
});

describe("Slider and shareable scenario", () => {
  const selection = {
    id: PlayStrategy.Long,
    token: "0x4200000000000000000000000000000000000006",
  };
  it("derives absolute target prices, including small token prices", () => {
    expect(playTarget(1700, 10)).toBe("1870");
    expect(playTarget(0.00000000001, 10)).toBe("0.000000000011");
    expect(playSlider(PlayStrategy.BuyTheDip)?.max).toBe(0);
    const holdSlider = playSlider(PlayStrategy.HoldAndEarn)!;
    expect(holdSlider).toMatchObject({ min: 0, max: 100, initial: 100 });
  });
  it.each([PlayStrategy.BuyTheDip, PlayStrategy.TakeProfit])(
    "uses the Yield Book grid for %s when the displayed asset is token1",
    (id) => {
      const common = { network: "eip155:8453", listed: true } as const;
      const asset = {
        ...common,
        address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        symbol: "cbBTC",
        name: "Coinbase Wrapped Bitcoin",
        decimals: 8,
      } as const satisfies Token;
      const quote = {
        ...common,
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      } as const satisfies Token;
      const slider = playTickSlider({ id }, 60000, asset, quote)!;
      expect(slider.step).toBe(PRODUCT_MARKET.stepTicks);
      const next = slider.value + slider.step;
      expect(slider.canonicalTick(next)).toBe(-next);

      const bid = id === PlayStrategy.BuyTheDip;
      expect(slider.priceAt(next)).toBe(
        tickPrice(
          {
            asset: bid ? quote.address : asset.address,
            priceX128: priceAtTick(bid ? -next : next),
          },
          [asset, quote],
        ),
      );
    },
  );
  it("caps saved Hold & Earn order prices at double the entry price", () => {
    const params = playParams("base", {
      ...selection,
      id: PlayStrategy.HoldAndEarn,
      entry: "249.3296839",
      target: "2742.626523",
    });
    expect(decodePlayStrategy(params.get("strategy"))?.target).toBe(
      "498.6593678",
    );
  });
  it("defaults to the amount worth 1,000 quote tokens when an entry price is available", () => {
    expect(playDefaultAmount({ id: PlayStrategy.Long })).toBe("1000");
    expect(playDefaultAmount({ id: PlayStrategy.Short })).toBeUndefined();
    expect(playDefaultAmount({ id: PlayStrategy.Short, entry: "250" })).toBe(
      "4",
    );
    expect(
      playDefaultAmount({ id: PlayStrategy.UseLiquidity, entry: "0.004" }),
    ).toBe("1000");
    expect(
      playDefaultAmount({
        id: PlayStrategy.UseLiquidity,
        rentSelectedToken: true,
        entry: "250",
      }),
    ).toBe("4");
    const settings = {
      ...selection,
      id: PlayStrategy.TakeProfit,
      entry: "250",
      target: "300",
    };
    expect(readPlayValues(settings)?.amount).toBe(4);
    expect(readPlayValues({ ...settings, amount: "1" })?.amount).toBe(1);
    expect(readPlayValues({ ...settings, amount: "" })).toBeUndefined();
  });
  it("round trips the scenario and reproduces its outcome", () => {
    const values = { amount: 1000, entry: 1700, target: 1870, rate: 0.5 };
    const settings = {
      ...selection,
      amount: "1000",
      entry: "1700",
      target: "1870",
      rate: "0.5",
    };
    const params = playParams("base", settings);
    expect([...params.keys()]).toEqual(["network", "strategy"]);
    expect(params.get("strategy")).toMatch(/^[\w-]+$/);
    const decoded = decodePlayStrategy(params.get("strategy"))!;
    expect(decoded).toEqual(settings);
    expect(readPlayValues(decoded)).toEqual(values);
    expect(
      playOutcome(PlayStrategy.Long, readPlayValues(decoded)!)?.value,
    ).toBeCloseTo(95);
    expect(
      playParams("base", { ...settings, target: "1800" }).toString(),
    ).not.toBe(params.toString());
  });
  it("defaults rentals and providers to their minimum seven-day rates", () => {
    const settings = {
      ...selection,
      amount: "1000",
      entry: "100",
      target: "110",
    };
    const params = playParams("base", settings);
    const values = readPlayValues(decodePlayStrategy(params.get("strategy"))!)!;
    expect(values.rate).toBe(0.07);
    expect(readPlayValues({ ...settings, id: PlayStrategy.Short })?.rate).toBe(
      0.07,
    );
    expect(
      readPlayValues({ ...settings, id: PlayStrategy.HoldAndEarn })?.rate,
    ).toBe(0.0693);
    expect(
      readPlayValues({
        ...settings,
        id: PlayStrategy.HoldAndEarn,
        rate: "0.25",
      })?.rate,
    ).toBe(0.25);
    const cleared = readPlayValues({ ...settings, rate: "" })!;
    expect(cleared.rate).toBeUndefined();
    expect(playOutcome(PlayStrategy.Long, cleared)?.label).toBe(
      "Potential PnL before rental cost",
    );
    expect(readPlayValues({ ...settings, rate: "0" })?.rate).toBe(0);
  });
  it("returns conditional fill amounts or conditional rental income", () => {
    expect(
      playOutcome(PlayStrategy.BuyTheDip, {
        amount: 1000,
        entry: 100,
        target: 80,
      })?.value,
    ).toBe(12.5);
    expect(
      playOutcome(PlayStrategy.TakeProfit, {
        amount: 10,
        entry: 100,
        target: 120,
      })?.value,
    ).toBe(1200);
    expect(
      playOutcome(PlayStrategy.HoldAndEarn, {
        amount: 10,
        entry: 100,
        target: 200,
        rate: 1,
      })?.value,
    ).toBe(0.1);
  });
  it("uses the saved quote price in Use Liquidity links", () => {
    const params = playParams("base", {
      ...selection,
      id: PlayStrategy.UseLiquidity,
      amount: "1000",
      entry: "0.1",
      rentSelectedToken: false,
    });
    const decoded = decodePlayStrategy(params.get("strategy"))!;
    const previousLink = Buffer.from(
      JSON.stringify({ ...decoded, id: "access-liquidity" }),
    ).toString("base64url");
    expect(decodePlayStrategy(previousLink)).toEqual(decoded);
    expect(decoded).toMatchObject({ rentSelectedToken: false, entry: "0.1" });
    expect(orientPlayPrice(decoded, decoded.entry)).toBe("10");
    expect(orientPlayPrice(decoded, "20")).toBe("0.05");
    expect(playFieldUnits(decoded, "USDC", "AMZNc")).toEqual({
      amount: "USDC",
      entry: "USDC",
    });
    const values = readPlayValues(decoded)!;
    expect(values.rate).toBe(0.07);
    expect(playOutcome(decoded.id, values)).toMatchObject({
      label: "Full-term repayment",
      value: 1000.7,
      unit: "asset",
      quotePrincipal: 100,
    });
  });
  it.each([
    [PlayStrategy.Long, "USDC", "USDC", "quote"],
    [PlayStrategy.Short, "AMZNc", "USDC", "quote"],
    [PlayStrategy.BuyTheDip, "USDC", "USDC", "asset"],
    [PlayStrategy.TakeProfit, "AMZNc", "USDC", "quote"],
    [PlayStrategy.HoldAndEarn, "AMZNc", "USDC", "asset"],
    [PlayStrategy.UseLiquidity, "AMZNc", "USDC", "asset"],
  ] as const)(
    "uses the correct input and result units for %s",
    (id, amount, entry, unit) => {
      expect(
        playFieldUnits({ id, rentSelectedToken: true }, "AMZNc", "USDC"),
      ).toEqual({ amount, entry });
      expect(
        playOutcome(id, { amount: 10, entry: 100, target: 110, rate: 1 })?.unit,
      ).toBe(unit);
    },
  );
  it.each([
    { id: PlayStrategy.Short, target: "90", outcome: 91, unit: "quote" },
    {
      id: PlayStrategy.TakeProfit,
      target: "120",
      outcome: 1200,
      unit: "quote",
    },
    {
      id: PlayStrategy.HoldAndEarn,
      target: "200",
      outcome: 0.1,
      unit: "asset",
    },
  ] as const)(
    "uses the saved token quantity and result for $id",
    ({ id, target, outcome, unit }) => {
      const settings = {
        ...selection,
        id,
        amount: "10",
        entry: "100",
        target,
        rate: "1",
      };
      const query = playParams("base", settings);
      const decoded = decodePlayStrategy(query.get("strategy"))!;
      const values = readPlayValues(decoded)!;
      expect(values.amount).toBe(10);
      const result = playOutcome(decoded.id, values);
      expect(result?.value).toBeCloseTo(outcome);
      expect(result?.unit).toBe(unit);
    },
  );
  it("rejects invalid snapshots", () => {
    const settings = {
      ...selection,
      amount: "1000",
      entry: "100",
      target: "110",
    };
    expect(readPlayValues({ ...settings, target: "0" })).toBeUndefined();
    expect(readPlayValues({ ...settings, rate: "NaN" })).toBeUndefined();
    expect(decodePlayStrategy("malformed!")).toBeUndefined();
    expect(
      decodePlayStrategy(
        playParams("base", { ...settings, token: "invalid" }).get("strategy"),
      ),
    ).toBeUndefined();
  });
});
