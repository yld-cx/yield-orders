"use client";
import { useId, type ReactNode } from "react";
import { Info, LoaderIcon, WalletIcon } from "lucide-react";
import { DURATIONS, type Duration } from "@yld-cx/sdk";
import { cn } from "@yld-cx/ui/lib/utils";
import { Field, FieldLabel } from "@yld-cx/ui/components/ui/field";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupText,
} from "@yld-cx/ui/components/ui/input-group";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@yld-cx/ui/components/ui/select";
import { Alert, AlertDescription } from "@yld-cx/ui/components/ui/alert";
import { Button } from "@yld-cx/ui/components/ui/button";
import { formatUnits } from "viem";
import { amountText } from "@/lib/utils";
export function AmountInput({
  label,
  value,
  onChange,
  symbol,
  balance,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  symbol: string;
  balance?: {
    value?: bigint;
    decimals: number;
    isPending?: boolean;
    isError?: boolean;
  };
  max?: {
    value: bigint;
    decimals: number;
  };
}) {
  const id = useId();
  const maximum = max ?? balance;
  const maxDisabled = max
    ? max.value <= 0n
    : !balance ||
      balance.isPending ||
      balance.isError ||
      balance.value === undefined ||
      balance.value <= 0n;
  return (
    <Field className="my-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {maximum && (
          <div className="ml-auto flex min-w-0 items-center justify-end gap-2 text-xs text-muted-foreground">
            {balance && (
              <div
                className="flex items-center gap-1 break-all text-right tabular-nums"
                aria-live="polite"
                aria-label="Wallet balance"
              >
                <WalletIcon className="size-3" aria-hidden="true" />
                {balance.isPending
                  ? "…"
                  : balance.value !== undefined
                    ? `${amountText(balance.value, balance.decimals)}`
                    : "—"}
              </div>
            )}
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto cursor-pointer px-0 py-0 text-muted-foreground font-bold hover:text-primary hover:no-underline"
              disabled={maxDisabled}
              onClick={() => {
                if (maximum.value !== undefined)
                  onChange(formatUnits(maximum.value, maximum.decimals));
              }}
            >
              Max
            </Button>
          </div>
        )}
      </div>
      <InputGroup>
        <InputGroupInput
          id={id}
          aria-label={label}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="0.00"
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            if (/^\d*(?:\.\d*)?$/.test(next)) onChange(next);
          }}
          className="tabular-nums"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupText>{symbol}</InputGroupText>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}
const durationItems = DURATIONS.map((duration) => ({
  value: String(duration),
  label: `${duration}D`,
  duration,
}));
export function DurationSelect({
  value,
  onChange,
  label = "Duration",
  inline = false,
}: {
  value: Duration;
  onChange: (duration: Duration) => void;
  label?: string;
  inline?: boolean;
}) {
  const id = useId();
  const select = (
    <Select
      items={durationItems}
      value={String(value)}
      onValueChange={(next) => {
        const selected = durationItems.find((item) => item.value === next);
        if (selected) onChange(selected.duration);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        className={inline ? "min-w-20" : undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {durationItems.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return inline ? (
    select
  ) : (
    <Field className="my-4">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {select}
    </Field>
  );
}
export function Metric({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <dl className="my-2 flex items-start justify-between gap-4 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="max-w-[65%] text-right font-medium break-words tabular-nums">
        {children}
      </dd>
    </dl>
  );
}
export function Message({
  children,
  error = false,
  busy = false,
  info = false,
  className,
}: {
  children: ReactNode;
  error?: boolean;
  busy?: boolean;
  info?: boolean;
  className?: string;
}) {
  return (
    <Alert
      className={cn("my-3 min-w-0 border-dashed break-all", className)}
      variant={error ? "destructive" : "default"}
      role={error ? "alert" : "status"}
    >
      {busy ? (
        <LoaderIcon
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
      ) : info ? (
        <Info aria-hidden="true" className="size-4" />
      ) : null}
      <AlertDescription className="min-w-0 text-[length:inherit] break-all">
        {children}
      </AlertDescription>
    </Alert>
  );
}
