# yld.cx - Yield Orders

**Product Specification**
**Targets:** Ethereum / EVM L2s + Solana
**Version:** 0.1

---

# 1. Product summary

yld.cx presents Yield Orders as a trading primitive, not as lending.

A supplier posts liquidity at a predefined price. A taker can consume the same liquidity in two ways:

1. **Use** — take the Asset temporarily, lock Quote, pay Yield, then Repay before maturity or let the position Close as the predefined Swap.
2. **Swap** — accept the predefined exchange immediately.

Core supplier framing:

> **Set your price. Earn when liquidity is used — or trade when your price is accepted.**

Core protocol framing:

> **Asset moves. Quote locks.**

The public action vocabulary is identical on EVM and Solana:

```text
Post Ask / Post Bid
Withdraw
Collect
Use
Repay
Swap
Close
```

---

# 2. Final supplier mental model

Supplier liquidity has two live Asset states:

```text
Available Asset
Working Asset / In Use
```

and two claimable Quote components:

```text
Swapped Quote principal
Earned Yield
```

The UX distinction is final:

```text
Withdraw → remaining Asset principal
Collect  → realized Quote principal + earned Yield
```

Swapped Quote is displayed beside Yield under the **Claimable** section for collection convenience, but it is not labeled as Yield.

A provider may Withdraw before Collect without losing accrued Quote/Yield. Withdraw synchronizes accounting first; claimable amounts remain until Collect.

## 2.1 Pooled principal, historical proceeds

The official product hides protocol share math, but its economic behavior is fixed:

```text
Available + In Use = one pooled remaining-principal position
Historical Claimable = separate receivable
```

A supplier entering a tick joins the tick's **current remaining principal**, including any existing In Use principal, at the protocol's pro-rata share price. Available and In Use are pooled states, not individually reserved balances belonging to specific suppliers.

Historical proceeds do not transfer to later suppliers:

- Yield already generated belongs to the shareholders that owned shares when the Use generated that Yield.
- Swap/Close Quote already realized belongs to the shareholders that owned shares when it was realized.
- A new supplier receives no historical Claimable amount.

Before Withdraw burns shares, the protocol locks everything earned so far into that provider's Claimable balance. Therefore a provider may fully withdraw, have zero current liquidity, and still Collect historical proceeds later.

Once a provider has zero shares:

```text
historical Claimable → remains collectible
future Yield         → 0
future Swap/Close    → 0
```

If existing In Use principal later Repays or Closes after share ownership has changed, its **principal resolution belongs to the current shareholders**. Any Yield that was already paid when that Use originally opened remains with the shareholders that earned it at opening.

This is intentionally a pooled-liquidity model. The UI MUST NOT imply that a particular Working/In Use unit remains personally reserved to the supplier who originally funded the pool.

---

# 3. Ask / Bid semantics

For market:

```text
TOKEN | USDC
```

## Ask

```text
Asset = TOKEN
Quote = USDC
```

Supplier posts TOKEN.

If Used:

```text
Taker receives TOKEN
Taker locks USDC
Taker pays Yield in USDC
```

If Repaid:

```text
TOKEN returns to Available
locked USDC returns to taker
Yield remains claimable to supplier
```

If Closed or immediately Swapped:

```text
TOKEN principal becomes claimable USDC Swap proceeds
```

## Bid

```text
Asset = USDC
Quote = TOKEN
```

Supplier posts USDC.

If Used:

```text
Taker receives USDC
Taker locks TOKEN
Taker pays Yield in TOKEN
```

If Repaid:

```text
USDC returns to Available
locked TOKEN returns to taker
Yield remains claimable to supplier
```

If Closed or immediately Swapped:

```text
USDC principal becomes claimable TOKEN Swap proceeds
```

Therefore Yield may be denominated in either token depending on direction.

---

# 4. Product principles

The UI MUST NOT present yld.cx as conventional lending.

Avoid primary language:

```text
borrow
lend
utilization
health factor
liquidation
variable borrow APR
```

Preferred language:

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
Yield
Claimable
```

Protocol complexity such as shares, growth accumulators, generations and fixed-point math stays behind the UI.

---

# 5. Duration

The official v0.1 product shows a fixed visible:

```text
7D
```

for Use.

The protocol supports any positive whole-number duration in days, but the primary v0.1 product flow does not expose a duration selector.

Immediate Swap has no duration.

---

# 6. Information architecture

Primary navigation:

```text
yld.cx | Yield | Orders
```

Right side:

```text
Network | Wallet
```

Routes:

```text
/                 → Yield / recent markets
/market/:pair     → symmetric market
/orders           → global Term Position ledger
/portfolio        → connected-wallet portfolio
```

Portfolio may be accessed from the Wallet menu rather than primary nav.

---

# 7. Multi-chain architecture

yld.cx MUST support:

```text
Ethereum / EVM-compatible L2s
Solana
```

The UI consumes one common domain model. Chain-specific encoding, wallets, RPC and transaction construction remain behind adapters.

Recommended frontend stacks:

```text
EVM
- wagmi
- viem

Solana
- @solana/kit
- @solana/react
- @solana/kit-plugin-wallet
- Wallet Standard-compatible wallets
```

New Solana product code should prefer Solana Kit rather than legacy `@solana/web3.js` v1 / wallet-adapter unless an external integration requires legacy compatibility.

These libraries are implementation choices, not economic protocol invariants.

## 7.1 Common adapter interface

Product code SHOULD expose chain-neutral operations such as:

```ts
getMarkets();
getPair(tokenA, tokenB);
getTick();
getEarnPosition();
getUsePosition();
previewSupply();
previewWithdraw();
previewUse();
previewSwap();
previewCollect();
supply();
withdraw();
collect();
use();
repay();
swap();
close();
```

UI components SHOULD NOT contain EVM ABI logic or Solana account/instruction logic directly.

Adapters also own canonical protocol encoding such as Pair token ordering, direction `0/1`, price-tick conversion, PDA/ID derivation, and raw-unit decimal conversion. Ask/Bid remains the product vocabulary; users do not interact with the numeric direction encoding.

Pair lookup is canonical and input-order independent:

```text
getPair(tokenA, tokenB) == getPair(tokenB, tokenA)
```

`getPair(...)` MUST return the deployment-local canonical Pair identity together with the canonical Pair state in one adapter call. The same two token addresses/mints MUST resolve to the same Pair on a given deployment regardless of argument order. On EVM the adapter calls the protocol `getPair(...)` view. On Solana it canonicalizes the two mints, derives the Pair PDA and fetches that account.

Discovery of **all** markets involving a token is an indexing/search concern rather than a requirement to maintain unbounded token→Pair arrays in core protocol state.

Canonical cross-chain IDs are represented with deployment/network context in the common domain model:

```text
EVM Pair        → deterministic uint256 pairId from canonical sorted token addresses
Solana Pair     → canonical Pair PDA from sorted mint addresses
EVM Position    → numeric positionId encoded with deployment/network context
Solana Position → TermPosition PDA (client nonce is an implementation input, not the display identity)
```

Pair identity is deterministic from the two tokens; liquidity and market state remain deployment-scoped and are never implicitly shared across networks.

## 7.2 Composition

Equivalent composed UX:

```text
EVM     → OpenZeppelin Multicall
Solana  → multiple instructions in one atomic transaction where limits permit
```

Primary composed convenience:

```text
Withdraw & Collect
```

Solana clients choose distinct Position nonces before constructing multiple Use instructions, so all TermPosition PDAs are known before signing.

If Solana transaction limits require multiple transactions, the UI must state that explicitly rather than changing action semantics.

Solana Pair/Tick initialization and GenerationState creation are permissionless infrastructure operations. Their rent payer receives no protocol rights. If a Swap/Close exhausts a Tick generation, that transaction also creates the immutable GenerationState snapshot; the transaction preview SHOULD include the resulting additional rent/account-creation cost.

## 7.3 Wallet identity

EVM and Solana wallet identities are independent.

Connecting one ecosystem MUST NOT imply identity or authorization in the other.

All positions, balances and actions are scoped to the selected deployment/network.

---

# 8. Network selector

The header Network control must distinguish ecosystem and deployment.

Example options:

```text
Ethereum
Base
Robinhood Chain / supported EVM deployment
Solana
More...
```

Only networks with deployed protocol contracts/programs are executable.

The same market pair may exist independently on multiple networks. Liquidity is never implicitly shared across chains.

---

# 9. Yield page

Route:

```text
/
```

Purpose: discover recent active Yield markets.

No crowned token hero here.

Recommended columns:

```text
Market
Ask Liquidity
Ask Yield*
Bid Liquidity
Bid Yield*
Active Uses
Network
```

> **\* Yield is earned only when liquidity is used.**

Liquidity is displayed in native supplied-token units rather than fake cross-asset USD totals.

Ask uses red accents. Bid uses green accents. Taker actions use purple.

Default sort: recent protocol activity.

---

# 10. Market page

Route:

```text
/market/:pair
```

Main layout remains three functional columns:

```text
[Post Ask / Post Bid]   [Yield Book]   [Use / Swap]
```

The selected token gets the crowned hero only on this page:

```text
      👑
  [TOKEN ICON]
   TOKEN | USDC
       7D
```

Yield Book rows show only actionable protocol-native data:

```text
Price
Available Liquidity
In Use / Working
Current Yield
```

The UI may aggregate depth visually but execution is always against exact protocol ticks.

Protocol adapters use the same canonical TickMath price on EVM and Solana. Tick price is stored/executed in raw token units; the UI converts it to human `Quote per Asset` using token decimals. This representation remains hidden from normal users.

For a displayed market `TOKEN | USDC`, both Ask and Bid MUST use the same displayed price unit: `USDC per TOKEN`. Ask already uses that directional unit. Bid protocol ticks remain `TOKEN per USDC` internally and MUST be reciprocated by the product adapter for display only. This display conversion MUST NOT change canonical TickMath, tick identity, quoting, or execution.

---

# 11. Supply / Post Ask / Post Bid

Supplier chooses:

```text
side
price
amount
```

Duration is fixed to 7D in the official v0.1 UI.

The official UI MUST snap entered prices to a valid canonical protocol `priceTick` and show the resulting execution price before signing. This is a product input/display rule only and does not restrict the protocol tick domain.

Preview shows:

```text
You supply
Price
7D
Current available liquidity
Current in-use liquidity
Estimated shares/accounting hidden from primary UI
```

Do not promise Yield on idle liquidity.

Use wording such as:

```text
Yield when used
Current Yield
```

not guaranteed APY.

---

# 12. Use

Use panel shows:

```text
Receive Asset
Lock Quote
Yield Fee
Term 7D
Maturity
```

Ask example:

```text
Receive       1,000 TOKEN
Lock         12,000 USDC
Yield Fee        72 USDC
Term                 7D
```

The Yield Fee is paid upfront and non-refundable.

The locked Quote principal is refundable only on Repay.

Successful Use creates one ACTIVE Term Position.

---

# 13. Repay

Before maturity, the position owner sees:

```text
Repay
```

Preview:

```text
Return Asset
Unlock Quote
Yield already paid
```

After successful Repay:

```text
Working Asset → Available Asset
Quote → user
status → REPAID
```

The returned Asset is immediately normal Available liquidity again.

---

# 14. Close

At/after maturity, ACTIVE positions become visually:

```text
Expired / Closeable
```

Close is permissionless.

Preview shows:

```text
Asset remains with Use user
Locked Quote settles to suppliers
Close Fee
status → CLOSED
```

Close Fee is 10% of the position Gross Yield Fee, deducted from realized Quote proceeds.

---

# 15. Immediate Swap

Swap is a one-transaction acceptance of the exact Yield Order price.

Show:

```text
Receive
Pay
Price
Execution: Immediate
Protocol Fee
```

Also make explicit:

```text
No 7D term
No locked principal
No Repay
No Term Position
No actual Yield Fee
```

The protocol fee is deducted from provider Swap proceeds, not added to taker Quote Principal.

---

# 16. Portfolio — Earn

Route:

```text
/portfolio
```

Tabs:

```text
Earn
Use
```

Each Earn position should show the economically meaningful state without exposing share math.

Recommended card:

```text
TOKEN | USDC · Ask · 7D
Price                12.00 USDC

Pool
Available              700 TOKEN
In Use                 300 TOKEN

[Withdraw]

Claimable
Swapped               6,000 USDC
Earned Yield              42 USDC
Protocol Fee on Yield      4.2 USDC
Net Yield                 37.8 USDC

[Collect]
```

`Pool` makes clear that Available and In Use are dynamic shared tick values, not individually reserved supplier balances.

For reverse direction, Claimable values may be denominated in TOKEN rather than USDC.

`Collect` MUST be placed visually adjacent to **Claimable / Earned Yield**, not beside Withdraw.

---

# 17. Withdraw UX

`Withdraw` removes only currently withdrawable Asset principal.

The UI computes/displays:

```text
Available to withdraw
Remaining In Use
```

If a provider has more economic exposure than current Available liquidity, the UI must explain:

> Some liquidity is currently in Use and cannot be withdrawn yet.

v0.1 SHOULD support an amount input plus a prominent `Max` action.

Before burning shares, Withdraw synchronizes all currently earned Yield and realized Swap/Close Quote into Claimable accounting.

After Withdraw:

- accrued Yield remains claimable,
- realized Swap Quote remains claimable,
- any remaining shares/Working exposure stay visible,
- if shares become zero, no future Yield or Swap/Close proceeds accrue to that provider.

A full withdrawal may therefore leave:

```text
Liquidity      0
Claimable      > 0
[Collect]
```

Withdraw never implicitly Collects.

---

# 18. Collect UX

`Collect` transfers all currently claimable Quote-denominated proceeds for the selected provider position.

Breakdown:

```text
Swapped Quote principal
Gross Yield
Protocol Fee on Yield
Net Yield
Total received
```

Rules:

```text
Yield → 10% protocol fee at collection
Swap/Close Quote → no second fee
```

The button label remains simply:

```text
Collect
```

because both claim components use the tick Quote token.

If only one component is non-zero, show only the relevant rows.

---

# 19. Withdraw before Collect

The product MUST support:

```text
Withdraw first
Collect later
```

without loss of economics already earned before the share burn.

After a full Asset withdrawal, a position may remain visible as:

```text
Liquidity      0
Claimable      > 0
[Collect]
```

This remaining Claimable amount is historical only. While the position has zero shares it MUST NOT increase from later Uses, Swaps or Closes.

The position disappears from active Earn UI only once it has no remaining principal exposure and no claimable proceeds.

---

# 20. Withdraw & Collect

Provide optional convenience:

```text
Withdraw & Collect
```

Semantics remain two canonical actions:

```text
withdraw(...)
collect(...)
```

EVM executes them atomically via Multicall.

Solana composes them as instructions in one transaction where transaction limits permit.

The UI should preview the final combined balances before signing.

---

# 21. Portfolio — Use

Each ACTIVE Use position shows:

```text
Market
Side
Asset received
Quote locked
Yield paid
Opened
Maturity
Status
```

Before maturity and owned by connected wallet:

```text
[Repay]
```

At/after maturity:

```text
[Close]
```

Close may be shown to any connected wallet because it is permissionless.

REPAID/CLOSED history remains discoverable in Orders.

---

# 22. Orders page

Route:

```text
/orders
```

Orders is the permanent Use Term Position ledger.

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

Search:

```text
position ID / position address
wallet address
market
```

Position identity is deployment-scoped:

```text
EVM     → permanent numeric positionId within that deployment
Solana  → permanent TermPosition PDA
```

The UI MUST always show network context to avoid ambiguity. The Solana client nonce does not need to be primary UI unless useful in technical details.

---

# 23. Transaction preview and simulation

Before wallet signature, every state-changing action must show the exact economic preview derived from canonical onchain state.

EVM:

```text
viem/wagmi simulation
full ordered Multicall simulation for composed transactions
```

Solana:

```text
Solana Kit transaction/instruction construction
RPC simulation where supported
```

State-sensitive authorizations remain in the transaction itself:

```text
maxYieldFee
maxQuoteIn
deadline/maturity checks
```

Simulation is not a guarantee of execution.

---

# 24. Wallets and approvals

## EVM

Use wagmi + viem.

Support:

```text
EOAs
Safe-style wallets
ERC-4337 smart accounts
```

Never assume `tx.origin == wallet`.

Approvals:

```text
Supply → Asset
Use    → Quote Principal + Yield Fee
Swap   → Quote Principal
Repay  → Asset
```

Permit/Permit2 may optimize UX but are not required.

## Solana

Use Solana Kit + `@solana/react` + Wallet Standard.

The product prepares required token accounts and validates mint/network ownership.

Where immutable `FEE_TO` needs a Quote ATA, the product should ensure the canonical ATA exists before a fee-bearing transaction.

---

# 25. Errors

User-facing errors must explain economic reason, not implementation jargon.

Examples:

```text
Yield changed. Review the new fee and try again.

Swap amount changed. Review the updated quote and try again.

Some of your liquidity is currently in Use and cannot be withdrawn yet.

Newly supplied liquidity cannot be withdrawn in the same block/slot.

This position has matured and can no longer be Repaid.

This position is not mature yet.

Collectable amount changed. Refresh and try again.

Transaction simulation failed.
```

Chain-specific transport errors may appear in expandable technical details.

---

# 26. Indexing and source of truth

Indexers may be used for:

```text
speed
search
sorting
activity feeds
analytics
global Orders history
token → Pair / market discovery
```

The reference indexer SHOULD maintain token→Pair discovery so the UI can search a token and list every indexed market involving it. This discovery index is not canonical protocol state; before execution the product resolves/reconciles the selected Pair and Tick against onchain state.

Canonical protocol state remains source of truth.

EVM essential state MUST remain RPC + Multicall readable through the required portfolio indexes/views.

Solana essential connected-wallet state MUST remain RPC/account readable through fixed-size ProviderPosition and TermPosition account layouts with stable SDK-published filters. An indexer is an accelerator, not a correctness dependency.

The product must tolerate indexer lag by reconciling with final onchain state after transactions.

---

# 27. Brand and visual system

Interface style:

```text
dark
minimal
degen-native
high contrast
trading-oriented
```

Canonical accents:

```text
Ask / Sell     red
Bid / Buy      green
Use / Swap     purple
Crown          gold/yellow
Neutral data   white/cool gray
```

`👑` is reserved as a recurring yld.cx brand marker, strongest on the selected token hero on the Market page.

Do not show the crowned token hero on Yield, Orders or Portfolio pages.

---

# 28. Product metrics

Prefer protocol-native metrics:

```text
Available liquidity
Working liquidity
Current Yield
Active Uses
Repaid Uses
Closed Uses
Realized Swap volume
Generated Yield
```

Avoid making external spot prices or oracle valuations core dependencies.

If external prices are added later, visually distinguish them from protocol state.

---

# 29. Final end-to-end supplier flow

```text
1. Select network.
2. Connect the wallet for that ecosystem.
3. Open TOKEN | USDC.
4. Select Ask or Bid.
5. Choose price and amount.
6. Post liquidity.
7. Liquidity appears as Available.
8. If Used, part becomes In Use and Yield becomes claimable.
9. If Repaid, Asset returns to Available.
10. If Swapped/Closed, that principal becomes claimable Quote.
11. Withdraw currently Available Asset whenever desired.
12. Collect realized Quote + Yield whenever desired.
13. Withdraw before Collect never forfeits claims.
```

---

# 30. Final end-to-end taker flow

```text
1. Select network and market.
2. Select an exact Yield Book row.
3. Choose Use or Swap.

Use:
- receive Asset
- lock Quote
- pay Yield
- Repay before maturity or Close after maturity

Swap:
- pay Quote
- receive Asset immediately
- no Term Position
```

---

# 31. Out of scope product v0.1

```text
cross-chain liquidity aggregation
bridging inside the core flow
governance pages
protocol token
conventional Borrow/Lend pages
oracle-dependent health metrics
resting taker Demand book
external AMM routing as a required path
advanced analytics dashboard
LP share token UI
provider generation/share math in primary UX
```

---

# 32. Canonical v0.1 product model

```text
yld.cx
│
├── Yield
│   └── Recent markets across supported deployments
│
├── Market: TOKEN | USDC
│   ├── Ask 🔴 / Bid 🟢
│   ├── Yield Book
│   ├── Use 🟣
│   ├── Swap 🟣
│   └── 👑 selected token hero
│
├── Orders
│   └── ACTIVE / REPAID / CLOSED Term Positions
│
└── Portfolio
    ├── Earn
    │   ├── Pool: Available + In Use
    │   ├── [Withdraw]
    │   ├── Claimable: Swapped Quote + Yield
    │   └── [Collect]
    │
    └── Use
        ├── [Repay]
        └── [Close]
```

The final UX rule is intentionally simple:

> **Withdraw liquidity. Collect proceeds.**

Historical proceeds remain yours after withdrawal; future proceeds require current liquidity ownership.
