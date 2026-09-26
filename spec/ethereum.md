# yld.cx — Yield Orders Protocol

**Ethereum / EVM Implementation Specification**
**Target:** Ethereum and EVM-compatible L2s
**Version:** 0.1

---

# 1. Summary

Yield Orders is a permissionless fixed-term liquidity primitive built around one invariant:

> **Asset moves. Quote locks.**

A supplier places an ERC-20 **Asset** into a pooled exact tick:

```text
Pair × Direction × Price Tick × DurationDays
```

A taker can consume available Asset in two ways:

- **Use** — receive Asset temporarily, lock Quote principal, pay Yield, then either Repay before maturity or Close as the predefined Swap at/after maturity.
- **Swap** — accept the predefined exchange immediately in one transaction.

The protocol has no oracle, LTV, health factor, liquidation engine, variable borrow rate, resting Demand queue, per-provider maker matching, or mutable governance economics.

The immutable external **economic** action vocabulary is:

```solidity
supply(...)
withdraw(...)
collect(...)

use(...)
repay(...)
swap(...)
close(...)
```

Permissionless infrastructure entrypoints `createPair(...)` and `createTick(...)` initialize canonical markets. They confer no economic privilege and are not user-facing Yield Order actions.

---

# 2. Core economic model

For each exact directional tick:

```text
A = availableSupply
W = workingSupply
C = A + W
S = totalShares
```

`A` and `W` are denominated in Asset units.

Provider shares represent proportional ownership of the tick's **current remaining Asset principal `C`**. There is one fungible share class: shares do not separately identify Available principal and Working principal, and Working principal is not permanently attached to the provider that happened to supply before a Use opened.

Therefore:

- Supply into a live tick joins the current pooled principal across `A + W` at the canonical pro-rata share price.
- Available and Working are states of pooled principal, not provider-reserved buckets.
- A provider that later owns the shares owns the corresponding remaining principal exposure, including the economic resolution of existing Working principal.
- Historical realized economics do **not** follow principal ownership. Yield and realized Swap/Close Quote are checkpointed as receivables for the shareholders that owned shares when that growth was created.

Per provider:

```text
shares
generation
yieldGrowthLastX128
swapQuoteGrowthLastX128
owedYield
owedSwapQuote
lastSupplyBlock
```

Per current tick generation:

```text
availableSupply
workingSupply
totalShares
yieldGrowthX128
swapQuoteGrowthX128
generation
```

The clean separation is:

```text
withdraw() → remaining Asset principal
collect()  → realized Quote principal + earned Yield
```

Before any share mutation, provider growth is synchronized into `owedYield` and `owedSwapQuote`. Those `owed*` balances are historical receivables and survive later share burns. A provider with `shares == 0` receives no future growth but may still Collect previously accrued `owed*` balances.

Realized Swap/Close Quote is principal transformed into Quote. It is collected through the same action as Yield for UX simplicity, but MUST remain a separate accounting component from Yield.

---

# 3. Pair and direction

A Pair is the canonical unordered combination of two ERC-20 token addresses.

For Pair `TOKEN ↔ USDC`, both directions exist:

```text
TOKEN / USDC
USDC / TOKEN
```

For a direction:

```text
Asset = token supplied and moved to taker
Quote = opposite token locked or paid by taker
```

Direction is protocol-significant. Product presentation may show both directions on one symmetric market page.

Canonical direction encoding:

```text
direction = 0 → Asset = token0, Quote = token1
direction = 1 → Asset = token1, Quote = token0
all other values → reject
```

`token0 < token1` is unsigned comparison of the raw 20-byte addresses. For any two valid distinct token addresses, canonical Pair identity is frozen as:

```solidity
token0 = min(tokenA, tokenB);
token1 = max(tokenA, tokenB);
pairId = uint256(keccak256(abi.encode(token0, token1)));
```

Therefore the same two token addresses MUST always produce the same `pairId` on every EVM deployment using this v0.1 specification, regardless of input order. There is no sequential Pair counter and no caller-selected Pair identifier.

`createPair(tokenA, tokenB)` is permissionless, MUST canonicalize ordering, reject identical/zero addresses, derive the canonical `pairId`, initialize only that canonical pair record, reject duplicate initialization, and grant the caller no owner/admin/creator rights.

The core MUST expose one canonical lookup view:

```solidity
getPair(address tokenA, address tokenB)
    external
    view
    returns (
        uint256 pairId,
        address token0,
        address token1,
        bool exists
    );
```

`getPair(tokenA, tokenB)` MUST canonicalize the inputs using the same rule as `createPair`, derive the same `pairId`, and return that ID together with canonical `token0`, canonical `token1`, and existence state in one call. These four values are the complete Pair-level state required by v0.1. Reversing the two input token addresses MUST return exactly the same values. For invalid identical/zero-address input, the view MUST reject under the same canonical-address validity rules as Pair creation. For a valid but not-yet-created token combination, it MUST return the canonical derived `pairId`, canonical token ordering, and `exists = false`.

This direct Pair lookup is canonical protocol read functionality. Enumerating every Pair that contains a given token remains an indexer/UI discovery concern; the core does not require unbounded token→Pair arrays.

---

# 4. Tick identity

A tick is identified by:

```text
Pair
Direction
Price Tick
DurationDays
```

Canonical field domains:

```text
direction    uint8, values {0,1}
priceTick    int32, canonical range [-887272, 887272]
durationDays uint64, > 0
```

At Use:

```text
maturity = checked(openedAt + durationDays * 1 days)
```

The protocol imposes no semantic maximum duration in v0.1 beyond integer/timestamp representability and the fee-solvency checks required by Use/Swap.

Price math is frozen and identical to Solana. `priceTick` represents **raw Quote units per raw Asset unit** for this directional Tick. Direction chooses Asset/Quote; it does not invert the tick automatically.

```text
sqrtPriceX96 = TickMath.getSqrtRatioAtTick(int24(priceTick))
priceX128     = floor(sqrtPriceX96^2 / 2^64)
P             = priceX128 / 2^128
QuotePrincipal = ceil(assetAmount * priceX128 / 2^128)
```

The range check MUST occur before the `int24` cast. `sqrtPriceX96^2`, price derivation and amount multiplication MUST use overflow-safe full-precision arithmetic. `QuotePrincipal` MUST be non-zero. The implementation SHOULD store the derived `priceX128` on Tick creation so every quote uses the same frozen integer price.

`createTick(pairId, direction, priceTick, durationDays)` is permissionless. It MUST validate the Pair, direction, price range, positive duration, uniqueness, derive Asset/Quote from the frozen direction encoding, compute/store canonical `priceX128`, and grant the caller no owner/admin/creator rights.

Human display conversion belongs to the product layer:

```text
display Quote/Asset = (priceX128 / 2^128) * 10^assetDecimals / 10^quoteDecimals
```

No oracle price participates in execution or settlement.

---

# 5. Immutable configuration

Reference v0.1 deployment constants:

```solidity
uint256 constant BPS = 10_000;
uint256 constant FEE_BPS = 1_000; // 10%
address immutable FEE_TO;

MIN_DAILY_FEE  = 0.01% // 1 bp
MAX_DAILY_FEE  = 1.00% // 100 bps
CURVE_EXPONENT = 3
```

There is no:

```text
nextPairId / sequential Pair counter
owner fee setter
Treasury abstraction
protocol fee vault
protocolFees mapping
collectProtocolFees()
governance-controlled rate
upgradeable proxy
```

Every protocol fee is transferred directly to immutable `FEE_TO` in the fee-bearing transaction.

---

# 6. Yield pricing

Working Share is:

\[
u = W / (A + W)
\]

when `A + W > 0`.

The marginal daily Yield rate is:

\[
r(u)=Min+(Max-Min)u^n
\]

where `n = CURVE_EXPONENT`.

For a Use moving `x` Asset from Available to Working:

```text
C  = A0 + W0
u0 = W0 / C
u1 = (W0 + x) / C
```

The integrated curve is:

\[
I(u_0,u_1)=Min(u_1-u_0)+\frac{Max-Min}{n+1}(u_1^{n+1}-u_0^{n+1})
\]

For tick price `P` Quote per Asset and duration `D` days:

\[
GrossYieldFee=P \times C \times D \times I(u_0,u_1)
\]

Canonical integer conversion:

```text
Quote Principal                    → round UP to Quote smallest units
Gross Yield Fee                    → round UP to Quote smallest units
Reference Yield Fee for Swap       → round UP using the same quote path
Protocol fee derived from a source → round DOWN
```

The final Yield/Reference-Yield conversion MUST use overflow-safe full-precision arithmetic and ceil division. This prevents repeated small Uses from systematically truncating Yield below the canonical curve quote.

Equivalent sequential Uses traversing the same Working Share path MUST produce the same theoretical total Yield subject only to documented deterministic integer-rounding bounds.

The Yield Fee is fixed at `use()` execution and never accrues afterward.

---

# 7. Share accounting

## 7.1 Supply

Before changing shares, synchronize the supplier's current generation accounting.

For `assetIn > 0`:

If the tick is empty:

```text
S == 0
C == 0
sharesMinted = assetIn
```

Otherwise:

\[
sharesMinted=\left\lfloor assetIn \times S / C \right\rfloor
\]

Requirements:

```text
assetIn > 0
S > 0 iff C > 0
C > 0 when S > 0
sharesMinted > 0
```

Then:

```text
Asset → protocol
availableSupply += assetIn
totalShares += sharesMinted
provider.shares += sharesMinted
provider.lastSupplyBlock = block.number
```

Supply immediately increases Available liquidity and may be consumed by `use()` or `swap()` in the same block.

A supplier joining a live tick joins the current pooled remaining principal `A + W`; it does not receive historical Yield or historical Swap/Close Quote because synchronization checkpoints current growth before the new shares are minted.

`supply()` accepts `referrer` for event attribution only. It MUST NOT store or economically use the referrer.

## 7.2 Withdraw

Withdraw removes only currently Available Asset.

Before changing shares, synchronize provider accounting into `owedYield` and `owedSwapQuote`.

For requested `assetOut`:

```text
assetOut > 0
S > 0
C > 0
assetOut <= availableSupply
assetOut <= floor(provider.shares * C / S)
block.number > provider.lastSupplyBlock
```

Shares burned MUST conservatively round up:

\[
sharesBurned=\left\lceil assetOut \times S / C \right\rceil
\]

and MUST satisfy:

```text
sharesBurned <= provider.shares
```

Then:

```text
availableSupply -= assetOut
totalShares -= sharesBurned
provider.shares -= sharesBurned
Asset → provider
```

After mutation the live-state invariant MUST hold:

```text
(availableSupply + workingSupply == 0) == (totalShares == 0)
```

In particular, if Withdraw removes the final unit of principal, it MUST also burn the final share. An implementation MUST revert rather than leave `C == 0 && S > 0` or `C > 0 && S == 0`.

This intentionally permits providers to exit against liquidity currently Available. Available and Working are pooled states: a later supplier can become the current shareholder of existing Working principal, while historical Yield already accrued from that Working remains owed to the shareholders that earned it.

A provider may withdraw repeatedly as Asset becomes Available.

Product UX SHOULD default to `Max`, where:

```text
maxWithdraw = min(availableSupply, floor(provider.shares * C / S))
```

`withdraw()` never transfers accrued Yield or realized Quote proceeds. A provider whose shares reach zero may still Collect previously synchronized `owedYield` / `owedSwapQuote`, but earns no later growth.

## 7.3 One-block Supply withdrawal cooldown

A supplier that calls Supply in block `N` cannot withdraw from that supplier × tick position until:

```solidity
block.number > lastSupplyBlock
```

This is defense-in-depth against atomic supply/use/withdraw capacity manipulation. It is not a solvency mechanism and does not reserve newly supplied Available liquidity for that supplier.

---

# 8. Growth accounting

Provider accounting uses cumulative Q128 fixed-point growth accumulators:

```text
yieldGrowthX128
swapQuoteGrowthX128
```

Before any provider share mutation or `collect()`:

```text
owedYield += shares * (yieldGrowthX128 - yieldGrowthLastX128) / Q128
owedSwapQuote += shares * (swapQuoteGrowthX128 - swapQuoteGrowthLastX128) / Q128

yieldGrowthLastX128 = yieldGrowthX128
swapQuoteGrowthLastX128 = swapQuoteGrowthX128
```

All multiplications/divisions MUST use overflow-safe full-precision arithmetic.

Growth increments round down. Provider claim realization rounds down. Residual deterministic dust remains protocol-accounted and MUST never create an unfunded claim.

A later supplier checkpoints current growth before minting and therefore receives no historical Yield or historical Swap/Close Quote proceeds.

When a provider burns all shares, synchronization happens first. Previously accrued economics remain in `owed*`; future increases in either growth accumulator multiply by zero shares and therefore accrue nothing further to that provider.

---

# 9. Use

Canonical entry:

```solidity
use(
    uint256 tickId,
    uint256 assetAmount,
    uint256 maxYieldFee,
    uint256 deadline,
    address referrer
)
```

Requirements:

```text
assetAmount > 0
assetAmount <= availableSupply
C > 0
totalShares > 0
block.timestamp <= deadline
QuotePrincipal > 0
GrossYieldFee > 0
GrossYieldFee <= maxYieldFee
CloseFee = floor(GrossYieldFee * FEE_BPS / BPS)
CloseFee <= QuotePrincipal
maturity = checked(openedAt + durationDays * 1 days)
```

`QuotePrincipal` and `GrossYieldFee` use the canonical rounding rules in §6 / §22.

Execution:

```text
availableSupply -= assetAmount
workingSupply += assetAmount

Asset → user
Quote Principal → locked escrow
Gross Yield Fee → protocol provider-proceeds custody
```

Yield distribution:

```text
yieldGrowthX128 += GrossYieldFee * Q128 / totalShares
```

The growth increment uses the pre-existing non-zero `totalShares` and rounds down.

No protocol fee is taken at Use opening. The provider Yield protocol fee is assessed when Yield is actually collected.

A permanent sequential Term Position is created with at least:

```text
positionId
tickId
user
assetAmount
quotePrincipal
grossYieldFee
openedAt
maturity
status = ACTIVE
```

`referrer` is event-only.

---

# 10. Repay

Repay is allowed only when:

```text
status == ACTIVE
block.timestamp < maturity
msg.sender == position.user
```

v0.1 requires full repayment.

Execution:

```text
Asset from user → protocol
workingSupply -= assetAmount
availableSupply += assetAmount
locked Quote Principal → user
status = REPAID
```

The Gross Yield Fee remains earned and is never refunded.

Repay has no protocol fee.

The active user-position index entry is removed in O(1) using swap-and-pop. The permanent Term Position record remains readable.

---

# 11. Close

Close is permissionless at:

```text
status == ACTIVE
block.timestamp >= maturity
totalShares > 0
```

Repay is forbidden from maturity onward.

Close resolves Working Asset into Quote at the immutable tick price.

The protocol computes, rounding down:

\[
CloseFee = grossYieldFee \times FEE_BPS / BPS
\]

The Term Position was required at Use creation to satisfy `CloseFee <= quotePrincipal`.

Then:

```text
workingSupply -= assetAmount
CloseFee → FEE_TO
ProviderSwapProceeds = quotePrincipal - CloseFee
swapQuoteGrowthX128 += ProviderSwapProceeds * Q128 / totalShares
status = CLOSED
```

The final growth increment uses the pre-reset non-zero `totalShares`. If this Close exhausts remaining principal, generation finalization in §14 MUST execute atomically in the same call.

The Asset remains with the Use user.

The Close Fee is a Yield-denominated reference fee, not a percentage of Swap notional.

No oracle is consulted.

---

# 12. Immediate Swap

Canonical entry:

```solidity
swap(
    uint256 tickId,
    uint256 assetAmount,
    uint256 maxQuoteIn,
    uint256 deadline,
    address referrer
)
```

Requirements:

```text
assetAmount > 0
assetAmount <= availableSupply
C > 0
totalShares > 0
block.timestamp <= deadline
QuotePrincipal <= maxQuoteIn
```

Immediate Swap creates no Term Position and no Working state.

For fee calculation only, compute the **Reference Yield Fee** using the same Yield pricing function an equivalent `use()` would apply to the same tick and amount against the pre-execution state. Reference Yield rounds up under the same rule as Gross Yield.

\[
SwapFee=\left\lfloor ReferenceYieldFee \times FEE_BPS/BPS \right\rfloor
\]

Require:

```text
SwapFee <= QuotePrincipal
```

Execution:

```text
availableSupply -= assetAmount
Asset → taker
Quote Principal from taker → protocol
SwapFee → FEE_TO
ProviderSwapProceeds = QuotePrincipal - SwapFee
swapQuoteGrowthX128 += ProviderSwapProceeds * Q128 / totalShares
```

The growth increment uses the pre-reset non-zero `totalShares`. If this Swap exhausts remaining principal, generation finalization in §14 MUST execute atomically in the same call.

The taker pays only Quote Principal. The fee is deducted from provider proceeds.

`referrer` is event-only.

---

# 13. Collect

`collect(tickId)` is the only supplier action that transfers accrued Quote-denominated economics.

First synchronize the provider.

Let:

```text
grossYield = owedYield
swapQuote = owedSwapQuote
```

Provider Yield fee:

\[
YieldFeeTo = grossYield \times FEE_BPS / BPS
\]

Then:

```text
YieldFeeTo → FEE_TO
NetYield = grossYield - YieldFeeTo
NetYield + swapQuote → provider
owedYield = 0
owedSwapQuote = 0
```

`swapQuote` is not charged again because Swap/Close already paid its protocol fee when realized.

Thus:

```text
Withdraw = Asset principal
Collect  = realized Quote principal + earned Yield
```

A provider may Withdraw before Collect without losing accrued economics because Withdraw synchronizes growth before burning shares.

---

# 14. Tick generations

The post-state live-share invariant is:

```text
C = availableSupply + workingSupply
(C == 0) == (totalShares == 0)
```

Normal Supply/Withdraw paths MUST preserve this invariant directly.

A Swap or Close can resolve the final remaining Asset principal into Quote while shares still exist. When a Swap or Close would produce:

```text
availableSupply + workingSupply == 0
totalShares > 0   // pre-finalization shares
```

the current generation MUST be finalized atomically after applying that action's final growth increment with the pre-reset `totalShares`.

Conceptual generation state:

```text
generationId
finalYieldGrowthX128
finalSwapQuoteGrowthX128
```

On exhaustion:

1. Apply the final Swap/Close growth increment using the pre-reset non-zero `totalShares`.
2. Persist the generation's final growth values.
3. Set current `availableSupply = 0`, `workingSupply = 0`, `totalShares = 0`.
4. Increment `generation`.
5. Reset current-generation growth accumulators to zero.

A provider position stores the generation of its shares. If its generation is older than the current tick generation, synchronization uses that provider generation's persisted final growth, realizes its old `owedYield` / `owedSwapQuote`, then sets old shares to zero.

A provider can be behind by multiple tick generations but its shares belong to exactly one stored generation; synchronization therefore reads exactly that generation snapshot and remains O(1).

If the same supplier later Supplies into the current generation, old economics are synchronized first and retained in `owed*`; then the provider joins with fresh shares and fresh checkpoints.

A full Withdraw with `W == 0` must burn the final share when it removes the final Available Asset. It does not require a generation rollover because no stale shares remain. Any attempted post-state with `C == 0 && S > 0` or `C > 0 && S == 0` MUST revert.

This guarantees:

- old providers keep all historical Quote/Yield claims,
- providers with zero shares receive no future growth,
- new providers receive no historical claims,
- fully swapped/closed ticks can restart,
- no provider iteration is required.

---

# 15. Term Position lifecycle

State machine:

```text
ACTIVE ── Repay before maturity ──→ REPAID
ACTIVE ── Close at/after maturity ─→ CLOSED
```

Exactly one terminal transition is permitted.

Before maturity:

```text
Repay allowed
Close forbidden
```

At/after maturity:

```text
Repay forbidden
Close allowed
```

`swap()` is not a Term Position transition.

Global `positionId` values are monotonically increasing and permanent.

---

# 16. Portfolio indexes

RPC-first current state is required.

Recommended mappings:

```solidity
mapping(address => uint256[]) userEarnTicks;
mapping(address => mapping(uint256 => uint256)) userEarnTickIndexPlusOne;

mapping(address => uint256[]) userActiveTermPositions;
mapping(uint256 => uint256) activePositionIndexPlusOne;
```

Insertions and removals MUST be O(1); removal uses swap-and-pop.

A supplier × tick Earn entry remains active while it has any of:

```text
current-generation shares
owedYield
owedSwapQuote
unsynchronized old-generation shares/claims
```

Term Position history remains in permanent `positions[positionId]` storage.

---

# 17. Multicall and composition

The core MUST inherit or expose OpenZeppelin `Multicall` semantics.

No bespoke batch APIs are required:

```text
no batchUse
no batchSupply
no batchRepay
no batchClose
```

Useful compositions include:

```text
withdraw + collect
multiple independent Uses
multiple independent Swaps
multiple Repays / Closes
```

Each `use()` still creates an independent Term Position.

Do not put a conflicting `nonReentrant` modifier around `multicall()` itself if delegatecall-based composition would make nested guarded entrypoints fail. Guard individual economic entrypoints consistently.

The frontend/router MUST simulate the complete ordered Multicall before signing where possible.

---

# 18. Token support

Core v0.1 supports ERC-20 tokens only.

Native ETH is out of core scope; use WETH through product/router flows.

The protocol MUST reject or safely fail accounting for tokens whose behavior breaks deterministic balance accounting, including unsupported fee-on-transfer, rebasing, or callback behavior.

Use balance-before/balance-after checks where necessary to verify exact transfers.

Permit / Permit2 may be supported by a router/product layer but is not required by the immutable core.

---

# 19. Smart-wallet compatibility

Never use `tx.origin` for authorization or identity.

Normal callers include:

```text
EOAs
Safe-style contract wallets
ERC-4337 smart accounts
routers/aggregators
```

Economic behavior and fees MUST be identical regardless of caller type.

---

# 20. Events

The event schema is frozen for v0.1. Implementations MAY add non-economic metadata fields only if they do not change the canonical fields below.

```text
PairCreated(
  pairId, token0, token1
)

TickCreated(
  tickId, pairId, direction, priceTick, durationDays, asset, quote
)

Supplied(
  tickId, supplier, assetAmount, sharesMinted, referrer
)

Withdrawn(
  tickId, supplier, assetAmount, sharesBurned
)

Collected(
  tickId, supplier,
  grossYield, yieldFeeTo, netYield,
  swapQuote, totalQuoteOut
)

UseOpened(
  positionId, tickId, user,
  assetAmount, quotePrincipal, grossYieldFee,
  openedAt, maturity, referrer
)

TermRepaid(
  positionId, tickId, user,
  assetAmount, quotePrincipal
)

TermClosed(
  positionId, tickId, user, caller,
  assetAmount, quotePrincipal,
  closeFee, providerSwapProceeds
)

ImmediateSwap(
  tickId, taker,
  assetAmount, quotePrincipal,
  referenceYieldFee, swapFee, providerSwapProceeds,
  referrer
)

GenerationFinalized(
  tickId, generationId,
  finalYieldGrowthX128, finalSwapQuoteGrowthX128
)
```

`referrer` appears only on Supply, Use and Immediate Swap and has no economic effect.

Indexers may derive `FEE_TO` from immutable deployment configuration; fee-bearing events expose the actual fee amount.

---

# 21. Preview/view functions

Reference views:

```solidity
previewSupply(tickId, assetAmount)
previewWithdraw(tickId, supplier, assetAmount)
previewUse(tickId, assetAmount)
previewSwap(tickId, assetAmount)
previewCollect(tickId, supplier)

getPair(tokenA, tokenB)
getTick(tickId)
getEarnPosition(supplier, tickId)
getPosition(positionId)
getEarnPositions(user, offset, limit)
getUsePositions(user, offset, limit)
```

`previewUse` SHOULD return:

```text
matchAmount
quotePrincipal
workingShareBefore
workingShareAfter
grossYieldFee
termFeeRate
maturity
```

`previewSwap` SHOULD return:

```text
assetAmount
quotePrincipal
referenceYieldFee
swapFee
providerSwapProceeds
```

`previewCollect` SHOULD separate:

```text
grossYield
yieldFeeTo
netYield
swapQuote
totalQuoteOut
```

---

# 22. Rounding rules

Canonical conservative direction:

```text
Supply share mint             → round DOWN
Withdraw max principal        → round DOWN
Withdraw shares burned        → round UP
Quote Principal required      → round UP
Gross Yield Fee               → round UP
Reference Yield Fee           → round UP
Growth increment              → round DOWN
Provider accrued claims       → round DOWN
Protocol fee                  → round DOWN, fee <= source amount
```

All multiply/divide paths MUST use full-precision overflow-safe arithmetic. Round-up paths MUST use checked ceil division and MUST NOT overflow through `x + denominator - 1` style arithmetic.

Rounding MUST never:

```text
create value
under-collateralize Quote escrow
allow Asset withdrawal above claim
allow claim payout above funded proceeds
make CloseFee or SwapFee exceed Quote Principal
leave C == 0 with S > 0
leave C > 0 with S == 0
```

Dust may remain in protocol accounting until naturally absorbed by later operations or generation finalization. No admin dust sweep is required in v0.1.

---

# 23. Security invariants

Property/fuzz tests MUST prove at minimum:

1. `availableSupply + workingSupply` changes only through Supply/Withdraw/Swap/Close; Use and Repay only move value between A and W.
2. After every successful state transition, `(availableSupply + workingSupply == 0) == (totalShares == 0)`.
3. Every ACTIVE Term Position has exactly its required Quote Principal escrowed.
4. Every position settles exactly once.
5. Repay and Close maturity boundaries are strict.
6. Equivalent split Uses are Yield-equivalent within documented rounding bounds and cannot reduce theoretical Yield through systematic round-down.
7. Use/Repay/Swap/Close complexity is independent of provider count.
8. Later suppliers receive no historical Yield or Swap Quote.
9. Withdraw synchronizes claims before burning shares; previously earned Yield/Quote cannot be lost.
10. A provider with zero shares may Collect old `owed*` but receives zero future growth.
11. Current shareholders, not historical suppliers, receive later Swap/Close growth when existing Working principal resolves.
12. `collect()` cannot charge Swap Quote twice.
13. Protocol fees can only reach immutable `FEE_TO`.
14. `CloseFee <= QuotePrincipal` and `SwapFee <= QuotePrincipal` on every accepted path.
15. A fully exhausted generation can restart without giving new shares old claims.
16. Same-block Supply withdrawal cooldown cannot be bypassed through Multicall.
17. Reentrancy cannot corrupt A/W/S, growth, escrow, or position status.
18. Nonstandard token behavior cannot silently create accounting deficits.
19. Permanent Term Position history remains readable after settlement.
20. No successful action can divide by zero or distribute growth with `totalShares == 0`.
21. Stored `priceX128` is the canonical value for `priceTick`; Quote Principal uses the frozen round-up formula.

---

# 24. Required implementation tests

At minimum:

```text
createPair canonicalization / deterministic pairId / reversed-input equivalence / duplicate / zero-address rejection
getPair returns the same canonical pairId and Pair state for `(tokenA, tokenB)` and `(tokenB, tokenA)`
getPair valid-but-uninitialized Pair reports non-existence unambiguously; invalid identical/zero-address input rejects
createTick direction, TickMath range, duration, canonical priceX128 and duplicate rejection
Single supplier → Use → Repay → Withdraw → Collect
Single supplier → Use → Close → Collect
Single supplier → immediate Swap → Collect
Withdraw before Collect preserves Yield and Swap Quote
Full Withdraw → shares zero → historical Collect still succeeds
Full Withdraw → later Use/Swap growth gives withdrawn provider zero
Multiple providers with different join times
Supplier joins after historical Use and receives no historical Yield
Supplier joins while Working > 0
Old provider withdraws Available after new supplier joins
Existing Working Repay after ownership has shifted through shares
Existing Working Close after ownership has shifted through shares
Supplier joins after historical Swap/Close
Partial withdrawal while Working > 0
100% Working then Repay
100% Working then Close
100% Available then immediate Swap → generation exhaustion
New Supply after exhausted generation
Same supplier rejoins after old generation exhaustion
Provider stale across multiple later generations syncs only its stored generation
Split Use invariance including 1-unit partitions
TickMath / priceX128 / Quote Principal cross-chain vectors
Gross Yield / Reference Yield round-up vectors
Protocol fee round-down vectors
CloseFee / SwapFee <= QuotePrincipal boundary
Front-run Yield bound / maxYieldFee
Swap maxQuoteIn bound
Deadline exact-boundary and expired cases
Maturity arithmetic overflow rejection
Maturity race Repay vs Close
Multicall withdraw + collect
Multicall multiple Uses
Fee-on-transfer/rebasing/callback token rejection
Extreme price/duration/amount arithmetic
1-unit share/principal/growth rounding cases
C == 0 / S > 0 and C > 0 / S == 0 invariant rejection
```

---

# 25. Out of scope v0.1

```text
oracles
liquidations
LTV / health factors
variable-rate lending
resting Demand orders
provider FIFO matching
per-provider matching loops
upgradeability
governance fee changes
onchain referral payouts
protocol token
external AMM deployment
native ETH core support
transferable LP/share token
automatic refinancing
portfolio margin
```

---

# 26. Canonical v0.1 mental model

```text
Supply   → Asset becomes Available
Use      → Available becomes Working; Yield is earned
Repay    → Working becomes Available; locked Quote returns to user
Swap     → Available Asset becomes provider claimable Quote
Close    → Working Asset becomes provider claimable Quote
Withdraw → provider removes currently Available Asset principal
Collect  → provider receives realized Quote principal + earned Yield
```

Provider shares own remaining Asset principal. Growth accumulators distribute realized Quote and Yield without iterating providers.

> **Asset moves. Quote locks.**
