import { SAFE_INFO_TIMEOUT_MS } from "@yld-cx/sdk";
import { createConfig, createStorage, cookieStorage, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { coinbaseWallet } from "wagmi/connectors/coinbaseWallet";
import { safe } from "wagmi/connectors/safe";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { mock } from "wagmi/connectors/mock";
import type { Address } from "viem";
import { mainnet, base, robinhood } from "viem/chains";
import { ORIGIN } from "./registry";
import { rpcUrls } from "./rpc";

function browserConnectors(spy?: Address) {
  if (spy)
    return [
      mock({
        accounts: [spy],
        features: { defaultConnected: true, reconnect: true },
      }),
    ];

  const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  return [
    safe({
      allowedDomains: [
        /^https:\/\/app\.safe\.global$/,
        /^https:\/\/safe\.global$/,
      ],
      unstable_getInfoTimeout: SAFE_INFO_TIMEOUT_MS,
    }),
    injected({ shimDisconnect: true }),
    coinbaseWallet({
      appName: "yld.cx",
      appLogoUrl: `${ORIGIN}/icon.svg`,
    }),
    ...(projectId
      ? [
          walletConnect({
            projectId,
            showQrModal: false,
            metadata: {
              name: "yld.cx",
              description: "Liquidity rental markets",
              url: window.location.origin,
              icons: [`${ORIGIN}/icon.svg`],
            },
          }),
        ]
      : []),
  ];
}

function createWagmiConfig(spy?: Address) {
  return createConfig({
    chains: [base, mainnet, robinhood],
    ssr: true,
    multiInjectedProviderDiscovery: true,
    storage: createStorage({ storage: cookieStorage }),
    // Server renders only read cookies; connector setup starts browser SDKs.
    connectors: typeof window === "undefined" ? [] : browserConnectors(spy),
    transports: {
      [mainnet.id]: http(rpcUrls.ethereum),
      [base.id]: http(rpcUrls.base),
      [robinhood.id]: http(rpcUrls.robinhood),
    },
  });
}

type WagmiConfig = ReturnType<typeof createWagmiConfig>;
type WalletWindow = Window & {
  __yldWagmiConfigs?: Map<string, WagmiConfig>;
};

export function getWagmiConfig(spy?: Address): WagmiConfig {
  if (typeof window === "undefined") return createWagmiConfig(spy);

  // Keep one config per wallet mode across Strict Mode and Fast Refresh.
  const browser = window as WalletWindow;
  const configs = (browser.__yldWagmiConfigs ??= new Map());
  const key = JSON.stringify([
    spy?.toLowerCase(),
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
    rpcUrls,
  ]);
  let config = configs.get(key);
  if (!config) {
    config = createWagmiConfig(spy);
    configs.set(key, config);
  }
  return config;
}
