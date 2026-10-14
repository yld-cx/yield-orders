"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useNetwork } from "./providers";
import { BrandLogo } from "./brand-logo";
import { LayoutGrid, List } from "lucide-react";
import { networks, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { WalletConnect } from "@/components/wallet/wallet-connect";
import { Button } from "@yld-cx/ui/components/ui/button";
import { marketFilterParams, parseMarketFilters } from "@/lib/market-filters";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@yld-cx/ui/components/ui/select";
export function AppHeader() {
  const pathname = usePathname(),
    router = useRouter();
  const { network, setNetwork } = useNetwork();
  const routeNetwork = pathname.split("/")[2];
  const current = networks.some((n) => n.slug === routeNetwork)
    ? routeNetwork
    : network;
  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-[1380px] flex-wrap items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6 lg:px-9">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center"
          aria-label="yld.cx home"
        >
          <BrandLogo />
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-1">
          <Button
            render={<Link href="/" />}
            nativeButton={false}
            role="link"
            variant={pathname !== "/orders" ? "secondary" : "ghost"}
            data-intent={pathname !== "/orders" ? "term" : undefined}
            aria-current={pathname !== "/orders" ? "page" : undefined}
          >
            <LayoutGrid size={17} aria-hidden="true" />
            Yield
          </Button>
          <Button
            render={<Link href="/orders" />}
            nativeButton={false}
            role="link"
            variant={pathname === "/orders" ? "secondary" : "ghost"}
            data-intent={pathname === "/orders" ? "term" : undefined}
            onClick={() => {
              if (networks.some((n) => n.slug === routeNetwork))
                setNetwork(routeNetwork as NetworkSlug);
            }}
            aria-current={pathname === "/orders" ? "page" : undefined}
          >
            <List size={17} aria-hidden="true" />
            Orders
          </Button>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={current}
            items={networks.map((n) => ({ value: n.slug, label: n.name }))}
            onValueChange={(next) => {
              if (next) {
                if (pathname === "/") {
                  const params = new URLSearchParams(window.location.search);
                  const query = marketFilterParams(
                    {
                      ...parseMarketFilters(params, network),
                      network: next as NetworkSlug,
                    },
                    params,
                  );
                  window.history.pushState(
                    null,
                    "",
                    `?${query}${window.location.hash}`,
                  );
                } else {
                  setNetwork(next as NetworkSlug);
                  router.push(`/?network=${next}`);
                }
              }
            }}
          >
            <SelectTrigger aria-label="Network">
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
          <WalletConnect />
        </div>
      </div>
    </header>
  );
}
