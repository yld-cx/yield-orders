import { formatUnits } from "viem";
export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
export function amountText(
  amount: bigint,
  decimals: number,
  precision = 6,
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
    new Date(Number(value) * 1000).toLocaleString("en-GB", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " UTC"
  );
}
