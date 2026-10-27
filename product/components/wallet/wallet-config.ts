import type { Connector } from "wagmi";

export const CONNECTOR_IDS = {
  injected: "injected",
  coinbase: "coinbaseWalletSDK",
} as const;

export const CONNECTOR_TYPES = {
  injected: "injected",
  safe: "safe",
  walletConnect: "walletConnect",
} as const;

export const WALLETCONNECT_URI_EVENT = "display_uri";
export const COPY_FEEDBACK_DURATION_MS = 2000;
export const QR_QUIET_ZONE_MODULES = 4;
export const QR_CODE_OPTIONS = { errorCorrectionLevel: "L" } as const;

export const WALLET_TEXT = {
  connect: {
    trigger: "Connect wallet",
    title: "Connect Wallet",
    description: "Choose your wallet to connect.",
    other: "Other",
  },
  walletConnect: {
    title: "WalletConnect",
    description: "Scan the QR code or copy the connection link.",
    qrLabel: "WalletConnect QR code",
    copyLink: "Copy connection link",
    loading: "Preparing WalletConnect…",
  },
  connected: {
    title: "Your wallet",
    description: "Manage your connected wallet.",
    status: "Wallet connected",
    tooltip: (address?: string) => `Wallet connected: ${address}`,
    genericName: "Connected wallet",
    copyAddress: "Copy address",
    network: "Network:",
    unsupportedNetwork: (chainId?: number) => `Unsupported (${chainId})`,
    disconnect: "Disconnect",
  },
  clipboard: {
    copied: "Copied",
    unavailable: "Clipboard unavailable",
  },
  network: {
    disconnected: "Connect a wallet to transact.",
    current: (name?: string) =>
      `Your wallet is on ${name ?? "an unsupported network"}.`,
    switch: "Switch network",
  },
} as const;

export function distinctConnectors(
  connectors: readonly Connector[],
): Connector[] {
  const announced = connectors.filter(
    (connector) =>
      connector.type === CONNECTOR_TYPES.injected &&
      connector.id !== CONNECTOR_IDS.injected,
  );
  const seen = new Set<string>();
  return connectors.filter((connector) => {
    if (connector.id === CONNECTOR_IDS.injected) return false;
    if (
      connector.id === CONNECTOR_IDS.coinbase &&
      announced.some((wallet) => /coinbase/i.test(wallet.name))
    )
      return false;
    if (seen.has(connector.id)) return false;
    seen.add(connector.id);
    return true;
  });
}
