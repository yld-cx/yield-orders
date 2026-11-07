const tokens: Record<
  string,
  { symbol: string; name: string; decimals: number }
> = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": {
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
  },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  },
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": {
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
  },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": {
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
  },
  "0x4200000000000000000000000000000000000006": {
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
  },
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": {
    symbol: "cbBTC",
    name: "Coinbase Wrapped Bitcoin",
    decimals: 8,
  },
};

// Worker and RPC mocks share identities so fallback reads remain distinguishable.
// Unknown addresses represent test contracts, each with an explicit RPC result.
export function tokenFixture(address: string) {
  const normalized = address.toLowerCase();
  return (
    tokens[normalized] ?? {
      symbol: `TKN${normalized.slice(-6)}`,
      name: `Test token ${normalized}`,
      decimals: 18,
    }
  );
}
