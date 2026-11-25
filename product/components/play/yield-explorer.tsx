"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Share2 } from "lucide-react";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import { PRODUCT_MARKET, type MarketConfiguration } from "@yld-cx/sdk";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Input } from "@yld-cx/ui/components/ui/input";
import { useNetwork } from "@/components/layout/providers";
import { TokenIcon } from "@/components/markets/token-icon";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { usePlayMarket, usePlayTerms } from "@/hooks/use-play-terms";
import { isNetworkSlug, marketPath } from "@/lib/registry";
import { playAddresses, playMarkets } from "@/lib/play-market";
import { fallbackToken, type TokenMetadata } from "@/lib/token-metadata";
import {
  PLAY_STRATEGIES, PLAY_CLEAR_SCENARIO, playStrategy, playOutcome,
  playFormat, playSigned, playSlider, playTarget, playDecimal, scenarioNumber,
  isRentalPlay, playSnapshotParams, type PlayStrategy, type PlayValues,
} from "@/lib/play";

type Strategy = (typeof PLAY_STRATEGIES)[number];
type Update = (patch: Record<string, string | null>, replace?: boolean) => void;

function steps(strategy: PlayStrategy, asset: string, quote: string) {
  switch (strategy) {
    case "long":
      return [`Lock ${asset} & rent ${quote} (Buy → Rent).`, `Swap ${quote} → ${asset}.`, `Swap back & repay ${quote} + Yield before maturity.`];
    case "short":
      return [`Lock ${quote} & rent ${asset} (Sell → Rent).`, `Swap ${asset} → ${quote}.`, `Buy back & repay ${asset} + Yield before maturity.`];
    case "buy-the-dip":
      return [`Select Buy → Limit and your buy price.`, `Provide ${quote}.`, "Earn Yield if rented and repaid; receive tokens if filled."];
    case "take-profit":
    case "hold-and-earn":
      return [`Select Sell → Limit and a price you accept.`, `Provide ${asset}.`, "Earn Yield if rented and repaid; receive quote tokens if filled."];
  }
}

function Scenario({ strategy, market, asset, quote, params, update }: {
  strategy: Strategy;
  market: MarketConfiguration;
  asset: TokenMetadata;
  quote: TokenMetadata;
  params: Pick<URLSearchParams, "get">;
  update: Update;
}) {
  const [shareStatus, setShareStatus] = useState("");
  const metadataRatio = Number(asset.priceUsd) / Number(quote.priceUsd);
  const metadataPrice = asset.status === "available" && quote.status === "available" &&
    !asset.stale && !quote.stale && Number.isFinite(metadataRatio) && metadataRatio > 0
    ? playDecimal(metadataRatio) : undefined;
  const live = usePlayMarket(market, metadataPrice);
  const rental = isRentalPlay(strategy.id);
  const slider = playSlider(strategy.id);
  const amount = params.get("amount") ?? "1000";
  const entry = scenarioNumber(params.get("entry") ?? "") ?? scenarioNumber(live.liveEntry ?? "");
  const target = scenarioNumber(params.get("target") ?? "") ??
    (entry === undefined ? undefined : Number(playTarget(entry, slider.initial)));
  const terms = usePlayTerms(live, strategy.id, amount, target === undefined ? "" : playDecimal(target), entry === undefined ? undefined : playDecimal(entry));
  const rawRate = params.get("rate");
  const rate = rawRate === null ? terms.rate : scenarioNumber(rawRate, true);
  const a = scenarioNumber(amount);
  const values: PlayValues | undefined = a !== undefined && entry !== undefined && target !== undefined
    ? { amount: a, entry, target, rate } : undefined;
  const outcome = values ? playOutcome(strategy.id, values) : undefined;
  const change = entry && target !== undefined ? Math.round((target / entry - 1) * 100) : slider.initial;
  const sliderValue = Math.max(slider.min, Math.min(slider.max, change));
  const marketHref = marketPath(market) + (terms.tick === undefined ? "" : `?baseTick=${terms.tick}`);
  const snapshot = params.get("entry") !== null;
  const unit = outcome?.unit === "asset" ? asset.symbol : quote.symbol;
  const previousTick = params.get("tick");
  const snapshotTick = previousTick && /^-?\\d+$/.test(previousTick) && Number.isSafeInteger(Number(previousTick)) ? Number(previousTick) : undefined;
  function changeTarget(percent: number) {
    if (entry === undefined) return;
    setShareStatus("");
    update({ entry: playDecimal(entry), target: playTarget(entry, percent), amount,
      // A new provider order price needs a new yield estimate.
      ...(rental ? { rate: rawRate === "none" ? "none" : rate === undefined ? null : playDecimal(rate) } : { rate: null, tick: null }),
    }, true);
  }
  function changeAmount(value: string) {
    setShareStatus("");
    update({ amount: value, rate: null, tick: null,
      ...(entry === undefined ? {} : { entry: playDecimal(entry) }),
      ...(target === undefined ? {} : { target: playDecimal(target) }),
    }, true);
  }
  async function share() {
    if (!values || !outcome) return;
    const query = playSnapshotParams({ network: live.network, market: market.key, strategy: strategy.id }, values, rawRate === null ? terms.tick : snapshotTick);
    const url = new URL("/play?" + query.toString(), window.location.origin);
    // Persist exactly the snapshot used by the image, even when the original URL
    // contained only defaults or the clipboard is unavailable.
    window.history.replaceState(null, "", url.pathname + url.search);
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareStatus("Link copied");
    } catch {
      setShareStatus("Copy the link from your address bar.");
    }
  }
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardContent className="space-y-5">
        <div className="flex items-center gap-3">
          <TokenIcon token={asset} size={44} />
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-2xl font-semibold">{strategy.emoji} {strategy.title} {asset.symbol}</h2>
            <p className="text-sm text-muted-foreground">{getNetwork(market.network).name} · {quote.symbol} · {PRODUCT_MARKET.duration} days</p>
          </div>
          <Button variant="outline" size="sm" onClick={share} disabled={!outcome}><Share2 size={16} /> Share</Button>
        </div>
        {shareStatus && <p role="status" className="text-xs text-muted-foreground">{shareStatus}</p>}
        <label className="block space-y-1.5">
          <span className="text-sm text-muted-foreground">{rental ? "Rented exposure" : strategy.id === "buy-the-dip" ? "Amount to provide" : "Holdings value at reference price"} · {quote.symbol}</span>
          <Input inputMode="decimal" className="tabular-nums" value={amount} maxLength={64} onChange={(event) => changeAmount(event.target.value)} />
        </label>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{snapshot ? "Scenario entry" : "Indicative reference price"}</span>
            <span className="tabular-nums">{entry === undefined ? "—" : playFormat(entry) + " " + quote.symbol}</span>
          </div>
          <label className="block space-y-3">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{rental ? "Target price" : "Your order price"}</span>
              <strong className="text-xl tabular-nums">{target === undefined ? "—" : playFormat(target) + " " + quote.symbol}</strong>
            </span>
            <input type="range" min={slider.min} max={slider.max} step={slider.step}
              value={sliderValue} disabled={entry === undefined}
              aria-label={rental ? "Target price" : "Order price"}
              aria-valuetext={target === undefined ? "Reference unavailable" : playFormat(target) + " " + quote.symbol}
              onChange={(event) => changeTarget(Number(event.target.value))}
              className="h-6 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
            />
          </label>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{slider.min}%</span>
            <span className="font-medium text-foreground">{change > 0 ? "+" : ""}{change}%</span>
            <span>+{slider.max}%</span>
          </div>
        </div>
        <div className="space-y-2 rounded-lg border bg-muted/30 p-5 text-center">
          <p className="text-sm text-muted-foreground">{outcome?.label ?? (rental ? "Potential PnL" : "Potential outcome")}</p>
          <p aria-live="polite" className={`break-words text-3xl font-semibold tabular-nums ${outcome?.value === undefined ? "" : outcome.value >= 0 ? "text-bid" : "text-ask"}`}>
            {outcome?.value === undefined ? "—" : (outcome.signed ? playSigned(outcome.value) : playFormat(outcome.value)) + " " + unit}
          </p>
          {outcome?.percent !== undefined && <p className="text-sm tabular-nums">{playSigned(outcome.percent)}% of rented exposure</p>}
          <p className="text-xs text-muted-foreground">{rental
            ? rate === undefined ? "Rental cost not included" : `Scenario full-term rental cost: ${playFormat(rate)}%`
            : strategy.id === "hold-and-earn" ? rate === undefined ? "Rental Yield unavailable" : `Assumed net term Yield: ${playFormat(rate)}%`
            : "Conditional fill · before protocol and trading fees"}</p>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p role="status">{terms.status}</p>
          {terms.collateral && <p>Current quote · lock {terms.collateral}</p>}
          {snapshot && terms.rate !== undefined && rental && <p>Current full-term rental cost: {playFormat(terms.rate)}%</p>}
          {snapshot && live.liveEntry && <p>Current reference: {playFormat(Number(live.liveEntry))} {quote.symbol}</p>}
          {snapshot && <button type="button" className="text-primary underline underline-offset-4" onClick={() => update({ entry: null, rate: null, tick: null }, true)}>Use current terms</button>}
          {entry === undefined && !live.referencePending && <p>Reference price unavailable. Open the market to check current prices.</p>}
        </div>
        {strategy.id === "hold-and-earn" && <p className="text-xs text-muted-foreground">Distant prices may reduce the chance of a fill, but also rental demand. Yield assumes the supplied amount is rented and repaid; actual allocation varies.</p>}
        <div className="space-y-2 border-t pt-4">
          <h3 className="font-semibold">How it works</h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {steps(strategy.id, asset.symbol, quote.symbol).map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
        <Button className="w-full" render={<Link href={marketHref} />} nativeButton={false}>Open Yield Market <ArrowRight size={16} /></Button>
        <p className="text-xs text-muted-foreground">{rental ? "Hypothetical incremental PnL, assuming repayment. Locked tokens are forfeited if not repaid by maturity." : "Yield and fills are not guaranteed. Provided tokens may be exchanged."} Excludes swap fees, slippage and gas. Not a forecast or executable quote.</p>
      </CardContent>
    </Card>
  );
}

export function YieldExplorer() {
  const params = useSearchParams();
  const { network: savedNetwork } = useNetwork();
  const requestedNetwork = params.get("network");
  const network = requestedNetwork && isNetworkSlug(requestedNetwork) ? requestedNetwork : savedNetwork;
  const id = getNetwork(network).id;
  const markets = playMarkets(network);
  const strategy = playStrategy(params.get("strategy"));
  const market = markets.find((m) => m.key === params.get("market"));
  const visibleMarkets = market && strategy ? [market] : strategy ? markets : [];
  const addresses = visibleMarkets.flatMap((m) => [m.token0.address, m.token1.address]);
  const metadata = useTokenMetadata(network, addresses);
  const token = (address: string) => metadata.find((item) => item.address === address) ?? fallbackToken(id, address);
  const marketTokens = (m: MarketConfiguration) => {
    const [asset, quote] = playAddresses(m);
    return [token(asset), token(quote)] as const;
  };
  const update: Update = (patch, replace = false) => {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries({ network, ...patch })) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const url = "/play" + (next.size ? "?" + next.toString() : "");
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  };
  return (
    <>
      <section className="py-8 text-center md:py-10">
        <h1 className="text-4xl font-semibold tracking-tight">👑 Yield Explorer</h1>
        <p className="mt-2 text-muted-foreground">Play your way.</p>
      </section>
      {strategy && <div className="mx-auto mb-4 flex max-w-xl items-center justify-between gap-2">
        <Button variant="ghost" onClick={() => update(market ? { market: null, ...PLAY_CLEAR_SCENARIO } : { strategy: null, market: null, ...PLAY_CLEAR_SCENARIO })}><ArrowLeft size={16} /> {market ? "Markets" : "Strategies"}</Button>
        <span className="text-xs text-muted-foreground">{getNetwork(network).name}</span>
      </div>}
      {!strategy ? (
        <Card className="mx-auto max-w-xl gap-0 py-0">
          <CardContent className="divide-y p-0">
            {PLAY_STRATEGIES.map((item) => (
              <button key={item.id} type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40 focus-visible:outline-ring" onClick={() => update({ strategy: item.id, market: market?.key ?? null, ...PLAY_CLEAR_SCENARIO })}>
                <span className="text-2xl" aria-hidden="true">{item.emoji}</span>
                <span className="min-w-0 flex-1"><strong className="block">{item.title}</strong><small className="text-muted-foreground">{item.description}</small></span>
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            ))}
          </CardContent>
        </Card>
      ) : !market ? (
        <Card className="mx-auto max-w-xl">
          <CardContent className="space-y-3">
            <h2 className="text-lg font-semibold">{strategy.emoji} {strategy.title} · Choose a token</h2>
            {markets.length === 0 && <p className="text-sm text-muted-foreground">No supported quote markets on this network.</p>}
            <div className="divide-y">
              {markets.map((m) => {
                const [asset, quote] = marketTokens(m);
                return <button key={m.key} type="button" className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/40" onClick={() => update({ market: m.key, ...PLAY_CLEAR_SCENARIO })}><TokenIcon token={asset} /><span className="min-w-0 flex-1 break-all">{asset.symbol} / {quote.symbol}</span><ArrowRight size={16} aria-hidden="true" /></button>;
              })}
            </div>
            <p className="text-xs text-muted-foreground">Strategy templates. Rental availability is checked in the Yield Market.</p>
          </CardContent>
        </Card>
      ) : (
        <Scenario key={network + "/" + market.key + "/" + strategy.id} strategy={strategy} market={market} asset={marketTokens(market)[0]} quote={marketTokens(market)[1]} params={params} update={update} />
      )}
    </>
  );
}
