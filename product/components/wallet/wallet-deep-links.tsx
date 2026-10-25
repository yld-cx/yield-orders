"use client";

import { useEffect, useState } from "react";
import type { Connector } from "wagmi";
import { Button } from "@yld-cx/ui/components/ui/button";
import { MOBILE_WALLETS, type MobileWallet } from "@/lib/deep-links";

type WalletDeepLinksProps = {
  connectors: readonly Connector[];
  pending: boolean;
};

function MobileWalletOption({
  wallet,
  connectors,
  pending,
}: WalletDeepLinksProps & { wallet: MobileWallet }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (
      !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) &&
      !(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    )
      return;
    let active = true;
    async function detect() {
      const providers = await Promise.all(
        connectors
          .filter(
            (connector) =>
              connector.type === "injected" &&
              (connector.name.toLowerCase() === wallet.name.toLowerCase() ||
                connector.id === wallet.id),
          )
          .map((connector) => connector.getProvider().catch(() => undefined)),
      );
      if (active) setVisible(!providers.some(Boolean));
    }
    void detect();
    return () => {
      active = false;
    };
  }, [connectors, wallet]);
  if (!visible) return null;
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() => window.location.assign(wallet.browseUrl)}
    >
      Open in {wallet.name}
    </Button>
  );
}

export function WalletDeepLinks(props: WalletDeepLinksProps) {
  return Object.values(MOBILE_WALLETS).map((wallet) => (
    <MobileWalletOption key={wallet.id} wallet={wallet} {...props} />
  ));
}
