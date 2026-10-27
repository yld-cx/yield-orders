"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@yld-cx/ui/components/ui/button";
import { COPY_FEEDBACK_DURATION_MS, WALLET_TEXT } from "./wallet-config";

export function WalletCopyButton({
  value,
  label,
  iconOnly = false,
  onError,
}: {
  value: string;
  label: string;
  iconOnly?: boolean;
  onError?: (error: string) => void;
}) {
  const [copiedValue, setCopiedValue] = useState<string>();
  const request = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const copied = copiedValue === value;

  useEffect(
    () => () => {
      request.current += 1;
      clearTimeout(resetTimer.current);
    },
    [value],
  );

  async function copy() {
    const currentRequest = ++request.current;
    clearTimeout(resetTimer.current);
    setCopiedValue(undefined);
    try {
      await navigator.clipboard.writeText(value);
      if (currentRequest !== request.current) return;
      setCopiedValue(value);
      resetTimer.current = setTimeout(
        () => setCopiedValue(undefined),
        COPY_FEEDBACK_DURATION_MS,
      );
    } catch {
      if (currentRequest === request.current)
        onError?.(WALLET_TEXT.clipboard.unavailable);
    }
  }

  return (
    <Button
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon" : "default"}
      className={iconOnly ? undefined : "w-full"}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      onClick={() => void copy()}
    >
      {copied ? (
        <Check size={16} aria-hidden="true" />
      ) : (
        <Copy size={16} aria-hidden="true" />
      )}
      {!iconOnly && (copied ? WALLET_TEXT.clipboard.copied : label)}
    </Button>
  );
}
