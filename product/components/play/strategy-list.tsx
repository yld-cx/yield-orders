import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Token } from "@yld-cx/sdk";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@yld-cx/ui/components/ui/card";
import { PLAY_STRATEGIES, playParams } from "@/lib/play";

export const PLAY_STRATEGY_PROMPT = "Choose your strategy to play";

export function StrategyList({
  network,
  token,
}: {
  network: NetworkSlug;
  token?: Pick<Token, "address" | "symbol">;
}) {
  return (
    <Card
      className={token ? "min-w-0" : "gap-0 py-0"}
      role={token ? "region" : undefined}
      aria-label={token ? "Yield Explorer" : undefined}
    >
      {token && (
        <CardHeader>
          <h2 className="font-semibold">
            Yield Explorer<span className="text-brand">.</span>
          </h2>
          <CardDescription>{PLAY_STRATEGY_PROMPT}</CardDescription>
        </CardHeader>
      )}
      <CardContent
        className={token ? "grid gap-1 sm:grid-cols-2" : "divide-y p-0"}
      >
        {PLAY_STRATEGIES.map((item) => (
          <Link
            key={item.id}
            href={`/play?${playParams(network, { id: item.id, token: token?.address })}`}
            prefetch={false}
            className={`flex min-w-0 items-center gap-3 text-left hover:bg-muted/40 focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring ${token ? "rounded-md p-2" : "p-4"}`}
          >
            <span className="shrink-0 text-2xl" aria-hidden="true">
              {item.emoji}
            </span>
            <span className="min-w-0 flex-1 break-words">
              <span className="block font-semibold">{item.title}</span>
              <span className="block text-sm text-muted-foreground">
                {item.description(token?.symbol)}
              </span>
            </span>
            <ArrowRight size={16} className="shrink-0" aria-hidden="true" />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
