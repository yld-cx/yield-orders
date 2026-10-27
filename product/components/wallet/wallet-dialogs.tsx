"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  useConnect,
  useConnection,
  useDisconnect,
  type Connector,
} from "wagmi";
import type { EthereumProvider } from "@walletconnect/ethereum-provider";
import QRCode from "qrcode";
import { LogOut, Wallet } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@yld-cx/ui/components/ui/dialog";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Skeleton } from "@yld-cx/ui/components/ui/skeleton";
import { Message } from "@/components/forms/financial-fields";
import { explainError } from "@yld-cx/sdk/ethereum";
import { shortAddress } from "@/lib/utils";
import { WalletDeepLinks } from "./wallet-deep-links";
import { WalletCopyButton } from "./wallet-copy-button";
import {
  CONNECTOR_IDS,
  CONNECTOR_TYPES,
  distinctConnectors,
  QR_CODE_OPTIONS,
  QR_QUIET_ZONE_MODULES,
  WALLET_TEXT,
  WALLETCONNECT_URI_EVENT,
} from "./wallet-config";

type WalletDialogProps = {
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
};

function WalletDialog({
  title,
  description,
  onClose,
  returnFocus,
  children,
}: WalletDialogProps & {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        finalFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet size={16} aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function WalletOption({
  connector,
  pending,
  onChoose,
}: {
  connector: Connector;
  pending: boolean;
  onChoose: (connector: Connector) => void;
}) {
  const needsProvider =
    connector.type === CONNECTOR_TYPES.injected ||
    connector.type === CONNECTOR_TYPES.safe;
  const [available, setAvailable] = useState(!needsProvider);
  useEffect(() => {
    if (!needsProvider) return;
    let active = true;
    async function detect() {
      try {
        const provider = await connector.getProvider();
        if (active) setAvailable(Boolean(provider));
      } catch {
        if (active) setAvailable(false);
      }
    }
    void detect();
    return () => {
      active = false;
    };
  }, [connector, needsProvider]);
  if (!available) return null;
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() => onChoose(connector)}
    >
      {connector.name}
    </Button>
  );
}

export function WalletPickerDialog({
  connectors,
  initialError,
  onClose,
  returnFocus,
  onWalletConnect,
}: WalletDialogProps & {
  connectors: readonly Connector[];
  initialError?: string;
  onWalletConnect: (connector: Connector) => void;
}) {
  const [error, setError] = useState(initialError);
  const { mutateAsync, reset, isPending } = useConnect();
  const active = useRef(true);
  const options = distinctConnectors(connectors);
  const wallets = options.filter(
    (connector) => connector.type !== CONNECTOR_TYPES.walletConnect,
  );
  const walletConnect = options.find(
    (connector) => connector.type === CONNECTOR_TYPES.walletConnect,
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      reset();
    };
  }, [reset]);

  async function choose(connector: Connector) {
    setError(undefined);
    try {
      await mutateAsync({ connector });
      if (active.current) onClose();
    } catch (error) {
      if (active.current) setError(explainError(error));
    }
  }

  return (
    <WalletDialog
      title={WALLET_TEXT.connect.title}
      description={WALLET_TEXT.connect.description}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-2">
        {wallets.map((connector) => (
          <WalletOption
            key={connector.uid}
            connector={connector}
            pending={isPending}
            onChoose={(connector) => void choose(connector)}
          />
        ))}
        <WalletDeepLinks connectors={connectors} pending={isPending} />
        {walletConnect && (
          <>
            <div className="my-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex-1 border-t border-dashed border-input" />
              <span>{WALLET_TEXT.connect.other}</span>
              <span className="flex-1 border-t border-dashed border-input" />
            </div>
            <WalletOption
              connector={walletConnect}
              pending={isPending}
              onChoose={onWalletConnect}
            />
          </>
        )}
      </div>
      {error && <Message error>{error}</Message>}
    </WalletDialog>
  );
}

function WalletQrCode({ uri }: { uri: string }) {
  const qr = QRCode.create(uri, QR_CODE_OPTIONS);
  const size = qr.modules.size + QR_QUIET_ZONE_MODULES * 2;
  let path = "";
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++)
      if (qr.modules.get(y, x))
        path += `M${x + QR_QUIET_ZONE_MODULES} ${y + QR_QUIET_ZONE_MODULES}h1v1h-1z`;
  return (
    <svg
      className="aspect-square w-full rounded-lg"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={WALLET_TEXT.walletConnect.qrLabel}
    >
      <rect width="100%" height="100%" fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}

export function WalletConnectDialog({
  connector,
  onClose,
  returnFocus,
  onError,
}: WalletDialogProps & {
  connector: Connector;
  onError: (error: string) => void;
}) {
  const [uri, setUri] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const { mutateAsync, reset } = useConnect();

  useEffect(() => {
    let active = true;
    let removeListener: (() => void) | undefined;
    async function connect() {
      try {
        const provider = (await connector.getProvider()) as Awaited<
          ReturnType<typeof EthereumProvider.init>
        >;
        if (!active) return;
        const displayUri = (uri: string) => {
          if (active) setUri(uri);
        };
        provider.on(WALLETCONNECT_URI_EVENT, displayUri);
        removeListener = () =>
          provider.removeListener(WALLETCONNECT_URI_EVENT, displayUri);
        await mutateAsync({ connector });
        if (active) onClose();
      } catch (error) {
        if (active) onError(explainError(error));
      } finally {
        removeListener?.();
      }
    }
    void connect();
    return () => {
      active = false;
      removeListener?.();
      reset();
    };
  }, [connector, mutateAsync, reset, onClose, onError]);

  return (
    <WalletDialog
      title={WALLET_TEXT.walletConnect.title}
      description={WALLET_TEXT.walletConnect.description}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <div
        className="mx-auto w-56 max-w-full space-y-3 text-center"
        aria-busy={!uri}
      >
        {uri ? (
          <>
            <WalletQrCode uri={uri} />
            <WalletCopyButton
              value={uri}
              label={WALLET_TEXT.walletConnect.copyLink}
              onError={setCopyError}
            />
          </>
        ) : (
          <WalletConnectSkeleton />
        )}
      </div>
      {copyError && <Message error>{copyError}</Message>}
    </WalletDialog>
  );
}

function WalletConnectSkeleton() {
  return (
    <div
      role="status"
      aria-label={WALLET_TEXT.walletConnect.loading}
      className="space-y-3"
    >
      <Skeleton
        aria-hidden="true"
        className="aspect-square w-full rounded-lg motion-reduce:animate-none"
      />
      <Skeleton
        aria-hidden="true"
        className="h-8 w-full rounded-lg motion-reduce:animate-none"
      />
    </div>
  );
}

export function ConnectedWalletDialog({
  onClose,
  returnFocus,
}: WalletDialogProps) {
  const connection = useConnection();
  const disconnect = useDisconnect();
  if (!connection.address) return null;
  return (
    <WalletDialog
      title={WALLET_TEXT.connected.title}
      description={WALLET_TEXT.connected.description}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-3">
        <p>
          {connection.connector?.id === CONNECTOR_IDS.injected
            ? WALLET_TEXT.connected.genericName
            : connection.connector?.name}
        </p>
        <div className="flex items-center gap-2">
          <code
            className="text-center min-w-0 flex-1 break-all bg-card p-1 rounded"
            title={connection.address}
          >
            <span className="sm:hidden">
              {shortAddress(connection.address)}
            </span>
            <span className="hidden sm:inline">{connection.address}</span>
          </code>
          <WalletCopyButton
            value={connection.address}
            label={WALLET_TEXT.connected.copyAddress}
            iconOnly
          />
        </div>
        <p>
          {WALLET_TEXT.connected.network}{" "}
          {connection.chain?.name ??
            WALLET_TEXT.connected.unsupportedNetwork(connection.chainId)}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            disconnect.mutate();
            onClose();
          }}
        >
          <LogOut size={15} />
          {WALLET_TEXT.connected.disconnect}
        </Button>
      </div>
    </WalletDialog>
  );
}
