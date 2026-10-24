"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNetwork } from "./providers";
import { BrandLogo } from "./brand-logo";
import { NetworkSelector } from "./network-selector";
import { LayoutGrid, List } from "lucide-react";
import { networks, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { WalletConnect } from "@/components/wallet/wallet-connect";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Badge } from "@yld-cx/ui/components/ui/badge";
export function AppHeader() {
  const pathname = usePathname();
  const { setNetwork } = useNetwork();
  const routeNetwork = pathname.split("/")[2];
  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-[1380px] flex-wrap items-center gap-3 px-4 py-3 sm:gap-6 sm:px-6 lg:px-9">
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/"
            className="inline-flex shrink-0 items-center"
            aria-label="yld.cx home"
          >
            <BrandLogo />
          </Link>
        </div>
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
          <Badge variant="ghost" className="text-green-500!">
            beta
          </Badge>
          <NetworkSelector />
          <WalletConnect />
        </div>
      </div>
    </header>
  );
}
