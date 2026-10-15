import { isAddress, zeroAddress } from "viem";
import type { NetworkId } from "../types/index.ts";
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function decodeBase58(value: string): Uint8Array {
  if (!value || value.length > 64) throw new Error("Invalid Base58 address");
  let n = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid Base58 address");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}
export function normalizeAddress(network: NetworkId, address: string): string {
  if (network.startsWith("eip155:")) {
    if (
      !isAddress(address, { strict: false }) ||
      address.toLowerCase() === zeroAddress
    )
      throw new Error("Invalid EVM token address");
    return address.toLowerCase();
  }
  if (decodeBase58(address).length !== 32)
    throw new Error("Invalid Solana public key");
  return address;
}
export function canonicalPair(
  network: NetworkId,
  a: string,
  b: string,
): readonly [string, string] {
  a = normalizeAddress(network, a);
  b = normalizeAddress(network, b);
  if (a === b) throw new Error("Select two different tokens");
  if (network.startsWith("eip155:"))
    return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const aa = decodeBase58(a),
    bb = decodeBase58(b);
  for (let i = 0; i < 32; i++) {
    if (aa[i] !== bb[i]) return aa[i] < bb[i] ? [a, b] : [b, a];
  }
  throw new Error("Select two different tokens");
}
export function pairKey(network: NetworkId, a: string, b: string): string {
  return canonicalPair(network, a, b).join(":");
}
