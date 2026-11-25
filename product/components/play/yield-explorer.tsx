"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronDown,
  Droplets,
  Hourglass,
  Share2,
} from "lucide-react";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { MarketConfiguration } from "@yld-cx/sdk";
import { zeroAddress } from "viem";
import { Button, buttonVariants } from "@yld-cx/ui/components/ui/button";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Input } from "@yld-cx/ui/components/ui/input";
import { Skeleton } from "@yld-cx/ui/components/ui/skeleton";
import { AmountInput } from "@/components/forms/financial-fields";
import { useNetwork } from "@/components/layout/providers";
import { TokenIcon } from "@/components/markets/token-icon";
import { useTokens } from "@/hooks/use-market";
import {
  useTokenDiscovery,
  useTokenMetadata,
} from "@/hooks/use-token-metadata";
import { marketPath } from "@/lib/registry";
import { priceText } from "@/lib/market-values";
import { playAddresses, playMarket, playTickSlider } from "@/lib/play-market";
import { fallbackToken, type TokenMetadata } from "@/lib/token-metadata";
import { USD_ADDRESSES } from "@/lib/trending-markets";
import { PLAY_STRATEGY_PROMPT, StrategyList } from "./strategy-list";
import {
  PlayStepAction,
  PlayStrategy,
  decodePlayStrategy,
  encodePlayStrategy,
  invertPlayPrice,
  orientPlayPrice,
  playDefaultAmount,
  playFieldLabels,
  playFieldUnits,
  playInput,
  playOutcome,
  playOutcomeText,
  playPageTitle,
  playPath,
  playPriceText,
  playQuoteText,
  playRateInput,
  playSigned,
  playStrategy,
  playTarget,
  readPlayPath,
  readPlayValues,
  scenarioNumber,
  type PlaySettings,
  type PlayStrategyConfig,
} from "@/lib/play";

const stepActions = {
  [PlayStepAction.Limit]: { icon: Droplets, intent: "limit" },
  [PlayStepAction.Swap]: { icon: ArrowLeftRight, intent: "swap" },
  [PlayStepAction.Rent]: { icon: Hourglass, intent: "rent" },
};

function setPageTitle(description?: string) {
  document.title = `${playPageTitle(description)} | yld.cx`;
}

function writePlayUrl(
  network: NetworkSlug,
  settings?: PlaySettings,
  replace = false,
) {
  const url = new URL(
    playPath(network, settings && encodePlayStrategy(settings)),
    window.location.origin,
  );
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  return url.href;
}

function TokenPicker({
  network,
  strategy,
}: {
  network: NetworkSlug;
  strategy: PlayStrategyConfig;
}) {
  const quote = USD_ADDRESSES[getNetwork(network).id]?.toLowerCase();
  const discovery = useTokenDiscovery(network, !!quote);
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const tokens = (discovery.data ?? []).filter(
    (token) =>
      token.address !== quote &&
      token.address !== zeroAddress &&
      [token.symbol, token.name, token.address].some((value) =>
        value.toLowerCase().includes(term),
      ),
  );
  const status = !quote
    ? "Trending tokens are unavailable on this network."
    : discovery.isError && !discovery.data
      ? "Couldn’t load trending tokens."
      : term
        ? "No matching tokens."
        : "No trending tokens available.";

  return (
    <Card>
      <CardContent className="space-y-3">
        <h2 className="text-lg font-semibold">
          {strategy.title} · Choose a token
        </h2>
        <Input
          type="search"
          aria-label="Search trending tokens"
          placeholder="Search trending tokens"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {quote && discovery.isPending ? (
          <div role="status">
            <span className="sr-only">Loading trending tokens</span>
            <ul aria-hidden="true" className="divide-y">
              {Array.from({ length: 5 }, (_, index) => (
                <li key={index} className="flex items-center gap-3 p-2">
                  <Skeleton className="size-[34px] shrink-0 rounded-full motion-reduce:animate-none" />
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-16 motion-reduce:animate-none" />
                    <Skeleton className="h-4 w-28 motion-reduce:animate-none" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : tokens.length ? (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {tokens.map((token) => (
              <li key={token.address}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-muted/40 focus-visible:outline-ring"
                  onClick={() =>
                    writePlayUrl(network, {
                      id: strategy.id,
                      token: token.address,
                      rentSelectedToken:
                        strategy.id === PlayStrategy.UseLiquidity
                          ? false
                          : undefined,
                      amount: playDefaultAmount({ id: strategy.id }),
                      rate: playRateInput({ id: strategy.id }),
                    })
                  }
                >
                  <TokenIcon token={token} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {token.symbol}
                    </span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {token.name}
                    </span>
                  </span>
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="py-2 text-sm text-muted-foreground">
            {status}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function referencePrice(asset?: TokenMetadata, quote?: TokenMetadata) {
  if (
    asset?.status !== "available" ||
    quote?.status !== "available" ||
    asset.stale ||
    quote.stale
  )
    return;
  const ratio = Number(asset.priceUsd) / Number(quote.priceUsd);
  const price = playTarget(ratio, 0);
  if (scenarioNumber(price) !== undefined) return price;
}

function Simulation({
  network,
  strategy,
  market,
  settings,
}: {
  network: NetworkSlug;
  strategy: PlayStrategyConfig;
  market: MarketConfiguration;
  settings: PlaySettings;
}) {
  const [shareStatus, setShareStatus] = useState("");
  const [edits, setEdits] = useState<Partial<PlaySettings>>({});
  const [editingEntry, setEditingEntry] = useState(false);
  const draft = { ...settings, ...edits };
  const [assetAddress, quoteAddress] = playAddresses(market, settings);
  const tokens = useTokenMetadata(network, [assetAddress, quoteAddress]);
  const { data: trending } = useTokenDiscovery(network, false);
  const assetMetadata = tokens.find((token) => token.address === assetAddress);
  const quoteMetadata = tokens.find((token) => token.address === quoteAddress);
  const displayToken = (address: string, metadata?: TokenMetadata) =>
    metadata?.status === "available"
      ? metadata
      : (trending?.find((token) => token.address === address) ??
        fallbackToken(market.network, address));
  const asset = displayToken(assetAddress, assetMetadata);
  const quote = displayToken(quoteAddress, quoteMetadata);
  const description = strategy.description(asset.symbol, quote.symbol);

  const labels = playFieldLabels(strategy.id);
  const units = playFieldUnits(settings, asset.symbol, quote.symbol);
  const marketTokens = useTokens(
    network,
    labels.target ? [assetAddress, quoteAddress] : [],
  );
  const marketAsset = marketTokens.find(
    (token) => token.address === assetAddress,
  );
  const marketQuote = marketTokens.find(
    (token) => token.address === quoteAddress,
  );
  const reference = referencePrice(assetMetadata, quoteMetadata);
  const entryPrice =
    edits.entry === undefined
      ? (settings.entry ?? reference)
      : orientPlayPrice(settings, edits.entry);
  const entryInput = edits.entry ?? orientPlayPrice(settings, entryPrice) ?? "";
  const entry = scenarioNumber(entryPrice ?? "");
  const slider =
    entry !== undefined && marketAsset && marketQuote
      ? playTickSlider(draft, entry, marketAsset, marketQuote)
      : undefined;
  const targetInput = slider?.price;
  const targetTick = slider?.canonicalTick(slider.value);
  const targetText = targetInput && `${priceText(targetInput)} ${quote.symbol}`;
  const scenario: PlaySettings = {
    ...draft,
    entry: entryPrice,
    target: targetInput,
    targetTick,
    rate: playRateInput(draft),
  };
  const amount = scenario.amount ?? playDefaultAmount(scenario);
  const values = readPlayValues(scenario);
  const outcome = values ? playOutcome(strategy.id, values) : undefined;
  const quoteText = playQuoteText(outcome, quote.symbol);

  useEffect(() => {
    setPageTitle(description);
  }, [description]);

  useEffect(() => {
    if (entry === undefined || (labels.target && targetTick === undefined))
      return;
    if (
      settings.entry !== undefined &&
      (!labels.target ||
        (settings.target === targetInput && settings.targetTick === targetTick))
    )
      return;
    const route = readPlayPath(window.location.pathname);
    const current = decodePlayStrategy(route?.strategy);
    if (
      route?.network !== network ||
      current?.id !== settings.id ||
      current.token !== settings.token ||
      current.rentSelectedToken !== settings.rentSelectedToken ||
      current.entry !== settings.entry ||
      current.target !== settings.target ||
      current.targetTick !== settings.targetTick
    )
      return;
    const pricedSettings = {
      ...current,
      entry: entryPrice,
      target: targetInput,
      targetTick,
    };
    writePlayUrl(
      network,
      {
        ...pricedSettings,
        amount:
          current.amount ??
          (settings.entry === undefined
            ? playDefaultAmount(pricedSettings)
            : undefined),
        rate: playRateInput(current),
      },
      true,
    );
  }, [
    network,
    entry,
    entryPrice,
    labels.target,
    settings.entry,
    settings.id,
    settings.rentSelectedToken,
    settings.token,
    settings.target,
    settings.targetTick,
    targetInput,
    targetTick,
  ]);

  function edit(
    field: "amount" | "entry" | "target" | "rate",
    value: string,
    tick?: number,
  ) {
    if (playInput(value) === undefined) return;
    setShareStatus("");
    const patch: Partial<PlaySettings> = { [field]: value };
    if (field === "entry" && labels.target) {
      patch.target = undefined;
      patch.targetTick = undefined;
    }
    if (field === "target") patch.targetTick = tick;
    setEdits({ ...edits, ...patch });
    const next = { ...scenario, ...patch };
    if (field === "entry") next.entry = orientPlayPrice(settings, value);
    writePlayUrl(network, next, true);
  }

  function switchTokens() {
    const principal = scenarioNumber(amount ?? "");
    const switchedAmount =
      principal !== undefined && entry !== undefined
        ? playInput(playTarget(principal * entry, 0))
        : undefined;
    writePlayUrl(network, {
      ...scenario,
      rentSelectedToken: !settings.rentSelectedToken,
      amount: switchedAmount ?? amount,
      entry: invertPlayPrice(entryPrice),
    });
  }

  async function share() {
    const url = writePlayUrl(network, { ...scenario, amount }, true);
    setShareStatus("");
    const copy = navigator.clipboard?.writeText(url);
    const nativeShare = navigator.share?.({ url });
    const [copied, shared] = await Promise.allSettled([copy, nativeShare]);
    if (
      (!copy || copied.status === "rejected") &&
      (!nativeShare || shared.status === "rejected")
    ) {
      setShareStatus("Copy the link from your address bar.");
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <TokenIcon token={asset} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-xl">
              <h2 className="inline break-words font-semibold">
                {description}
              </h2>
              {strategy.id === PlayStrategy.UseLiquidity && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  className="ml-2 align-middle"
                  aria-label="Switch tokens"
                  onClick={switchTokens}
                >
                  <ArrowLeftRight aria-hidden="true" />
                </Button>
              )}
            </div>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <span aria-hidden="true">{strategy.emoji}</span>
              <span>{strategy.title}</span>
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={share}
            disabled={!outcome}
          >
            <Share2 size={16} /> Share
          </Button>
        </div>
        {shareStatus && (
          <p role="status" className="text-sm text-muted-foreground">
            {shareStatus}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <AmountInput
            className="my-0"
            label={labels.amount}
            symbol={units.amount}
            value={amount ?? ""}
            maxLength={64}
            onChange={(value) => edit("amount", value)}
          />
          <AmountInput
            className="my-0"
            label={labels.entry}
            symbol={units.entry}
            value={editingEntry ? entryInput : playPriceText(entryInput)}
            maxLength={64}
            onFocus={() => setEditingEntry(true)}
            onBlur={() => setEditingEntry(false)}
            onChange={(value) => edit("entry", value)}
          />
        </div>
        {labels.target && (
          <label className="grid gap-2">
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-sm">{labels.target}</span>
              <strong className="text-lg tabular-nums">
                {targetText ?? "—"}
              </strong>
            </span>
            <input
              type="range"
              min={slider?.min ?? 0}
              max={slider?.max ?? 1}
              step={slider?.step ?? 1}
              value={slider?.value ?? 0}
              disabled={!slider}
              aria-label={labels.target}
              aria-valuetext={targetText}
              onChange={(event) => {
                if (!slider) return;
                const tick = Number(event.target.value);
                edit(
                  "target",
                  slider.priceAt(tick),
                  slider.canonicalTick(tick),
                );
              }}
              className="h-6 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
            />
          </label>
        )}
        {labels.rate && (
          <AmountInput
            className="my-0"
            label={labels.rate}
            symbol="%"
            value={scenario.rate ?? ""}
            maxLength={64}
            onChange={(value) => edit("rate", value)}
          />
        )}
        <div className="space-y-1 rounded-lg border bg-muted/30 p-4 text-center">
          <p className="text-sm text-muted-foreground">
            {outcome?.label ?? "Simulated outcome"}
          </p>
          <p
            aria-live="polite"
            className={`break-words text-3xl font-semibold tabular-nums ${outcome?.value === undefined ? "" : outcome.value >= 0 ? "text-bid" : "text-ask"}`}
          >
            {playOutcomeText(outcome, asset.symbol, quote.symbol)}
          </p>
          {outcome?.percent !== undefined && (
            <p className="text-sm tabular-nums">
              {playSigned(outcome.percent)}%
            </p>
          )}
          {quoteText && (
            <p className="text-sm text-muted-foreground tabular-nums">
              {quoteText}
            </p>
          )}
        </div>
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            How to play
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground group-open:rotate-180"
            />
          </summary>
          <ol className="mt-4 space-y-3 text-sm">
            {strategy
              .steps(asset.symbol, quote.symbol)
              .map(({ action, text }) => {
                const { icon: Icon, intent } = stepActions[action];
                return (
                  <li
                    key={text}
                    className="flex items-start gap-2.5 break-words"
                  >
                    <Icon
                      aria-hidden="true"
                      data-intent={intent}
                      className="mt-0.5 size-4 shrink-0 text-foreground"
                    />
                    <span className="min-w-0">{text}</span>
                  </li>
                );
              })}
          </ol>
        </details>
        <Link
          className={buttonVariants({ className: "w-full" })}
          href={marketPath(market)}
        >
          Open Yield Market <ArrowRight size={16} />
        </Link>
      </CardContent>
    </Card>
  );
}

export function YieldExplorer() {
  const pathname = usePathname();
  const { network } = useNetwork();
  const settings = decodePlayStrategy(readPlayPath(pathname)?.strategy);
  const strategy = playStrategy(settings?.id ?? null);
  const market = playMarket(network, settings?.token);
  const hasMarket = !!market;

  useEffect(() => {
    // Native history updates the route parameters without refreshing metadata.
    if (!hasMarket) setPageTitle();
  }, [hasMarket]);

  return (
    <section className="mx-auto max-w-xl space-y-4 py-8 md:py-10">
      <header className="pb-2 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">
          Yield Explorer<span className="text-brand">.</span>
        </h1>
        {!strategy && (
          <p className="mt-2 text-muted-foreground">{PLAY_STRATEGY_PROMPT}</p>
        )}
      </header>
      {strategy && (
        <Button
          variant="ghost"
          onClick={() =>
            writePlayUrl(network, market ? { id: strategy.id } : undefined)
          }
        >
          <ArrowLeft size={16} /> {market ? "Tokens" : "Strategies"}
        </Button>
      )}
      {strategy && settings ? (
        market ? (
          <Simulation
            key={`${network}/${strategy.id}/${market.key}/${settings.rentSelectedToken ?? ""}`}
            network={network}
            strategy={strategy}
            market={market}
            settings={settings}
          />
        ) : (
          <TokenPicker key={network} network={network} strategy={strategy} />
        )
      ) : (
        <StrategyList network={network} />
      )}
    </section>
  );
}
