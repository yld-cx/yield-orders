"use client";
import { useId } from "react";
import { registry } from "@/lib/registry";
import { getNetwork, type NetworkSlug } from "@yld-cx/sdk/ethereum";
import type { Token } from "@yld-cx/sdk";
import { TokenIcon } from "./token-icon";
import { Input } from "@yld-cx/ui/components/ui/input";
import {
  Field,
  FieldLabel,
  FieldDescription,
} from "@yld-cx/ui/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@yld-cx/ui/components/ui/select";
export function TokenSelector({
  label,
  network,
  value,
  onChange,
  token,
}: {
  label: string;
  network: NetworkSlug;
  value: string;
  onChange: (address: string) => void;
  token?: Token;
}) {
  const id = useId(),
    tokens = registry.getTokens(getNetwork(network).id),
    listed = tokens.some((t) => t.address === value.toLowerCase());
  const items = [
    { value: "custom", label: "Custom token address…" },
    ...tokens.map((t) => ({
      value: t.address,
      label: t.symbol,
    })),
  ];
  return (
    <Field className="my-4">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={listed ? value.toLowerCase() : "custom"}
        onValueChange={(next) => {
          if (next) onChange(next === "custom" ? "" : next);
        }}
      >
        <SelectTrigger
          id={id}
          aria-label={`${label} selection`}
          className="w-full"
        >
          {token && <TokenIcon token={token} size={24} />}
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!listed && (
        <Input
          aria-label={`${label} address`}
          placeholder="0x… token contract address"
          value={value}
          onChange={(event) => onChange(event.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      {token && !listed && (
        <FieldDescription>
          {token.symbol}{" "}
          {!token.listed && <span className="text-primary">· Unlisted</span>}
        </FieldDescription>
      )}
    </Field>
  );
}
