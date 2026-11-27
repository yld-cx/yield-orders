"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection, useWalletClient } from "wagmi";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  isAddress,
  isAddressEqual,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { base } from "viem/chains";
import {
  coinbaseBatch,
  coinbaseOwnerBytes,
  coinbaseWalletAbi,
  isCoinbaseOwner,
} from "@yld-cx/sdk/coinbase";
import { explainError, tokenAmount } from "@yld-cx/sdk/ethereum";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@yld-cx/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@yld-cx/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@yld-cx/ui/components/ui/dialog";
import { Badge } from "@yld-cx/ui/components/ui/badge";
import { AmountInput, Message } from "@/components/forms/financial-fields";
import { TokenSelector } from "@/components/markets/token-selector";
import {
  NetworkGuard,
  WalletConnect,
} from "@/components/wallet/wallet-connect";
import { WalletCopyButton } from "@/components/wallet/wallet-copy-button";
import { useToken } from "@/hooks/use-market";
import { MCP_ORIGIN } from "@/lib/endpoints";
import { getSdk } from "@/lib/rpc";
import {
  agentWalletLimit,
  deployAgentWallet,
  discoverAgentWallets,
  readAgentSigner,
  requestAgentSigner,
  requireMainOwner,
  wasAgentWalletCreated,
  type AgentWallet,
} from "@/lib/agent-wallets";

const sdk = () => getSdk("base");
const PAGE_SIZE = 10;
type Action =
  | "Create Agent Wallet"
  | "Deposit"
  | "Withdraw"
  | "Add Gas"
  | "Connect Agent"
  | "Replace"
  | "Revoke";
type Call = { to: Address; value: bigint; data: Hex };
type ActionResult = { created?: boolean; address?: Address; secret?: string };

export function AgentsScreen() {
  const { address, chainId, connector } = useConnection();
  return (
    <section className="mx-auto max-w-3xl space-y-5 pt-8">
      {address && connector && chainId === base.id ? (
        <AgentWallets key={`${connector.uid}/${address}`} main={address} />
      ) : (
        <>
          <h1 className="text-2xl font-semibold">Agent Wallets</h1>
          {address && connector ? (
            <NetworkGuard chainId={base.id} />
          ) : (
            <>
              <p className="text-muted-foreground">
                Connect your main wallet to manage Agent Wallets on Base.
              </p>
              <WalletConnect />
            </>
          )}
        </>
      )}
    </section>
  );
}

function AgentWallets({ main }: { main: Address }) {
  const rpc = sdk().publicClient;
  const [creation, setCreation] = useState<AgentWallet>();
  const [message, setMessage] = useState<string>();
  const [requestedPage, setPage] = useState(1);
  const accounts = useQuery({
    queryKey: ["agent-wallets", base.id, main],
    queryFn: () => discoverAgentWallets(rpc, main),
  });
  const snapshot = accounts.data;
  const next = snapshot?.next;
  const pageCount = Math.ceil((snapshot?.wallets.length ?? 0) / PAGE_SIZE);
  const page = Math.min(requestedPage, Math.max(1, pageCount));
  const start = (page - 1) * PAGE_SIZE;
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Agent Wallets</h1>
        <Button
          variant="outline"
          className="ml-auto"
          disabled={!next || accounts.isError || accounts.isFetching}
          onClick={() => {
            setMessage(undefined);
            setCreation(next);
          }}
        >
          <Plus size={16} aria-hidden="true" /> Agent Wallet
        </Button>
      </header>
      {message && <Message>{message}</Message>}
      {accounts.isPending && (
        <p role="status">Discovering Agent Wallets on Base…</p>
      )}
      {accounts.isError && (
        <>
          <Message error>{explainError(accounts.error)}</Message>
          <Button variant="outline" onClick={() => void accounts.refetch()}>
            Retry discovery
          </Button>
        </>
      )}
      {snapshot?.wallets.length === 0 && <p>No Agent Wallets found on Base.</p>}
      {accounts.isSuccess && !next && (
        <Message>All {agentWalletLimit} wallet slots are deployed.</Message>
      )}
      {pageCount > 1 && (
        <nav
          aria-label="Agent Wallet pagination"
          className="flex flex-wrap items-center justify-end gap-3 text-sm"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span aria-live="polite">
            Page {page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === pageCount}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </nav>
      )}
      {snapshot?.wallets.slice(start, start + PAGE_SIZE).map(({ address }) => (
        <AgentWalletCard
          key={address}
          account={address}
          main={main}
          blockNumber={snapshot.blockNumber}
          onWalletChanged={() => void accounts.refetch()}
        />
      ))}
      {creation && (
        <WalletAction
          action="Create Agent Wallet"
          account={creation.address}
          main={main}
          creation={creation}
          close={() => setCreation(undefined)}
          onSuccess={(result) => {
            setCreation(undefined);
            setMessage(
              result?.created
                ? "Agent Wallet created on Base."
                : "This slot is already deployed. Refreshing Agent Wallets.",
            );
            void accounts.refetch().then(({ data }) => {
              if (!result?.created || !data) return;
              const position = data.wallets.findIndex(
                ({ index }) => index === creation.index,
              );
              if (position !== -1)
                setPage(Math.floor(position / PAGE_SIZE) + 1);
            });
          }}
        />
      )}
    </>
  );
}

function AgentWalletCard({
  account,
  main,
  blockNumber,
  onWalletChanged,
}: {
  account: Address;
  main: Address;
  blockNumber: bigint;
  onWalletChanged: () => void;
}) {
  const rpc = sdk().publicClient;
  const [action, setAction] = useState<Action>();
  const [connectionUrl, setConnectionUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const auth = useQuery({
    queryKey: ["agent-wallet-signer", account, main, blockNumber.toString()],
    staleTime: Infinity,
    queryFn: async () => {
      const signer = await readAgentSigner(rpc, account, main, blockNumber);
      if (!signer) return null;
      const gas = await rpc.getBalance({
        address: signer.address,
        blockNumber,
      });
      return { address: signer.address, gas };
    },
    retry: false,
  });
  const signer = auth.data?.address;
  function start(next: Action) {
    setMessage(undefined);
    setError(undefined);
    setConnectionUrl(undefined);
    setAction(next);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Wallet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all text-sm">{account}</code>
          <WalletCopyButton
            value={account}
            label="Copy Agent Wallet address"
            iconOnly
            onError={setError}
          />
          <a
            href={`${base.blockExplorers.default.url}/address/${account}`}
            className="ml-auto inline-flex items-center gap-1 text-sm underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Explorer <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => start("Deposit")}>
            Deposit
          </Button>
          <Button variant="outline" onClick={() => start("Withdraw")}>
            Withdraw
          </Button>
        </div>
        <div className="space-y-3 border-t pt-4">
          <h3 className="font-medium">Agent signer</h3>
          {auth.isPending && <p role="status">Checking agent authorization…</p>}
          {auth.isError && <Message error>{explainError(auth.error)}</Message>}
          {auth.isSuccess && auth.data && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all text-sm">{auth.data.address}</code>
                <WalletCopyButton
                  value={auth.data.address}
                  label="Copy agent signer address"
                  iconOnly
                  onError={setError}
                />
                <Badge variant="outline">Authorized onchain</Badge>
              </div>
              <p>Signer gas balance · {formatEther(auth.data.gas)} ETH</p>
            </>
          )}
          {auth.isSuccess && (
            <div className="flex flex-wrap gap-2">
              {signer ? (
                <>
                  <Button variant="outline" onClick={() => start("Add Gas")}>
                    Add Gas
                  </Button>
                  <Button variant="outline" onClick={() => start("Replace")}>
                    Replace
                  </Button>
                  <Button variant="outline" onClick={() => start("Revoke")}>
                    Revoke
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => start("Connect Agent")}
                >
                  Connect Agent
                </Button>
              )}
            </div>
          )}
        </div>
        {message && <Message>{message}</Message>}
        {error && <Message error>{error}</Message>}
        {action && (
          <WalletAction
            action={action}
            account={account}
            main={main}
            signer={signer}
            close={() => setAction(undefined)}
            onSuccess={(result) => {
              setAction(undefined);
              if (result?.address && result.secret)
                setConnectionUrl(`${MCP_ORIGIN}/${account}/${result.secret}`);
              setMessage(
                action === "Revoke"
                  ? "Agent authorization revoked onchain."
                  : "Transaction confirmed.",
              );
              onWalletChanged();
            }}
          />
        )}
        {!!connectionUrl && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setConnectionUrl(undefined);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Agent MCP URL</DialogTitle>
                <DialogDescription>
                  Store this bearer credential securely. Anyone with it can
                  request allowed actions. Replacing the signer invalidates its
                  wallet access.
                </DialogDescription>
              </DialogHeader>
              <code className="break-all text-xs">{connectionUrl}</code>
              <WalletCopyButton
                value={connectionUrl}
                label="Copy MCP URL"
                onError={() => setError("Could not copy the MCP URL")}
              />
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}

function WalletAction({
  action,
  account,
  main,
  signer,
  creation,
  close,
  onSuccess,
}: {
  action: Action;
  account: Address;
  main: Address;
  signer?: Address;
  creation?: AgentWallet;
  close: () => void;
  onSuccess: (result?: ActionResult) => void;
}) {
  const rpc = sdk().publicClient;
  const wallet = useWalletClient({ chainId: base.id });
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("");
  const [eth, setEth] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState<Hex>();
  const locked = useRef(false);
  const confirm = useRef<() => Promise<void>>(undefined);
  const funding = ["Deposit", "Withdraw", "Add Gas"].includes(action);
  const native = eth || action === "Add Gas";
  const isToken = !native && isAddress(asset) && asset !== zeroAddress;
  const token = useToken("base", asset, funding && isToken);
  const source = action === "Withdraw" ? account : main;
  const destination =
    action === "Deposit" ? account : action === "Add Gas" ? signer : main;
  const balance = useQuery({
    queryKey: ["agent-wallet-balance", source, native ? "ETH" : asset],
    enabled: funding && (native || isToken),
    queryFn: () =>
      native
        ? rpc.getBalance({ address: source })
        : sdk().balance(asset as Address, source),
  });
  const decimals = native ? 18 : token.data?.decimals;

  async function submit() {
    if (locked.current) return;
    locked.current = true;
    setPending(true);
    setError("");
    try {
      if (confirm.current) {
        await confirm.current();
        return;
      }
      const client = wallet.data;
      if (!client || !isAddressEqual(client.account.address, main))
        throw new Error("Reconnect the main Coinbase wallet");
      const send = async (
        call: Call,
        onConfirmed: (receipt: TransactionReceipt) => void | Promise<void>,
      ) => {
        await rpc.call({ account: main, ...call });
        const tx = await client.sendTransaction({
          account: client.account,
          chain: base,
          ...call,
        });
        setHash(tx);
        let confirmedReceipt: TransactionReceipt | undefined;
        confirm.current = async () => {
          if (!confirmedReceipt) {
            let replaced = false;
            const receipt = await rpc.waitForTransactionReceipt({
              hash: tx,
              confirmations: 2,
              timeout: 90000,
              onReplaced: ({ reason }) => {
                replaced = reason !== "repriced";
              },
            });
            if (replaced || receipt.status !== "success") {
              setHash(undefined);
              confirm.current = undefined;
              throw new Error(
                replaced
                  ? "The wallet replaced this transaction"
                  : "The transaction reverted",
              );
            }
            confirmedReceipt = receipt;
          }
          await onConfirmed(confirmedReceipt);
        };
        await confirm.current();
      };
      if (creation) {
        if ((await rpc.getChainId()) !== base.id)
          throw new Error("Agent Wallets require Base");
        const code = await rpc.getCode({ address: account });
        if (code && code !== "0x") {
          onSuccess({ created: false });
          return;
        }
        await send(deployAgentWallet(main, creation.index), async (receipt) => {
          const created = wasAgentWalletCreated(receipt.logs, creation, main);
          if (created) await requireMainOwner(rpc, account, main);
          onSuccess({ created });
        });
        return;
      }
      const blockNumber = await requireMainOwner(rpc, account, main);
      if (funding) {
        if (decimals === undefined || !destination)
          throw new Error("Select the asset and destination");
        if (action === "Add Gas") {
          const current = await readAgentSigner(
            rpc,
            account,
            main,
            blockNumber,
          );
          if (!current || !isAddressEqual(current.address, destination))
            throw new Error(
              "The agent signer changed. Reopen Add Gas and try again.",
            );
        }
        const raw = tokenAmount(amount, decimals);
        const available = native
          ? await rpc.getBalance({ address: source })
          : await sdk().balance(asset as Address, source);
        if (raw <= 0n || raw > available)
          throw new Error(
            "Enter a positive amount within the available balance",
          );
        const transfer = native
          ? { to: destination, value: raw, data: "0x" as const }
          : {
              to: asset as Address,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "transfer",
                args: [destination, raw],
              }),
            };
        if (!native) {
          const { data } = await rpc.call({ account: source, ...transfer });
          if (
            data &&
            data !== "0x" &&
            !decodeFunctionResult({
              abi: erc20Abi,
              functionName: "transfer",
              data,
            })
          )
            throw new Error("The token rejected the transfer");
        }
        await send(
          action === "Withdraw"
            ? { to: account, value: 0n, data: coinbaseBatch([transfer]) }
            : transfer,
          (receipt) => {
            if (!native) {
              const transferred = parseEventLogs({
                abi: erc20Abi,
                eventName: "Transfer",
                logs: receipt.logs.filter(({ address }) =>
                  isAddressEqual(address, transfer.to),
                ),
              }).some(
                ({ args }) =>
                  isAddressEqual(args.from, source) &&
                  isAddressEqual(args.to, destination) &&
                  args.value > 0n,
              );
              if (!transferred)
                throw new Error(
                  "The confirmed transaction did not report the token transfer",
                );
            }
            onSuccess();
          },
        );
        return;
      }
      const current = await readAgentSigner(rpc, account, main, blockNumber);
      if (action === "Connect Agent" && current)
        throw new Error("An agent signer is already connected");
      if (
        action !== "Connect Agent" &&
        (!current || !signer || !isAddressEqual(current.address, signer))
      )
        throw new Error(
          "The agent signer changed. Reopen the action and try again.",
        );
      const generated =
        action === "Revoke" ? undefined : await requestAgentSigner();
      const calls: Call[] = [];
      if (generated)
        calls.push({
          to: account,
          value: 0n,
          data: encodeFunctionData({
            abi: coinbaseWalletAbi,
            functionName: "addOwnerAddress",
            args: [generated.address],
          }),
        });
      if (current)
        calls.push({
          to: account,
          value: 0n,
          data: encodeFunctionData({
            abi: coinbaseWalletAbi,
            functionName: "removeOwnerAtIndex",
            args: [current.index, coinbaseOwnerBytes(current.address)],
          }),
        });
      await send(
        calls.length === 1
          ? calls[0]
          : { to: account, value: 0n, data: coinbaseBatch(calls) },
        async () => {
          const confirmedBlock = await requireMainOwner(rpc, account, main);
          if (
            current &&
            (await isCoinbaseOwner(
              rpc,
              account,
              current.address,
              confirmedBlock,
            ))
          )
            throw new Error("The previous signer is still authorized");
          if (
            generated &&
            !(await isCoinbaseOwner(
              rpc,
              account,
              generated.address,
              confirmedBlock,
            ))
          )
            throw new Error("New signer authorization could not be verified");
          onSuccess(generated);
        },
      );
    } catch (cause) {
      setError(explainError(cause));
    } finally {
      locked.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action}</DialogTitle>
          <DialogDescription>
            {creation
              ? "Deploy this Agent Wallet on Base with your main wallet as its only owner."
              : action === "Add Gas"
                ? "Send Base ETH directly to the agent signer for transaction gas."
                : action === "Withdraw"
                  ? "Send available Agent Wallet assets back to your main wallet. Existing positions stay open."
                  : action === "Deposit"
                    ? "Send assets from your main wallet to this Agent Wallet on Base."
                    : "The main wallet must authorize this ownership change. An agent signer has full onchain owner authority."}
          </DialogDescription>
        </DialogHeader>
        {creation && <code className="break-all text-sm">{account}</code>}
        {funding && (
          <>
            {action !== "Add Gas" && (
              <div className="flex gap-2">
                <Button
                  variant={eth ? "default" : "outline"}
                  onClick={() => setEth(true)}
                >
                  ETH
                </Button>
                <Button
                  variant={eth ? "outline" : "default"}
                  onClick={() => setEth(false)}
                >
                  ERC-20
                </Button>
              </div>
            )}
            {!native && (
              <TokenSelector
                label="Token"
                network="base"
                value={asset}
                onChange={setAsset}
                token={token.data}
              />
            )}
            <AmountInput
              label="Amount"
              value={amount}
              onChange={setAmount}
              symbol={native ? "ETH" : (token.data?.symbol ?? "")}
              balance={
                decimals === undefined
                  ? undefined
                  : {
                      value: balance.data,
                      decimals,
                      isPending: balance.isPending,
                      isError: balance.isError,
                    }
              }
            />
          </>
        )}
        {error && <Message error>{error}</Message>}
        {hash && <p className="break-all text-xs">Transaction hash · {hash}</p>}
        <Button disabled={pending} onClick={() => void submit()}>
          {pending
            ? "Waiting for confirmation…"
            : hash
              ? "Check confirmation"
              : action}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
