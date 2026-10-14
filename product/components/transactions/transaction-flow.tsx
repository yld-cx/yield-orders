"use client";
import { useState } from "react";
import { useConnection, useWalletClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import type { EconomicAction, Token, TransactionResult } from "@yld-cx/sdk";
import {
  explainError,
  type NetworkSlug,
  type Preview,
  type TransactionStage,
  getNetwork,
} from "@yld-cx/sdk/ethereum";
import { getSdk } from "@/lib/rpc";
import { shortAddress, amountText } from "@/lib/utils";
import { Button } from "@yld-cx/ui/components/ui/button";
import { Message } from "@/components/forms/financial-fields";
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
}: {
  network: NetworkSlug;
  label: string;
  prepare: () => Promise<EconomicAction>;
  asset?: Token;
  quote?: Token;
  disabled?: boolean;
  onSuccess?: (result: TransactionResult) => void;
}) {
  const account = useConnection();
  // Account/network/form changes remount the review so stale approval is never reused.
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
}: Parameters<typeof TransactionFlow>[0]) {
  const [stage, setStage] = useState<
    TransactionStage | "idle" | "preparing" | "approval" | "review"
  >("idle");
  const [error, setError] = useState(""),
    [preview, setPreview] = useState<Preview>(),
    [action, setAction] = useState<EconomicAction>(),
    [hash, setHash] = useState<string>(),
    [open, setOpen] = useState(false);
  const [required, setRequired] = useState<{
    token: `0x${string}`;
    amount: bigint;
  }>();
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
  async function simulate(next: EconomicAction) {
    setStage("simulating");
    setPreview(await sdk.preview(next, account.address!));
    setStage("review");
  }
  async function review() {
    setError("");
    setHash(undefined);
    setPreview(undefined);
    setOpen(true);
    setStage("preparing");
    try {
      if (!account.address) throw new Error("Connect your wallet first");
      await sdk.verifyDeployment();
      const next = await prepare();
      setAction(next);
      const input = await sdk.requiredInput(next);
      setRequired(input);
      if (input) {
        const [balance, allowance] = await Promise.all([
          sdk.balance(input.token, account.address),
          sdk.allowance(input.token, account.address),
        ]);
        if (balance < input.amount)
          throw new Error("Insufficient balance for the execution limit");
        if (allowance < input.amount) {
          setStage("approval");
          return;
        }
      }
      await simulate(next);
    } catch (e) {
      setError(explainError(e));
      setStage("idle");
    }
  }
  async function approve() {
    setError("");
    try {
      if (!wallet.data || !account.address || !action)
        throw new Error("Wallet unavailable");
      await sdk.approve(action, wallet.data, account.address, status);
      await simulate(action);
    } catch (e) {
      setError(explainError(e));
      setStage("idle");
    }
  }
  async function execute() {
    setError("");
    try {
      if (!wallet.data || !preview || preview.account !== account.address)
        throw new Error("Wallet changed. Review a new preview.");
      const result = await sdk.execute(preview, wallet.data, status);
      await queries.invalidateQueries({
        predicate: (q) =>
          [
            "ticks",
            "known-ticks",
            "pair",
            "portfolio",
            "quote",
            "deployment",
            "tick",
          ].includes(String(q.queryKey[0])) && q.queryKey[1] === network,
      });
      onSuccess?.(result);
    } catch (e) {
      setError(explainError(e));
      setStage("idle");
    }
  }
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
        disabled={
          disabled ||
          busy ||
          !account.address ||
          account.chainId !== sdk.chainId ||
          !wallet.data
        }
        onClick={() => void review()}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next, details) => {
          if (busy) {
            details.cancel();
            return;
          }
          setOpen(next);
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
          {stage === "approval" && required && (
            <>
              <Message>
                Approval required before the economic simulation.
              </Message>
              <p>
                Approve{" "}
                {token
                  ? `${amountText(required.amount, token.decimals)} ${token.symbol}`
                  : `${required.amount} raw units of ${shortAddress(required.token)}`}
                .
              </p>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Spender: <code>{sdk.address}</code>. If needed, the current
                allowance is reset to zero first. Approval alone does not
                execute the action.
              </p>
              <Button className="w-full" onClick={() => void approve()}>
                Approve exact amount &amp; simulate
              </Button>
            </>
          )}
          {preview && (
            <TransactionPreview preview={preview} asset={asset} quote={quote} />
          )}{" "}
          {stage === "review" && (
            <Button className="w-full" onClick={() => void execute()}>
              Confirm in wallet
            </Button>
          )}
          {busy && (
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
              Refresh and review again
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
