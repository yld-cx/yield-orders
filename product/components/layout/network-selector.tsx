"use client";
import { usePathname, useRouter } from "next/navigation";
import { useConnection, useSwitchChain } from "wagmi";
import { getNetwork, networks } from "@yld-cx/sdk/ethereum";
import { marketFilterParams, parseMarketFilters } from "@/lib/market-filters";
import { useNetwork } from "./providers";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@yld-cx/ui/components/ui/select";

export function NetworkSelector() {
  const pathname = usePathname();
  const router = useRouter();
  const { network, setNetwork } = useNetwork();
  const connection = useConnection();
  const switchChain = useSwitchChain();
  const routeNetwork = pathname.split("/")[2];
  const current =
    networks.find((n) => n.slug === routeNetwork) ?? getNetwork(network);

  function selectNetwork(next: string | null) {
    const selected = networks.find((n) => n.slug === next);
    if (!selected) return;
    switchChain.reset();
    if (pathname === "/") {
      const params = new URLSearchParams(window.location.search);
      const query = marketFilterParams(
        {
          ...parseMarketFilters(params, network),
          network: selected.slug,
          page: 1,
        },
        params,
      );
      window.history.pushState(null, "", `?${query}${window.location.hash}`);
    } else {
      setNetwork(selected.slug);
      router.push(`/?network=${selected.slug}`);
    }
    if (
      connection.isConnected &&
      connection.chainId !== selected.chain.id &&
      connection.connector?.switchChain
    ) {
      switchChain.mutate({
        chainId: selected.chain.id,
        connector: connection.connector,
      });
    }
  }

  return (
    <div className="flex max-w-64 flex-col items-end gap-1">
      <Select
        value={current.slug}
        items={networks.map((n) => ({ value: n.slug, label: n.name }))}
        disabled={switchChain.isPending}
        onValueChange={selectNetwork}
      >
        <SelectTrigger aria-label="Network" aria-busy={switchChain.isPending}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {networks.map((n) => (
            <SelectItem key={n.id} value={n.slug}>
              {n.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
