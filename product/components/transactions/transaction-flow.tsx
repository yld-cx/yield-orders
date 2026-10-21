"use client";
import { useEffect, useRef, useState } from "react";
import {
  useConnection,
  useWalletClient,
  useCapabilities,
  useSendCalls,
  useCallsStatus,
} from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { GetCallsStatusReturnType } from "viem";
import type { EconomicAction, Token, TransactionResult } from "@yld-cx/sdk";
import {
  explainError,
  protocolErrorName,
  PreviewChangedError,
  TransactionPendingError,
  AtomicUnavailableError,
  supportsAtomic,
  type PendingOperation,
  humanPrice,
  priceAtTick,
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
export function TransactionFlow({
  network,
  label,
  prepare,
  asset,
  quote,
  disabled,
  onSuccess,
  validatePreview,
}: {
  network: NetworkSlug;
  label: string;
  prepare: () => Promise<EconomicAction>;
  asset?: Token;
  quote?: Token;
  disabled?: boolean;
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
  const [waiting, setWaiting] = useState<"approval" | "execute">();
  const [operation, setOperation] = useState<PendingOperation>();
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
  const callsStatus = useCallsStatus({
    id: operation?.identifier === "calls" ? (operation.id ?? "") : "",
    query: {
      enabled:
        open &&
        operation?.identifier === "calls" &&
        !!operation.id &&
        operation.status !== "confirmed" &&
        operation.status !== "reverted",
      retry: false,
      refetchInterval: 2000,
    },
  });
  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => {
      if (account.address) setOperation(sdk.pending(account.address));
    }, 0);
    return () => {
      clearTimeout(timer);
      mounted.current = false;
    };
  }, [sdk, account.address]);
  const busy = [
    "preparing",
    "verifying",
    "approving-reset",
    "approving",
    "simulating",
    "signing",
    "submitted",
    "synchronizing",
    "pending",
  ].includes(stage);
  const blocking = busy && stage !== "pending" && stage !== "submitted";
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
    if (account.address) {
      const pending = sdk.pending(account.address);
      if (pending && pending.status !== "reverted") {
        setOperation(pending);
        setAction(pending!.action);
        setWaiting(
          pending!.phase.startsWith("approval") ? "approval" : "execute",
        );
        setStage(pending!.phase.startsWith("approval") ? "approval" : "review");
        if (pending!.identifier === "transaction") setHash(pending!.id);
        return;
      }
      sdk.clearTerminal(account.address);
      setOperation(undefined);
    }
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
      setWaiting(undefined);
      approved = true;
      await refresh(action, minBlock);
    } catch (e) {
      setError(
        e instanceof TransactionPendingError && e.outcome === "pending"
          ? ""
          : explainError(e),
      );
      const pending = account.address
        ? sdk.pending(account.address)
        : undefined;
      setOperation(pending);
      setWaiting(pending ? "approval" : undefined);
      if (e instanceof TransactionPendingError) setHash(e.hash);
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
      if (operation || (account.address && sdk.pending(account.address))) {
        await recover();
        return;
      }
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
      setWaiting(undefined);
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
      const pending = account.address
        ? sdk.pending(account.address)
        : undefined;
      setOperation(pending);
      setWaiting(pending ? "execute" : undefined);
      if (
        e instanceof TransactionPendingError &&
        pending?.identifier !== "calls"
      )
        setHash(e.hash);
      setError(explainError(e));
      setStage(preview ? "review" : "idle");
      if (!pending && !preview?.walletCalls && required && account.address) {
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
  async function finish(result: TransactionResult, recovered = false) {
    if (!mounted.current) return;
    setStage("confirmed");
    setWaiting(undefined);
    setOperation(undefined);
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
    if (account.address) sdk.clearTerminal(account.address);
    if (!recovered) onSuccess?.(result);
  }
  async function recover(knownStatus?: GetCallsStatusReturnType) {
    if (!wallet.data || !account.address)
      throw new Error(
        "Connect the submitting wallet and network to resume tracking.",
      );
    const pending = sdk.pending(account.address);
    if (!pending) throw new Error("No pending operation");
    const batchState =
      pending.identifier === "calls"
        ? (knownStatus ?? (await callsStatus.refetch()).data)
        : undefined;
    const result = await sdk.recover(
      wallet.data,
      account.address,
      status,
      batchState,
    );
    if ("approvalBlock" in result) {
      setOperation(undefined);
      setWaiting(undefined);
      setPreview(undefined);
      const next = await prepare();
      setAction(next);
      await refresh(next, result.approvalBlock);
    } else await finish(result, true);
  }

  async function check(knownStatus?: GetCallsStatusReturnType) {
    if (locked.current) return;
    locked.current = true;
    setError("");
    try {
      await recover(knownStatus);
    } catch (e) {
      setError(
        e instanceof TransactionPendingError && e.outcome === "pending"
          ? ""
          : explainError(e),
      );
      const pending = account.address
        ? sdk.pending(account.address)
        : undefined;
      setOperation(pending);
      if (pending?.status === "reverted") {
        sdk.clearTerminal(account.address!);
        setOperation(undefined);
        setWaiting(undefined);
        setPreview(undefined);
        setStage("idle");
      } else if (pending)
        setStage(pending.phase.startsWith("approval") ? "approval" : "review");
      else setStage("idle");
    } finally {
      locked.current = false;
    }
  }
  function clearPending() {
    if (locked.current || !account.address) return;
    const pending = sdk.pending(account.address);
    if (!pending || pending.id) return;
    sdk.operations.remove(account.address);
    setOperation(undefined);
    setWaiting(undefined);
    setPreview(undefined);
    setHash(undefined);
    setError("");
    setStage("idle");
  }
  useEffect(() => {
    if (
      open &&
      operation?.identifier === "calls" &&
      callsStatus.data &&
      !locked.current
    )
      void check(callsStatus.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callsStatus.dataUpdatedAt, open, operation?.id]);
  useEffect(() => {
    if (
      !open ||
      operation?.status !== "confirmed" ||
      !operation.phase.startsWith("approval")
    )
      return;
    const timer = setInterval(() => {
      if (!locked.current) void check();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, operation?.status, operation?.phase]);
  const actionName =
    waiting && operation
      ? {
          supply: "Provide",
          use: "Rent",
          swap: "Swap",
          repay: "Repay",
          withdraw: "Withdraw",
          collect: "Collect",
          close: "Close",
          settle: "Settle",
          createPair: "Create Market",
          createTick: "Create Market",
        }[operation.action.kind]
      : label.replace(/^(?:Preview|Review)\s+/i, "");
  const token = required
    ? [asset, quote].find(
        (t) => t?.address.toLowerCase() === required.token.toLowerCase(),
      )
    : undefined;
  return (
    <div className="transaction-flow">
      <NetworkGuard chainId={sdk.chainId} />
      <Button
        className="w-full"
        aria-label={label}
        disabled={
          (disabled && !operation) ||
          blocking ||
          !account.address ||
          account.chainId !== sdk.chainId ||
          !wallet.data
        }
        onClick={() => void review()}
      >
        <span aria-hidden="true">👀</span> {actionName}
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
              {getNetwork(network).name} · Verify all amounts before signing.
            </DialogDescription>
          </DialogHeader>
          {!preview && action?.kind === "supply" && action.initialize && (
            <>
              <Metric label="You provide">
                {asset
                  ? `${amountText(action.amount, asset.decimals)} ${asset.symbol}`
                  : action.amount.toString()}
              </Metric>
              <Metric label="Price">
                {humanPrice(
                  priceAtTick(action.initialize.priceTick),
                  asset?.decimals ?? 0,
                  quote?.decimals ?? 0,
                )}{" "}
                {quote?.symbol ?? "Quote"} / {asset?.symbol ?? "Asset"}
              </Metric>
              <Metric label="Duration">
                {action.initialize.durationDays}D
              </Metric>
            </>
          )}
          {atomicUnavailable && stage === "approval" && (
            <Message>{atomicUnavailable}</Message>
          )}
          {operation && waiting && (
            <Message>
              {!operation.id
                ? "The transaction may have been submitted. Check your wallet before clearing pending state, since it might still execute. Clearing does not cancel the transaction."
                : operation.identifier === "calls"
                  ? `Wallet batch ${operation.id}. Awaiting verified onchain execution.`
                  : "A submitted operation is being tracked. Checking confirmation never submits another transaction."}
            </Message>
          )}
          {waiting ? (
            <Button
              className="w-full"
              disabled={busy}
              onClick={() =>
                operation && !operation.id ? clearPending() : void check()
              }
            >
              {operation && !operation.id
                ? "Clear pending state"
                : waiting === "approval"
                  ? "Check approval confirmation"
                  : "Check transaction confirmation"}
            </Button>
          ) : (
            stage === "approval" &&
            required && (
              <>
                <Message>
                  Approve the token to calculate your full preview. The action
                  has not been simulated yet.
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
                  Spender: <code>{sdk.address}</code>. If needed, allowance is
                  reset to zero first. Approval alone does not execute the
                  action.
                </details>
                <Button className="w-full" onClick={() => void approve()}>
                  {`Approve ${token?.symbol ?? "token"}`}
                </Button>
              </>
            )
          )}
          {preview && (
            <TransactionPreview preview={preview} asset={asset} quote={quote} />
          )}{" "}
          {stage === "review" && !waiting && (
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
                : stage === "synchronizing"
                  ? "Approval confirmed. Synchronizing allowance and refreshing simulation…"
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
