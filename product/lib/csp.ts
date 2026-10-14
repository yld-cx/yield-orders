const walletConnections = [
  "https://rpc.walletconnect.com",
  "https://relay.walletconnect.com",
  "https://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://pulse.walletconnect.org",
  "https://keys.walletconnect.com",
  "https://keys.coinbase.com",
  "https://api.wallet.coinbase.com",
];

export function contentSecurityPolicy(
  nonce: string,
  rpcOrigins: string[],
  development = false,
): string {
  const connections = [
    ...new Set([
      "'self'",
      ...rpcOrigins,
      ...walletConnections,
      ...(development ? ["ws:"] : []),
    ]),
  ];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connections.join(" ")}`,
    "frame-src https://verify.walletconnect.com https://verify.walletconnect.org https://keys.coinbase.com",
    "frame-ancestors 'self' https://app.safe.global https://safe.global",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(!development ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
