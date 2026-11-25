import { describe, expect, it } from "vitest";
import { PRODUCT_MARKET, type Token } from "@yld-cx/sdk";
import { priceAtTick } from "@yld-cx/sdk/ethereum";
import { tickPrice } from "@/lib/market-values";
import { playTickSlider } from "@/lib/play-market";
import {
  PlayStrategy,
  decodePlayStrategy,
  encodePlayStrategy,
  orientPlayPrice,
  playDefaultAmount,
  playFieldUnits,
  playPath,
  playStrategy,
  scenarioNumber,
  playOutcome,
  readPlayPath,
  readPlayValues,
} from "@/lib/play";

const base = { amount: 1000, entry: 100, target: 110, rate: 1 };

describe("Yield Explorer scenario", () => {
  it("uses quote-denominated rental cost for longs", () => {
    expect(playOutcome(PlayStrategy.Long, base)?.value).toBeCloseTo(90);
    expect(
      playOutcome(PlayStrategy.Long, { ...base, target: 90 })?.value,
    ).toBeCloseTo(-110);
  });
  it("uses asset-denominated repayment cost for shorts", () => {
    const short = { ...base, amount: 10 };
    expect(
      playOutcome(PlayStrategy.Short, { ...short, target: 90 })?.value,
    ).toBeCloseTo(91);
    expect(playOutcome(PlayStrategy.Short, short)?.value).toBeCloseTo(-111);
  });
  it("validates user-supplied values and strategy names", () => {
    expect(playStrategy("long")?.id).toBe(PlayStrategy.Long);
    expect(playStrategy("unknown")).toBeUndefined();
    expect(scenarioNumber("1.25")).toBe(1.25);
    expect(scenarioNumber("0", true)).toBe(0);
    for (const value of ["", "-1", "NaN", "Infinity", "1e2", "0"])
      expect(scenarioNumber(value)).toBeUndefined();
    expect(
      playOutcome(PlayStrategy.Long, { ...base, entry: 0 }),
    ).toBeUndefined();
  });
});

describe("Slider and shareable scenario", () => {
  const selection = {
    id: PlayStrategy.Long,
    token: "0x4200000000000000000000000000000000000006",
  };
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
    const strategy = encodePlayStrategy({
      ...selection,
      id: PlayStrategy.HoldAndEarn,
      entry: "249.3296839",
      target: "2742.626523",
    });
    expect(decodePlayStrategy(strategy)?.target).toBe("498.6593678");
  });
  it("defaults to the amount worth 1,000 quote tokens when an entry price is available", () => {
    expect(playDefaultAmount({ id: PlayStrategy.Long })).toBe("1000");
    expect(playDefaultAmount({ id: PlayStrategy.Short })).toBeUndefined();
    expect(playDefaultAmount({ id: PlayStrategy.Short, entry: "250" })).toBe(
      "4",
    );
    expect(
      playDefaultAmount({ id: PlayStrategy.Short, entry: "0.00000000001" }),
    ).toBe("100000000000000");
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
  it("round trips a scenario with an exact market tick", () => {
    const settings = {
      ...selection,
      amount: "1000",
      entry: "10",
      target: "14.7651257629",
      targetTick: -249400,
      rate: "0.5",
    };
    const strategy = encodePlayStrategy(settings);
    const path = playPath("base", strategy);
    expect(path).toMatch(/^\/play\/base\/[\w-]+$/);
    const route = readPlayPath(path);
    expect(route?.network).toBe("base");
    const decoded = decodePlayStrategy(route?.strategy)!;
    expect(decoded).toEqual(settings);
    expect(readPlayValues(decoded)).toEqual({
      amount: 1000,
      entry: 10,
      target: 14.7651257629,
      rate: 0.5,
    });
  });
  it("defaults rentals and providers to their minimum seven-day rates", () => {
    const settings = {
      ...selection,
      amount: "1000",
      entry: "100",
      target: "110",
    };
    expect(readPlayValues(settings)?.rate).toBe(0.07);
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
      }),
    ).toMatchObject({ label: "Potential tokens", value: 12.5 });
    expect(
      playOutcome(PlayStrategy.TakeProfit, {
        amount: 10,
        entry: 100,
        target: 120,
      }),
    ).toMatchObject({ label: "Potential tokens", value: 1200 });
    expect(
      playOutcome(PlayStrategy.HoldAndEarn, {
        amount: 10,
        entry: 100,
        target: 200,
        rate: 1,
      }),
    ).toMatchObject({ label: "Potential Yield", value: 0.1 });
    expect(
      playOutcome(PlayStrategy.HoldAndEarn, { ...base, rate: undefined })
        ?.value,
    ).toBeUndefined();
  });
  it("uses the saved quote price in Use Liquidity links", () => {
    const strategy = encodePlayStrategy({
      ...selection,
      id: PlayStrategy.UseLiquidity,
      amount: "1000",
      entry: "0.1",
      rentSelectedToken: false,
    });
    const decoded = decodePlayStrategy(strategy)!;
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
      decodePlayStrategy(encodePlayStrategy({ ...settings, token: "invalid" })),
    ).toBeUndefined();
  });
});
