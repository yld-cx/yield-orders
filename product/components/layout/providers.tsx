"use client";
import {
  QUERY_TIMING,
  QUERY_RETRY_COUNT,
  NETWORK_COOKIE_MAX_AGE_SECONDS,
} from "@yld-cx/sdk";
import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { WagmiProvider, type State } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeWagmiConfig } from "@/lib/wagmi";
import type { NetworkSlug } from "@yld-cx/sdk/ethereum";
import { isNetworkSlug } from "@/lib/registry";
const NetworkContext = createContext<{
  network: NetworkSlug;
  setNetwork: (value: NetworkSlug) => void;
} | null>(null);
export function Providers({
  children,
  initialState,
  initialNetwork = "base",
}: {
  children: ReactNode;
  initialState?: State;
  initialNetwork?: NetworkSlug;
}) {
  const [config] = useState(makeWagmiConfig);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: QUERY_TIMING.defaultStale,
            retry: QUERY_RETRY_COUNT,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );
  const [savedNetwork, setNetwork] = useState(initialNetwork);
  const pathname = usePathname();
  const urlNetwork = useSearchParams().get("network");
  const network =
    pathname === "/" && urlNetwork && isNetworkSlug(urlNetwork)
      ? urlNetwork
      : savedNetwork;
  // Remember URL selections for screens that do not have market filters.
  if (network !== savedNetwork) setNetwork(network);
  useEffect(() => {
    document.cookie = `yld.network=${network}; Path=/; SameSite=Lax; Max-Age=${NETWORK_COOKIE_MAX_AGE_SECONDS}${location.protocol === "https:" ? "; Secure" : ""}`;
  }, [network]);
  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <NetworkContext.Provider value={{ network, setNetwork }}>
          {children}
        </NetworkContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
export function useNetwork() {
  const context = useContext(NetworkContext);
  if (!context) throw new Error("Missing network provider");
  return context;
}
