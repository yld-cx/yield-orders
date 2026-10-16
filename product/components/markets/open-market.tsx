"use client";
import { Card, CardContent } from "@yld-cx/ui/components/ui/card";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address } from "viem";
import { canonicalPair } from "@yld-cx/sdk/registry";
import { getNetwork, explainError } from "@yld-cx/sdk/ethereum";
import { useNetwork } from "@/components/layout/providers";
import { registry } from "@/lib/registry";
import { getSdk } from "@/lib/rpc";
import { TokenSelector } from "./token-selector";
import { TransactionFlow } from "@/components/transactions/transaction-flow";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import LoadingScreen from "@/components/layout/loading-screen";
import { useToken } from "@/hooks/use-market";
import { ArrowDownUp } from "lucide-react";
export function OpenMarket() {
  const { network } = useNetwork();
  return <OpenMarketForm key={network} network={network} />;
}
function OpenMarketForm({
  network,
}: {
  network: ReturnType<typeof useNetwork>["network"];
}) {
  const tokens = registry.getTokens(getNetwork(network).id),
    router = useRouter();
  const [a, setA] = useState(tokens[0]?.address ?? ""),
    [b, setB] = useState(tokens[1]?.address ?? "");
  let key = "",
    validation = "";
  try {
    key = canonicalPair(getNetwork(network).id, a, b).join(":");
  } catch (e) {
    validation = explainError(e);
  }
  const query = useQuery({
    queryKey: ["pair", network, key],
    queryFn: () => getSdk(network).getPair(a as Address, b as Address),
    enabled: !!key,
  });
  const tokenA = useToken(network, a, isAddress(a, { strict: false })),
    tokenB = useToken(network, b, isAddress(b, { strict: false }));
  const path = `/market/${network}/${key}`;
  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="flex flex-wrap items-center gap-3 py-6 text-xs text-muted-foreground">
        <Link href="/">Yield</Link>
        <span>/</span>
        <span>Open Market</span>
      </div>
      <div className="my-8 space-y-3 text-center [&>h1]:text-4xl [&>h1]:font-semibold [&>p]:text-muted-foreground">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Any pair · Permissionless
        </p>
        <h1>
          Open a market<span className="text-brand">.</span>
        </h1>
        <p>Select two tokens to view or create their liquidity market.</p>
      </div>
      <Card className="open-card">
        <CardContent className="space-y-4">
          <div className="my-4 flex flex-wrap items-center justify-between gap-4">
            <h2>Choose your tokens</h2>
            <Badge>{getNetwork(network).name}</Badge>
          </div>
          <TokenSelector
            label="Token A"
            network={network}
            value={a}
            onChange={setA}
            token={tokenA.data}
          />
          {tokenA.error && (
            <Message error>{explainError(tokenA.error)}</Message>
          )}
          <Button
            variant="outline"
            size="icon"
            className="self-center m-0!"
            aria-label="Swap Token A and Token B"
            onClick={() => {
              setA(b);
              setB(a);
            }}
          >
            <ArrowDownUp />
          </Button>
          <TokenSelector
            label="Token B"
            network={network}
            value={b}
            onChange={setB}
            token={tokenB.data}
          />
          {tokenB.error && (
            <Message error>{explainError(tokenB.error)}</Message>
          )}
          {validation && <Message>{validation}</Message>}
          <div className="min-h-40" aria-busy={query.isLoading}>
            {query.isLoading && (
              <LoadingScreen
                className="min-h-40 [&_svg]:size-16"
                label="Checking market…"
              />
            )}
            {query.isError && (
              <Message error>{explainError(query.error)}</Message>
            )}
            {query.data &&
              key &&
              (query.data[3] ? (
                <>
                  <Message>
                    <strong>Market found</strong>
                    <br />
                    {tokenA.data?.symbol ?? "Token A"} /{" "}
                    {tokenB.data?.symbol ?? "Token B"} already exists on{" "}
                    {getNetwork(network).name}.
                  </Message>
                  <Button
                    className="w-full"
                    render={<Link href={path} />}
                    nativeButton={false}
                  >
                    View Market →
                  </Button>
                </>
              ) : (
                <>
                  <Message>New market · Ready to create</Message>
                  <TransactionFlow
                    key={`${network}/${key}`}
                    network={network}
                    label="Create Market"
                    disabled={
                      !tokenA.data ||
                      !tokenB.data ||
                      !!tokenA.error ||
                      !!tokenB.error
                    }
                    prepare={async () => ({
                      kind: "createPair",
                      tokenA: a as Address,
                      tokenB: b as Address,
                    })}
                    onSuccess={() => router.push(path)}
                  />
                  <Button
                    className="mt-4 w-full"
                    variant="outline"
                    render={<Link href={path} />}
                    nativeButton={false}
                  >
                    Preview Market →
                  </Button>
                </>
              ))}
          </div>
        </CardContent>
      </Card>
      <p className="mx-auto mt-6 max-w-xl text-center text-xs leading-relaxed text-muted-foreground">
        Creating a market unlocks liquidity for everyone to provide and use.
      </p>
    </div>
  );
}
