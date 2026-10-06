# yld.cx — Yield Orders

**Product Specification**  
**Version:** 0.3
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

v0.3 retains Product-Sum pooled accounting internally.

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

There are no provider shares in v0.3.

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
├── currently collectible Asset Yield
└── Quote proceeds
```

Uncollected Yield may continue vesting over the Tick duration.

Withdraw:

```text
selected Active principal
├── proportional Available → Asset now
└── proportional In Use    → Resolving
```

Collect:

```text
resolved Exit Asset
+ currently collectible net Asset Yield
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

Official v0.3 UI durations:

```text
7D | 30D
```

Default: `7D`.

The official UI presents duration as a dropdown for Supply and Use.

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
/orders           → current ACTIVE Use positions
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
Active Uses†
Network
```

Footnote:

> **\* Yield is earned when Used liquidity Repays. Close/Swap settles Quote instead.**

`Active Uses†` is optional market analytics. If shown, its source MUST be explicit (for example, an optional indexer / event-derived activity view or a future dedicated O(1) counter). The product MUST NOT imply that the protocol scans Term Positions or `tickPositionId` to calculate it, and execution never depends on this metric.

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

Official duration dropdown:

```text
7D | 30D
```

Default: `7D`.

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

No guaranteed APY. Every Supply (including a top-up) restarts Yield vesting for that provider's outstanding uncollected Yield. Show currently collectible Yield and the time to full vesting; Collect before additional Supply is optional.

---

# 11. Use

Panel:

```text
Receive Asset
Lock Quote
Duration
Current Yield
Max {Duration} Yield
Maturity
Solana account deposit (when applicable)
```

Example:

```text
Receive              1,000 TOKEN
Lock                12,000 USDC
Duration                [7D ▾]
Current Yield          0.20% / day
Max 7D Yield             14 TOKEN
Yield paid now              0
```

Exit / Resolving never disables Use when sufficient active Available exists.



On Solana, opening a Use creates a temporary TermPosition PDA and therefore locks a small SOL account deposit. The preview MUST surface that deposit separately from Quote Principal and protocol fees. It is returned to the stored rent payer on Repay; if the position expires and is Closed, the reclaimed SOL goes to the caller who performs settlement.

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



After successful Repay the ACTIVE Use position disappears from current Orders / Portfolio state. Historical Repay activity is event / transaction history.

On Solana, closing the TermPosition PDA returns its SOL account deposit to the stored rent payer.

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
position removed from active state
```

Close fee was frozen when Use opened.

It is independent of later utilization/Yield state.



After successful Close the Use position disappears from current Orders / Portfolio state. Historical Close activity is event / transaction history.

On Solana, the closed TermPosition PDA's reclaimed SOL goes to the caller that performs Close, including an automatic Close triggered by another economic action. This is storage recovery, not part of the 1% protocol fee.

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

At the market-wide proceeds level, providers receive at least 99% of posted Quote, subject to raw-unit fee rounding. Individual Active/Resolving allocations round to whole raw units; a very small Exit allocation may round to zero. Display the actual simulated result for the entered amount rather than implying every individual provider receives exactly 99%.

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
Allocated Yield (net)     5.94 TOKEN
Collectible Yield now      [preview] TOKEN
Yield fully collectible    [time remaining]
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

The adapter obtains current provider active principal from `getEarnPosition` or a simulated action and converts percentage to Asset-denominated principal. Both EVM and Solana execution use a deadline and minimum immediate Asset output; the minimum excludes the Yield paid in the same Withdraw. The adapter should surface the expected amount and execution bounds before signing.

No raw shares.

Preview:

```text
Withdraw                 50%

Receive principal now   200 TOKEN
Collectible Yield out   [preview] TOKEN
Unvested Yield          [preview] TOKEN
Move to Resolving       300 TOKEN-equivalent
```

Explanation:

> Available liquidity and vested Yield attributable to withdrawn principal are received now. Unvested Yield attributable to the withdrawal becomes an Asset protocol fee. In Use principal moves to Resolving; Repay resolves it as Asset + Yield and Close as Quote.

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

Collect everything currently claimable. Net Asset Yield becomes collectible linearly from the last Supply or Collect over the Tick duration; principal and Quote proceeds do not vest.

```text
Asset:
- Exit Asset principal
- currently collectible net active Asset Yield
- currently collectible net Exit Asset Yield

Quote:
- active Swap/Close proceeds
- Exit Close proceeds
```

All Yield is already net of the 1% Repay fee.

All Quote is already net of the 1% Swap/Close fee.

Collect charges no fee.

Collect may occur before Resolving is complete. Each Collect resets the position timestamp and restarts vesting of the remaining uncollected Yield. Multiple Collects at the same timestamp release no additional Yield. Collect before a new Supply is optional; Supply always resets the timestamp.

---

# 19. Withdraw before Collect

Supported:

```text
Withdraw first
Collect later
```

Withdraw releases the currently collectible Yield attributable to withdrawn Active principal and reclassifies its unvested remainder as an Asset protocol fee. Previously settled principal/Quote proceeds and outstanding Yield not attributable to withdrawn principal remain claimable according to the existing rules.

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
Multicall (Withdraw first, then Collect)
```

Solana:

```text
atomic instruction composition where limits permit
```

Semantics remain two canonical actions. Collect resets the timestamp; collecting first and then withdrawing at the same blockchain timestamp will fail the withdrawal time check. Adapters MUST preserve the `Withdraw → Collect` ordering and surface a dedicated timestamp/cooldown error rather than silently retrying or reversing the calls.

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



Portfolio — Use is current-state only. Once Repay or Close succeeds, the resolved position is removed rather than displayed with a terminal status. Historical activity may be shown by an optional event / transaction-history surface.

---

# 22. Orders

Orders is a **current position** view, not a permanent historical ledger.

Show ACTIVE Uses only.

Filters:

```text
All
Active
Ask
Bid
Market
Network
Wallet
```

Identity while ACTIVE:

```text
EVM     → numeric positionId
Solana  → TermPosition PDA / sequence
```

Position IDs / sequences are never reused, but resolved Term Position state is removed:

```text
Repay → disappears from Orders
Close → disappears from Orders
```

Historical Repaid / Closed activity belongs to optional transaction / event history, not canonical Orders state.

Always show network context.

---

# 23. Product previews and future SDK interface

The future TypeScript SDK in `product/` will simulate the real protocol path. Automatic settlement is protocol-enforced: the official client does not prepend `settle()` merely to make an economic action valid, and third-party callers cannot bypass the same one-sequence settlement rule.

For EVM, previews use OpenZeppelin `multicall(bytes[])` in `eth_call` with the connected caller and sufficient balances / allowances. Additional explicit `settle()` calls MAY be composed when the user intentionally wants more cursor progress, but they are not a replacement for per-action settlement.

| SDK preview | Simulated call and decoded result |
| --- | --- |
| `previewSupply` | `supply` + `getEarnPosition` + `getTick`; resulting principal and market state. |
| `previewWithdraw` | `withdraw` + `getEarnPosition` + `getTick`; immediate Asset, Working moved to Exit, vested Yield out, Unvested Yield, remaining claims. |
| `previewCollect` | `collect` + `getEarnPosition`; Asset, Quote and vested Yield paid, remaining claims. |
| `previewUse` | `use` + `getPosition` + `getTick`; Quote Principal, full-term Yield, frozen Close fee, maturity, resulting ACTIVE position. Read `nextPositionId` before the EVM batch. |
| `previewRepay` | `repay` return data + `getTick` / domain getters as needed; gross accrued Yield, Asset fee, total Asset in, Quote unlocked. The Term Position is deleted by the simulated action. |
| `previewSwap` | `swap` + `getTick`; Quote required, fee, provider proceeds. |
| `previewClose` | `close` return data + `getTick` / domain getters as needed; provider proceeds and Active/Exit accounting. The Term Position is deleted by the simulated action. |

The SDK MUST NOT attempt to read a resolved Term Position after Repay / Close.

The SDK may use `quoteUse(tickId, assetAmount)` before approval for Quote Principal and full-term Yield. This read-only quotation uses current state and does not simulate an expired cursor settlement. Quote, simulation, and transaction execution can see different market state or timestamps. Preserve `maxFullTermYieldAsset`, `maxYieldAsset`, `maxQuoteIn`, Withdraw's `minImmediateAssetOut`, and deadlines. Passing zero minimum and a permissive deadline keeps an unrestricted Withdraw option.

The EVM SDK must decode `bytes[]` with each call's ABI entry and verify that `eth_call` did not commit changes. The tests in `protocol/ethereum/test/PreviewIntegration.ts` are the reference integration workflow.

The Solana adapter simulates the corresponding program instruction with the canonical PDA/account bundle required by program-level `settle_one`. It MUST surface:

```text
TermPosition PDA creation deposit on Use
deposit refund destination on Repay
deposit recovery by caller on mature Close / automatic settlement
required ScaleState account creation cost
changed settlement-account bundle / rebuild requirement
```

Both adapters expose the same token-economic preview fields, minimum-immediate-output protection, and deadlines where relevant. Solana's account deposit is chain-native storage funding and is not presented as a YLD protocol fee.

Internal Product-Sum P/scale/generation and fractional remainders remain hidden from normal UX. A zero-value Collect must retain fractional Active and Exit entitlements for future distributions.

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
previewClose

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



`getUsePosition` and position enumeration are current-state only. Resolved Term Positions are absent. Adapters MAY expose separate event/history helpers, but canonical economic execution and current portfolio state never depend on an indexer.

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
resolved Use history
global history
```

Settlement never depends on indexer/yieldlist.

Connected-wallet portfolio discovery MUST NOT filter only on transferable whole-raw principal. If the adapter reports a live internal fixed-point principal remainder, nonzero fractional gain carry, pending claim, or unsynchronized historical gain, the position remains discoverable even when the displayed transferable principal is `0`. Fractional gain carry is not independently withdrawable and remains hidden from normal UX.



Current ACTIVE Uses MUST remain discoverable from canonical onchain state without historical Term Position retention.

---

# 26. Token compatibility risk

The product MUST not imply that immutable YLD can rescue incompatible token behavior. Supported markets assume exact-transfer, non-rebasing token semantics. If an admitted token later rebases, blacklists required protocol/user accounts, or changes transfer behavior incompatibly, affected actions may become unavailable for that Tick. There is no mutable admin rescue path.

This is product risk disclosure only; it does not change protocol economics or add governance.

---

# 27. Errors

User-facing messages explain economics:

```text
Yield changed. Review and try again.

Yield due increased while pending.
Review the updated Repay amount.

Liquidity changed.
Review the updated amount.

Part of your withdrawal is Resolving
because that liquidity is currently In Use.

Supply or Collect restarts your timestamp.
Withdraw requires blockchain time to advance.

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

# 28. Product principles

## Simple, self-explanatory UI/UX

The official yld.cx UI MUST be as simple and self-explanatory as possible.

Users should understand the economic action without understanding protocol internals.

Prefer clear terminology, sensible defaults, minimal required inputs, one primary action per panel, and progressive disclosure for secondary details.

Information that does not materially affect the user's decision or transaction SHOULD NOT appear in the primary UI.

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

# 29. Final supplier flow

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
11. Collect resolved Asset and Quote plus the currently collectible net Yield. Collect restarts remaining Yield vesting.
```

---

# 30. Final taker flow

```text
Use:
receive Asset
lock Quote
freeze full-term Yield
Repay before maturity
→ active position removed
or
Close at/after maturity
→ active position removed

Swap:
pay Quote
receive Asset immediately
```

---

# 31. Canonical product model

> **Return → Asset + Asset Yield. Swap → Quote.**

> **Protocol fee: 1%.**

> **Withdraw liquidity. Collect proceeds.**

The Product-Sum accounting that powers pooled ownership remains entirely internal.
