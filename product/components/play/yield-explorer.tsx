"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Share2 } from "lucide-react";
import { getNetwork } from "@yld-cx/sdk/ethereum";
import type { MarketConfiguration } from "@yld-cx/sdk";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Input } from "@yld-cx/ui/components/ui/input";
import { useNetwork } from "@/components/layout/providers";
import { TokenIcon } from "@/components/markets/token-icon";
import { useTokenMetadata } from "@/hooks/use-token-metadata";
import { isNetworkSlug, marketPath, registry } from "@/lib/registry";
import { USD_ADDRESSES } from "@/lib/trending-markets";
import { fallbackToken, type TokenMetadata } from "@/lib/token-metadata";
import { PLAY_STRATEGIES, playStrategy, playScenario, scenarioNumber, type PlayStrategy } from "@/lib/play";

type Strategy = (typeof PLAY_STRATEGIES)[number];
type Update = (patch: Record<string, string | null>, replace?: boolean) => void;
const numberFormat = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 });
const format = (value: number) => numberFormat.format(value);
const signed = (value: number) => (value > 0 ? "+" : value < 0 ? "−" : "") + format(Math.abs(value));
const scenarioKeys = ["amount", "entry", "target", "order", "rate"] as const;
const clearScenario = Object.fromEntries(scenarioKeys.map((key) => [key, null]));

function steps(strategy: PlayStrategy, asset: string, quote: string) {
  switch (strategy) {
    case "long":
      return [`Choose Buy → Rent; lock ${asset} and rent ${quote}.`, `Swap ${quote} for ${asset}.`, `Swap back and repay ${quote} + Yield before maturity.`];
    case "short":
      return [`Choose Sell → Rent; lock ${quote} and rent ${asset}.`, `Swap ${asset} for ${quote}.`, `Buy back and repay ${asset} + Yield before maturity.`];
    case "buy-the-dip":
      return [`Choose Buy → Limit.`, `Select your buy price and provide ${quote}.`, "Earn Yield if a rental is repaid; tokens may exchange if filled."];
    case "take-profit":
    case "hold-and-earn":
      return [`Choose Sell → Limit.`, `Select a price you would accept and provide ${asset}.`, "Earn Yield if a rental is repaid; tokens may exchange if filled."];
  }
}

function Field({ label, value, onChange, suffix }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2">
        <Input className="min-w-0 tabular-nums" inputMode="decimal" value={value} maxLength={64} onChange={(event) => onChange(event.target.value)} />
        {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
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
  const assetPrice = Number(asset.priceUsd);
  const quotePrice = Number(quote.priceUsd);
  const ratio = assetPrice / quotePrice;
  const indicative = asset.status === "available" && quote.status === "available" &&
    !asset.stale && !quote.stale && Number.isFinite(ratio) && ratio > 0
    ? ratio.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 8 })
    : "";
  const amount = params.get("amount") ?? "1000";
  const entry = params.get("entry") ?? indicative;
  const target = params.get("target") ?? entry;
  const order = params.get("order") ?? entry;
  const rate = params.get("rate") ?? "";
  const a = scenarioNumber(amount);
  const e = scenarioNumber(entry);
  const t = scenarioNumber(target, true);
  const o = scenarioNumber(order);
  const r = scenarioNumber(rate, true);
  const rental = strategy.id === "long" || strategy.id === "short";
  const hold = strategy.id === "hold-and-earn";
  const result = a !== undefined && e !== undefined && t !== undefined &&
    (rental || o !== undefined) && (rate === "" || r !== undefined)
      ? playScenario({ strategy: strategy.id, amount: a, entry: e, target: t, order: rental ? e : o!, rate: r })
      : undefined;
  const values = { amount, entry, target, order, rate };
  function change(key: keyof typeof values, value: string) {
    setShareStatus("");
    const snapshot = Object.fromEntries(Object.entries(values).filter(([, current]) => current !== ""));
    update({ ...snapshot, [key]: value }, true);
  }
  async function share() {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareStatus("Link copied");
    } catch {
      setShareStatus("Copy the URL from your address bar.");
      update(values, true);
    }
  }
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardContent className="space-y-5">
        <div className="flex items-center gap-3">
          <TokenIcon token={asset} size={44} />
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold">{strategy.emoji} {strategy.title} {asset.symbol}</h2>
            <p className="text-sm text-muted-foreground">{getNetwork(market.network).name} · {quote.symbol} · 7 days</p>
          </div>
          <Button variant="outline" size="sm" onClick={share}><Share2 size={16} /> Share</Button>
        </div>
        {shareStatus && <p role="status" className="text-xs text-muted-foreground">{shareStatus}</p>}
        <p className="text-xs text-muted-foreground">Hypothetical scenario · not a live quote</p>
        <Field label={rental ? "Rented exposure" : "Position value at entry"} value={amount} onChange={(v) => change("amount", v)} suffix={quote.symbol} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Entry price" value={entry} onChange={(v) => change("entry", v)} suffix={quote.symbol} />
          <Field label="Target price" value={target} onChange={(v) => change("target", v)} suffix={quote.symbol} />
        </div>
        {!rental && <Field label="Your order price" value={order} onChange={(v) => change("order", v)} suffix={quote.symbol} />}
        <Field label={rental ? "7-day rental cost (optional)" : "Net rental Yield if repaid (optional)"} value={rate} onChange={(v) => change("rate", v)} suffix="%" />
        <div className="space-y-2 rounded-lg border bg-muted/30 p-5 text-center">
          <p className="text-sm text-muted-foreground">{hold ? "Potential Yield if repaid" : rental ? (rate === "" ? "Potential PnL before rental cost" : "Potential PnL") : "Potential PnL if filled"}</p>
          {(() => {
            const value = hold ? result?.income : result?.pnl;
            return <p aria-live="polite" className={`text-3xl font-semibold tabular-nums ${value === undefined ? "" : value >= 0 ? "text-bid" : "text-ask"}`}>{value === undefined ? "—" : signed(value) + " " + quote.symbol}</p>;
          })()}
          {!rental && result?.income !== undefined && !hold && <p className="text-xs text-muted-foreground">If rented and repaid instead: {format(result.income)} {quote.symbol} potential Yield</p>}
          {hold && result && <p className="text-xs text-muted-foreground">If filled instead: {signed(result.pnl)} {quote.symbol} vs holding</p>}
          <p className="text-xs text-muted-foreground">{rental ? "Incremental return on rented exposure; assumes repayment." : "Compared with holding the supplied token; fill and repayment are separate scenarios."}</p>
        </div>
        {hold && <p className="text-xs text-muted-foreground">A distant sell price may reduce fill likelihood, but may also attract less rental demand.</p>}
        <div className="space-y-2 border-t pt-4">
          <h3 className="font-semibold">How it works</h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            {steps(strategy.id, asset.symbol, quote.symbol).map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
        <Button className="w-full" render={<Link href={marketPath(market)} />} nativeButton={false}>Open Yield Market <ArrowRight size={16} /></Button>
        <p className="text-xs text-muted-foreground">{rental ? "Availability and actual rental costs must be checked in the market. Locked tokens are forfeited if not repaid by maturity." : "Yield and fills are not guaranteed. Provided tokens may be exchanged."} Excludes swap fees, slippage and gas. Not a forecast.</p>
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
  const quoteAddress = USD_ADDRESSES[id]?.toLowerCase();
  const markets = registry.getMarkets(id).filter((m) => quoteAddress && [m.token0.address, m.token1.address].includes(quoteAddress));
  const strategy = playStrategy(params.get("strategy"));
  const market = markets.find((m) => m.key === params.get("market"));
  const visibleMarkets = market && strategy ? [market] : strategy ? markets : [];
  const addresses = visibleMarkets.flatMap((m) => [m.token0.address, m.token1.address]);
  const metadata = useTokenMetadata(network, addresses);
  const token = (address: string) => metadata.find((item) => item.address === address) ?? fallbackToken(id, address);
  const marketTokens = (m: MarketConfiguration) => {
    const [a, b] = [m.token0.address, m.token1.address];
    return a === quoteAddress ? [token(b), token(a)] as const : [token(a), token(b)] as const;
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
        <Button variant="ghost" onClick={() => update(market ? { market: null, ...clearScenario } : { strategy: null, market: null, ...clearScenario })}><ArrowLeft size={16} /> {market ? "Markets" : "Strategies"}</Button>
        <span className="text-xs text-muted-foreground">{getNetwork(network).name}</span>
      </div>}
      {!strategy ? (
        <Card className="mx-auto max-w-xl gap-0 py-0">
          <CardContent className="divide-y p-0">
            {PLAY_STRATEGIES.map((item) => (
              <button key={item.id} type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40 focus-visible:outline-ring" onClick={() => update({ strategy: item.id, market: null, ...clearScenario })}>
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
                return <button key={m.key} type="button" className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/40" onClick={() => update({ market: m.key, ...clearScenario })}><TokenIcon token={asset} /><span className="min-w-0 flex-1 break-all">{asset.symbol} / {quote.symbol}</span><ArrowRight size={16} aria-hidden="true" /></button>;
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
