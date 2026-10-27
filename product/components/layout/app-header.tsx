"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useNetwork } from "./providers";
import { BrandLogo } from "./brand-logo";
import { NetworkSelector } from "./network-selector";
import { LayoutGrid, List, Menu } from "lucide-react";
import { networks, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import { WalletConnect } from "@/components/wallet/wallet-connect";
import { Button } from "@yld-cx/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@yld-cx/ui/components/ui/sheet";

function HeaderNavigation({
  className,
  onNavigate,
}: {
  className: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { setNetwork } = useNetwork();
  const routeNetwork = pathname.split("/")[2];

  return (
    <nav aria-label="Main navigation" className={className}>
      <Button
        render={<Link href="/" />}
        nativeButton={false}
        role="link"
        variant={pathname !== "/orders" ? "secondary" : "ghost"}
        data-intent={pathname !== "/orders" ? "term" : undefined}
        aria-current={pathname !== "/orders" ? "page" : undefined}
        className="justify-start"
        onClick={onNavigate}
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
        aria-current={pathname === "/orders" ? "page" : undefined}
        className="justify-start"
        onClick={() => {
          if (networks.some((network) => network.slug === routeNetwork))
            setNetwork(routeNetwork as NetworkSlug);
          onNavigate?.();
        }}
      >
        <List size={17} aria-hidden="true" />
        Orders
      </Button>
    </nav>
  );
}

export function AppHeader() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 640px)");
    function closeOnDesktop(event: MediaQueryListEvent) {
      if (event.matches) setMenuOpen(false);
    }
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex min-h-16 max-w-[1380px] flex-wrap items-center gap-1.5 px-3 py-2 sm:gap-6 sm:px-6 sm:py-3 lg:px-9">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center"
          aria-label="yld.cx home"
        >
          <BrandLogo />
        </Link>
        <HeaderNavigation className="hidden items-center gap-1 sm:flex" />
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <NetworkSelector />
          <WalletConnect />
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              render={
                <Button variant="outline" size="icon" className="sm:hidden" />
              }
              aria-label="Open navigation menu"
            >
              <Menu size={16} aria-hidden="true" />
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>👑</SheetTitle>
                <SheetDescription className="sr-only">
                  Browse Yield markets and manage your Orders.
                </SheetDescription>
              </SheetHeader>
              <HeaderNavigation
                className="flex flex-col gap-2"
                onNavigate={() => setMenuOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
