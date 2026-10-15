import {
  SHORT_ADDRESS,
  FORMAT_PRECISION,
  MILLISECONDS_PER_SECOND,
} from "@yld-cx/sdk";
import { formatUnits } from "viem";
export function shortAddress(address: string) {
  return `${address.slice(0, SHORT_ADDRESS.prefix)}…${address.slice(-SHORT_ADDRESS.suffix)}`;
}
export function amountText(
  amount: bigint,
  decimals: number,
  precision: number = FORMAT_PRECISION.amount,
): string {
  const value = formatUnits(amount, decimals);
  const [whole, f = ""] = value.split(".");
  if (amount > 0n && whole === "0" && Number(f.slice(0, precision)) === 0)
    return `<0.${"0".repeat(precision - 1)}1`;
  const tail = f.slice(0, precision).replace(/0+$/, "");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (tail ? "." + tail : "");
}
export function timestampText(value: bigint): string {
  return (
    new Date(Number(value) * MILLISECONDS_PER_SECOND).toLocaleString("en-GB", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " UTC"
  );
}
