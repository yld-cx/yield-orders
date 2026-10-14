"use client";
import { useState } from "react";
import {
  useConnect,
  useConnectors,
  useConnection,
  useDisconnect,
  useSwitchChain,
  type Connector,
} from "wagmi";
import QRCode from "qrcode";
import { Wallet, LogOut } from "lucide-react";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "@yld-cx/ui/components/ui/dialog";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
import { shortAddress } from "@/lib/utils";
import { explainError } from "@yld-cx/sdk/ethereum";
export function distinctConnectors(
  connectors: readonly Connector[],
): Connector[] {
  const announced = connectors.filter(
    (c) => c.type === "injected" && c.id !== "injected",
  );
  const seen = new Set<string>();
  return connectors.filter((c) => {
    if (c.id === "injected" && announced.length > 0) return false;
    if (
      c.id === "coinbaseWalletSDK" &&
      announced.some((a) => /coinbase/i.test(a.name))
    )
      return false;
    const identity = c.id;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
function Qr({ uri }: { uri: string }) {
  const qr = QRCode.create(uri, { errorCorrectionLevel: "L" });
  let path = "";
  for (let y = 0; y < qr.modules.size; y++)
    for (let x = 0; x < qr.modules.size; x++)
      if (qr.modules.get(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  return (
    <svg
      className="mx-auto size-56 max-w-full rounded-lg"
      viewBox={`0 0 ${qr.modules.size + 8} ${qr.modules.size + 8}`}
      role="img"
      aria-label="WalletConnect QR code"
    >
      <rect width="100%" height="100%" fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
export function WalletConnect() {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [uri, setUri] = useState("");
  const connection = useConnection();
  const connect = useConnect();
  const connectors = useConnectors();
  const disconnect = useDisconnect();
  async function choose(connector: Connector) {
    setError("");
    setUri("");
    try {
      if (connector.id === "walletConnect") {
        const provider = (await connector.getProvider()) as {
          on: (event: string, callback: (uri: string) => void) => void;
          removeListener: (
            event: string,
            callback: (uri: string) => void,
          ) => void;
        };
        const listener = (value: string) => setUri(value);
        provider.on("display_uri", listener);
        try {
          await connect.mutateAsync({ connector });
        } finally {
          provider.removeListener("display_uri", listener);
        }
      } else await connect.mutateAsync({ connector });
      setOpen(false);
      setUri("");
    } catch (e) {
      setError(explainError(e));
    }
  }
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={<Button variant="outline" />}
          aria-label={
            connection.address
              ? shortAddress(connection.address)
              : "Connect wallet"
          }
        >
          <Wallet size={16} aria-hidden="true" />
          <span className="hidden sm:inline">
            {connection.address
              ? shortAddress(connection.address)
              : "Connect wallet"}
          </span>
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {connection.isConnected ? "Your wallet" : "Connect wallet"}
            </DialogTitle>
            <DialogDescription>
              Choose your wallet. Your funds stay in your control.
            </DialogDescription>
          </DialogHeader>
          {connection.address && (
            <div className="flex flex-col gap-3">
              <p>{connection.connector?.name}</p>
              <code>{connection.address}</code>
              <p>
                Wallet network:{" "}
                {connection.chain?.name ??
                  `Unsupported (${connection.chainId})`}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  disconnect.mutate();
                  setOpen(false);
                }}
              >
                <LogOut size={15} />
                Disconnect
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-2">
            {distinctConnectors(connectors).map((c) => (
              <Button
                key={c.uid}
                variant="outline"
                disabled={connect.isPending}
                onClick={() => void choose(c)}
              >
                {c.name}
              </Button>
            ))}
          </div>
          {connect.isPending && <Message>Waiting for your wallet…</Message>}
          {uri && (
            <div className="space-y-3 text-center">
              <Qr uri={uri} />
              <p>Scan with a WalletConnect wallet.</p>
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(uri)
                    .catch(() => setError("Clipboard unavailable"))
                }
              >
                Copy connection link
              </Button>
            </div>
          )}
          {!process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID && (
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Mobile WalletConnect is unavailable until a project ID is
              configured.
            </p>
          )}
          {error && <Message error>{error}</Message>}
        </DialogContent>
      </Dialog>
    </>
  );
}
export function NetworkGuard({ chainId }: { chainId: number }) {
  const connection = useConnection(),
    switchChain = useSwitchChain();
  if (!connection.isConnected)
    return <Message>Connect a wallet to transact.</Message>;
  if (connection.chainId === chainId) return null;
  return (
    <div className="message">
      <p>
        Your wallet is on {connection.chain?.name ?? "an unsupported network"}.
      </p>
      <Button
        variant="outline"
        onClick={() => switchChain.mutate({ chainId })}
        disabled={switchChain.isPending}
      >
        Switch wallet network
      </Button>
      {switchChain.error && (
        <Message error>{explainError(switchChain.error)}</Message>
      )}
    </div>
  );
}
