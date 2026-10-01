# yld.cx — Yield Orders Protocol

**Canonical Cross-Chain Economic & Accounting Specification**  
**Version:** 0.2
**Targets:** Ethereum / EVM-compatible chains + Solana

---

# 1. Summary

Yield Orders is a permissionless fixed-term liquidity primitive built around:

> **Asset moves. Quote locks.**

A supplier posts Asset liquidity at an exact directional Tick:

```text
Pair × Direction × Price Tick × DurationDays
```

A taker can consume active Available Asset in two ways:

```text
Use  → receive Asset temporarily; lock full Quote Principal.
Swap → receive Asset permanently; pay Quote Principal immediately.
```

A Use has two mutually exclusive terminal outcomes:

```text
Repay before maturity
→ Asset principal returns
→ elapsed Asset Yield is paid
→ Quote Principal unlocks

Close at/after maturity
→ taker keeps Asset
→ locked Quote Principal settles
→ no Asset Yield
```

The protocol has no oracle, LTV, liquidation, health factor, mutable fee governance, provider matching loop, provider-specific taker selection, or indexer dependency for settlement.

Liquidity remains pooled per Tick.

v0.2 replaces supplier shares and per-share growth accounting with a **Product-Sum principal index**:

```text
P          → cumulative proportional principal depletion
gain sums  → cumulative funded provider proceeds
scale      → precision-preserving P re-denomination
generation → reset when a principal domain reaches zero
```

There are **no active shares, Exit shares, MAX_SHARES, share mint formulas, or share-cap admission failures**.

The Product-Sum approach is adapted to YLD's separate active and Exit domains.

---

# 2. Canonical action vocabulary

Economic actions:

```text
supply
withdraw
collect
use
repay
swap
close
```

Infrastructure:

```text
createPair / initialize_pair
createTick / initialize_tick
settle
```

Infrastructure actions confer no economic privilege.

`referrer` parameters, where present in chain ABIs, are **metadata only**:

```text
zero value allowed
no fee split
no ownership
no settlement priority
no creator/referrer rights
no effect on price, Yield, principal, fees, or claims
```

Implementations MAY emit the supplied referrer for attribution/analytics. Referrer metadata MUST NOT become mutable protocol economics.

---

# 3. Pair, direction, Tick, and price

A Pair is the canonical unordered combination of two tokens.

For EVM:

```text
token0 = min(tokenA, tokenB)
token1 = max(tokenA, tokenB)

pairId = keccak256(abi.encode(token0, token1))
```

Directions:

```text
direction = 0 → Asset = token0, Quote = token1
direction = 1 → Asset = token1, Quote = token0
```

Tick identity:

```text
Pair
Direction
Price Tick
DurationDays
```

EVM:

```text
tickId =
    keccak256(
        abi.encode(
            pairId,
            direction,
            priceTick,
            durationDays
        )
    )
```

Canonical domains:

```text
direction    uint8, {0,1}
priceTick    int32, [-887272, 887272]
durationDays uint64, > 0
```

Price math:

```text
sqrtPriceX96 =
    TickMath.getSqrtRatioAtTick(priceTick)

priceX128 =
    floor(sqrtPriceX96² / 2^64)

QuotePrincipal =
    ceil(assetAmount * priceX128 / 2^128)
```

`priceTick` represents raw Quote units per raw Asset unit.

No oracle participates.

## 3.1 Canonical time domain

Cross-chain maturity semantics use a shared non-negative signed-64-bit timestamp domain:

```text
MAX_TIMESTAMP = 9_223_372_036_854_775_807
SECONDS_PER_DAY = 86_400
MAX_DURATION_DAYS = 106_751_991_167_300
```

For every Tick and Use:

```text
durationDays > 0

durationSeconds =
    durationDays * SECONDS_PER_DAY

maturity =
    openedAt + durationSeconds
```

`durationSeconds` and `maturity` MUST be computed with checked wide arithmetic before narrowing.

Require:

```text
0 <= openedAt <= MAX_TIMESTAMP
0 < maturity <= MAX_TIMESTAMP
```

The fixed `MAX_DURATION_DAYS` is only an absolute representability ceiling. The effective maximum duration at opening is additionally constrained by `openedAt`.

Equivalent inputs MUST produce the same `maturity` on EVM, Solana, and the reference SDK.

---

# 4. Core pooled principal state

For each directional Tick:

```text
A = availableSupply
W = workingSupply
E = exitWorking

Wa = W - E
Ca = A + Wa
```

Definitions:

```text
A   → active Available Asset
W   → all Asset outside custody in ACTIVE Uses
E   → Working principal already withdrawn from active ownership
Wa  → active Working
Ca  → active principal
```

Required:

```text
0 <= E <= W
Ca = A + W - E
```

Active Product-Sum domain principal:

```text
D_active = Ca
```

Exit Product-Sum domain principal:

```text
D_exit = E
```

The two domains are economically independent.

---

# 5. Product-Sum accounting

## 5.1 Principal depletion

A Swap or active portion of Close proportionally converts active Asset principal into Quote.

Instead of retaining a fixed share supply while principal shrinks, every active provider's principal is conceptually multiplied by the same depletion factor.

For a depletion event:

```text
D_before > 0
loss > 0
D_after = D_before - loss
```

the economic depletion factor is:

```text
f = D_after / D_before
```

The global product `P` compounds these factors.

A provider is not updated during the event. Its current principal is derived lazily from its initial principal, P snapshot, current P, scale difference, and generation.

## 5.2 Domain state

Active domain:

```text
activeP
activeScale
activeGeneration

activeQuoteSum
activeYieldSum
```

Exit domain:

```text
exitP
exitScale
exitGeneration

exitAssetSum
exitYieldSum
exitQuoteSum
```

Reference precision constants:

```text
MAX_ACCOUNTING_AMOUNT = 1e30
PRINCIPAL_PRECISION = 1e36
P_PRECISION = 1e39
SCALE_FACTOR = 1e9
P_MIN = 1e30
MAX_SCALE_SPAN = 8
MAX_SCALE_JUMP = 4
```

On initialization and after a domain generation reset:

```text
P = P_PRECISION
scale = 0
```

The implementation MUST use full-precision checked arithmetic.

Provider principal is retained internally in fixed-point sub-raw units:

```text
PRINCIPAL_PRECISION = 1e36
principalX36 = raw Asset principal × PRINCIPAL_PRECISION
```

This is **not a share denomination**. There is no global share supply, no share mint/burn ratio, and no admission/capacity condition derived from provider accounting units. `principalX36` exists only to preserve proportional ownership when a provider's compounded claim falls below one raw Asset unit.

`MAX_ACCOUNTING_AMOUNT` applies to each raw domain principal and each single canonical funded distribution / Quote Principal / Yield amount. Provider `principalX36` is therefore bounded by `1e66`. `providerPSnapshot * PRINCIPAL_PRECISION <= 1e75`, which remains below the `uint256` limit. Aggregate reserves and already-realized owed balances remain checked `uint256`-sized values.

If canonical fixed-point principal finally rounds below one `principalX36` unit, the exact residual principal is below `1e-36` raw Asset. Since one canonical funded gain is at most `1e30` raw units and domain principal is at least one raw unit while non-empty, such a truncated residual can receive **less than `1e-6` raw gain units from any single funded distribution**. This is the protocol's deterministic sub-unit dust boundary.

While a domain is non-empty:

```text
1 <= D <= 1e30
P >= 1e30
```

Therefore for every positive whole-unit funded gain `G >= 1`:

```text
floor(G * P / D) >= 1
```

so a positive funded distribution cannot become a zero Product-Sum increment.

The exact constants are protocol constants and MUST be identical in EVM, Solana, and the reference SDK.

---

# 6. Provider snapshots

Per provider × Tick:

```text
// active
activeInitialPrincipalX36
activeGeneration
activeScale
activePSnapshot
activeQuoteSumSnapshot
activeYieldSumSnapshot

// Exit
exitInitialPrincipalX36
exitGeneration
exitScale
exitPSnapshot
exitAssetSumSnapshot
exitYieldSumSnapshot
exitQuoteSumSnapshot

// realized claims
owedActiveYieldAsset
owedActiveQuote

owedExitAsset
owedExitYieldAsset
owedExitQuote

timestamp
```

Whenever a provider changes its active or Exit principal:

1. calculate current compounded `principalX36`;
2. realize accumulated whole-raw-unit gains into `owed*`;
3. apply the principal increase/decrease as `rawAmount × PRINCIPAL_PRECISION`;
4. overwrite `initialPrincipalX36` with the resulting current fixed-point principal;
5. snapshot current `P`, scale, generation, and gain sums.

This is equivalent to closing the old accounting snapshot and opening a fresh one.

Each provider × Tick also stores exactly one `timestamp` (non-negative canonical seconds). Supply and Collect set it to the current chain timestamp. Withdraw does not reset it. The timestamp governs both Yield vesting and the same-timestamp withdrawal restriction; there is no separate block/slot cooldown field.

A snapshot MUST NOT be cleared merely because `floor(principalX36 / PRINCIPAL_PRECISION) == 0`. Sub-raw principal remains economically owned and continues participating in later gains until its canonical fixed-point principal reaches zero or the domain generation ends.

---

# 7. Gain sums

For a funded gain `G` distributed proportionally over domain principal `D`:

```text
sumIncrement =
    floor(G * P / D)
```

The gain MUST be added to the current scale's sum **before any principal depletion updates P**.

Active gain streams:

```text
activeQuoteSum  ← Immediate Swap / active Close Quote
activeYieldSum  ← active Repay net Asset Yield
```

Exit gain streams:

```text
exitAssetSum  ← Exit principal resolved by Repay
exitYieldSum  ← Exit Repay net Asset Yield
exitQuoteSum  ← Exit Close Quote
```

New providers snapshot current sums and therefore inherit no historical gains.

A positive funded gain MUST NOT silently become a material unclaimable distribution because of accumulator precision. Precision bounds and supported amount domains MUST make any whole-unit funded distribution either produce a positive sum increment or be explicitly classified as deterministic sub-unit dust.

---

# 8. Scale re-denomination

`P` decreases as a domain is depleted.

It MUST never round to zero while domain principal remains non-zero.

When a non-empty depletion would make `P` too small for the safe precision range:

```text
P numerator *= SCALE_FACTOR
scale += 1
```

until stored `P` is back inside the safe range.

This is only a numerical denomination change:

```text
economic ownership unchanged
domain principal unchanged by scaling
gain entitlement unchanged
```

Gain sums are retained by:

```text
domain × generation × scale
```

Provider compounded principal:

```text
if providerGeneration < currentGeneration:
    compoundedPrincipalX36 = 0
else:
    scaleDiff = currentScale - providerScale

    compoundedPrincipalX36 =
        floor(
            initialPrincipalX36
            * currentP
            / providerPSnapshot
            / SCALE_FACTOR^scaleDiff
        )

transferablePrincipal =
    floor(
        compoundedPrincipalX36
        / PRINCIPAL_PRECISION
    )
```

The implementation MUST avoid overflowing `SCALE_FACTOR^scaleDiff`; use sequential checked divisions or equivalent full-precision arithmetic.

`transferablePrincipal` is the whole-raw-unit amount usable by Withdraw and product previews. A positive `compoundedPrincipalX36 < PRINCIPAL_PRECISION` is retained as sub-raw accounting principal; it MUST NOT be silently discarded.

---

# 9. Gains across scales

For a snapshot taken at scale `k`, define one gain stream's scale deltas:

```text
dS[0] = S[k] - S_snapshot
dS[i] = S[k+i]                 for i > 0
```

Missing / skipped scale states contribute:

```text
dS[i] = 0
```

Let:

```text
F = SCALE_FACTOR = 1e9

endScale =
    currentScale    for the current generation
    finalScale      for a finalized historical generation

span =
    min(
        MAX_SCALE_SPAN,
        endScale - k
    )
```

The mathematical value is:

```text
normalizedGain =
      dS[0]
    + dS[1] / F
    + dS[2] / F²
    + ...
    + dS[span] / F^span

providerGain =
    floor(
        initialPrincipalX36
        * normalizedGain
        / (
            providerPSnapshot
            * PRINCIPAL_PRECISION
        )
    )
```

The mathematical expression above is normative. The following bounded integer recurrence is the **canonical executable algorithm** and MUST be used by EVM, Solana, and the reference SDK.

Let:

```text
A = initialPrincipalX36
B = providerPSnapshot * PRINCIPAL_PRECISION

0 <= A <= B
B <= 1e75
```

Initialize scale `0` exactly:

```text
gain =
    floor(
        A * dS[0]
        / B
    )

R =
    (A * dS[0])
    mod B

pow = 1
```

For every `i = 1 .. span`:

```text
pow *= F
// pow = F^i

whole =
    floor(
        dS[i] / pow
    )

frac =
    dS[i] mod pow

wholeGain =
    floor(
        A * whole
        / B
    )

wholeRem =
    (A * whole)
    mod B
```

The prior exact fractional remainder has denominator:

```text
B * F^(i-1)
```

Align the prior remainder and the new scale term to denominator `B * pow`:

```text
N =
      R * F
    + wholeRem * pow
    + A * frac

D =
    B * pow
```

Because:

```text
R < B * F^(i-1)
wholeRem < B
A <= B
frac < pow
```

it follows that:

```text
0 <= N < 3 * D
```

Therefore extract the exact integer carry with at most two comparisons/subtractions:

```text
carry = 0

if N >= D:
    N -= D
    carry += 1

if N >= D:
    N -= D
    carry += 1
```

Then:

```text
gain =
    checkedAdd(
        gain,
        wholeGain + carry
    )

R = N
```

After the final iteration:

```text
providerGain = gain
```

This recurrence is exactly equal to the single mathematical floor above. It does **not** round provider gain independently per scale; every fractional remainder is retained in `R` and carried across subsequent scales.

At provider synchronization, lift the same rational calculation to **X36 gain units** by using `B = providerPSnapshot` rather than `providerPSnapshot * PRINCIPAL_PRECISION`. For each of the five independent streams (Active Yield/Quote, Exit Asset/Yield/Quote), add the result to that stream’s stored fraction, credit `floor(combinedX36 / PRINCIPAL_PRECISION)` whole raw units to `owed*`, and store `combinedX36 % PRINCIPAL_PRECISION`. This normalization permits principal changes, Collect, scale changes, and generation rollover without mixing fractions from different denominators or granting past gains to new liquidity. A single checkpoint floors less than one X36 unit per stream, so across `N` checkpoints the total discarded amount is strictly below `N / 1e36` raw units per stream. There is no silent whole-raw-unit loss in the reproduced two-provider, two-distribution vector with an intermediate Collect.

For X36 recurrence steps, `A / B` may be as large as `1e36`, so the raw-gain two-subtraction carry bound does not apply. Split `A = principalWhole * B + principalRemainder`, extract `floor(principalWhole * fraction / scalePower)` with full-precision multiplication, and carry its remainder into the two-limb numerator. The four normalized remainder terms are each below the scaled denominator, so at most **three** subtractions are needed. The exact X36 result must equal the single rational floor; separately rounding each scale or limiting the lifted carry to two is invalid.

Required arithmetic bounds:

```text
F^8 = 1e72 < 2^256
B <= 1e75 < 2^256

D = B * F^i
  <= 1e147
  < 2^512

N < 3 * D
  < 2^512
```

EVM therefore requires canonical two-limb / 512-bit helpers for:

```text
uint256 × uint256 → uint512
uint512 × F
uint512 addition
uint512 comparison
uint512 subtraction
```

`wholeGain` uses full-precision floor `mulDiv(A, whole, B)`, and `wholeRem` uses the exact corresponding remainder (`mulmod` on EVM or equivalent).

Solana MUST produce bit-for-bit identical integer results.

The canonical scale span is:

```text
MAX_SCALE_SPAN = 8
```

A provider therefore reads at most its snapshot scale plus eight subsequent scales for one gain stream.

With `initialPrincipalX36 <= 1e66`, `SCALE_FACTOR = 1e9`, and `Pcurrent / Psnapshot < 1e9`, a snapshot that is nine or more scale changes old has canonical `compoundedPrincipalX36 < 1` and therefore zero fixed-point principal. Hence scales `k` through `k+8` are sufficient for a stale snapshot.

Synchronization complexity is bounded and independent of provider count.

No provider loop is permitted.

---

# 10. Generation = epoch

YLD introduces no separate epoch abstraction.

Existing domain generations are the Product-Sum epochs.

When active principal reaches zero:

```text
persist current active scale sums
activeGeneration += 1
activeScale = 0
activeP = P_PRECISION
activeQuoteSum = 0
activeYieldSum = 0
```

When Exit principal reaches zero:

```text
persist current Exit scale sums
exitGeneration += 1
exitScale = 0
exitP = P_PRECISION
exitAssetSum = 0
exitYieldSum = 0
exitQuoteSum = 0
```

A provider from an older generation has zero remaining principal but can still realize gains from its historical generation/scales.

Generation rollover MUST NOT lose funded claims.

---

# 11. Gain-before-depletion ordering

For every event that both creates a gain and depletes domain principal:

```text
1. read D_before and P_before
2. add funded gain using P_before / D_before
3. reduce domain principal
4. update P using D_after / D_before
5. apply any required scale re-denomination
6. if D_after == 0, finalize generation instead of setting P = 0
```

This applies to:

```text
Immediate Swap
active portion of Close
Exit portion of Repay
Exit portion of Close
```

---

# 12. Accounting amount bounds

Every successful action MUST satisfy, where applicable:

```text
activePrincipal       <= MAX_ACCOUNTING_AMOUNT
exitWorking           <= MAX_ACCOUNTING_AMOUNT
assetAmount           <= MAX_ACCOUNTING_AMOUNT
QuotePrincipal        <= MAX_ACCOUNTING_AMOUNT
FullTermYieldAsset    <= MAX_ACCOUNTING_AMOUNT
grossYieldAsset       <= MAX_ACCOUNTING_AMOUNT
single funded gain    <= MAX_ACCOUNTING_AMOUNT
```

Provider fixed-point principal additionally satisfies:

```text
providerPrincipalX36 <= MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION
                     <= 1e66
```

These are raw smallest-unit bounds except where the `X36` suffix explicitly denotes fixed-point provider principal.

If an input or derived amount exceeds the bound, the action MUST reject before creating state that would later be impossible to settle.

Aggregate contract balances, reserves, and already-realized provider `owed*` balances remain checked `uint256` values and may exceed one single-action bound.

All cumulative gain sums use checked `uint256` arithmetic. Under the canonical bounds, one maximum single sum increment is at most `1e69`, leaving more than `1e8` maximum-magnitude increments of headroom below the `uint256` range. Overflow MUST still revert rather than wrap.

---

# 13. Yield pricing

Yield uses active liquidity only:

```text
Wa = W - E
Ca = A + Wa
u  = Wa / Ca
```

Constants:

```text
MIN_DAILY_BPS  = 1
MAX_DAILY_BPS  = 100
CURVE_EXPONENT = 3
```

Marginal theoretical rate:

```text
r(u) = Min + (Max - Min)u³
```

For a Use of `x`:

```text
u0 = Wa / Ca
u1 = (Wa + x) / Ca
```

Integrated curve:

```text
I(u0,u1)
=
Min(u1-u0)
+
(Max-Min)/4 × (u1⁴-u0⁴)
```

Full-term Yield:

```text
FullTermYieldAsset =
    Ca × durationDays × I(u0,u1)
```

Canonical integer algorithm:

```text
Q128 = 2^128

u0X128 = floor(Wa       * Q128 / Ca)
u1X128 = floor((Wa + x) * Q128 / Ca)

pow4X128(u):
    u2 = floor(u  * u  / Q128)
    u4 = floor(u2 * u2 / Q128)
    return u4

deltaU  = u1X128 - u0X128
deltaU4 = pow4X128(u1X128) - pow4X128(u0X128)

curveNumeratorX128 =
      4 * MIN_DAILY_BPS * deltaU
    + (MAX_DAILY_BPS - MIN_DAILY_BPS) * deltaU4

curveDenominator =
    4 * BPS * Q128

FullTermYieldAsset =
    ceil(
        Ca
        * durationDays
        * curveNumeratorX128
        / curveDenominator
    )
```

No Yield transfers at Use opening.

---

# 14. Repay Yield

At Use opening, `fullTermYieldAsset` is frozen.

Before maturity:

```text
termSeconds = maturity - openedAt
elapsed = now - openedAt
billableElapsed = max(1, elapsed)

grossYieldAsset =
    ceil(
        fullTermYieldAsset
        * billableElapsed
        / termSeconds
    )
```

Require:

```text
0 < grossYieldAsset <= fullTermYieldAsset
```

Same-timestamp Repay therefore pays one billable second.

---

# 15. Unified protocol fee

```text
BPS = 10_000
PROTOCOL_FEE_BPS = 100
```

Fee bases:

```text
Immediate Swap → Quote Principal
Use → Close    → Quote Principal
Use → Repay    → gross Asset Yield
```

Returned principal is fee-free.

```text
fee =
    floor(
        feeBase
        * PROTOCOL_FEE_BPS
        / BPS
    )
```

Therefore:

```text
Swap/Close:
    ≥99% Quote → providers
    ≤1% Quote  → accrued protocol fees, claimable only to FEE_TO

Repay:
    100% Asset principal → providers
    ≥99% Asset Yield     → providers
    ≤1% Asset Yield      → accrued protocol fees, claimable only to FEE_TO
    100% Quote Principal → taker
```

No minimum fee.

---

# 16. Supply

Supply joins only the active domain.

Before mutation:

```text
sync provider active
sync provider Exit only if required by portfolio bookkeeping
```

Let:

```text
dX36 = current compounded active principalX36
```

Then:

```text
Asset → protocol
availableSupply += assetIn

provider active principalX36 =
    dX36 + assetIn * PRINCIPAL_PRECISION

snapshot current active:
generation
scale
P
Quote sum
Yield sum
```

Supply does not alter active P.

Supply is valid while Exit exists.

Set `provider.timestamp = now` after synchronizing the provider and adding the new principal. Every Supply restarts vesting of all outstanding, uncollected Yield in that provider position. The provider MAY Collect before supplying.

Withdraw requires `now > provider.timestamp`; a Supply or Collect in the current timestamp therefore prevents Withdraw in that timestamp.

---

# 17. Use

Use performs one settlement step first.

Requirements:

```text
assetAmount > 0
assetAmount <= availableSupply
activePrincipal > 0
deadline valid

QuotePrincipal > 0
QuotePrincipal <= MAX_ACCOUNTING_AMOUNT

FullTermYieldAsset > 0
FullTermYieldAsset <= maxFullTermYieldAsset
FullTermYieldAsset <= MAX_ACCOUNTING_AMOUNT

durationDays > 0
durationDays <= MAX_DURATION_DAYS

durationSeconds =
    durationDays * SECONDS_PER_DAY

maturity =
    openedAt + durationSeconds

0 <= openedAt <= MAX_TIMESTAMP
0 < maturity <= MAX_TIMESTAMP
```

`durationSeconds` and `maturity` use checked wide arithmetic before narrowing.

Future Repay arithmetic is representable by construction:

```text
1 <= billableElapsed <= termSeconds

grossYieldAsset =
    ceil(
        FullTermYieldAsset
        * billableElapsed
        / termSeconds
    )

0 < grossYieldAsset <= FullTermYieldAsset
                         <= MAX_ACCOUNTING_AMOUNT
```

The multiplication/division MUST use canonical full-precision rounding-up math, so the intermediate product cannot overflow the externally visible amount type.

Freeze:

```text
closeFee =
    floor(
        QuotePrincipal
        * PROTOCOL_FEE_BPS
        / BPS
    )
```

Execution:

```text
availableSupply -= assetAmount
workingSupply += assetAmount

Asset → taker
QuotePrincipal → escrow
```

Crucially:

```text
activePrincipal unchanged
activeP unchanged
all Product-Sum gain sums unchanged
```

Create permanent Term Position containing at least:

```text
position identity
tick
user
assetAmount
quotePrincipal
fullTermYieldAsset
closeFee
openedAt
maturity
status = ACTIVE
```

---

# 18. Immediate Swap

Before:

```text
D = activePrincipal
P = activeP
```

Compute:

```text
SwapFee =
    floor(QuotePrincipal * 1%)

providerQuote =
    QuotePrincipal - SwapFee
```

Fund provider Quote before principal depletion:

```text
activeQuoteSum +=
    floor(
        providerQuote
        * activeP
        / D
    )
```

Then:

```text
availableSupply -= assetAmount
D_after = D - assetAmount
```

Update active P by the canonical depletion algorithm.

Transfers:

```text
Asset → taker
QuotePrincipal from taker
SwapFee → accrued Quote protocol fees
providerQuote → Quote proceeds custody
```

If `D_after == 0`, finalize active generation.

Exit is untouched.

---

# 19. Withdraw

Withdraw is expressed in active **Asset principal**, not shares. Execution accepts `minImmediateAssetOut` and `deadline`, checking the Available Asset returned against that minimum after its automatic settlement step. Zero minimum with a permissive deadline is unrestricted.

Conceptual entry:

```text
withdraw(tick, principalAmount)
```

Before mutation:

```text
sync provider active
sync provider Exit
```

Let:

```text
providerPrincipalX36 =
    compounded active principalX36

providerPrincipal =
    floor(
        providerPrincipalX36
        / PRINCIPAL_PRECISION
    )

x =
    min(principalAmount, providerPrincipal)
```

Require `x > 0` and `now > provider.timestamp`.

Withdraw operates only on whole raw Asset units. Any remaining positive `providerPrincipalX36 < PRINCIPAL_PRECISION` stays in the active snapshot as sub-raw accounting principal and is not discarded.

Global active state:

```text
D  = activePrincipal
A  = availableSupply
Wa = workingSupply - exitWorking
```

Split:

```text
availableOut =
    floor(x * A / D)

workingToExit =
    x - availableOut
```

Mutation:

```text
availableSupply -= availableOut
exitWorking += workingToExit
```

`workingSupply` is unchanged.

Active principal decreases exactly by `x`.

This is an individual provider withdrawal, not a market-wide proportional depletion:

```text
activeP does NOT change
```

Provider active principal becomes:

```text
providerPrincipalX36
- x * PRINCIPAL_PRECISION
```

and receives fresh active snapshots.

If `workingToExit > 0`:

1. use the already-synchronized Exit `principalX36`;
2. add `workingToExit * PRINCIPAL_PRECISION`;
3. snapshot current Exit P/scale/generation/sums.

Exit P does not change when new Resolving principal joins.

### Yield released and redistributed on Withdraw

Synchronize the provider first. Let `DproviderX36` be their active principal before withdrawal and `Y` their outstanding `owedActiveYieldAsset` (including newly realized gains). Use the canonical Yield-vesting fraction from §22.

```text
durationSeconds = tick.durationDays * SECONDS_PER_DAY
elapsed = min(now - provider.timestamp, durationSeconds)
yieldForWithdraw = floor(Y * (x * PRINCIPAL_PRECISION) / DproviderX36)
yieldOut = floor(yieldForWithdraw * elapsed / durationSeconds)
forfeitedYield = yieldForWithdraw - yieldOut
owedActiveYieldAsset = Y - yieldForWithdraw
```

`yieldOut` is transferred with `availableOut` on this Withdraw, without an additional fee. The provider's remaining outstanding Active Yield and previously allocated Exit Yield continue under the unchanged `timestamp`. A subsequent Collect may receive their then-claimable portions.

After reducing the provider's active principal and updating Active/Exit ownership, redistribute `forfeitedYield` to **other** remaining Active providers, excluding the withdrawing provider's retained principal:

```text
remainingActive = availableSupply + workingSupply - exitWorking
remainingProviderX36 = provider's updated active principalX36
otherActiveX36 = remainingActive * PRINCIPAL_PRECISION - remainingProviderX36

// Require at least one whole raw unit of other Active exposure.
if remainingActive > ceil(remainingProviderX36 / PRINCIPAL_PRECISION):
    eligiblePrincipal = ceil(otherActiveX36 / PRINCIPAL_PRECISION)
    activeYieldSum += floor(forfeitedYield * activeP / eligiblePrincipal)
    refresh withdrawing provider's Active gain checkpoint to the new sum
else:
    forfeitedYield -> accrued Asset protocol fees
```

The denominator rounds UP to ensure other providers cannot collectively claim more than the forfeited funds, including when fractional `principalX36` exists. Refreshing the withdrawing provider's checkpoint after funding prevents self-recapture through repeated partial Withdrawals. The redistributed amount is already funded in the Yield reserve: do not add new funds, increase the reserve, or charge the protocol fee again. When assigned to protocol fees, reduce the Tick funded Yield reserve and increase the global Asset fee liability by the same amount. Ordinary gain rounding can leave sub-raw dust in the reserve.

`workingToExit` retains the existing Exit-first resolution rules. Future Yield funded into Exit after Withdraw follows ordinary provider Yield vesting. A provider with no Active principal can still Collect outstanding Yield, including Yield allocated before Swap/Close.

Transfer `availableOut + yieldOut` Asset to the provider.

---

# 20. Repay

Only Position owner may Repay before maturity.

Let:

```text
x = position.assetAmount

exitFill =
    min(x, exitWorking)

activeReturn =
    x - exitFill
```

Compute:

```text
grossYieldAsset

yieldFee =
    floor(grossYieldAsset * 1%)

netYield =
    grossYieldAsset - yieldFee

exitYield =
    floor(netYield * exitFill / x)

activeYield =
    netYield - exitYield
```

Transfers:

```text
Asset principal + grossYield from taker → protocol
Quote Principal → taker
yieldFee Asset → accrued Asset protocol fees
```

Global state:

```text
workingSupply -= x
exitWorking -= exitFill
availableSupply += activeReturn
```

## Exit portion

Using pre-resolution Exit state:

```text
D_exit_before = old exitWorking
P_exit_before = exitP
```

If `exitFill > 0`:

```text
exitAssetSum +=
    floor(
        exitFill
        * P_exit_before
        / D_exit_before
    )
```

If `exitYield > 0`:

```text
exitYieldSum +=
    floor(
        exitYield
        * P_exit_before
        / D_exit_before
    )
```

Then update Exit P from the principal depletion.

If Exit principal reaches zero, finalize Exit generation.

## Active portion

Active principal is unchanged by Repay.

If `activeYield > 0`:

```text
activeYieldSum +=
    floor(
        activeYield
        * activeP
        / activePrincipal
    )
```

Active P does not change.

Only net Yield becomes provider liability.

---

# 21. Close

Close is permissionless at/after maturity.

No Asset Yield.

Let:

```text
x = assetAmount
providerQuote =
    quotePrincipal - frozenCloseFee

exitFill =
    min(x, exitWorking)

activeFill =
    x - exitFill
```

Split:

```text
exitQuote =
    floor(providerQuote * exitFill / x)

activeQuote =
    providerQuote - exitQuote
```

Exit portion:

```text
if exitQuote > 0:
    exitQuoteSum +=
        floor(
            exitQuote
            * exitP
            / D_exit_before
        )

then deplete Exit principal by exitFill
then update Exit P/generation
```

Active portion:

```text
if activeQuote > 0:
    activeQuoteSum +=
        floor(
            activeQuote
            * activeP
            / D_active_before
        )

then deplete active principal by activeFill
then update active P/generation
```

Global Working:

```text
workingSupply -= x
exitWorking -= exitFill
```

Frozen Close fee accrues as a Quote-denominated protocol fee.

A single Close may finalize both domains.

---

# 22. Collect

Collect performs one settlement step and synchronizes both provider domains. Only **funded Asset Yield** is time-weighted; Exit Asset principal and active/Exit Quote proceeds remain immediately collectible.

For each provider position:

```text
durationSeconds = tick.durationDays * SECONDS_PER_DAY
elapsed = min(now - provider.timestamp, durationSeconds)

activeYieldOut = floor(owedActiveYieldAsset * elapsed / durationSeconds)
exitYieldOut   = floor(owedExitYieldAsset   * elapsed / durationSeconds)

totalAssetOut = owedExitAsset + activeYieldOut + exitYieldOut
totalQuoteOut = owedActiveQuote + owedExitQuote
```

Transfer `totalAssetOut` and `totalQuoteOut`. Deduct **only paid** Yield from `owedActiveYieldAsset` and `owedExitYieldAsset`; retain the rest as outstanding funded claims. Clear paid Exit principal and Quote proceeds. Set `provider.timestamp = now` after each successful Collect, including a zero-value Collect, restarting vesting of every outstanding Yield balance.

Repeated Collect at the same timestamp cannot release additional Yield. Collect does not change principal or charge a protocol fee. The timestamp remains valid even when Swap/Close or a historical generation reset has reduced Active principal to zero.

---

# 23. Custody

Accounted Asset custody:

```text
availableSupply
+ funded Exit Asset claims
+ funded active/Exit net Yield claims
```

Working Asset is outside protocol custody in ACTIVE Uses.

Quote custody:

```text
Quote escrow
→ full Quote Principal for ACTIVE Uses

Quote proceeds
→ funded active/Exit Swap/Close claims
```

Use/Swap may consume only `availableSupply`.

Funded claims are never active liquidity. Outstanding, not-yet-collectible Yield and Yield scheduled for redistribution remain covered by the existing funded Yield liability; redistribution does not mint a second claim.

Protocol fees accrue separately by token and are part of global token liabilities in addition to Tick reserves. `collectProtocolFees(token)` claims the accrued balance only to immutable `FEE_TO`. Failed fee claims do not affect ordinary market actions or settlement. No principal or unlocked Quote is charged.

Production has no rescue / admin bypass for token-specific transfer failures. If an admitted token later changes behavior, blacklists required accounts, or otherwise violates the frozen exact-transfer assumptions, affected actions may become permanently unavailable for that Tick. **Stuck is stuck; no mutable rescue backdoor is introduced.**

---

# 24. Provider synchronization

A provider-domain sync MUST:

1. identify the snapshot generation;
2. obtain required historical scale sums;
3. calculate accumulated gains using the canonical exact cross-scale recurrence;
4. add whole-raw-unit gains to `owed*`;
5. calculate compounded `principalX36`;
6. overwrite `initialPrincipalX36`;
7. snapshot current domain state if `principalX36 > 0`;
8. clear the principal snapshot only if `principalX36 == 0`.

If provider generation is older:

```text
compounded principalX36 = 0
```

but historical gains remain realizable.

A raw preview of provider principal is always:

```text
floor(principalX36 / PRINCIPAL_PRECISION)
```

A zero raw preview does not imply that the fixed-point accounting snapshot may be discarded.

No periodic provider writes are required.

---

# 25. Settlement cursor

Each Tick stores:

```text
nextPositionSeq
settleCursor
```

All Uses in a Tick share duration, so maturity is non-decreasing with sequence.

`settle(tick)` touches at most one cursor entry:

```text
queue empty
→ no-op

terminal cursor
→ cursor += 1

ACTIVE not mature
→ no-op

ACTIVE mature
→ canonical Close
→ cursor += 1
```

Every economic Tick action attempts the same one-step settlement first.

No provider loop.

No indexer required.

---

# 26. Portfolio/indexing

Core RPC/account reads MUST expose current connected-wallet state without requiring an indexer.

A provider Tick remains discoverable while any of:

```text
active compounded principalX36 > 0
Exit compounded principalX36 > 0
any owed* > 0
unsynchronized historical gain exists
```

Discovery MUST NOT use only whole-raw-unit / transferable principal. A provider whose raw preview is `0` but whose `principalX36 > 0` remains discoverable and synchronizable.

Term Position history remains permanent.

---

# 27. Rounding

Canonical directions:

```text
Quote Principal                       UP
Full-term Asset Yield                 UP
elapsed Repay Yield                   UP

protocol fee                          DOWN
Withdraw Available component          DOWN
Withdraw Working component            exact remainder

Repay net Yield to Exit               DOWN
Repay active Yield                    exact remainder

Close provider Quote to Exit          DOWN
Close active Quote                    exact remainder

Product-Sum gain increment            DOWN
provider compounded principal         DOWN
provider realized gains               DOWN
Collect/Withdraw time-weighted Yield    DOWN
Withdraw attributable Yield            DOWN
Withdraw redistribution gain           DOWN
```

No silent saturation.

---

# 28. Security invariants

At minimum:

1. `0 <= exitWorking <= workingSupply`.
2. `activePrincipal = availableSupply + workingSupply - exitWorking`.
3. Supply increases active principal exactly by Asset supplied.
4. Use changes Available→Working but does not change active principal or active P.
5. Active Repay changes Working→Available but does not change active principal or active P.
6. Immediate Swap decreases active principal exactly by swapped Asset.
7. Active Close decreases active principal exactly by `activeFill`.
8. Withdraw decreases raw active domain principal exactly by raw `x`; the provider's `principalX36` decreases exactly by `x * PRINCIPAL_PRECISION`, and any positive fixed-point remainder stays snapshotted.
9. Withdraw increases raw Exit principal exactly by `workingToExit`; provider Exit `principalX36` increases by `workingToExit * PRINCIPAL_PRECISION`.
10. Exit Repay/Close decreases Exit principal exactly by `exitFill`.
11. For each domain, the sum of canonical provider `principalX36` values is `<= rawDomainPrincipal * PRINCIPAL_PRECISION`. Equality is not required because canonical Product-Sum / fixed-point realization rounds down.
12. Every provider snapshot satisfies `initialPrincipalX36 <= providerPSnapshot * PRINCIPAL_PRECISION`.
13. New suppliers inherit no historical gain.
14. Another provider's Supply cannot increase an existing provider's principal.
15. Scale changes are economically neutral denomination changes.
16. Generation reset occurs only when domain principal is zero.
17. Historical gains survive scale/generation transitions.
18. No provider loop exists in economic actions or settlement.
19. Repeated Supply→partial Swap→Supply cannot create an accounting-capacity failure.
20. Repeated Exit join→partial resolution cannot block later Withdraw through accounting-unit inflation.
21. P never becomes zero while domain principal is non-zero.
22. Protocol fee is charged exactly once.
23. Repay principal and Quote refund are fee-free.
24. Collect is fee-free.
25. Custody covers funded liabilities.
26. Unsupported token behavior cannot silently create deficits.
27. Provider synchronization is bounded by scale limits, not provider count.
28. EVM/Solana/SDK integer results match for equivalent representable inputs.

29. Provider `timestamp` is reset by every Supply and Collect; Withdraw requires `now > timestamp` and does not reset it.
30. Only funded Asset Yield vests; principal and Quote proceeds remain unrestricted by vesting.
31. Collect releases at most the canonical time-weighted portion and cannot be compounded through repeated calls.
32. Withdraw releases only the time-weighted portion of attributable Active Yield; forfeited Yield is redistributed to other Active providers or accrued as a backed protocol fee, without self-recapture or new custody liabilities.
33. Historical Yield remains collectible after active principal depletion and generation rollover, subject to its timestamp.

---

# 29. Required adversarial tests

At minimum:

```text
two-provider Product-Sum vectors
fractional provider principal preservation:
Supply 1 raw unit from A
Supply 1 raw unit from B
Swap 1 raw unit
Expected:
A and B retain positive principalX36 snapshots
raw preview may be zero
no snapshot is silently cleared
remaining raw domain principal remains economically owned

new supplier after partial depletion
top-up after depletion
partial withdrawal after depletion
stale provider across scale
stale provider across generation

repeated near-total depletion sequence:
Supply
Swap almost all
Supply
Swap almost all
repeat

Expected:
no shares
no accounting-unit inflation
no Supply capacity failure
correct provider principal
correct Quote gain

repeated Exit resolution sequence:
Withdraw Working into Exit
partial Repay/Close
new Withdraw into Exit
repeat

Expected:
no Exit shares
no Exit capacity failure
correct unresolved principal
correct Asset/Yield/Quote gains

scale threshold boundaries
multi-scale jump
9+ scale changes within one generation with a passive provider; enforce the canonical fixed-point dust bound
cross-scale gain carry vector:
non-zero remainder from scale k
non-zero whole + fractional contribution at k+1
non-zero contribution at k+8
exact recurrence gain/remainder matches rational reference
full depletion generation reset
new Supply after reset
old provider claim after reset

same-timestamp Repay
near-maturity Repay
exact-maturity Close
fixed 1% fees
Collect no double fee
one provider timestamp per Tick; Supply and Collect reset it
same-timestamp Supply/Collect -> Withdraw reverts
Collect 0h / partial term / full term / repeated same timestamp
Collect then Supply; Supply without Collect restarts outstanding vesting
partial and full Withdraw release attributable Yield and redistribute the remainder
remaining Active with 0 Available (all liquidity Working)
no eligible other Active -> accrued Asset protocol fee
partial Withdraw cannot reclaim its own forfeited Yield through retained principal
Withdraw to Exit; later Exit Repay/Close; later Collect
Swap/Close exhaust Active but outstanding Yield remains collectible
forfeited Yield and custody conservation across rounding
fractional gains across repeated synchronization/Collect

stateful fuzzed action sequences
```

The fuzz reference model SHOULD use high-precision rational arithmetic.

---

# 30. Canonical mental model

```text
Supply
→ add Asset to pooled active principal
→ snapshot P and gain sums
→ reset provider timestamp

Use
→ Available → Working
→ P unchanged

Repay
→ active Working → Available
→ active P unchanged
→ net Yield distributed through active Yield sum

→ Exit portion:
   Exit principal depleted
   returned Asset + net Yield become Exit gains
   Exit P decreases

Swap
→ active principal depleted
→ Quote becomes active gain
→ active P decreases

Close
→ Exit first:
   Exit principal decreases
   Quote becomes Exit gain

→ active remainder:
   active principal decreases
   Quote becomes active gain

Withdraw
→ calculate provider compounded active principal
→ Available portion leaves now
→ Working portion becomes a fresh Exit deposit
→ release time-weighted Yield attributable to withdrawn principal
→ redistribute the remainder to post-withdrawal Active, or accrue an Asset protocol fee if none

Collect
→ realize Product-Sum gains
→ transfer available time-weighted Yield and all settled Asset/Quote
→ retain remaining Yield and reset provider timestamp
```

> **Return → Asset + Asset Yield. Swap → Quote.**

> **P tracks proportional principal depletion. Gain sums track funded proceeds. No share denomination can inflate.**
