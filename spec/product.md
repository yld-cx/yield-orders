# yld.cx - Yield Orders

**Product Specification**
**Targets:** Ethereum / EVM L2s + Solana
**Version:** 0.1

---

# 1. Product summary

> [yld.cx](https://yld.cx) — liquidity rental markets. \
>  **provide** or **rent** tokens at your price.

yld.cx presents Yield Orders as a trading primitive, not as lending.

A supplier posts liquidity at a predefined price. A taker can consume active liquidity in two ways:

1. **Use** — take the Asset temporarily and lock Quote. The Yield rate is frozen when Use opens, but no Yield is paid upfront. If the Asset is Repaid before maturity, the taker returns the Asset plus **Asset-denominated Yield for elapsed time, with a 1-second minimum billable interval**, and receives the locked Quote back.
2. **Swap** — accept the predefined exchange immediately.

An ACTIVE Use therefore has two mutually exclusive outcomes:

```text
Repay → Asset principal + Asset Yield
Close → Quote at the posted price
```

Earlier Repay costs less because accrued Yield grows with elapsed time. A same-timestamp Repay is billed as 1 second, so every successful Repay pays non-zero Yield. At/after maturity Repay is no longer available; Close settles the predefined Swap and no Asset Yield is owed.

Supplier liquidity revolves by default. `Withdraw` exits a selected percentage of the supplier's **active liquidity position**. The proportional Available part is received immediately; the proportional In Use ownership becomes **Exit / Resolving**.

Resolving is a pooled priority claim on the next Working principal that Repays or Closes; it is not ownership of tagged Use positions. It does not participate in new Use opening, but when a Repay resolves a Resolving principal claim, the corresponding Asset Yield goes to that Exit domain.

The active market does **not** pause while Exit exists. New Supply, Use and immediate Swap continue against active liquidity. Repay and Close resolve Exit Working first.

Core supplier framing:

> **Set your price. Earn when liquidity returns — or trade when your price is accepted.**

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

`settle` is permissionless protocol infrastructure used automatically by adapters/actions; it is not a primary user-facing action.

# 2. Final supplier mental model

Supplier liquidity has two **active** states:

```text
Available
In Use
```

and one withdrawal-settlement state:

```text
Exit / Resolving
```

The UX distinction is:

```text
Withdraw → exit a percentage of my active liquidity
           - proportional Available → received immediately
           - proportional In Use → Resolving

Collect  → receive everything currently resolved/claimable
           - Exit Asset principal from Repays
           - Asset Yield from Repays
           - Exit Quote from Closes
           - active realized Swap/Close Quote
```

The provider never needs to see or enter protocol shares. Percentage controls map to active shares internally.

Exit is not a second user-facing pool or token. Internally, it is a settlement domain for Working ownership already removed from active liquidity.

Once ownership enters Exit / Resolving:

```text
new Use opening → does not include that exited portion
new Swap        → does not affect that exited portion
Repay           → may resolve Exit as Asset + corresponding Asset Yield
Close           → may resolve Exit as Quote
```

The active market continues normally while Exit resolves.

## 2.1 Active liquidity and Exit settlement

The official product hides protocol share math, but its economic behavior is fixed:

```text
Active Available + Active In Use = active liquidity position
Resolving In Use                  = Exit settlement position
Historical Claimable              = separate receivable
```

A supplier entering a Tick joins only the current **active principal**. It does not inherit Exit Working or historical active/Exit proceeds.

Historical economics stay with the share domain that received the funded growth:

- Asset Yield is funded only on Repay and follows the same Exit/active principal split as that Repay.
- active Swap/Close Quote belongs to active shareholders when realized.
- Exit Asset/Quote/Yield belongs to Exit shareholders when resolved.
- later suppliers receive no already-funded historical claims.

On Withdraw, selected active ownership is removed immediately. The Available component is paid now; only the selected active Working component becomes Exit.

Therefore a provider may have:

```text
Active liquidity > 0
Resolving > 0
Claimable > 0
```

at the same time.

Or after Max Withdraw:

```text
Active liquidity = 0
Resolving > 0
Claimable >= 0
```

No particular Term Position is assigned to an individual supplier. Exit resolution remains pooled and O(1).

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
No Yield is paid yet
```

If Repaid:

```text
TOKEN principal returns
TOKEN Yield is paid for elapsed time (minimum 1 second)
locked USDC returns to taker
```

If Closed or immediately Swapped:

```text
TOKEN principal becomes USDC Swap proceeds
no TOKEN Yield is owed on Close/Swap
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
No Yield is paid yet
```

If Repaid:

```text
USDC principal returns
USDC Yield is paid for elapsed time (minimum 1 second)
locked TOKEN returns to taker
```

If Closed or immediately Swapped:

```text
USDC principal becomes TOKEN Swap proceeds
no USDC Yield is owed on Close/Swap
```

Therefore the canonical rule is:

> **Yield denomination = Asset. Swap settlement denomination = Quote.**

For token communities this means: if the supplied token comes back, the provider earns more of that same supplied token.

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
Resolving
Yield
Claimable
```

`Exit` is valid protocol/product-state terminology in technical details, but the primary user action remains **Withdraw**. Users do not need a separate Exit button.

Protocol complexity such as shares, Exit-share accounting, growth accumulators, generations, settlement cursors and fixed-point math stays behind the UI.

---

# 5. Duration

The official v0.1 product shows a fixed visible:

```text
7D
```

for Use.

The protocol supports any positive whole-number duration in days, but the primary v0.1 product flow does not expose a duration selector.

Immediate Swap has no duration.

A Use freezes its **full-term Asset Yield quote** at opening. The amount actually due on Repay grows linearly with elapsed time:

```text
billableElapsed = max(1 second, elapsed)
Current Yield Due
= Full-Term Yield × billableElapsed / 7D
```

subject to canonical protocol rounding. A same-timestamp Repay therefore pays the 1-second amount rather than zero.

Therefore:

```text
earlier Repay → less Asset Yield
later Repay   → more Asset Yield
Close         → no Asset Yield
```

The UI MUST NOT imply that the full 7D Yield is paid upfront.

Exit is pooled priority settlement, not tagged Working. `exitWorking` increases only when active shares are Withdrawn and decreases only when Working resolves through Repay or Close. New Uses never increase an existing Exit claim. Any later Repay/Close may satisfy Exit first, so newer activity can accelerate resolution.

The product MUST NOT imply that specific Use positions are reserved for a particular supplier's Exit.

Resolving has no separate guaranteed completion timestamp in v0.1. The UI MUST NOT promise that an individual withdrawal completes within 7D, even though each individual Use still has its own fixed 7D term.

The UI may state:

```text
Resolving
Paid from Repay / Close settlement
```

The UI MUST NOT promise return of the original Asset:

```text
Repay → Asset + Asset Yield
Close → Quote at the posted price
```

Nor should it imply an automatic transaction exactly at maturity. Mature Positions become permissionlessly closeable and `settle` advances one oldest Position per successful action or standalone settlement transaction.

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

The UI consumes one common domain model. Chain-specific encoding, wallets, RPC, settlement-account construction and transaction construction remain behind adapters.

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
previewRepay();
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

Adapters additionally implement the protocol-infrastructure settlement step:

```ts
settleTick();
```

`settleTick()` is not a primary UI action. Normal state-changing adapter methods include the required one-step protocol settlement hook automatically; standalone settlement may also be submitted when the app wants to advance a mature cursor Position without another economic action.

UI components SHOULD NOT contain EVM ABI logic, Solana account/instruction logic, or settlement-cursor logic directly.

Adapters also own canonical protocol encoding such as Pair token ordering, direction `0/1`, deterministic EVM `tickId` derivation, price-tick conversion, Solana PDA derivation, per-Tick position sequencing, the canonical Q128 Yield quote algorithm, and raw-unit decimal conversion. Ask/Bid remains the product vocabulary; users do not interact with numeric direction encoding or settlement cursors.

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
EVM Position    → permanent numeric positionId within deployment
Solana Position → permanent TermPosition PDA derived from Tick + position_seq
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

Settlement may also be composed:

```text
settle + collect
```

but normal economic actions already contain one automatic settlement step.

On Solana, clients read `tick.next_position_seq` and derive canonical same-Tick Position PDAs from consecutive sequence values before signing.

If Solana transaction limits require multiple transactions, the UI must state that explicitly rather than changing action semantics.

Solana Pair/Tick initialization plus active GenerationState / ExitGenerationState creation are permissionless infrastructure operations. Their rent payer receives no protocol rights. If an action/automatic settlement exhausts an active or Exit generation, that transaction also creates the required immutable generation snapshot; the transaction preview SHOULD include the resulting additional rent/account-creation cost.

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

> **\* Yield is earned when Used liquidity Repays. Close/Swap settles Quote instead.**

Liquidity is displayed in native supplied-token units rather than fake cross-asset USD totals.

`Ask Yield*` / `Bid Yield*` are annualized **marginal Current Yield** rates derived from the current active-liquidity curve at the Tick's current active Working Share. They are discovery/reference rates, not guaranteed realized return. A concrete Use amount is priced by the integrated curve; the transaction preview's `Max 7D Yield` is authoritative for that amount.

Ask uses red accents. Bid uses green accents. Taker actions use purple.

Default sort: recent protocol activity.

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

Yield Book rows show active protocol liquidity only:

```text
Price
Available Liquidity
In Use / Working
Current Yield
```

`Current Yield` is the current annualized **marginal** Asset Yield rate at the Tick's active Working Share. It is a compact market indicator. A selected Use amount traverses the integrated Yield curve, so its exact `Max 7D Yield` comes from the canonical preview and may imply a different effective average rate. The full-term Yield amount is frozen when Use opens; actual Yield paid on Repay grows with elapsed time.

`In Use / Working` for market pricing means **active Working**, excluding Working already redirected to Exit. Exit liquidity is not shown as usable market depth.

Pending Exit MUST NOT disable Use or Swap. If active Available liquidity exists, the Tick remains actionable.

The UI may expose aggregate Exit/Resolving data in secondary details or Portfolio, but MUST NOT expose raw `exitShares`, `settleCursor`, or generation math in primary market UI.

The UI may aggregate depth visually but execution is always against exact protocol ticks.

Protocol adapters use the same canonical TickMath price on EVM and Solana. Tick price is stored/executed in raw token units; the UI converts it to human `Quote per Asset` using token decimals.

For displayed `TOKEN | USDC`, both Ask and Bid use `USDC per TOKEN`; Bid protocol ticks are reciprocated for display only.

# 11. Supply / Post Ask / Post Bid

Supplier chooses:

```text
side
price
amount
```

Duration is fixed to 7D in the official v0.1 UI.

The UI snaps entered prices to a valid canonical protocol `priceTick` and shows the resulting execution price before signing.

Preview shows:

```text
You supply
Price
7D
Active available liquidity
Active in-use liquidity
Current Yield rate
```

Do not promise Yield on idle liquidity.

Preferred wording:

```text
Yield when used and returned
Current Yield
```

not guaranteed APY or guaranteed 7D return.

Supply remains valid while Exit resolves. New Supply joins only active liquidity and may be Used/Swapped immediately subject to normal protocol checks.

# 12. Use

Use panel shows:

```text
Receive Asset
Lock Quote
Current Yield
Max 7D Yield
Term 7D
Maturity
```

Ask example:

```text
Receive              1,000 TOKEN
Lock                12,000 USDC
Current Yield          0.20% / day
Max 7D Yield             14 TOKEN
Yield paid now              0
Term                       7D
```

The full-term Yield amount is frozen at Use opening from current active liquidity. `Current Yield` is the marginal reference rate; `Max 7D Yield` is the exact integrated protocol quote for the entered amount and is authoritative for signing.

**No Yield is paid upfront.**

If the taker Repays, Yield is paid in the **Asset** and is prorated by billable elapsed time, with a 1-second minimum. If the taker Closes/lets the position mature, no Asset Yield is owed; the locked Quote settles as the predefined Swap outcome.

Successful Use creates one ACTIVE Term Position.

**Exit does not disable Use.** Use is available whenever the Tick has enough active Available liquidity. Yield pricing uses active Working only; Resolving Exit Working is excluded.

The adapter performs the one-step settlement hook first, then requotes from resulting canonical state.

# 13. Repay

Before maturity, the position owner sees:

```text
Repay
```

The Use position should show a live/refreshing preview:

```text
Return Asset
Current Yield Due
Total Asset to Return
Unlock Quote
```

Example:

```text
Return principal      1,000 TOKEN
Yield Due               5.42 TOKEN
Total Return          1,005.42 TOKEN
Unlock               12,000 USDC
```

`Yield Due` grows with billable elapsed Use time against the full-term Yield amount frozen at Use opening. The minimum billable interval is 1 second.

The UI should make the incentive explicit:

> **Return earlier, pay less Yield.**

After Repay, principal resolves in this order:

```text
1. outstanding Exit / Resolving Working
2. active Available liquidity
```

The Asset Yield follows the same resolution split:

```text
Exit-resolved principal   → corresponding Asset Yield to Exit
active-returned principal → corresponding Asset Yield to active suppliers
```

So a Repay may produce:

```text
Exit Asset principal → claimable by exiting suppliers
Exit Asset Yield     → claimable by exiting suppliers
excess Asset         → active Available, usable again
active Asset Yield   → claimable by active suppliers
Quote                → Use user
status               → REPAID
```

The UI does not need to show aggregate allocation mechanics to the taker; supplier Portfolio updates Claimable/Resolving accordingly.

Because Yield grows with time between preview and inclusion, Repay transactions include a protocol-side maximum Yield bound. If the bound is exceeded, refresh the preview.

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
Asset Yield due      0
Close Fee
status → CLOSED
```

Close is the **Swap outcome**, not a late Repay.

The Close Fee is frozen from the full-term reference Yield at Use opening, converted to Quote at the immutable Tick price, and deducted from realized Quote proceeds.

If Exit Working exists, the net provider Quote from Close resolves Exit first for the corresponding principal portion; only the excess becomes active provider Quote growth.

The protocol maintains a deterministic per-Tick settlement cursor. Normal economic actions attempt one cursor settlement step, and standalone `settle` can close the oldest mature ACTIVE Position without an indexer.

A Close produced by automatic settlement is economically identical to direct Close.

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
No Asset Yield
```

For protocol-fee calculation only, Immediate Swap computes the same reference full-term Asset Yield an equivalent Use would quote, converts that reference to Quote at the Tick price, and derives the Swap Fee from it.

The protocol fee is deducted from provider Swap proceeds, not added to taker Quote Principal.

**Exit does not disable Swap.** Immediate Swap consumes only active Available liquidity and pays active shareholders. Resolving Working is untouched.

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

Recommended card:

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
Earned Yield              6 TOKEN
Exit Quote              960 USDC
Swapped               6,000 USDC

Protocol Fee on Yield    0.6 TOKEN
Net Yield                5.4 TOKEN

[Collect]
```

`Earned Yield` is always denominated in the supplied **Asset**. It may include active Repay Yield and Exit Repay Yield.

Only show `Resolving` when non-zero. The Asset-equivalent label describes unresolved Working principal, not a guaranteed Asset payout.

For reverse direction, denominations reverse naturally:

```text
Bid supplier Asset = USDC
Yield               = USDC
Swap/Close Quote    = TOKEN
```

`Collect` stays visually adjacent to Claimable. It may transfer both Tick tokens in one transaction.

Do not expose raw active shares, Exit shares, growth accumulators, settlement cursor, or generations.

# 17. Withdraw UX

Withdraw is position-percentage based, similar to LP withdrawal UX.

Primary control:

```text
25%   50%   75%   Max
```

A slider may be added, but raw protocol shares MUST remain hidden.

The selected percentage maps to active shares using deterministic floor rounding:

```text
sharesToWithdraw = floor(providerActiveShares × percentage)
```

For **Max**, the adapter MUST submit exactly `providerActiveShares`, not a percentage-derived approximation. This prevents residual share dust. If the provider's final shares represent less than one raw Asset unit and protocol rounding gives a zero principal claim, Max may burn that residual share dust with zero payout; partial withdrawals are not allowed to burn zero-principal shares.

Preview shows the economic split:

```text
Withdraw                 50%

Receive now             200 TOKEN
Move to Resolving       300 TOKEN-equivalent
```

Explanation:

> Available liquidity is received now. Liquidity currently In Use moves to Resolving. It no longer participates in new Use opening, but if Repay resolves that claim it receives the corresponding Asset Yield; Close resolves it as Quote.

Protocol semantics:

```text
selected active shares → burned immediately
proportional Available → supplier immediately
proportional active Working → Exit / Resolving
```

The user does not select Working Positions and never needs a separate Exit action.

Exit is one-way in v0.1: there is no Cancel Exit / Resolving→Active conversion. A supplier who wants active exposure again uses Supply as a separate action.

New Use/Swap/Supply remain available for the active market. The Exit claim is settled from pooled Repay/Close flow rather than being attached to named Working positions. Later Withdraws may join the same Resolving pool, so the UI must not show a guaranteed Exit maturity date.

For Max:

```text
all provider active shares → Withdraw
```

The provider may end with:

```text
Active liquidity  0
Resolving         > 0
Claimable         >= 0
```

This is expected.

Withdraw synchronizes historical active and Exit accounting before burning/minting internal shares. Withdraw does not implicitly Collect existing proceeds.

# 18. Collect UX

`Collect` transfers everything currently claimable for the selected Earn position.

It may include both Tick tokens:

```text
Asset side
- Exit Asset principal
- Gross Asset Yield
- Protocol Fee on Yield
- Net Asset Yield

Quote side
- Exit Quote
- Swapped / Closed Quote
```

Rules:

```text
Exit Asset principal      → no fee
Asset Yield               → 10% cumulative protocol fee at collection
Exit Quote                → no second fee
active Swap/Close Quote   → no second fee
```

The Yield protocol fee is denominated in **Asset**, because Yield itself is denominated in Asset. The protocol carries fractional fee remainder per supplier × Tick, so repeatedly collecting the same cumulative gross Yield cannot reduce the cumulative 10% fee through rounding.

The button remains:

```text
Collect
```

If Exit is only partly resolved, Collect pays the resolved part now while `Resolving` remains visible for the rest.

Example:

```text
Resolving          180 TOKEN-equivalent

Claimable
Exit Asset         120 TOKEN
Earned Yield         4 TOKEN
Exit Quote       1,440 USDC

[Collect]
```

After Collect, unresolved Exit continues as a pooled priority claim on future Repay/Close resolution. Collect does not cancel Exit or convert it back to active liquidity.

# 19. Withdraw before Collect

The product MUST support:

```text
Withdraw first
Collect later
```

without loss of already-funded economics.

After Withdraw the position may contain:

```text
Active liquidity
Resolving Exit Working
Claimable Exit Asset principal
Claimable active/Exit Asset Yield
Claimable Exit Quote
Claimable active Swap/Close Quote
```

These are independent.

After Max Withdraw:

```text
Active liquidity  0
Resolving         > 0 or 0
Claimable         >= 0
```

Once both active shares and Exit shares are zero, future Uses/Swaps/Repays/Closes cannot increase that provider's claims; only already-funded historical Claimable balances remain.

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

Withdraw burns the selected active shares, transfers immediate Available Asset, and redirects proportional active Working into Exit.

Collect then pays all currently claimable:

```text
Exit Asset principal
net Asset Yield
Exit Quote
active Swap/Close Quote
```

EVM uses Multicall. Solana composes instructions atomically where transaction limits permit.

The UI previews final balances in both tokens before signing.

# 21. Portfolio — Use

Each ACTIVE Use position shows:

```text
Market
Side
Asset received
Quote locked

Current Yield rate
Current Yield Due
Max Yield at maturity

Opened
Maturity
Status
```

`Current Yield Due` is denominated in Asset and grows with elapsed time, with a 1-second minimum billable interval.

Before maturity and owned by connected wallet:

```text
[Repay]
```

Repay preview shows:

```text
Asset principal
Current Asset Yield
Total Asset return
Quote unlocked
```

At/after maturity:

```text
[Close]
```

Close preview shows:

```text
Asset Yield due  0
Quote settles
```

Close may be shown to any connected wallet because it is permissionless.

REPAID/CLOSED history remains discoverable in Orders.

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
Solana  → permanent TermPosition PDA derived from Tick + position_seq
```

The UI MUST always show network context to avoid ambiguity. Tick-local settlement sequence does not need to be primary UI unless useful in technical details.

---

# 23. Transaction preview and simulation

Before wallet signature, every state-changing action must show the exact economic preview derived from canonical onchain state.

The preview includes the action's automatic one-step settlement hook. A mature cursor Close may change:

```text
active Working
Exit Working
Available liquidity
active/Exit Quote growth
claimable Exit Asset/Yield/Quote
generation state
```

before the requested action executes.

For Use preview, show the frozen full-term Asset Yield that will apply if the position is opened.

For Repay preview, use the current timestamp to show:

```text
current accrued Asset Yield
total Asset required
Quote unlocked
```

Because Yield continues growing with time until inclusion, Repay uses an onchain `maxYieldAsset` bound. If the transaction would exceed the bound, it reverts and the UI refreshes.

EVM:

```text
viem/wagmi simulation
full ordered Multicall simulation for composed transactions
```

Solana:

```text
Solana Kit transaction/instruction construction
canonical settlement remaining-account bundle from Tick/cursor state
RPC simulation where supported
```

For Solana, when the automatic settlement hook has a current cursor Position, the adapter MUST construct the protocol-defined settlement account bundle in canonical order. If simulation/state changes indicate a different bundle is required, rebuild rather than omitting settlement accounts.

State-sensitive bounds remain in the transaction:

```text
Use:
- maxFullTermYieldAsset
- deadline

Repay:
- maxYieldAsset

Swap:
- maxQuoteIn
- deadline

Other:
- maturity checks
- position sequence checks
- share amount for Withdraw
```

Simulation is not a guarantee of execution. If cursor/liquidity/time state changes before inclusion, refresh and rebuild. This includes Solana settlement-account-bundle changes and elapsed-time Repay Yield changes.

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
Use    → Quote Principal
Swap   → Quote Principal
Repay  → Asset Principal + accrued Asset Yield
```

Permit/Permit2 may optimize UX but are not required.

## Solana

Use Solana Kit + `@solana/react` + Wallet Standard.

The product prepares required token accounts and validates mint/network ownership.

Fee recipient token accounts are denomination-specific:

```text
Collect Yield fee → FEE_TO Asset ATA
Close/Swap fee    → FEE_TO Quote ATA
```

Because automatic settlement may perform a Close inside another action, the product should ensure the Quote FEE_TO ATA exists whenever the current cursor Position may be mature.

The Asset FEE_TO ATA is required for Collect whenever gross Asset Yield is claimable.

# 25. Errors and resolving states

User-facing errors/status text must explain economic reason, not implementation jargon.

Examples:

```text
Yield changed. Review the new full-term Yield and try again.

Yield due increased while the transaction was pending. Review the updated Repay amount.

Swap amount changed. Review the updated quote and try again.

Part of your withdrawal is still resolving from liquidity currently In Use.

Newly supplied liquidity cannot be withdrawn in the same block/slot.

This position has matured and can no longer be Repaid.

This position is not mature yet.

Settlement state changed. Refresh and try again.

Collectable amount changed. Refresh and try again.

Transaction simulation failed.
```

Do not expose primary messages such as:

```text
exit_shares mismatch
exit_working invariant
settle_cursor mismatch
wrong position sequence
```

Chain/protocol diagnostics may appear in expandable technical details.

# 26. Discovery, indexing and source of truth

## 26.1 Curated market discovery — `yieldlist.json`

The official v0.1 product MAY use a curated `yieldlist.json` registry for lightweight market discovery without requiring an indexer.

```text
yieldlist.json
    ↓
known supported markets
    ↓
canonical Pair / Tick lookup
    ↓
live RPC / onchain state
```

`yieldlist.json` is a **product discovery layer only**. It is never a source of truth for liquidity, Yield, positions, settlement state, balances, fees, or execution.

Entries MAY include product metadata such as:

```text
network / deployment
token addresses or mints
market pair
symbol / name
token icon
preferred display order
official supported ticks / price grid
featured / community metadata
```

Before displaying executable state or constructing a transaction, the adapter MUST resolve and reconcile the referenced Pair/Tick against canonical onchain state.

A missing market from `yieldlist.json` does not make the market invalid at protocol level. Permissionlessly created Pair/Tick state remains valid if it satisfies the protocol specification.

The official registry MAY be maintained through repository contributions so token communities can propose markets for discovery in the yld.cx interface.

`yieldlist.json` MUST NOT be required for protocol correctness, connected-wallet state, execution, or Tick settlement. A client that already knows a canonical Pair/Tick MAY interact with it directly through RPC even when the market is not listed.

## 26.2 Optional indexer

An indexer MAY supplement or later replace registry-based discovery for:

```text
speed
all-market search
token → Pair / market discovery
sorting
recent activity
analytics
global Orders history
```

The reference indexer SHOULD maintain token→Pair discovery so the UI can search a token and list every indexed market involving it. This discovery index is not canonical protocol state; before execution the product resolves/reconciles the selected Pair and Tick against onchain state.

Canonical protocol state remains source of truth.

**Tick settlement MUST NOT depend on `yieldlist.json` or an indexer.**

EVM settlement reads:

```text
tick.settleCursor
tickPositionId[tickId][settleCursor]
```

Solana settlement derives:

```text
PDA(["position", tick, tick.settle_cursor])
```

Therefore the next settlement Position is canonical and directly discoverable from Tick state on both runtimes.

EVM essential provider/position state MUST remain RPC + Multicall readable through the required portfolio indexes/views.

Solana essential connected-wallet state MUST remain RPC/account readable through fixed-size ProviderPosition and TermPosition account layouts with stable SDK-published filters. GPA/indexer support may accelerate portfolio/history search, but is not required to find the next Position to settle.

The product must tolerate indexer or registry lag by reconciling with canonical onchain state before execution and with final onchain state after transactions.

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
Active Available liquidity
Active Working liquidity
Exit / Resolving Working

Current Asset Yield rate
Accrued Asset Yield
Generated Asset Yield

Active Uses
Repaid Uses
Closed Uses
Realized Swap volume
```

Avoid making external spot prices or oracle valuations core dependencies.

If external prices are added later, visually distinguish them from protocol state.

# 29. Final end-to-end supplier flow

```text
1. Select network.
2. Connect wallet.
3. Open TOKEN | USDC.
4. Select Ask or Bid.
5. Choose price and amount.
6. Post liquidity.
7. Liquidity appears as active Available.
8. If Used, part becomes active In Use. No Yield is funded yet.
9. If that Use Repays, Asset returns and Asset Yield is funded for elapsed time with a 1-second minimum billable interval.
10. If that Use Closes, Quote settles instead and no Asset Yield is paid.
11. Supplier chooses Withdraw percentage: 25% / 50% / 75% / Max.
12. Proportional active Available is received immediately.
13. Proportional active In Use moves to Resolving.
14. The market remains open for Supply / Use / Swap against active liquidity.
15. Repay resolves Exit first as Asset + corresponding Asset Yield; Close resolves Exit first as Quote.
16. Normal actions/settle advance the oldest mature Position without an indexer.
17. Collect currently resolved Exit Asset + Asset Yield + Exit Quote + active Quote whenever desired.
18. Remaining Resolving exposure can be collected later as it resolves.
19. Withdraw before Collect never forfeits funded claims.
```

# 30. Final end-to-end taker flow

```text
1. Select network and market.
2. Select an exact Yield Book row.
3. Choose Use or Swap.

Use:
- consume active Available liquidity
- receive Asset
- lock Quote
- freeze the full-term Asset Yield quote
- pay no Yield upfront
- Current Yield Due grows with elapsed time, minimum 1 second

Before maturity:
- Repay Asset principal + accrued Asset Yield
- unlock Quote
- earlier Repay costs less

At/after maturity:
- Repay is unavailable
- Close settles locked Quote
- Asset remains with user
- no Asset Yield is owed

Swap:
- consume active Available liquidity
- pay Quote
- receive Asset immediately
- no Term Position
```

Pending supplier Exit does not block taker actions; only active Available liquidity is executable.

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
provider active-share / Exit-share / generation math in primary UX
manual Working-position selection for withdrawal
provider FIFO withdrawal queues
Exit cancellation / Exit→Active conversion
indexer-dependent settlement
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
│   ├── Yield Book: active liquidity only
│   ├── Use 🟣
│   │   ├── Receive Asset
│   │   ├── Lock Quote
│   │   ├── Yield accrues in Asset
│   │   └── Repay or Close
│   ├── Swap 🟣
│   └── 👑 selected token hero
│
├── Orders
│   └── ACTIVE / REPAID / CLOSED Term Positions
│
└── Portfolio
    ├── Earn
    │   ├── Active: Available + In Use
    │   ├── [Withdraw 25% / 50% / 75% / Max]
    │   ├── Resolving: exited In Use
    │   ├── Claimable: Exit Asset + Asset Yield + Exit Quote + Swapped Quote
    │   └── [Collect]
    │
    └── Use
        ├── Current Yield Due
        ├── [Repay]
        └── [Close]
```

The final UX rule remains:

> **Withdraw liquidity. Collect proceeds.**

Under the hood:

```text
Use       → receive Asset, lock Quote, freeze full-term Asset Yield
Repay     → Asset principal + elapsed Asset Yield; Quote unlocks
Close     → Quote settles; no Asset Yield

Withdraw  → active ownership exits immediately
            ├─ Available → Asset now
            └─ In Use → Resolving

Repay/Close → Resolving first
Settle      → one oldest Position per action, no indexer
Collect     → resolved Asset + net Asset Yield + Quote
```

The market does not pause for withdrawals. Resolving is priority on Working resolution, not tagged inventory: new Uses do not increase an existing Exit claim, while later Repay/Close may satisfy it sooner.

> **Return → Asset + Asset Yield. Swap → Quote.**
