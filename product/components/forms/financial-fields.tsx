"use client";
import { useId, type ReactNode } from "react";
import { DURATIONS, type Duration } from "@yld-cx/sdk";
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
export function AmountInput({
  label,
  value,
  onChange,
  symbol,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  symbol: string;
}) {
  const id = useId();
  return (
    <Field className="my-4">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
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
  label: string;
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
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Alert
      className="my-3 border-dashed"
      variant={error ? "destructive" : "default"}
      role={error ? "alert" : "status"}
    >
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
