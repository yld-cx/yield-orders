import { SAFE_INFO_TIMEOUT_MS } from "@yld-cx/sdk";
import { createConfig, createStorage, cookieStorage, http } from "wagmi";
import { injected } from "wagmi/connectors/injected";
import { coinbaseWallet } from "wagmi/connectors/coinbaseWallet";
import { safe } from "wagmi/connectors/safe";
import { walletConnect } from "wagmi/connectors/walletConnect";
import { mainnet, base, robinhood } from "viem/chains";
import { rpcUrls } from "./rpc";
export function makeWagmiConfig() {
  return createConfig({
    chains: [base, mainnet, robinhood],
    ssr: true,
    multiInjectedProviderDiscovery: true,
    storage: createStorage({ storage: cookieStorage }),
    connectors: [
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
        appLogoUrl: "https://yld.cx/icon.svg",
      }),
      ...(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
        ? [
            walletConnect({
              projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
              showQrModal: false,
              metadata: {
                name: "yld.cx",
                description: "Liquidity rental markets",
                url: "https://yld.cx",
                icons: ["https://yld.cx/icon.svg"],
              },
            }),
          ]
        : []),
    ],
    transports: {
      [mainnet.id]: http(rpcUrls.ethereum),
      [base.id]: http(rpcUrls.base),
      [robinhood.id]: http(rpcUrls.robinhood),
    },
  });
}
