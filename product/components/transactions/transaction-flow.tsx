"use client";
import { useRef, useState } from "react";
import { useConnection, useWalletClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { EconomicAction, Token, TransactionResult } from "@yld-cx/sdk";
import {
  explainError,
  protocolErrorName,
  PreviewChangedError,
  TransactionPendingError,
  humanPrice,
  priceAtTick,
  type NetworkSlug,
  type Preview,
  type TransactionStage,
  type InputRequirement,
  getNetwork,
} from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
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
      key={`${account.address}:${account.chainId}`}
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
  const [required, setRequired] = useState<InputRequirement>();
  const account = useConnection(),
    wallet = useWalletClient(),
    queries = useQueryClient();
  const sdk = getSdk(network);
  const busy = [
    "preparing",
    "verifying",
    "approving-reset",
    "approving",
    "simulating",
    "signing",
    "pending",
  ].includes(stage);
  const status = (next: TransactionStage, txHash?: `0x${string}`) => {
    setStage(next);
    if (txHash) setHash(txHash);
  };
  async function refresh(next: EconomicAction) {
    setStage("preparing");
    const input = await sdk.requiredInput(next);
    setRequired(input);
    if (input) {
      const [balance, allowance] = await Promise.all([
        sdk.balance(input.token, account.address!),
        sdk.allowance(input.token, account.address!),
      ]);
      if (balance < input.amount)
        throw new Error("Insufficient balance for this action");
      if (allowance < input.allowanceAmount) {
        setStage("approval");
        return;
      }
    }
    setStage("simulating");
    const simulated = await sdk.preview(next, account.address!);
    await validatePreview?.(simulated);
    setPreview(simulated);
    setStage("review");
  }
  async function review() {
    if (locked.current) return;
    locked.current = true;
    setError("");
    setHash(undefined);
    setOpen(true);
    setStage("preparing");
    try {
      if (!account.address) throw new Error("Connect your wallet first");
      const next = await prepare();
      setAction(next);
      await refresh(next);
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
      await sdk.approve(action, wallet.data, account.address, status);
      setWaiting(undefined);
      approved = true;
      // Approval never submits the main action. Refresh the confirmed allowance and simulation.
      await refresh(action);
    } catch (e) {
      setError(explainError(e));
      setWaiting(e instanceof TransactionPendingError ? "approval" : undefined);
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
      if (!wallet.data || !preview || preview.account !== account.address)
        throw new Error("Wallet changed. Review a new preview.");
      const result = await sdk.execute(preview, wallet.data, status);
      confirmed = true;
      setWaiting(undefined);
      await queries.invalidateQueries({
        predicate: (q) =>
          [
            "ticks",
            "pair",
            "portfolio",
            "quote",
            "deployment",
            "tick",
          ].includes(String(q.queryKey[0])) && q.queryKey[1] === network,
      });
      onSuccess?.(result);
    } catch (e) {
      if (confirmed) {
        setStage("confirmed");
        setError(
          `Transaction confirmed, but refreshing the view failed. ${explainError(e)}`,
        );
        return;
      }
      if (e instanceof PreviewChangedError) setPreview(e.preview);
      if (protocolErrorName(e) === "Expired") {
        try {
          const next = await prepare();
          setAction(next);
          await refresh(next);
        } catch {
          /* Preserve the current action if refreshing is unavailable. */
        }
      }
      setWaiting(e instanceof TransactionPendingError ? "execute" : undefined);
      if (e instanceof TransactionPendingError) setHash(e.hash);
      setError(explainError(e));
      setStage(preview ? "review" : "idle");
      if (
        !(e instanceof TransactionPendingError) &&
        required &&
        account.address
      ) {
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
  const actionName = label.replace(/^(?:Preview|Review)\s+/i, "");
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
          disabled ||
          busy ||
          !account.address ||
          account.chainId !== sdk.chainId ||
          !wallet.data
        }
        onClick={() => {
          if (action) setOpen(true);
          else void review();
        }}
      >
        <span aria-hidden="true">👀</span> {actionName}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next, details) => {
          if (busy) {
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
        disablePointerDismissal={busy}
      >
        <DialogContent
          showCloseButton={!busy}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        >
          <DialogHeader>
            <DialogTitle>
              {stage === "confirmed"
                ? "Transaction confirmed"
                : `Preview ${label.replace(/^(?:Preview|Review)\s+/i, "")}`}
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
          {stage === "approval" && required && (
            <>
              <Message>
                Approve the token to calculate your full preview. The action has
                not been simulated yet.
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
                reset to zero first. Approval alone does not execute the action.
              </details>
              <Button className="w-full" onClick={() => void approve()}>
                {waiting === "approval"
                  ? "Check approval confirmation"
                  : `Approve ${token?.symbol ?? "token"}`}
              </Button>
            </>
          )}
          {preview && (
            <TransactionPreview preview={preview} asset={asset} quote={quote} />
          )}{" "}
          {stage === "review" && (
            <Button className="w-full" onClick={() => void execute()}>
              {waiting === "execute"
                ? "Check transaction confirmation"
                : `Confirm ${actionName}`}
            </Button>
          )}
          {busy && (
            <div role="status" aria-live="polite">
              <Message>
                {stage === "pending"
                  ? "Waiting for onchain confirmation…"
                  : stage === "approving-reset"
                    ? "Reset allowance in your wallet…"
                    : stage === "approving"
                      ? "Approve token allowance in your wallet…"
                      : stage === "signing"
                        ? "Confirm the transaction in your wallet…"
                        : "Reading and simulating current state…"}
              </Message>
            </div>
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
          {stage === "confirmed" && (
            <Message>Confirmed. Market and Orders have been refreshed.</Message>
          )}
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
