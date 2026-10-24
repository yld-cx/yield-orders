"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpFromLine,
  CircleCheck,
  CircleX,
  Coins,
  Crown,
  Droplets,
  Hourglass,
  LockKeyholeOpen,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useConnection,
  useWalletClient,
  useCapabilities,
  useSendCalls,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { EconomicAction, Token, TransactionResult } from "@yld-cx/sdk";
import {
  explainError,
  protocolErrorName,
  PreviewChangedError,
  TransactionTerminalError,
  AtomicUnavailableError,
  supportsAtomic,
  type NetworkSlug,
  type Preview,
  type TransactionStage,
  type InputRequirement,
  getNetwork,
} from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
import { QUERY_NAMES } from "@/lib/query-keys";
import { shortAddress, amountText } from "@/lib/utils";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message, Metric } from "@/components/forms/financial-fields";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "@yld-cx/ui/components/ui/dialog";
import { NetworkGuard } from "@/components/wallet/wallet-connect";
import { TransactionPreview } from "./transaction-preview";

const ACTION_ICONS: Record<string, LucideIcon> = {
  Provide: Droplets,
  Rent: Hourglass,
  Swap: ArrowLeftRight,
  Withdraw: ArrowUpFromLine,
  Collect: Coins,
  Repay: LockKeyholeOpen,
  Close: CircleX,
  Settle: CircleCheck,
  "Create Market": Crown,
};

export function TransactionFlow({
  network,
  label,
  prepare,
  asset,
  quote,
  disabled,
  showNetworkGuard = true,
  onSuccess,
  validatePreview,
}: {
  network: NetworkSlug;
  label: string;
  prepare: () => Promise<EconomicAction>;
  asset?: Token;
  quote?: Token;
  disabled?: boolean;
  showNetworkGuard?: boolean;
  onSuccess?: (result: TransactionResult) => void;
  validatePreview?: (preview: Preview) => void | Promise<void>;
}) {
  const account = useConnection();
  return (
    <TransactionSession
      key={`${network}:${account.address}:${account.chainId}`}
      network={network}
      label={label}
      prepare={prepare}
      asset={asset}
      quote={quote}
      disabled={disabled}
      showNetworkGuard={showNetworkGuard}
      onSuccess={onSuccess}
      validatePreview={validatePreview}
    />
  );
}
function TransactionSession({
  network,
  label,
  prepare,
  asset,
  quote,
  disabled,
  showNetworkGuard,
  onSuccess,
  validatePreview,
}: Parameters<typeof TransactionFlow>[0]) {
  const [stage, setStage] = useState<
    TransactionStage | "idle" | "preparing" | "approval" | "review"
  >("idle");
  const [error, setError] = useState(""),
    [preview, setPreview] = useState<Preview>(),
    [action, setAction] = useState<EconomicAction>(),
    [hash, setHash] = useState<string>(),
    [open, setOpen] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  const [atomicUnavailable, setAtomicUnavailable] = useState("");
  const [required, setRequired] = useState<InputRequirement>();
  const account = useConnection(),
    wallet = useWalletClient(),
    queries = useQueryClient();
  const sdk = getSdk(network);
  const capabilities = useCapabilities({
    chainId: sdk.chainId,
    query: {
      enabled: open && account.chainId === sdk.chainId && !!account.address,
      retry: false,
    },
  });
  const batch = useSendCalls();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const busy = [
    "preparing",
    "verifying",
    "approving-reset",
    "approving",
    "simulating",
    "signing",
    "submitted",
    "pending",
  ].includes(stage);
  const blocking = busy && stage !== "pending" && stage !== "submitted";
  const previewLoading = ["preparing", "verifying", "simulating"].includes(
    stage,
  );
  const status = (next: TransactionStage, txHash?: `0x${string}`) => {
    if (!mounted.current) return;
    setStage(next);
    if (txHash) setHash(txHash);
  };
  async function refresh(
    next: EconomicAction,
    minBlock?: bigint,
    sequential = !!atomicUnavailable,
  ) {
    setStage("preparing");
    const input = await sdk.requiredInput(next);
    setRequired(input);
    if (input) {
      const [balance, allowance] = await Promise.all([
        sdk.balance(input.token, account.address!),
        sdk.allowance(input.token, account.address!, minBlock),
      ]);
      if (balance < input.amount)
        throw new Error("Insufficient balance for this action");
      if (allowance < input.allowanceAmount) {
        const detected = await capabilities.refetch();
        if (!sequential && supportsAtomic(detected.data)) {
          setStage("simulating");
          try {
            const simulated = await sdk.preview(next, account.address!, {
              atomic: true,
            });
            await validatePreview?.(simulated);
            setPreview(simulated);
            setStage("review");
            return;
          } catch (e) {
            if (
              !/method.*(not found|not supported|not available)|unsupported.*(eth_simulate|simulation)/i.test(
                String(e),
              )
            )
              throw e;
            setAtomicUnavailable(
              "Atomic simulation is unavailable on this RPC. Approve separately to simulate the action before execution.",
            );
          }
        }
        setStage("approval");
        return;
      }
    }
    setStage("simulating");
    const simulated = await sdk.preview(next, account.address!, { minBlock });
    await validatePreview?.(simulated);
    setPreview(simulated);
    setStage("review");
  }
  async function review() {
    setOpen(true);
    if (locked.current) return;
    locked.current = true;
    setAction(undefined);
    setPreview(undefined);
    setRequired(undefined);
    setAtomicUnavailable("");
    setError("");
    setHash(undefined);
    setStage("preparing");
    try {
      if (!account.address) throw new Error("Connect your wallet first");
      const next = await prepare();
      setAction(next);
      await refresh(next, undefined, false);
    } catch (e) {
      setError(explainError(e));
      setStage("idle");
    } finally {
      locked.current = false;
    }
  }
  async function approve() {
    if (locked.current) return;
    locked.current = true;
    setError("");
    setHash(undefined);
    setStage("verifying");
    let approved = false;
    try {
      if (!wallet.data || !account.address || !action)
        throw new Error("Wallet unavailable");
      const minBlock = await sdk.approve(
        action,
        wallet.data,
        account.address,
        status,
      );
      approved = true;
      await refresh(action, minBlock);
    } catch (e) {
      setError(explainError(e));
      setStage(approved ? "idle" : "approval");
    } finally {
      locked.current = false;
    }
  }
  async function execute() {
    if (locked.current) return;
    locked.current = true;
    setError("");
    setHash(undefined);
    setStage("verifying");
    let confirmed = false;
    try {
      if (
        !wallet.data ||
        !preview ||
        preview.account.toLowerCase() !== account.address?.toLowerCase()
      )
        throw new Error("Wallet changed. Review a new preview.");
      const result = await sdk.execute(
        preview,
        wallet.data,
        status,
        async (calls) => {
          const detected = await capabilities.refetch();
          if (!supportsAtomic(detected.data))
            throw new AtomicUnavailableError(
              "Atomic capability changed. Review a new preview.",
            );
          await sdk.assertWallet(wallet.data!, preview.account);
          const sent = await batch.mutateAsync({
            account: preview.account,
            chainId: sdk.chainId,
            calls,
            forceAtomic: true,
          });
          return sent.id;
        },
      );
      confirmed = true;
      if (!mounted.current) return;
      await finish(result);
    } catch (e) {
      if (confirmed) {
        setStage("confirmed");
        setError(
          `Transaction confirmed, but refreshing the view failed. ${explainError(e)}`,
        );
        return;
      }
      if (e instanceof AtomicUnavailableError && action) {
        setAtomicUnavailable(e.message);
        setPreview(undefined);
        try {
          await refresh(action, undefined, true);
        } catch (refreshError) {
          setError(explainError(refreshError));
          setStage("idle");
        }
        return;
      }
      if (e instanceof PreviewChangedError) setPreview(e.preview);
      if (protocolErrorName(e) === "Expired") {
        try {
          const next = await prepare();
          setAction(next);
          await refresh(next);
          setError(explainError(e));
          return;
        } catch {
          /* Preserve the current action if refreshing is unavailable. */
        }
      }
      setError(explainError(e));
      if (e instanceof TransactionTerminalError) {
        setPreview(undefined);
        setStage("idle");
        return;
      }
      setStage(preview ? "review" : "idle");
      if (!preview?.walletCalls && required && account.address) {
        try {
          if (
            (await sdk.allowance(required.token, account.address)) <
            required.allowanceAmount
          )
            setStage("approval");
        } catch {
          /* Keep the preview available for another validated attempt. */
        }
      }
    } finally {
      locked.current = false;
    }
  }
  async function finish(result: TransactionResult) {
    if (!mounted.current) return;
    setStage("confirmed");
    setHash(result.hash);
    await Promise.all(
      [
        QUERY_NAMES.portfolio,
        QUERY_NAMES.quote,
        QUERY_NAMES.pair,
        QUERY_NAMES.ticks,
      ].map((name) =>
        queries.invalidateQueries({ queryKey: [name, getNetwork(network).id] }),
      ),
    );
    if (!mounted.current) return;
    onSuccess?.(result);
  }
  const actionName = label.replace(/^(?:Preview|Review)\s+/i, "");
  const ActionIcon = ACTION_ICONS[actionName] ?? Zap;
  const token = required
    ? [asset, quote].find(
        (t) => t?.address.toLowerCase() === required.token.toLowerCase(),
      )
    : undefined;
  return (
    <div className="transaction-flow">
      {showNetworkGuard && <NetworkGuard chainId={sdk.chainId} />}
      <Button
        className="w-full"
        aria-label={label}
        disabled={
          disabled ||
          blocking ||
          !account.address ||
          account.chainId !== sdk.chainId ||
          !wallet.data
        }
        onClick={() => void review()}
      >
        <ActionIcon aria-hidden="true" data-icon="inline-start" />
        {actionName}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next, details) => {
          if (blocking) {
            details.cancel();
            return;
          }
          setOpen(next);
          if (!next && stage === "confirmed") {
            setAction(undefined);
            setPreview(undefined);
            setStage("idle");
          }
        }}
        disablePointerDismissal={blocking}
      >
        <DialogContent
          showCloseButton={!blocking}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>
              {stage === "confirmed"
                ? "Transaction confirmed"
                : `Preview ${actionName}`}
            </DialogTitle>
            <DialogDescription>
              {getNetwork(network).name} · Verify amounts before signing.
            </DialogDescription>
          </DialogHeader>
          {atomicUnavailable && stage === "approval" && (
            <Message>{atomicUnavailable}</Message>
          )}
          {stage === "approval" && required && (
            <>
              <Message>
                Approve the token to simulate your full preview.
              </Message>
              <Metric label="Estimated payment">
                {token
                  ? `${amountText(required.amount, token.decimals)} ${token.symbol}`
                  : required.amount.toString()}
              </Metric>
              <p>
                Approve{" "}
                {token
                  ? `${amountText(required.allowanceAmount, token.decimals)} ${token.symbol}`
                  : `${required.allowanceAmount} raw units of ${shortAddress(required.token)}`}
                .
              </p>
              <details className="my-3 text-xs text-muted-foreground">
                <summary>Approval details</summary>
                Spender: <code>{sdk.address}</code>.
                <p>Approval does not execute the action.</p>
              </details>
              <Button className="w-full" onClick={() => void approve()}>
                {`Approve ${token?.symbol ?? "token"}`}
              </Button>
            </>
          )}
          {preview && !previewLoading && (
            <TransactionPreview preview={preview} asset={asset} quote={quote} />
          )}{" "}
          {stage === "review" && (
            <Button className="w-full" onClick={() => void execute()}>
              {preview?.walletCalls && preview.walletCalls.length > 1
                ? `Approve & ${actionName}`
                : `Confirm ${actionName}`}
            </Button>
          )}
          {busy && (
            <Message busy>
              {stage === "pending" || stage === "submitted"
                ? "Waiting for onchain confirmation…"
                : stage === "approving-reset"
                  ? "Reset allowance in your wallet…"
                  : stage === "approving"
                    ? "Approve token allowance in your wallet…"
                    : stage === "signing"
                      ? "Confirm the transaction in your wallet…"
                      : "Reading and simulating current state…"}
            </Message>
          )}
          {hash && (
            <a
              className="text-sm text-primary"
              href={`${getNetwork(network).chain.blockExplorers.default.url}/tx/${hash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View transaction ↗
            </a>
          )}
          {stage === "confirmed" && <Message>Confirmed ✅</Message>}
          {error && <Message error>{error}</Message>}
          {stage === "idle" && (
            <Button variant="outline" onClick={() => void review()}>
              Retry {actionName}
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
