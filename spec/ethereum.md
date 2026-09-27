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

A taker can consume active Available Asset in two ways:

- **Use** — receive Asset temporarily and lock Quote principal. The position freezes a full-term Asset Yield quote at opening. Yield then accrues linearly with elapsed time, with a **1-second minimum billable interval**, and is paid in **Asset only if the taker Repays** before maturity.
- **Swap** — accept the predefined exchange immediately in one transaction.

A Use therefore has two mutually exclusive economic outcomes:

```text
Return → Asset principal + accrued Asset Yield
Swap   → Quote principal at the posted price
```

No Yield is paid upfront. A taker that Repays earlier pays less Yield because Yield is charged from elapsed time, subject to a **1-second minimum billable interval**. A same-timestamp Repay therefore pays 1 second of Yield rather than zero. If the position reaches maturity, Repay is no longer available and permissionless Close settles the predefined Swap; no Asset Yield is owed on Close.

Supplier liquidity revolves by default. `withdraw(...)` removes a selected fraction of the supplier's **active shares**. The proportional Available part leaves immediately; the proportional active Working claim is redirected into a separate internal **Exit settlement pool**. Exit is a pooled priority claim on future Working resolution, not ownership of tagged Term Positions.

The active market remains open while Exit exists. Supply, Use and immediate Swap continue against active liquidity. Repay and Close resolve outstanding Exit Working with priority. When a Repay fills Exit, the corresponding Repay Yield is routed to Exit shareholders; any remaining Repay Yield is routed to active shareholders.

The protocol has no oracle, LTV, health factor, liquidation engine, variable borrow rate, resting Demand queue, per-provider maker matching, provider-position allocation, or mutable governance economics.

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

Permissionless infrastructure entrypoints `createPair(...)`, `createTick(...)`, and `settle(...)` initialize canonical markets or advance deterministic Tick settlement. They confer no economic privilege and are not user-facing Yield Order actions.

# 2. Core economic model

For each exact directional Tick:

```text
A  = availableSupply        // active Available Asset
W  = workingSupply          // all Asset currently held by ACTIVE Uses
E  = exitWorking            // subset of W reserved for Exit settlement
Wa = W - E                  // active Working
Ca = A + Wa                 // active remaining Asset principal
S  = totalShares            // active supplier shares

X  = totalExitShares        // current Exit-generation shares
```

`A`, `W`, `E`, `Wa`, and `Ca` are denominated in Asset units.

Active provider shares represent proportional ownership of **active remaining principal `Ca`**. They participate in new Uses and active Swap/Close proceeds. Repay Yield is not paid at Use opening; it is funded later if and when a Use Repays and is allocated according to the principal domain resolved by that Repay.

Exit shares are a separate internal settlement claim. They represent proportional ownership of the current unresolved Exit Working pool `E`; they do **not** participate in new Use opening or immediate Swap. Exit is **not tagged inventory**: no particular Term Position is permanently assigned to Exit. When a Repay resolves Exit principal, Exit shares receive the corresponding Asset Yield for that resolved principal.

Required live-state bounds:

```text
0 <= E <= W
Wa = W - E
Ca = A + Wa
(Ca == 0) == (S == 0)
(E  == 0) == (X == 0)
X >= E whenever E > 0
```

Therefore:

- Supply joins only the active pool `Ca`.
- Use consumes `A` and creates new active Working; it never increases `E`.
- Immediate Swap consumes only active Available `A`; it never touches Exit.
- Withdraw burns active shares immediately. Its proportional Available component is paid immediately and its proportional active Working component is redirected into Exit.
- Repay and Close resolve `E` first. Only the portion above outstanding Exit returns to or settles for the active pool.
- Exit is priority on **resolution flow**, not tagged Working. Any Repay/Close may satisfy `E`, including a Position opened after the Withdraw. New Uses never increase an existing `E`, but their later resolution may accelerate Exit.
- On Repay, Asset Yield follows the same principal split: the Yield corresponding to `exitFill` accrues to Exit shares; the residual Yield accrues to active shares.
- Historical active/Exit growth is checkpointed before the corresponding shares are burned or minted.
- Resolved Exit Asset, Exit Yield, Exit Quote, active Yield and active Quote are distributed with O(1) growth accounting.

Per provider:

```text
// active pool
shares
generation
yieldAssetGrowthLastX128
swapQuoteGrowthLastX128
owedYieldAsset
owedSwapQuote
yieldFeeCarry       // remainder in BPS-denominator units, always < BPS
lastSupplyBlock

// Exit settlement pool
exitShares
exitGeneration
exitAssetGrowthLastX128
exitYieldAssetGrowthLastX128
exitQuoteGrowthLastX128
owedExitAsset
owedExitYieldAsset
owedExitQuote
```

Per Tick:

```text
availableSupply
workingSupply
exitWorking

totalShares
yieldAssetGrowthX128
swapQuoteGrowthX128
generation

totalExitShares
exitAssetGrowthX128
exitYieldAssetGrowthX128
exitQuoteGrowthX128
exitGeneration

exitAssetReserve
yieldAssetReserve
exitQuoteReserve

nextPositionSeq
settleCursor
```

`yieldAssetReserve` backs **gross, funded but uncollected Asset Yield claims** from both active and Exit growth domains.

The supplier action split is:

```text
withdraw() → burn selected active shares; receive proportional Available Asset now;
             redirect proportional active Working into Exit

collect()  → receive currently claimable Exit Asset + net Asset Yield
             + Exit Quote + historical active Swap/Close Quote
```

Shares are an implementation unit. Product UX MUST NOT require suppliers to understand or enter raw share values; percentage/Max controls translate to active shares offchain.

Asset custody is split by accounting domain even though all Asset-denominated balances may sit in the same contract token balance:

```text
accounted Asset liability =
    availableSupply
  + exitAssetReserve
  + yieldAssetReserve
```

`Use` and immediate `Swap` may spend **only** `availableSupply`. `exitAssetReserve` and `yieldAssetReserve` are funded supplier property and MUST never be reused as active market liquidity. The contract's physical Asset balance MUST be at least the accounted Asset liability; unsolicited excess creates no shares or claims.

Quote custody remains separated conceptually:

```text
Quote escrow   → locked Quote principal for ACTIVE Uses
Quote proceeds → active Swap/Close claims + Exit Close claims
```

No Yield is funded into Quote custody.

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
tickSeq      uint64, per-Tick settlement order
```

Canonical EVM Tick identity is deterministic:

```solidity
tickId = uint256(
    keccak256(abi.encode(pairId, direction, priceTick, durationDays))
);
```

The same canonical Pair, direction, price tick, and duration MUST always derive the same `tickId` within every EVM deployment implementing v0.1. Caller-selected or sequential Tick identifiers are forbidden.

`nextPositionSeq` and `settleCursor` use checked `uint64` arithmetic. Sequence exhaustion MUST revert rather than wrap.

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

`createTick(pairId, direction, priceTick, durationDays)` is permissionless. It MUST derive the canonical `tickId` above, validate the Pair, direction, price range, positive duration, uniqueness, derive Asset/Quote from the frozen direction encoding, compute/store canonical `priceX128`, initialize active/Exit accounting to zero, including `exitWorking = 0`, `totalExitShares = 0`, `yieldAssetReserve = 0`, `exitAssetReserve = 0`, `exitQuoteReserve = 0`, `generation = 0`, `exitGeneration = 0`, `nextPositionSeq = 0`, and `settleCursor = 0`, and grant the caller no owner/admin/creator rights. Duplicate initialization of the same deterministic `tickId` MUST revert.

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
uint256 constant Q128 = 1 << 128;
uint256 constant FEE_BPS = 1_000; // 10%
address immutable FEE_TO;

uint256 constant MIN_DAILY_BPS = 1;   // 0.01% / day
uint256 constant MAX_DAILY_BPS = 100; // 1.00% / day
uint256 constant CURVE_EXPONENT = 3;
uint256 constant MIN_BILLABLE_SECONDS = 1;
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

Yield pricing uses **active liquidity only**. Exit Working has already left active supplier ownership and MUST NOT affect the price of a new Use.

Define:

```text
Wa = W - E
Ca = A + Wa
```

Working Share is:

\[
u = Wa / Ca
\]

when `Ca > 0`.

The theoretical marginal daily Yield rate is:

\[
r(u)=Min+(Max-Min)u^3
\]

with `Min = MIN_DAILY_BPS / BPS` and `Max = MAX_DAILY_BPS / BPS`.

For a Use moving `x` Asset from active Available to active Working:

```text
Ca = A0 + (W0 - E)
u0 = (W0 - E) / Ca
u1 = (W0 - E + x) / Ca
```

`E` is unchanged by Use, and `Ca` is unchanged by the A→W transition.

The theoretical integrated curve is:

\[
I(u_0,u_1)=Min(u_1-u_0)+\frac{Max-Min}{4}(u_1^4-u_0^4)
\]

For duration `D` days:

\[
FullTermYieldAsset=Ca \times D \times I(u_0,u_1)
\]

## 6.1 Canonical integer Yield algorithm

The theoretical formula above is descriptive. **The following fixed-point algorithm is normative** on EVM, Solana and the reference SDK. Implementations MUST NOT choose a different intermediate-rounding sequence.

```text
Q128 = 2^128
minBps = MIN_DAILY_BPS = 1
maxBps = MAX_DAILY_BPS = 100

u0X128 = floor(Wa       * Q128 / Ca)
u1X128 = floor((Wa + x) * Q128 / Ca)

pow4X128(u):
    u2 = floor(u  * u  / Q128)
    u4 = floor(u2 * u2 / Q128)
    return u4

u0Pow4X128 = pow4X128(u0X128)
u1Pow4X128 = pow4X128(u1X128)

deltaUX128  = u1X128 - u0X128
deltaU4X128 = u1Pow4X128 - u0Pow4X128

curveNumeratorX128 =
      4 * minBps * deltaUX128
    + (maxBps - minBps) * deltaU4X128

curveDenominator = 4 * BPS * Q128
durationCurveNumerator = checked(D * curveNumeratorX128)

FullTermYieldAsset = ceil(
    Ca * durationCurveNumerator / curveDenominator
)
```

`D` is the Tick's integer `durationDays`. `Ca * durationCurveNumerator / curveDenominator` MUST use checked full-precision multiply/divide with final rounding **UP** and no earlier division. All intermediate overflow MUST revert.

The Q128 utilization calculations and both `pow4X128` multiplications round **DOWN** exactly where shown. These intermediate roundings are part of the protocol and MUST match the shared EVM/Solana/SDK golden vectors.

If the canonical algorithm yields `FullTermYieldAsset == 0`, Use/Swap for that amount MUST reject rather than invent a minimum Yield amount.

For display-only marginal `Current Yield`, the reference SDK computes `uX128 = floor(Wa * Q128 / Ca)` and evaluates `Min + (Max-Min)u^3` with the same Q128 round-down convention. For a concrete Use amount, `FullTermYieldAsset` from the integrated algorithm is the authoritative transaction quote.

Canonical integer conversion:

```text
Quote Principal                    → round UP to Quote smallest units
Q128 utilization / powers          → round DOWN at the exact steps above
Full-Term Yield Asset              → round UP only at the final formula
Repay accrued Yield Asset          → round UP after billable-time proration
Reference Yield Quote              → round UP from Full-Term Yield Asset at Tick price
Close/Swap protocol fee            → round DOWN
Collect Yield fee                  → round DOWN with persistent BPS carry
```

The implementation MUST use overflow-safe full-precision arithmetic and checked ceil division.

At Use opening the protocol freezes `fullTermYieldAsset`. No Yield token transfer occurs.

For an ACTIVE Position that Repays before maturity:

```text
termSeconds     = maturity - openedAt
elapsed         = block.timestamp - openedAt
billableElapsed = max(MIN_BILLABLE_SECONDS, elapsed)
```

with `0 <= elapsed < termSeconds`, `MIN_BILLABLE_SECONDS = 1`, and:

\[
GrossYieldAsset=
\left\lceil
FullTermYieldAsset \times billableElapsed / termSeconds
\right\rceil
\]

where `billableElapsed = max(1, elapsed)`. Therefore a same-timestamp Repay is billed as exactly 1 second. Because `fullTermYieldAsset > 0`, every successful Repay owes at least 1 raw Asset unit under canonical round-up.

Therefore:

```text
earlier Repay → lower absolute Yield
later Repay   → higher absolute Yield
Close         → no Asset Yield payment
```

`GrossYieldAsset` MUST never exceed `fullTermYieldAsset`.

Equivalent Uses traversing the same active Working Share path MUST produce the same theoretical full-term Yield subject only to the canonical deterministic integer-rounding bounds above.

For Close/Immediate Swap fee calculation, convert the frozen/reference full-term Asset Yield into Quote at the canonical Tick price:

\[
ReferenceYieldQuote=
\left\lceil
FullTermYieldAsset \times priceX128 / 2^{128}
\right\rceil
\]

The reference conversion exists only for protocol fee calculation on the Swap outcome. It is not provider Yield.

# 7. Active share and Exit accounting

## 7.1 Supply

Canonical protocol entry:

```solidity
supply(uint256 tickId, uint256 assetAmount, address referrer)
```

Every call first performs the automatic settlement hook in §15.2, then synchronizes the supplier's active and Exit accounting before changing active shares.

Define pre-supply:

```text
Wa = workingSupply - exitWorking
Ca = availableSupply + Wa
S  = totalShares
```

For `assetIn > 0`:

If the active pool is empty:

```text
S == 0
Ca == 0
sharesMinted = assetIn
```

Otherwise:

\[
sharesMinted=\left\lfloor assetIn \times S / Ca \right\rfloor
\]

Requirements:

```text
assetIn > 0
(S == 0) == (Ca == 0)
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

Supply never changes:

```text
workingSupply
exitWorking
totalExitShares
```

A supplier may create/restart active liquidity while an older Exit pool is resolving. The supplier joins only `Ca`; it does not inherit Exit Working or historical active/Exit proceeds.

`Supply` creates no Yield by itself. Yield is funded only when a Use later Repays.

`supply()` accepts `referrer` for event attribution only. It MUST NOT store or economically use the referrer.

## 7.2 Withdraw: active shares → immediate Asset + Exit

Canonical protocol entry:

```solidity
withdraw(uint256 tickId, uint256 sharesToWithdraw)
```

`sharesToWithdraw` is an internal protocol unit. Product UX SHOULD expose percentages / Max, not raw shares.

Every call first performs the automatic settlement hook in §15.2, then synchronizes both:

```text
active provider growth → owedYieldAsset / owedSwapQuote
Exit provider growth   → owedExitAsset / owedExitYieldAsset / owedExitQuote
```

Define the pre-withdraw active state:

```text
A  = availableSupply
Wa = workingSupply - exitWorking
Ca = A + Wa
S  = totalShares
x  = sharesToWithdraw
```

Requirements:

```text
x > 0
x <= provider.shares
S > 0
Ca > 0
block.number > provider.lastSupplyBlock
```

The selected shares own this amount of active principal:

\[
principalClaim=\left\lfloor x \times Ca / S \right\rfloor
\]

Normally require `principalClaim > 0`.

The only exception is an explicit **Max / full-provider-share** withdrawal where `x == provider.shares` and rounding gives `principalClaim == 0`. That call MAY burn the provider's remaining sub-unit active-share dust with `availableOut = 0` and `workingToExit = 0`. This intentionally relinquishes an unpayable sub-unit claim to the remaining active shareholders and makes Max withdrawal deterministic. A partial withdrawal with `principalClaim == 0` MUST revert.

Split a non-zero principal claim between immediate Available Asset and Working redirected to Exit. Canonical rounding assigns any one-unit split remainder to Working rather than overpaying immediate Asset:

\[
availableOut=\left\lfloor x \times A / S \right\rfloor
\]

```text
workingToExit = principalClaim - availableOut
```

Required:

```text
availableOut <= A
workingToExit <= Wa
availableOut + workingToExit == principalClaim
```

The active shares are burned immediately:

```text
availableSupply -= availableOut
totalShares -= x
provider.shares -= x
```

`workingSupply` does not change. `workingToExit` reclassifies existing active Working into Exit Working:

```text
exitWorking += workingToExit
```

If `workingToExit > 0`, mint Exit shares against the **pre-add** Exit pool.

If the Exit pool is empty:

```text
preExitWorking == 0
preTotalExitShares == 0
exitSharesMinted = workingToExit
```

Otherwise:

\[
exitSharesMinted=\left\lfloor workingToExit \times preTotalExitShares / preExitWorking \right\rfloor
\]

The invariant `preTotalExitShares >= preExitWorking > 0` implies `exitSharesMinted >= workingToExit > 0` for every non-zero `workingToExit`. The implementation MUST still assert `exitSharesMinted > 0` defensively.

Then:

```text
provider.exitShares += exitSharesMinted
totalExitShares += exitSharesMinted
```

The provider's Exit growth checkpoints were synchronized before minting, so newly minted Exit shares receive no historical Exit Asset/Yield/Quote.

Finally:

```text
Asset availableOut → provider
```

After mutation:

```text
0 <= exitWorking <= workingSupply
(activePrincipal == 0) == (totalShares == 0)
(exitWorking == 0) == (totalExitShares == 0)
totalExitShares >= exitWorking whenever exitWorking > 0
```

where:

```text
activePrincipal = availableSupply + workingSupply - exitWorking
```

A full active withdrawal may therefore produce:

```text
provider.shares == 0
provider.exitShares > 0
```

The provider has left active liquidity but still owns unresolved Exit settlement claims. Exit shares do not participate in **new Use opening**, but if Repay resolution is allocated to Exit they receive the corresponding Asset Yield because that Yield is paid together with the returned principal.

Withdraw never selects individual Term Positions. Exit is pooled priority settlement: `exitWorking` is satisfied by the next Working principal that resolves through Repay or Close, in settlement order. Exit is one-way in v0.1: there is no Exit→Active conversion; a supplier re-enters active liquidity only through a new Supply.

## 7.3 One-block Supply withdrawal cooldown

A supplier that calls Supply in block `N` cannot withdraw active shares from that supplier × Tick position until:

```solidity
block.number > lastSupplyBlock
```

This is defense-in-depth against atomic Supply/Withdraw capacity manipulation. It is not a solvency mechanism and does not affect already-existing Exit claims.

# 8. Growth accounting

There are two share domains and three economic growth streams.

## 8.1 Active growth

Active supplier accounting uses:

```text
yieldAssetGrowthX128
swapQuoteGrowthX128
```

Before active share mutation or `collect()`:

```text
owedYieldAsset += shares * (yieldAssetGrowthX128 - yieldAssetGrowthLastX128) / Q128
owedSwapQuote  += shares * (swapQuoteGrowthX128 - swapQuoteGrowthLastX128) / Q128

yieldAssetGrowthLastX128 = yieldAssetGrowthX128
swapQuoteGrowthLastX128  = swapQuoteGrowthX128
```

`yieldAssetGrowthX128` increases only when a Repay allocates part of its accrued Asset Yield to active principal.

`swapQuoteGrowthX128` increases only from Immediate Swap or the active portion of Close.

## 8.2 Exit growth

Exit settlement accounting uses:

```text
exitAssetGrowthX128
exitYieldAssetGrowthX128
exitQuoteGrowthX128
```

Before Exit-share mutation or `collect()`:

```text
owedExitAsset += exitShares * (exitAssetGrowthX128 - exitAssetGrowthLastX128) / Q128
owedExitYieldAsset += exitShares * (exitYieldAssetGrowthX128 - exitYieldAssetGrowthLastX128) / Q128
owedExitQuote += exitShares * (exitQuoteGrowthX128 - exitQuoteGrowthLastX128) / Q128

exitAssetGrowthLastX128      = exitAssetGrowthX128
exitYieldAssetGrowthLastX128 = exitYieldAssetGrowthX128
exitQuoteGrowthLastX128      = exitQuoteGrowthX128
```

Repay creates Exit Asset principal growth and may also create Exit Asset Yield growth. Close creates Exit Quote growth. New Exit shares checkpoint all current Exit growth before minting and receive no historical Exit proceeds.

All multiplications/divisions MUST use overflow-safe full-precision arithmetic. Growth increments and provider realization round down. Funded residual dust remains protocol-accounted and MUST never create an unfunded claim.

When active or Exit shares reach zero, already synchronized `owed*` balances remain collectible; zero shares receive no future growth.

No Yield growth is created at `use()`. Yield growth is created only when Repay funds actual accrued Asset Yield.

# 9. Use

Canonical entry:

```solidity
use(
    uint256 tickId,
    uint256 assetAmount,
    uint256 maxFullTermYieldAsset,
    uint256 deadline,
    address referrer
)
```

The call performs the automatic settlement hook in §15.2 before Use-specific checks.

Define:

```text
Wa = workingSupply - exitWorking
Ca = availableSupply + Wa
```

Requirements:

```text
assetAmount > 0
assetAmount <= availableSupply
Ca > 0
totalShares > 0
block.timestamp <= deadline
QuotePrincipal > 0
FullTermYieldAsset > 0
FullTermYieldAsset <= maxFullTermYieldAsset
maturity = checked(openedAt + durationDays * 1 days)
```

Compute:

```text
FullTermYieldAsset = canonical active-liquidity Yield quote from §6
ReferenceYieldQuote = ceil(FullTermYieldAsset * priceX128 / 2^128)
CloseFee = floor(ReferenceYieldQuote * FEE_BPS / BPS)
```

Require:

```text
CloseFee <= QuotePrincipal
```

`FullTermYieldAsset` and `CloseFee` are frozen for the Position at opening.

**Exit state never blocks Use.** `availableSupply` is active Available liquidity by definition; Exit Working is excluded from active pricing.

Execution:

```text
availableSupply -= assetAmount
workingSupply += assetAmount
exitWorking unchanged

Asset → user
Quote Principal → locked escrow
```

No Yield Asset is transferred at Use opening and no Yield growth is created.

A permanent sequential Term Position is created with at least:

```text
positionId
tickId
tickSeq
user
assetAmount
quotePrincipal
fullTermYieldAsset
closeFee
openedAt
maturity
status = ACTIVE
```

Global and Tick-local identifiers are allocated atomically:

```text
positionId = nextPositionId
nextPositionId = checked(nextPositionId + 1)

tickSeq = nextPositionSeq
nextPositionSeq = checked(nextPositionSeq + 1)
tickPositionId[tickId][tickSeq] = positionId
```

`nextPositionId` is contract-global, initializes to `1`, and is used only to allocate permanent EVM Term Position IDs. Exhaustion MUST revert rather than wrap. `positionId == 0` is reserved as invalid/default.

`tickSeq` is settlement-order metadata. The externally canonical EVM position identifier remains permanent `positionId`.

`referrer` is event-only.

# 10. Repay

Repay is allowed only when:

```text
status == ACTIVE
block.timestamp < maturity
msg.sender == position.user
```

v0.1 requires full repayment.

Canonical entry includes a Yield slippage bound:

```solidity
repay(uint256 positionId, uint256 maxYieldAsset)
```

Before Repay-specific checks, apply the settlement hook in §15.2 unless the requested Position is the current `settleCursor` entry.

Let:

```text
x = position.assetAmount
termSeconds = position.maturity - position.openedAt
elapsed = block.timestamp - position.openedAt
billableElapsed = max(MIN_BILLABLE_SECONDS, elapsed)

grossYieldAsset =
    ceil(position.fullTermYieldAsset * billableElapsed / termSeconds)
```

Require:

```text
grossYieldAsset <= position.fullTermYieldAsset
grossYieldAsset <= maxYieldAsset
```

Yield is therefore paid from **elapsed time used**, with a 1-second minimum billable interval. It is not recalculated from current utilization; the full-term quote was frozen at Use opening and only billable elapsed time changes the amount due.

Principal resolution:

```text
exitFill = min(x, exitWorking)
activeReturn = x - exitFill
```

Split gross Asset Yield using the same principal resolution ratio:

```text
exitYieldAsset = floor(grossYieldAsset * exitFill / x)
activeYieldAsset = grossYieldAsset - exitYieldAsset
```

This exact remainder rule guarantees:

```text
exitYieldAsset + activeYieldAsset == grossYieldAsset
```

Execution:

```text
Asset principal + grossYieldAsset from user → protocol
workingSupply -= x
exitWorking -= exitFill
availableSupply += activeReturn
locked Quote Principal → user
status = REPAID
```

Funded principal/Yield accounting:

```text
if exitFill > 0:
    exitAssetReserve += exitFill
    exitAssetGrowthX128 += exitFill * Q128 / totalExitShares

if grossYieldAsset > 0:
    yieldAssetReserve += grossYieldAsset

if exitYieldAsset > 0:
    exitYieldAssetGrowthX128 += exitYieldAsset * Q128 / totalExitShares

if activeYieldAsset > 0:
    yieldAssetGrowthX128 += activeYieldAsset * Q128 / totalShares
```

Required denominator rules:

```text
exitFill > 0 or exitYieldAsset > 0  → totalExitShares > 0
activeYieldAsset > 0                → totalShares > 0
totalShares == 0                    → activeReturn == 0 and activeYieldAsset == 0
```

Repay itself takes no immediate protocol fee. Gross Asset Yield remains funded in `yieldAssetReserve`; the Yield protocol fee is assessed when the provider Collects.

Thus a Repay may pay Yield to Exit shares even when the repaid Position opened after the Exit was created. Exit is priority on pooled resolution flow, not tagged inventory.

If this Repay reduces `exitWorking` to zero, finalize the Exit generation atomically under §14.2 after applying the final Exit Asset/Yield growth increments.

The active user-position index entry is removed in O(1) using swap-and-pop. The permanent Term Position record remains readable.

If the repaid Position is the current cursor entry after any pre-step, advance `settleCursor` by one.

# 11. Close

Canonical protocol entry:

```solidity
close(uint256 positionId)
```

Close is permissionless at:

```text
status == ACTIVE
block.timestamp >= maturity
```

Repay is forbidden from maturity onward.

Before Close-specific checks, apply the settlement hook in §15.2 unless the requested Position is the current cursor entry.

Close is the predefined **Swap outcome**. The Use user keeps the Asset. No Asset Yield is owed on Close.

The Position stores the `closeFee` frozen at Use opening from its full-term reference Yield. Require:

```text
closeFee <= quotePrincipal
```

Let:

```text
x = position.assetAmount
ProviderSwapProceeds = quotePrincipal - closeFee
exitFill = min(x, exitWorking)
activeFill = x - exitFill
```

Split the **net** provider Quote proceeds proportionally by the Asset principal resolved:

```text
exitQuote = floor(ProviderSwapProceeds * exitFill / x)
activeQuote = ProviderSwapProceeds - exitQuote
```

Then:

```text
workingSupply -= x
exitWorking -= exitFill
CloseFee → FEE_TO
status = CLOSED
```

If `exitQuote > 0`:

```text
exitQuoteReserve += exitQuote
exitQuoteGrowthX128 += exitQuote * Q128 / totalExitShares
```

If `activeQuote > 0`:

```text
swapQuoteGrowthX128 += activeQuote * Q128 / totalShares
```

A non-zero Exit distribution requires `totalExitShares > 0`; a non-zero active distribution requires `totalShares > 0`. In particular, `totalShares == 0` MUST imply `activeQuote == 0`.

Close creates no Yield Asset growth. The economic outcomes are mutually exclusive:

```text
Repay → Asset principal + accrued Asset Yield
Close → Quote principal at posted price, net of Close Fee
```

If this Close exhausts Exit Working, finalize the Exit generation atomically after its final Quote growth increment. If it exhausts active principal while active shares still exist, finalize the active generation atomically after its final active Quote growth increment. Both finalizations may occur in the same Close.

No oracle is consulted.

If the closed Position is the current cursor entry after any pre-step, advance `settleCursor` by one.

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

The call performs the automatic settlement hook in §15.2 first.

Requirements:

```text
assetAmount > 0
assetAmount <= availableSupply
activePrincipal > 0
totalShares > 0
block.timestamp <= deadline
QuotePrincipal <= maxQuoteIn
```

Immediate Swap creates no Term Position and no Working state. It consumes only **active Available** liquidity; Exit Working is untouched.

For fee calculation only, compute the **Reference Full-Term Yield Asset** using the same active-liquidity Yield pricing function an equivalent Use would apply to the same Tick and amount.

Then:

```text
ReferenceYieldQuote =
    ceil(ReferenceFullTermYieldAsset * priceX128 / 2^128)

SwapFee =
    floor(ReferenceYieldQuote * FEE_BPS / BPS)
```

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

Only active shares receive Immediate Swap proceeds. Exit shares never participate.

If the Swap exhausts active principal while active shares remain, active generation finalization in §14.1 executes atomically. Exit state is independent and remains untouched.

The taker pays only Quote Principal. `referrer` is event-only.

# 13. Collect

Canonical supplier entry:

```solidity
collect(uint256 tickId)
```

The call performs the automatic settlement hook in §15.2, then synchronizes both active and Exit accounting for `msg.sender`, including stale active/Exit generation snapshots when required.

Collect transfers **everything currently claimable** for the supplier in the selected Tick:

```text
Exit Asset principal resolved by Repay
Exit Asset Yield resolved by Repay
active Asset Yield resolved by Repay
Exit Quote resolved by Close
historical active Swap/Close Quote
```

Let:

```text
exitAsset = owedExitAsset
exitYieldAsset = owedExitYieldAsset
activeYieldAsset = owedYieldAsset
swapQuote = owedSwapQuote
exitQuote = owedExitQuote

grossYieldAsset = exitYieldAsset + activeYieldAsset
```

Provider Yield protocol fee is **collection-frequency invariant**. Each provider × Tick keeps `yieldFeeCarry`, initialized to `0` and constrained to `0 <= yieldFeeCarry < BPS`.

```text
feeNumerator = grossYieldAsset * FEE_BPS + yieldFeeCarry
YieldFeeAsset = floor(feeNumerator / BPS)
yieldFeeCarry = feeNumerator % BPS
```

The multiplication/addition MUST use checked full-precision arithmetic. Splitting the same cumulative gross Asset Yield across multiple `collect()` calls MUST produce exactly the same cumulative fee as one collection:

```text
cumulative Yield fee = floor(cumulative gross Yield * FEE_BPS / BPS)
```

Then:

```text
NetYieldAsset = grossYieldAsset - YieldFeeAsset

(exitAsset + NetYieldAsset) Asset → supplier
YieldFeeAsset Asset → FEE_TO

(exitQuote + swapQuote) Quote → supplier
```

Accounting:

```text
exitAssetReserve -= exitAsset
yieldAssetReserve -= grossYieldAsset
exitQuoteReserve -= exitQuote

owedExitAsset = 0
owedExitYieldAsset = 0
owedYieldAsset = 0
owedExitQuote = 0
owedSwapQuote = 0
```

Exit Quote and active Swap/Close Quote are not charged again because Close/Swap already paid their protocol fee when realized. Only Yield is charged at collection, and that fee is denominated in **Asset** because Yield itself is denominated in Asset.

Collect may therefore transfer both Tick tokens in one transaction. Any zero component is skipped.

Collect does **not** require Exit to be fully resolved. Exit shares may remain while `exitWorking > 0`; future Repay/Close growth can be collected later.

`collect()` is supplier-authorized in v0.1; it is not permissionless and never pays a caller other than the supplier whose ProviderPosition is being collected. `yieldFeeCarry` is protocol accounting, not a supplier claim; it persists across periods with zero shares/claims and MUST NOT be reset by leaving and later re-entering the Tick.

A supplier may Withdraw before Collect without losing funded economics because all active/Exit growth is synchronized before active shares are burned or new Exit shares are minted.

# 14. Active and Exit generations

The active pool and Exit pool have independent generations because either can exhaust while the other remains live.

## 14.1 Active generation finalization

Define:

```text
activePrincipal = availableSupply + workingSupply - exitWorking
```

The active invariant is:

```text
(activePrincipal == 0) == (totalShares == 0)
```

Supply and Withdraw preserve this directly.

Immediate Swap or the active portion of Close can transform the final active Asset principal into Quote while active shares still exist. When an action would produce:

```text
activePrincipal == 0
totalShares > 0   // pre-finalization shares
```

apply the final active growth increment using the pre-reset `totalShares`, persist:

```text
generationId
finalYieldAssetGrowthX128
finalSwapQuoteGrowthX128
```

then:

```text
totalShares = 0
generation += 1
yieldAssetGrowthX128 = 0
swapQuoteGrowthX128 = 0
```

`availableSupply`, `workingSupply`, and `exitWorking` are **not** blindly zeroed by active-generation finalization. In particular, `workingSupply == exitWorking > 0` is valid when all remaining Working belongs to Exit.

A Repay may also create the final active Yield growth for a generation. If the same Repay leaves `activePrincipal == 0`, apply that final active Yield increment before active finalization.

A provider whose active generation is stale synchronizes exactly its stored finalized generation, realizes old `owedYieldAsset` / `owedSwapQuote`, clears old active shares, advances to the current active generation, and checkpoints current active growth.

A full Withdraw that burns the final active shares and directly leaves `activePrincipal == 0` does not require an active GenerationState snapshot because no stale active shares remain.

`yieldAssetReserve` is **not** zeroed on active-generation finalization; it backs already-funded uncollected Yield claims.

## 14.2 Exit generation finalization

The Exit invariant is:

```text
(exitWorking == 0) == (totalExitShares == 0)
totalExitShares >= exitWorking whenever exitWorking > 0
```

Repay or Close may resolve the final Exit Working while Exit shares still exist. After applying the final Exit Asset/Yield/Quote growth increment, persist:

```text
exitGenerationId
finalExitAssetGrowthX128
finalExitYieldAssetGrowthX128
finalExitQuoteGrowthX128
```

then:

```text
totalExitShares = 0
exitGeneration += 1
exitAssetGrowthX128 = 0
exitYieldAssetGrowthX128 = 0
exitQuoteGrowthX128 = 0
```

`exitAssetReserve`, `yieldAssetReserve`, and `exitQuoteReserve` are **not** zeroed: they back already-funded uncollected claims from current or finalized generations.

A provider whose `exitGeneration` is stale synchronizes exactly its stored Exit generation snapshot, realizes `owedExitAsset` / `owedExitYieldAsset` / `owedExitQuote`, clears old Exit shares, advances to the current Exit generation, and checkpoints current Exit growth.

A provider may be stale in the active generation, Exit generation, or both; each synchronization remains O(1) and independent.

Neither active nor Exit generation finalization resets `settleCursor`. Term Position settlement order is permanent across liquidity generations.

# 15. Term Position lifecycle and settlement cursor

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

Global `positionId` values are monotonically increasing and permanent. `nextPositionId` initializes to `1`; successful `use()` consumes exactly one ID and increments it with checked arithmetic. Reverts consume no ID.

## 15.1 Per-Tick settlement order

Each Tick assigns a monotonically increasing local `tickSeq` when a Use opens:

```text
tickSeq = nextPositionSeq
nextPositionSeq += 1
```

The core stores:

```solidity
mapping(uint256 tickId => mapping(uint64 tickSeq => uint256 positionId))
    tickPositionId;
```

and the Tick stores:

```text
nextPositionSeq
settleCursor
```

Both initialize to zero.

All Term Positions within one Tick use the same `durationDays`. Since opening time is non-decreasing with `tickSeq`, maturity is also non-decreasing. Therefore:

> If the ACTIVE Position at `settleCursor` is not mature, no later ACTIVE Position in that Tick can be mature.

No indexer, heap, provider loop, or unbounded search is required.

## 15.2 `settle(tickId)` and automatic settlement hook

Canonical infrastructure entry:

```solidity
settle(uint256 tickId)
```

`settle(tickId)` is permissionless and processes **at most one** cursor entry:

```text
if settleCursor == nextPositionSeq:
    no-op

positionId = tickPositionId[tickId][settleCursor]
position = positions[positionId]

if position.status != ACTIVE:
    settleCursor += 1
    return

if block.timestamp < position.maturity:
    return

Close(position) using the exact canonical Close economics
settleCursor += 1
```

Every economic Tick entrypoint attempts one settlement step so ordinary protocol activity continuously advances old positions:

- `supply`, `withdraw`, `collect`, `use`, and `swap` call `_settleOne(tickId)` before action-specific mutation.
- `repay(positionId)` and `close(positionId)` skip the pre-step when their requested Position is exactly the current cursor entry; their successful terminal transition advances the cursor.
- If `repay`/`close` targets another Position, it performs the normal pre-step first.
- standalone `settle(tickId)` performs only `_settleOne(tickId)`.

A settlement step never loops. `TermClosed` emitted by settlement is identical to direct Close.

Because Use and Swap are never blocked by Exit, successful normal market activity can both advance `settleCursor` and continue trading in the same transaction.

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

A supplier × Tick Earn entry remains active while it has any of:

```text
current active shares
current Exit shares
owedYieldAsset
owedSwapQuote
owedExitAsset
owedExitYieldAsset
owedExitQuote
unsynchronized active-generation or Exit-generation claims
```

Term Position history remains in permanent `positions[positionId]` storage.

# 17. Multicall and composition

The core MUST inherit or expose OpenZeppelin `Multicall` semantics.

No bespoke batch APIs are required:

```text
no batchUse
no batchSupply
no batchRepay
no batchClose
no batchSettle
```

Useful compositions include:

```text
withdraw + collect
multiple independent Uses
multiple independent Swaps
multiple Repays / Closes
settle + collect
```

Each `use()` still creates an independent Term Position.

The automatic one-step settlement hook is part of each economic entrypoint. Explicit `settle(tickId)` remains available when callers want to advance the cursor without another economic action.

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
  tickId, supplier,
  sharesBurned,
  principalClaim,
  availableAssetOut,
  workingToExit,
  exitSharesMinted
)

Collected(
  tickId, supplier,
  exitAsset,
  grossYieldAsset, yieldFeeAsset, netYieldAsset,
  exitQuote, swapQuote,
  totalAssetOut, totalQuoteOut
)

UseOpened(
  positionId, tickId, tickSeq, user,
  assetAmount, quotePrincipal,
  fullTermYieldAsset, closeFee,
  openedAt, maturity, referrer
)

TermRepaid(
  positionId, tickId, tickSeq, user,
  assetAmount, quotePrincipal,
  grossYieldAsset,
  exitFill, activeReturn,
  exitYieldAsset, activeYieldAsset
)

TermClosed(
  positionId, tickId, tickSeq, user, caller,
  assetAmount, quotePrincipal,
  closeFee, providerSwapProceeds,
  exitFill, exitQuote, activeQuote
)

ImmediateSwap(
  tickId, taker,
  assetAmount, quotePrincipal,
  referenceFullTermYieldAsset,
  referenceYieldQuote,
  swapFee, providerSwapProceeds,
  referrer
)

GenerationFinalized(
  tickId, generationId,
  finalYieldAssetGrowthX128, finalSwapQuoteGrowthX128
)

ExitGenerationFinalized(
  tickId, exitGenerationId,
  finalExitAssetGrowthX128,
  finalExitYieldAssetGrowthX128,
  finalExitQuoteGrowthX128
)
```

`settle(tickId)` emits no separate economic event when it only advances past an already-terminal cursor entry. When it closes a mature Position it emits the canonical `TermClosed` event.

`referrer` appears only on Supply, Use and Immediate Swap and has no economic effect.

# 21. Preview/view functions

All state-sensitive `preview*` functions MUST preview the state **after the same one-step automatic settlement hook** that the corresponding state-changing action would execute. If that step would Close a mature cursor Position, the preview MUST include the resulting active/Exit/reserve/generation changes before quoting the requested action.

Reference views:

```solidity
previewSupply(tickId, assetAmount)
previewWithdraw(tickId, supplier, sharesToWithdraw)
previewUse(tickId, assetAmount)
previewRepay(positionId)
previewSwap(tickId, assetAmount)
previewCollect(tickId, supplier)

getPair(tokenA, tokenB)
getTick(tickId)
getEarnPosition(supplier, tickId)
getPosition(positionId)
getEarnPositions(user, offset, limit)
getUsePositions(user, offset, limit)
```

`getTick` MUST expose at least:

```text
availableSupply
workingSupply
exitWorking
activeWorking = workingSupply - exitWorking
activePrincipal = availableSupply + activeWorking

totalShares
totalExitShares
yieldAssetReserve
exitAssetReserve
exitQuoteReserve

generation
exitGeneration
nextPositionSeq
settleCursor
```

`getEarnPosition` MUST expose active and Exit claims separately, including `shares`, `exitShares`, claimable Asset Yield, Exit Asset, Exit Yield and Quote claims.

`previewWithdraw` SHOULD return:

```text
sharesToWithdraw
principalClaim
availableAssetOut
workingToExit
exitSharesMinted
remainingActiveShares
remainingExitShares
```

`previewUse` SHOULD return:

```text
matchAmount
quotePrincipal
activeWorkingShareBefore
activeWorkingShareAfter
fullTermYieldAsset
referenceYieldQuote
closeFee
dailyRate
termRate
maturity
```

`previewRepay` SHOULD return using the current timestamp:

```text
assetPrincipal
grossYieldAsset
totalAssetIn
exitFill
activeReturn
exitYieldAsset
activeYieldAsset
quotePrincipalUnlocked
```

`previewSwap` SHOULD return:

```text
assetAmount
quotePrincipal
referenceFullTermYieldAsset
referenceYieldQuote
swapFee
providerSwapProceeds
```

`previewCollect` SHOULD separate:

```text
exitAsset
activeYieldAsset
exitYieldAsset
grossYieldAsset
yieldFeeAsset
netYieldAsset

exitQuote
swapQuote

totalAssetOut
totalQuoteOut
```

Views MAY expose the current cursor Position/status/maturity for UX/debugging.

# 22. Rounding rules

Canonical conservative direction:

```text
Supply active shares                    → round DOWN
Withdraw active principal claim         → round DOWN
Withdraw immediate Available component  → round DOWN
Withdraw Working→Exit component         → claim - Available component
Exit shares minted into live Exit pool  → round DOWN

Quote Principal required                → round UP
Full-Term Yield Asset                   → round UP
Repay billable-time Yield Asset         → round UP
Reference Yield Quote                   → round UP

Repay gross Yield allocated to Exit     → round DOWN
Repay gross Yield residual to active    → exact remainder

Close net Quote allocated to Exit       → round DOWN
Close net Quote residual to active      → exact remainder

Active/Exit growth increments            → round DOWN
Provider accrued claims                  → round DOWN
Close/Swap protocol fee                  → round DOWN, fee <= source amount
Collect Yield fee                         → round DOWN with persistent BPS carry
```

All multiply/divide paths MUST use full-precision overflow-safe arithmetic. Round-up paths MUST use checked ceil division and MUST NOT overflow through `x + denominator - 1` style arithmetic.

Rounding MUST never:

```text
create value
under-collateralize Quote escrow
make Repay gross Yield exceed fullTermYieldAsset
pay immediate Asset above the selected active-share claim
redirect more Working than active Working owned by the selected shares
violate totalExitShares >= exitWorking
mint zero Exit shares for non-zero Working redirected to a live Exit pool
allow Exit/active claim payout above funded reserves
make CloseFee or SwapFee exceed Quote Principal
leave exitWorking > workingSupply
leave activePrincipal == 0 with totalShares > 0
leave activePrincipal > 0 with totalShares == 0
leave exitWorking == 0 with totalExitShares > 0
leave exitWorking > 0 with totalExitShares == 0
produce activeYieldAsset > 0 with totalShares == 0
```

Deterministic residual dust may remain protocol-accounted and MUST never create an unfunded claim.

# 23. Security invariants

Property/fuzz tests MUST prove at minimum:

1. `0 <= exitWorking <= workingSupply` always holds.
2. `activeWorking = workingSupply - exitWorking` and `activePrincipal = availableSupply + activeWorking` never underflow.
3. `(activePrincipal == 0) == (totalShares == 0)` after every successful transition.
4. `(exitWorking == 0) == (totalExitShares == 0)` and `totalExitShares >= exitWorking` whenever `exitWorking > 0`.
5. Withdraw burns exactly the requested active shares and can affect only that provider's active ownership.
6. Withdraw pays only the selected shares' proportional Available component and redirects only their proportional active Working component to Exit.
7. Redirecting Working to Exit does not change `workingSupply`.
8. Use creates no Yield transfer or Yield growth.
9. `fullTermYieldAsset` is frozen at Use opening from active liquidity only.
10. Repay Yield depends only on frozen `fullTermYieldAsset` and `billableElapsed = max(1, actual elapsed seconds)`; current utilization cannot change an existing Position's rate.
11. `0 < grossYieldAsset <= fullTermYieldAsset` for every successful Repay; same-timestamp Repay is billed as 1 second.
12. Repay transfers Asset principal + accrued Asset Yield and unlocks the full Quote principal.
13. Repay allocates `min(assetAmount, exitWorking)` of principal to Exit before active Available.
14. Repay splits gross Asset Yield by the same principal resolution ratio; Exit + active Yield equals gross Yield exactly.
15. Exit shares may receive Repay Yield but receive no economics from new Use opening or Immediate Swap.
16. Active shares receive no Exit principal/Quote growth.
17. Close creates no Asset Yield and is the mutually exclusive Swap outcome.
18. Close allocates `min(assetAmount, exitWorking)` of principal to Exit before active Quote distribution.
19. Close net proceeds split exactly into Exit + active portions.
20. Immediate Swap never changes `exitWorking` and pays only active shareholders.
21. Supply/Use/Swap remain valid while Exit exists, subject to ordinary active-liquidity constraints.
22. Exit is pooled priority settlement, not tagged Working: no Term Position is permanently assigned to an Exit claim.
23. `exitWorking` grows only on Withdraw and shrinks only on Repay/Close. New Uses never increase an existing Exit claim; later Repay/Close may accelerate Exit.
24. Asset custody always covers `availableSupply + exitAssetReserve + yieldAssetReserve`; Use/Swap may debit only `availableSupply`.
25. `yieldAssetReserve` always covers funded but uncollected gross Asset Yield claims.
26. Quote escrow always covers every ACTIVE Position's Quote Principal.
27. Quote proceeds custody always covers funded active/Exit Quote claims.
28. Yield protocol fee is charged only on funded gross Asset Yield at Collect, uses persistent per-provider BPS carry so collection frequency cannot change the cumulative fee, and reaches only immutable `FEE_TO`.
29. Close/Swap protocol fees are Quote-denominated reference fees derived from full-term Asset Yield and reach only immutable `FEE_TO`.
30. `CloseFee <= QuotePrincipal` and `SwapFee <= QuotePrincipal` on every accepted path.
31. Every position settles exactly once; Repay/Close maturity boundaries are strict.
32. Per-Tick `tickSeq` is monotonic and uniquely maps to one permanent `positionId`.
33. `settleCursor <= nextPositionSeq` always holds and never decreases.
34. `settle(tickId)` touches at most one cursor entry and never performs an unbounded scan.
35. If the ACTIVE cursor Position is not mature, no later ACTIVE Position in that Tick is mature.
36. Automatic settlement uses the exact same Close economics/events as direct Close.
37. Active and Exit generation rollover are independent and cannot leak historical claims into new shares.
38. Neither active nor Exit generation finalization resets or skips the settlement cursor.
39. Equivalent split Uses are full-term-Yield-equivalent within documented rounding bounds using active liquidity only.
40. Use/Repay/Swap/Close/settle complexity is independent of provider count.
41. Later active suppliers receive no historical active Yield/Quote or historical Exit claims.
42. Withdraw/Collect synchronize all relevant growth before share mutation; funded claims cannot be lost.
43. A provider with zero active shares receives zero future active growth but may retain Exit shares/old claims.
44. A provider with zero Exit shares receives zero future Exit growth but may retain old Exit claims.
45. `collect()` cannot charge Quote proceeds twice or charge Yield twice.
46. Same-block Supply→Withdraw cooldown cannot be bypassed through Multicall.
47. Reentrancy cannot corrupt active/Exit accounting, reserves, escrow, cursor state, or position status.
48. Nonstandard token behavior cannot silently create accounting deficits.
49. Permanent Term Position history remains readable after settlement.
50. No successful action can divide by zero or distribute growth with the corresponding share denominator equal to zero.
51. Stored `priceX128` is canonical and all Asset↔Quote reference conversions use the frozen price formula.
52. Deterministic `tickId` derivation cannot vary once Pair identity/direction/price/duration are fixed.
53. `nextPositionId` is monotonic, starts at 1, and successful Uses receive unique permanent EVM position IDs.
54. The canonical Q128 Yield algorithm, including every intermediate round-down and final round-up, matches shared cross-chain golden vectors.
55. Repeated Collect calls over the same cumulative gross Yield charge the same cumulative Yield fee as one Collect.
56. A zero-principal Withdraw is possible only for Max/full-provider-share dust burn and cannot transfer Asset or create Exit Working.

# 24. Required implementation tests

At minimum:

```text
createPair canonicalization / deterministic pairId / reversed-input equivalence / duplicate / zero-address rejection
getPair initialized/uninitialized/reversed-input behavior
createTick deterministic tickId / direction / TickMath range / duration / priceX128 / zeroed active/Exit/cursor/reserve state / duplicate rejection
canonical Q128 Yield intermediate-rounding and golden vectors
nextPositionId starts at 1 / increments once per successful Use / revert does not consume ID

Supply into empty active pool with no Exit
Supply into active pool
Supply while Exit Working exists and active pool is empty
Supply while active + Exit liquidity coexist
new supplier inherits no historical active or Exit growth

Withdraw 25% / 50% / 75% / 100% active shares
Withdraw with 100% Available / 0% Working
Withdraw with 0% Available / 100% active Working
Withdraw with mixed Available + active Working
Withdraw burns active shares immediately
Withdraw leaves workingSupply unchanged while increasing exitWorking
Withdraw split rounding preserves principalClaim exactly
multiple Withdraws by same provider in one Exit generation
multiple providers enter same Exit generation
Exit invariant totalExitShares >= exitWorking across mint/resolve/generation sequences
1-unit workingToExit into live Exit pool mints non-zero Exit shares under X >= E
new Exit shares inherit no historical Exit Asset/Yield/Quote growth
full active withdrawal leaves provider.shares == 0 with provider.exitShares > 0
full active withdrawal with no Working leaves no Exit shares
same-block Supply→Withdraw rejection
partial Withdraw with zero principalClaim rejection
Max/full-share zero-principal dust burn succeeds with zero payout and preserves invariants

Use while Exit exists
Swap while Exit exists
Supply while Exit exists
Use changes W but not E
Swap changes A but not E
Yield pricing excludes Exit Working
Use transfers only Asset out + Quote Principal into escrow
Use transfers no Yield Asset or Quote
Use freezes fullTermYieldAsset and closeFee
fullTermYieldAsset round-up vectors
same-timestamp Repay → exactly 1-second billable Yield
Repay elapsed 1 second / 1 day / fractional day
Repay just before maturity → grossYieldAsset <= fullTermYieldAsset
Repay maxYieldAsset bound
Repay rate remains frozen despite later utilization changes

Repay with exitWorking == 0 → all principal to Available, all Yield to active shares
Repay amount < exitWorking → all principal + all Yield to Exit
Repay amount == exitWorking → Exit generation finalization
Repay amount > exitWorking → Exit first, excess principal/Yield to active
Repay Yield split exact-remainder conservation
Repay funds yieldAssetReserve exactly by grossYieldAsset
Repay Exit principal reserve solvency
Repay with totalShares == 0 implies activeReturn == 0 and activeYieldAsset == 0
newer Use Repay may satisfy older Exit and route corresponding Yield to Exit

Close with exitWorking == 0 → all net Quote to active growth
Close amount < exitWorking → all net Quote to Exit growth
Close straddling Exit/active → proportional net Quote split
Close exact exitWorking boundary
Close creates no Asset Yield
Close uses stored closeFee frozen at Use opening
Close simultaneously exhausts Exit and active generations
Close fee taken once before Exit/active net split
Close with totalShares == 0 requires activeQuote == 0

Immediate Swap reference full-term Asset Yield vectors
Reference Yield Asset → Quote conversion round-up vectors
Swap fee round-down vectors
Swap proceeds go only to active shares
Swap maxQuoteIn bound

Collect Exit Asset only
Collect active Asset Yield only
Collect Exit Asset Yield only
Collect mixed active + Exit Asset Yield
Collect Exit Quote only
Collect active Swap Quote only
Collect mixed Asset + Quote
Yield fee charged in Asset at Collect
Quote proceeds receive no second fee
Yield-fee carry: one large Collect == many split Collects for cumulative fee
Yield-fee carry persists after active/Exit shares and owed claims return to zero
Use/Swap cannot spend exitAssetReserve or yieldAssetReserve even when contract Asset balance is sufficient
Collect before Exit fully resolves; remaining Exit shares continue resolving
Collect after stale active generation
Collect after stale Exit generation
provider with zero active shares can collect Exit/historical claims
provider with zero Exit shares receives no future Exit growth

active generation exhaustion while Exit continues
Exit generation exhaustion while active market continues
new active generation starts while old Asset Yield claims remain uncollected
new Exit generation starts while old claims remain uncollected
provider stale across multiple active/Exit generations syncs only stored snapshots

Per-Tick tickSeq monotonic assignment and mapping to positionId
settleCursor initializes at zero and never decreases
settle on empty queue is no-op
settle advances exactly one already-terminal cursor entry
settle closes exactly one mature ACTIVE cursor Position
settle stops on non-mature ACTIVE cursor Position
Repay/Close of cursor Position advances cursor exactly one
out-of-order Repay/Close remains compatible with later cursor advancement
automatic settlement before Supply/Withdraw/Collect/Use/Swap
settlement remains correct across active and Exit generation rollovers
no indexer required to identify cursor Position

TickMath / priceX128 / Quote Principal cross-chain vectors
active-liquidity full-term Yield golden vectors
elapsed Repay Yield golden vectors
Exit principal/Yield/Quote growth golden vectors
protocol fee vectors
deadline exact-boundary and expired cases
maturity arithmetic overflow rejection
maturity race Repay vs Close
Multicall withdraw + collect
Multicall settle + collect
Multicall multiple Uses
Fee-on-transfer/rebasing/callback token rejection
Extreme price/duration/amount arithmetic
1-unit active-share / Exit-share / Yield / growth rounding cases
all active/Exit/reserve invariants under fuzzed action sequences
```

# 25. Out of scope v0.1

```text
oracles
liquidations
LTV / health factors
variable-rate lending
resting Demand orders
provider FIFO matching
provider-specific Working-position assignment
provider Exit FIFO queues
Exit cancellation / Exit→Active conversion
per-provider matching loops
offchain indexer dependency for Tick settlement
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
Supply   → Asset becomes active Available

Use      → active Available → active Working
           Asset → taker
           Quote → locked escrow
           full-term Asset Yield rate is frozen
           no Yield paid yet

Repay    → taker returns Asset principal + accrued Asset Yield
           Quote escrow → taker
           principal resolves:
             ├─ Exit first → claimable Exit Asset
             └─ excess → active Available
           Asset Yield follows the same split:
             ├─ Exit portion → Exit Yield claim
             └─ active portion → active Yield claim

Swap     → active Available → active provider Quote immediately

Close    → Working resolves to Quote
           no Asset Yield is paid
           ├─ Exit first → claimable Exit Quote
           └─ excess → active provider Quote

Withdraw → selected active shares are burned immediately
           ├─ proportional Available → Asset now
           └─ proportional active Working → Exit Working

Settle   → advances one oldest Tick Position; closes it if mature

Collect  → Exit Asset principal
           + net Asset Yield
           + Exit Quote
           + active Swap/Close Quote
```

The two Use outcomes are intentionally simple:

> **Return → Asset + Asset Yield. Swap → Quote.**

Yield is paid from elapsed Use time with a 1-second minimum billable interval. The full-term Yield quote is frozen when Use opens, but the amount due grows linearly until Repay. Earlier Repay therefore costs less, while same-timestamp Repay pays 1 second of Yield.

Active shares and Exit shares are separate internal accounting domains. Exit is not a new market and does not block the Tick. It is a settlement receipt for Working exposure already withdrawn from active ownership.

Exit is pooled rather than tagged to specific Term Positions. Later Withdraws may join the same live Exit generation, so v0.1 does not promise an individual Exit completion timestamp or provider-specific position assignment.

> **Asset moves. Quote locks.**

