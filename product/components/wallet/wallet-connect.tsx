"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useConnect,
  useConnectors,
  useConnection,
  useSwitchChain,
  type Connector,
} from "wagmi";
import { Wallet } from "lucide-react";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import { explainError } from "@yld-cx/sdk/ethereum";
import { shortAddress } from "@/lib/utils";
import {
  ConnectedWalletDialog,
  WalletConnectDialog,
  WalletPickerDialog,
} from "./wallet-dialogs";
import { CONNECTOR_TYPES, WALLET_TEXT } from "./wallet-config";

export { distinctConnectors } from "./wallet-config";

enum WalletView {
  Picker,
  WalletConnect,
  Connected,
}
type ActiveDialog =
  | { view: WalletView.Picker; error?: string }
  | { view: WalletView.WalletConnect; connector: Connector }
  | { view: WalletView.Connected };

function useSafeAutoConnect() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync } = useConnect();
  const attempted = useRef(false);
  useEffect(() => {
    if (
      attempted.current ||
      window.parent === window ||
      connection.isConnecting ||
      connection.isReconnecting
    )
      return;
    attempted.current = true;
    if (connection.connector?.type === CONNECTOR_TYPES.safe) return;
    const connector = connectors.find(
      (candidate) => candidate.type === CONNECTOR_TYPES.safe,
    );
    if (!connector) return;
    async function connectSafe(connector: Connector) {
      try {
        const provider = await connector.getProvider();
        if (provider) await mutateAsync({ connector });
      } catch {}
    }
    void connectSafe(connector);
  }, [
    connection.isConnecting,
    connection.isReconnecting,
    connection.connector,
    connectors,
    mutateAsync,
  ]);
}

export function WalletConnect() {
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const connection = useConnection();
  const connectors = useConnectors();
  useSafeAutoConnect();

  const close = useCallback(() => setActiveDialog(undefined), []);
  const showWalletConnect = useCallback((connector: Connector) => {
    setActiveDialog({ view: WalletView.WalletConnect, connector });
  }, []);
  const showConnectionError = useCallback((error: string) => {
    setActiveDialog({ view: WalletView.Picker, error });
  }, []);
  const label = connection.address
    ? shortAddress(connection.address)
    : WALLET_TEXT.connect.trigger;

  return (
    <>
      <Button
        ref={triggerRef}
        variant="outline"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={Boolean(activeDialog)}
        title={
          connection.isConnected
            ? WALLET_TEXT.connected.tooltip(connection.address)
            : WALLET_TEXT.connect.trigger
        }
        onClick={() =>
          setActiveDialog({
            view: connection.isConnected
              ? WalletView.Connected
              : WalletView.Picker,
          })
        }
      >
        <span className="relative">
          <Wallet size={16} aria-hidden="true" />
          {connection.isConnected && (
            <span
              role="status"
              aria-label={WALLET_TEXT.connected.status}
              className="absolute -right-1 -top-1 size-2 rounded-full bg-green-500 ring-2 ring-background"
            />
          )}
        </span>
        <span className="hidden sm:inline">{label}</span>
      </Button>
      {activeDialog?.view === WalletView.Picker && (
        <WalletPickerDialog
          connectors={connectors}
          initialError={activeDialog.error}
          onClose={close}
          returnFocus={triggerRef}
          onWalletConnect={showWalletConnect}
        />
      )}
      {activeDialog?.view === WalletView.WalletConnect && (
        <WalletConnectDialog
          connector={activeDialog.connector}
          onClose={close}
          returnFocus={triggerRef}
          onError={showConnectionError}
        />
      )}
      {activeDialog?.view === WalletView.Connected && (
        <ConnectedWalletDialog onClose={close} returnFocus={triggerRef} />
      )}
    </>
  );
}

export function NetworkGuard({ chainId }: { chainId: number }) {
  const connection = useConnection();
  const switchChain = useSwitchChain();
  if (!connection.isConnected)
    return <Message>{WALLET_TEXT.network.disconnected}</Message>;
  if (connection.chainId === chainId) return null;
  return (
    <div className="message flex flex-wrap items-center gap-2 my-2 text-sm">
      <p>{WALLET_TEXT.network.current(connection.chain?.name)}</p>
      <Button
        size="xs"
        variant="outline"
        onClick={() => switchChain.mutate({ chainId })}
        disabled={switchChain.isPending}
      >
        {WALLET_TEXT.network.switch}
      </Button>
      {switchChain.error && (
        <Message error>{explainError(switchChain.error)}</Message>
      )}
    </div>
  );
}
