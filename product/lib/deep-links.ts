import { ORIGIN } from "@/lib/registry";

export const MOBILE_WALLETS = {
  Phantom: {
    name: "Phantom",
    id: "app.phantom",
    browseUrl: `https://phantom.com/ul/browse/${encodeURIComponent(ORIGIN)}?ref=${encodeURIComponent(ORIGIN)}`,
  },
  MetaMask: {
    name: "MetaMask",
    id: "io.metamask",
    browseUrl: `https://link.metamask.io/dapp/${ORIGIN.replace(/^https?:\/\//, "")}`,
  },
} as const;

export type MobileWallet = (typeof MOBILE_WALLETS)[keyof typeof MOBILE_WALLETS];
