# yld.cx — Yield Orders

**Product Specification**  
**Version:** 0.2
**Targets:** Ethereum / EVM + Solana
**Depends on:** `spec/protocol.md`

---

# 1. Product summary

> **yld.cx — liquidity rental markets.**  
> **provide or rent tokens at your price.**

The product presents Yield Orders as its own trading/liquidity primitive, not conventional lending.

Supplier:

```text
posts Asset at a price
```

Taker:

```text
Use  → receive Asset temporarily and lock Quote
Swap → accept the price immediately
```

Use outcomes:

```text
Repay → Asset + Asset Yield
Close → Quote at posted price
```

Core protocol framing:

> **Asset moves. Quote locks.**

---

# 2. Internal accounting is invisible

v0.2 uses Product-Sum pooled accounting internally.

Users MUST NOT see:

```text
P
scale
generation
gain sums
snapshots
fixed-point principal remainder
historical scale state
```

There are no provider shares in v0.2.

The product deals only with economic amounts:

```text
Active liquidity
Available
In Use
Resolving
Claimable
```

---

# 3. Supplier mental model

Supplier liquidity has:

```text
Active
├── Available
└── In Use

Resolving
└── withdrawn In Use principal

Claimable
├── Exit Asset
├── Asset Yield
└── Quote proceeds
```

Withdraw:

```text
selected Active principal
├── proportional Available → Asset now
└── proportional In Use    → Resolving
```

Collect:

```text
resolved Exit Asset
+ net Asset Yield
+ active Swap/Close Quote
+ Exit Close Quote
```

No share terminology.

---

# 4. Ask / Bid

For:

```text
TOKEN | USDC
```

Ask:

```text
Asset = TOKEN
Quote = USDC
```

Bid:

```text
Asset = USDC
Quote = TOKEN
```

Canonical rule:

> **Yield denomination = Asset. Swap settlement denomination = Quote.**

---

# 5. Duration

Official v0.2 UI:

```text
7D
```

Protocol supports positive whole-number day durations.

Use freezes the maximum full-term Asset Yield quote.

Actual Repay Yield:

```text
grows with elapsed time
minimum billable interval = 1 second
```

Close pays no Asset Yield.

---

# 6. Navigation

```text
yld.cx | Yield | Orders
```

Right:

```text
Network | Wallet
```

Routes:

```text
/                 → Yield / recent markets
/market/:pair     → symmetric market
/orders           → permanent Term Position ledger
/portfolio        → connected-wallet portfolio
```

---

# 7. Networks

Target selector:

```text
Ethereum
Base
Robinhood
Solana
More...
```

Liquidity is deployment-local.

No implicit cross-chain aggregation.

---

# 8. Yield page

Recommended:

```text
Market
Ask Liquidity
Ask Yield*
Bid Liquidity
Bid Yield*
Active Uses
Network
```

Footnote:

> **\* Yield is earned when Used liquidity Repays. Close/Swap settles Quote instead.**

Yield is the marginal current Asset Yield reference.

A concrete Use preview is authoritative for its entered amount.

---

# 9. Market page

Layout:

```text
[Post Ask / Post Bid]   [Yield Book]   [Use / Swap]
```

Yield Book:

```text
Price
Available Liquidity
In Use
Current Yield
```

`Available Liquidity` means executable active Available.

`In Use` means active Working only.

Resolving Exit Working is not executable depth.

Pending Resolving does not pause the market.

---

# 10. Supply

Supplier chooses:

```text
side
price
amount
```

Official duration:

```text
7D
```

Preview:

```text
You supply
Price
Active available liquidity
Active in-use liquidity
Current Yield
```

Preferred wording:

```text
Yield when used and returned
```

No guaranteed APY.

---

# 11. Use

Panel:

```text
Receive Asset
Lock Quote
Current Yield
Max 7D Yield
Term
Maturity
```

Example:

```text
Receive              1,000 TOKEN
Lock                12,000 USDC
Current Yield          0.20% / day
Max 7D Yield             14 TOKEN
Yield paid now              0
Term                       7D
```

Exit / Resolving never disables Use when sufficient active Available exists.

---

# 12. Repay

Before maturity:

```text
Return Asset
Current Yield Due
Protocol Fee · 1% of Yield
Total Asset to Return
Unlock Quote
```

The taker transfers:

```text
Asset principal
+ gross accrued Asset Yield
```

The protocol fee is 1% of gross Yield.

Full Quote Principal unlocks.

Product wording:

> **Return earlier, pay less Yield.**

Principal itself is never charged a protocol fee.

---

# 13. Close

At/after maturity:

```text
Expired / Closeable
```

Preview:

```text
Asset remains with Use user
Locked Quote settles
Asset Yield due      0
Protocol Fee · 1%
Provider Net
status → CLOSED
```

Close fee was frozen when Use opened.

It is independent of later utilization/Yield state.

---

# 14. Immediate Swap

Show:

```text
Receive
Pay
Price
Execution: Immediate
Protocol Fee · 1%
Provider Net
```

Also:

```text
No term
No locked principal
No Repay
No Term Position
No Asset Yield
```

Taker pays exactly Quote Principal.

Fee is deducted from provider Quote proceeds.

Providers receive at least 99% of posted Quote, subject to raw-unit fee rounding.

---

# 15. Unified fee UX

Canonical product rule:

> **Protocol fee: 1%.**

Detailed:

```text
Swap  → 1% of Quote Principal
Close → 1% of Quote Principal
Repay → 1% of earned Asset Yield
```

No fee on:

```text
Repay Asset principal
Repay Quote refund
Collect
Withdraw principal
```

---

# 16. Portfolio — Earn

Example:

```text
TOKEN | USDC · Ask · 7D
Price                12.00 USDC

Active
Available              700 TOKEN
In Use                  300 TOKEN

Your Active Liquidity 1,000 TOKEN

[Withdraw]

Resolving
In Use                  120 TOKEN-equivalent

Claimable
Exit Asset               40 TOKEN
Earned Yield (net)        5.94 TOKEN
Exit Quote              960 USDC
Swapped               6,000 USDC

[Collect]
```

`Your Active Liquidity` is the provider's current compounded active principal rounded down to transferable raw Asset units.

It is not a share balance. The protocol may retain an invisible sub-raw fixed-point principal remainder for accounting correctness; the product does not expose that implementation detail.

---

# 17. Withdraw UX

Controls:

```text
25%   50%   75%   Max
```

The adapter obtains current provider active principal from preview and converts percentage to Asset-denominated principal.

No raw shares.

Preview:

```text
Withdraw                 50%

Receive now             200 TOKEN
Move to Resolving       300 TOKEN-equivalent
```

Explanation:

> Available liquidity is received now. Liquidity currently In Use moves to Resolving. Repay resolves it as Asset + Yield; Close resolves it as Quote.

For Max:

```text
principalAmount =
    current previewed transferable active principal
```

If market state changes before inclusion and the amount is no longer valid, refresh and rebuild.

`Max` means all currently transferable whole raw Asset units. A sub-raw internal accounting remainder may remain; it is not displayed as user-facing liquidity and is never silently converted into somebody else's claim.

There is no share dust-burn UX.

---

# 18. Collect

Collect everything currently claimable:

```text
Asset:
- Exit Asset principal
- net active Asset Yield
- net Exit Asset Yield

Quote:
- active Swap/Close proceeds
- Exit Close proceeds
```

All Yield is already net of the 1% Repay fee.

All Quote is already net of the 1% Swap/Close fee.

Collect charges no fee.

Collect may occur before Resolving is complete.

---

# 19. Withdraw before Collect

Supported:

```text
Withdraw first
Collect later
```

Already-funded economics are not lost.

After Max Withdraw:

```text
Transferable Active liquidity = 0
Resolving                    >= 0
Claimable                    >= 0
```

A sub-raw accounting remainder MAY exist internally and remains hidden from normal UX.

---

# 20. Withdraw & Collect

Optional convenience:

```text
Withdraw & Collect
```

EVM:

```text
Multicall
```

Solana:

```text
atomic instruction composition where limits permit
```

Semantics remain two canonical actions.

---

# 21. Portfolio — Use

ACTIVE Use:

```text
Market
Side
Asset received
Quote locked

Current Yield
Current Yield Due
Max Yield

Opened
Maturity
Status
```

Before maturity:

```text
[Repay]
```

At/after maturity:

```text
[Close]
```

Close is permissionless.

---

# 22. Orders

Permanent Term Position ledger.

Filters:

```text
All
Active
Repaid
Closed
Ask
Bid
Market
Network
Wallet
```

Identity:

```text
EVM     → permanent numeric positionId
Solana  → permanent TermPosition PDA
```

Always show network context.

---

# 23. Previews

Every state-changing preview includes the same automatic one-step settlement projection as execution.

Supply preview:

```text
Asset supplied
resulting provider Active principal
market Available / In Use
```

Withdraw preview:

```text
current transferable provider Active principal
requested principal
Receive now
Move to Resolving
remaining transferable Active principal
resulting Resolving principal
```

Use preview:

```text
Asset
Quote Principal
Current Yield
Full-term Yield
frozen Close Fee
maturity
```

Repay:

```text
Asset principal
gross Yield
1% Yield fee
total Asset in
Quote unlocked
```

Swap:

```text
Asset
Quote Principal
1% fee
Provider Net
```

Collect:

```text
Asset out
Quote out
remaining Resolving
```

Internal P/scale/generation must not be required for normal UX.

---

# 24. Adapter model

Common chain-neutral operations:

```text
getMarkets
getPair
getTick
getEarnPosition
getUsePosition

previewSupply
previewWithdraw
previewUse
previewRepay
previewSwap
previewCollect

supply
withdraw
collect
use
repay
swap
close
settleTick
```

Adapters hide:

```text
EVM ABI
Solana PDAs/accounts
Product-Sum scale state
generation state
fixed-point sub-raw provider principal
settlement cursor account bundles
```

---

# 25. Discovery

`yieldlist.json` remains optional curated discovery only.

Never source-of-truth for:

```text
liquidity
Yield
provider principal
claims
fees
positions
settlement
execution
```

Canonical state is onchain.

Indexer remains optional for:

```text
search
recent activity
analytics
global history
```

Settlement never depends on indexer/yieldlist.

Connected-wallet portfolio discovery MUST NOT filter only on transferable whole-raw principal. If the adapter reports a live internal fixed-point principal remainder, pending claim, or unsynchronized historical gain, the position remains discoverable even when the displayed transferable principal is `0`.

---

# 26. Errors

User-facing messages explain economics:

```text
Yield changed. Review and try again.

Yield due increased while pending.
Review the updated Repay amount.

Liquidity changed.
Review the updated amount.

Part of your withdrawal is Resolving
because that liquidity is currently In Use.

Newly supplied liquidity cannot be
withdrawn in the same block/slot.

This position has matured and can no longer be Repaid.

This position is not mature yet.

Settlement state changed.
Refresh and try again.
```

Never expose:

```text
P mismatch
scale state
generation snapshot
sum accumulator
```

as primary product copy.

---

# 27. Product principles

Avoid framing as:

```text
borrow/lend
health factor
liquidation
variable-rate lending
```

Preferred:

```text
Yield Order
Ask
Bid
Supply
Use
Swap
Repay
Close
Withdraw
Collect
Available
In Use
Resolving
Yield
Claimable
```

---

# 28. Final supplier flow

```text
1. Post Asset at a chosen price.
2. Asset appears as Available.
3. Use may move some Available → In Use.
4. Repay returns Asset + elapsed Asset Yield.
5. Close converts In Use into Quote at posted price.
6. Immediate Swap converts Available into Quote immediately.
7. Withdraw a percentage of current Active principal.
8. Available portion is received immediately.
9. In Use portion becomes Resolving.
10. Repay/Close resolves Resolving first.
11. Collect resolved Asset + net Yield + Quote whenever desired.
```

---

# 29. Final taker flow

```text
Use:
receive Asset
lock Quote
freeze full-term Yield
Repay before maturity
or
Close at/after maturity

Swap:
pay Quote
receive Asset immediately
```

---

# 30. Canonical product model

> **Return → Asset + Asset Yield. Swap → Quote.**

> **Protocol fee: 1%.**

> **Withdraw liquidity. Collect proceeds.**

The Product-Sum accounting that powers pooled ownership remains entirely internal.
