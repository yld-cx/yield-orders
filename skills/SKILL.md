---
name: skills
description: Discover Yield Orders markets, inspect liquidity and positions, quote Limit, Swap and Rent, and prepare or simulate unsigned transactions on Ethereum, Base and Robinhood.
compatibility: Node.js 24 or later, network access, and a separate EVM wallet for transaction execution.
metadata:
  package: "@yld-cx/skills"
---

# Yield Orders

Yield Orders is a permissionless market for fixed-price swaps and fixed-term liquidity rentals. A Tick defines the **Asset** a provider supplies and a taker receives, the **Quote** token the taker pays or locks, the price in Quote per Asset, and the rental duration. For the displayed market pair an Ask supplies the market base token and a Bid supplies the market quote token. Inspect the actual Asset and Quote addresses before using either side.

- **Limit (Provide)** deposits Asset at the selected price and term. A taker can swap it for Quote or borrow it in a rental. Yield depends on utilization, vesting and settlement. The marginal term rate describes the current pool and does not predict provider returns.
- **Swap** pays Quote immediately for an exact amount of Asset. The protocol fee is deducted from Quote proceeds, so the quoted total already includes it.
- **Rent** receives Asset and locks Quote principal. The opening fixes the full-term rental yield in Asset. To recover Quote, the owner must repay the Asset principal and accrued Asset yield **before** maturity. If the rental expires, the renter keeps the Asset already received and forfeits the locked Quote. Providers receive the Quote net of the frozen close fee.

## Discover and quote

Run `npx @yld-cx/skills --help` and `npx @yld-cx/skills <command> --help` for JSON command and option schemas. Amounts are human-readable decimal strings, raw amounts and identifiers are exact decimal strings, and timestamps are Unix seconds.

```sh
npx @yld-cx/skills protocol
npx @yld-cx/skills networks
npx @yld-cx/skills markets --chain base --offset 0 --limit 10
npx @yld-cx/skills book --chain base \
  --token-a 0x4200000000000000000000000000000000000006 \
  --token-b 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
npx @yld-cx/skills balances --chain base --account "$ACCOUNT" --tokens "$ASSET" --tokens "$QUOTE"
npx @yld-cx/skills portfolio --chain base --account "$ACCOUNT"
npx @yld-cx/skills quote --chain base --operation rent --tick-id "$TICK_ID" --amount 0.001
```

The book scans an explicit price grid and term. Inspect `window.complete`, bids, asks and each level's available quantity. A successful empty window means no discovered ticks in that window. Change `--center-tick`, `--step-ticks`, `--radius` or `--duration-days` to explore more levels. Canonical ticks use ascending token-address order. Direction 1 uses the negative of the canonical tick. Pass negative values with `=`, as in `--center-tick=-196000`. For markets without a configured center, use `--reference-price` in market Quote per market base token or set the canonical center explicitly. A new Limit quote takes `--token-a`, `--token-b`, `--asset`, `--price`, `--duration-days` and `--amount` in place of `--tick-id`. The price is in Quote per deposited Asset.

Use Swap and Rent quotes to evaluate the same liquidity with different outcomes. Choose explicit caps after reviewing a quote. For Repay, quote by `--position-id` and leave headroom for the increase in accrued yield until inclusion. The latest chain timestamp determines availability. Quotes can change with settlement or competing transactions.

## Prepare, simulate and submit

Use `--operation provide|rent|swap|repay|withdraw|collect|close|settle` with `prepare` and `simulate`.

```sh
npx @yld-cx/skills prepare --chain base --account "$ACCOUNT" \
  --operation swap --tick-id "$TICK_ID" --amount 0.001 --max-quote-in "$MAX_QUOTE"
npx @yld-cx/skills simulate --chain base --account "$ACCOUNT" \
  --operation swap --tick-id "$TICK_ID" --amount 0.001 --max-quote-in "$MAX_QUOTE" --atomic
npx @yld-cx/skills status --chain base --hash "$TRANSACTION_HASH"
```

If the RPC supports batch simulation, `--atomic` simulates the approvals and protocol call together. Without it, simulation requires existing onchain approvals. Set `YLD_RPC_URL` to prefer a compatible read-only RPC. Remote endpoints fall back to the selected chain's viem default on provider failures, and loopback endpoints stay pinned to the local fork. A simulation is a snapshot. The wallet pays gas even on a revert.

Review the plan's chain, sender, destinations, input, limits and deadline. Authorize and send it using your wallet. Wallets with native atomic batching can execute all listed calls in order as one batch. A sequential wallet can confirm approvals in order, then refresh and simulate before sending the final protocol call. The final call includes any required protocol initialization atomically. Confirmed approvals may survive rejection or failure of a later transaction. Never split the final multicall. Use `status` to check the receipt. If a wallet has uncertain submission status, check its hash and nonce before trying again.

## Manage positions

Use `portfolio` to identify Tick IDs, rental IDs, available and working Asset, claimable proceeds, maturity and repayment requirements. Preserve `blockNumber` while paging if you need one snapshot.

- Repay takes `--position-id` and `--max-yield-asset`.
- Withdraw takes `--tick-id`, `--amount` and `--min-immediate-asset-out`. Available Asset can return immediately. Working principal can enter the Exit pool and resolve as rentals settle.
- Collect takes `--tick-id` and pays claimable Asset and Quote. Supply and Collect reset the provider vesting timestamp.
- Close takes `--position-id` and is permissionless at or after maturity. Settle takes `--tick-id` and processes the next expired rental at that Tick in settlement order.

Use the transaction receipt and a refreshed portfolio to verify the result.
