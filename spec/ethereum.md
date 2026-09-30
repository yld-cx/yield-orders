# yld.cx — Yield Orders Protocol

**Ethereum / EVM Implementation Specification**  
**Version:** 0.2
**Depends on:** `spec/protocol.md`

---

# 1. Target

Targets:

```text
Ethereum mainnet
Base
Robinhood Chain
```

The production contract MUST deploy to the **same exact address** on all supported EVM chains.

Desired address prefix:

```text
0x0000
```

Deployment uses deterministic CREATE2 with frozen compiler settings, constructor args, `FEE_TO`, creation code, and salt.

`FEE_TO` MUST be frozen before vanity-address search. The same EVM `FEE_TO` constructor value is used on every supported EVM chain. Production SHOULD use an address whose receiving semantics do not depend on chain-local contract deployment (for example, an EOA or another explicitly verified same-address receiver).

Any bytecode/configuration change, including `FEE_TO`, invalidates previously computed deployment hashes/address.

---

# 2. Compiler

Reference:

```text
Solidity 0.8.36
EVM Cancun
optimizer enabled
optimizer runs 200
viaIR true
```

Core:

```text
non-upgradeable
immutable economics
OpenZeppelin ReentrancyGuard
OpenZeppelin Multicall
SafeERC20
full-precision Math.mulDiv
```

---

# 3. Immutable constants

```solidity
uint256 constant BPS = 10_000;
uint256 constant Q128 = 1 << 128;

uint256 constant PROTOCOL_FEE_BPS = 100; // 1%

uint256 constant MAX_ACCOUNTING_AMOUNT = 1e30;
uint256 constant PRINCIPAL_PRECISION = 1e36;

uint256 constant P_PRECISION = 1e39;
uint256 constant SCALE_FACTOR = 1e9;
uint256 constant P_MIN = 1e30;

uint256 constant MAX_SCALE_SPAN = 8;
uint256 constant MAX_SCALE_JUMP = 4;

uint256 constant MIN_DAILY_BPS = 1;
uint256 constant MAX_DAILY_BPS = 100;
uint256 constant CURVE_EXPONENT = 3;
uint256 constant MIN_BILLABLE_SECONDS = 1;

address immutable FEE_TO;
```

No owner, fee setter, proxy, protocol-fee vault, fee withdrawal function, or governance-controlled economics.

---

# 4. Pair and Tick identity

Canonical Pair:

```solidity
token0 = min(tokenA, tokenB);
token1 = max(tokenA, tokenB);

pairId =
    uint256(
        keccak256(
            abi.encode(token0, token1)
        )
    );
```

Tick:

```solidity
tickId =
    uint256(
        keccak256(
            abi.encode(
                pairId,
                direction,
                priceTick,
                durationDays
            )
        )
    );
```

`createPair` and `createTick` are permissionless and grant no creator rights.

Canonical time constants:

```solidity
uint256 constant SECONDS_PER_DAY = 86_400;
uint256 constant MAX_TIMESTAMP = 9_223_372_036_854_775_807;
uint256 constant MAX_DURATION_DAYS = 106_751_991_167_300;
```

For Tick creation and Use opening, compute `durationDays * SECONDS_PER_DAY` and `openedAt + durationSeconds` in checked wide arithmetic. Require the resulting maturity to be `<= MAX_TIMESTAMP` before storing/narrowing. EVM MUST intentionally use the same time domain as Solana so equivalent inputs cannot diverge cross-chain.

---

# 5. Reference storage

## 5.1 Tick

```solidity
struct Tick {
    uint256 pairId;
    address asset;
    address quote;

    uint8 direction;
    int32 priceTick;
    uint64 durationDays;

    uint256 priceX128;

    uint256 availableSupply;
    uint256 workingSupply;
    uint256 exitWorking;

    Domain active;
    Domain exit;

    uint64 nextPositionSeq;
    uint64 settleCursor;
}
```

Derived:

```solidity
activeWorking =
    workingSupply - exitWorking;

activePrincipal =
    availableSupply + activeWorking;
```

## 5.2 Domain

```solidity
struct Domain {
    uint256 P;
    uint64 scale;
    uint64 generation;

    uint256 assetSum;
    uint256 yieldSum;
    uint256 quoteSum;
}
```

Active:

```text
assetSum = 0
yieldSum = active net Repay Yield
quoteSum = active Swap/Close Quote
```

Exit:

```text
assetSum = resolved Exit principal
yieldSum = Exit net Repay Yield
quoteSum = Exit Close Quote
```

---

# 6. Historical scale state

Gain sums MUST remain readable after scale/generation changes.

Reference:

```solidity
enum DomainKind {
    Active,
    Exit
}

struct ScaleSums {
    uint256 assetSum;
    uint256 yieldSum;
    uint256 quoteSum;
    bool finalized;
}
```

Logical mapping:

```solidity
mapping(
    uint256 tickId
        => mapping(
            uint8 domain
                => mapping(
                    uint64 generation
                        => mapping(
                            uint64 scale
                                => ScaleSums
                        )
                )
        )
) scaleSums;
```

When a scale changes:

```text
persist current scale sums
start new scale sums at zero
```

When a generation empties:

```text
persist current scale sums
record final scale
increment generation
reset P / scale / current sums
```

Generation metadata:

```solidity
struct GenerationMeta {
    uint64 finalScale;
    bool finalized;
}
```

---

# 7. ProviderPosition

One per supplier × Tick.

```solidity
struct Snapshot {
    uint256 initialPrincipalX36;

    uint64 generation;
    uint64 scale;

    uint256 P;

    uint256 assetSum;
    uint256 yieldSum;
    uint256 quoteSum;
}

struct ProviderPosition {
    Snapshot active;
    Snapshot exit;

    uint256 owedActiveYieldAsset;
    uint256 owedActiveQuote;

    uint256 owedExitAsset;
    uint256 owedExitYieldAsset;
    uint256 owedExitQuote;

    uint256 lastSupplyBlock;
}
```

There are no:

```text
shares
exitShares
growth-per-share checkpoints
MAX_SHARES
share-capacity errors
```

---

# 8. Provider synchronization

Internal helpers SHOULD separate:

```text
_currentPrincipal(...)
_accruedGains(...)
_syncActive(...)
_syncExit(...)
_snapshotActive(...)
_snapshotExit(...)
```

Synchronization is O(1) with a fixed scale bound.

For stale generation:

```text
principalX36 = 0
gains = historical generation/scale sums
```

For current generation:

```text
principalX36 =
    initialPrincipalX36
    × currentP / snapshotP
    × scale adjustment

principalRaw =
    floor(principalX36 / PRINCIPAL_PRECISION)
```

Provider gains MUST use the canonical exact cross-scale recurrence in `spec/protocol.md` §9.

Do not floor each scale's provider gain independently. The EVM implementation MUST retain the exact cross-scale fractional remainder with bounded `uint512` arithmetic and produce the same `providerGain` as the canonical rational expression.

All realization rounds DOWN.

A sync writes gains into `owed*`, then refreshes snapshots. A positive sub-raw `principalX36` MUST remain snapshotted even when `principalRaw == 0`.

---

# 9. Accounting bounds

Every state-changing path MUST reject before mutation if any applicable single-action/domain amount exceeds:

```text
MAX_ACCOUNTING_AMOUNT = 1e30 raw units
```

This includes:

```text
activePrincipal
exitWorking
assetAmount
quotePrincipal
fullTermYieldAsset
grossYieldAsset
single funded gain
```

The invariant:

```text
P >= P_MIN >= domainPrincipal
```

guarantees every positive whole-unit funded gain produces a positive sum increment.

Provider synchronization reads at most the snapshot scale plus `MAX_SCALE_SPAN = 8` subsequent scale states.

Provider fixed-point principal is bounded by:

```text
MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION = 1e66
snapshotP * PRINCIPAL_PRECISION <= 1e75
```

A provider residual that finally rounds below one `principalX36` unit is below `1e-36` raw Asset and can receive less than `1e-6` raw units from any one maximum-sized funded gain.

One depletion may move by at most `MAX_SCALE_JUMP = 4` scales under the canonical amount domain.

---

# 10. Product update

For a depletion:

```text
D_before > 0
loss > 0
D_after = D_before - loss
```

If `D_after == 0`, finalize generation.

Otherwise:

```text
newP =
    floor(
        P_before
        * D_after
        / D_before
    )
```

If `newP` falls below the safe precision band, re-denominate using `SCALE_FACTOR` and increment scale until representable.

A single action MUST support a bounded multi-scale jump.

---

# 11. Gain update

Before domain depletion:

```solidity
sumIncrement =
    Math.mulDiv(
        fundedGain,
        domain.P,
        domainPrincipal,
        Math.Rounding.Floor
    );
```

A funded gain must be reflected in the appropriate reserve/liability before external Collect can withdraw it.

Ordering is protocol-critical.

---

# 12. Economic ABI

Reference external ABI:

```solidity
createPair(address tokenA, address tokenB)

createTick(
    uint256 pairId,
    uint8 direction,
    int32 priceTick,
    uint64 durationDays
)

supply(
    uint256 tickId,
    uint256 assetAmount,
    address referrer
)

withdraw(
    uint256 tickId,
    uint256 principalAmount
)

collect(
    uint256 tickId
)

use(
    uint256 tickId,
    uint256 assetAmount,
    uint256 maxFullTermYieldAsset,
    uint256 deadline,
    address referrer
)

repay(
    uint256 positionId,
    uint256 maxYieldAsset
)

swap(
    uint256 tickId,
    uint256 assetAmount,
    uint256 maxQuoteIn,
    uint256 deadline,
    address referrer
)

close(
    uint256 positionId
)

settle(
    uint256 tickId
)
```

`withdraw` now uses Asset-denominated active principal, not shares.

`referrer` in `supply`, `use`, and `swap` is metadata-only. Zero address is allowed. It MUST NOT alter fees, provider proceeds, Yield, settlement priority, ownership, or any protocol right. Implementations may emit it for attribution and analytics only.

---

# 13. Supply

Order:

```text
automatic settle one
sync provider active
sync provider Exit if required

exact Asset transfer in

availableSupply += assetAmount

provider.active.initialPrincipalX36 =
    currentCompoundedPrincipalX36
    + assetAmount * PRINCIPAL_PRECISION

snapshot active state

lastSupplyBlock = block.number
```

Supply does not alter active P.

---

# 14. Withdraw

Require:

```text
principalAmount > 0
block.number > lastSupplyBlock
```

After settlement and synchronization:

```text
providerPrincipalX36 = current active principalX36
providerPrincipal =
    floor(providerPrincipalX36 / PRINCIPAL_PRECISION)

x = min(principalAmount, providerPrincipal)
```

Preview MUST return whole-raw-unit `providerPrincipal`.

A positive sub-raw remainder in `providerPrincipalX36` remains economically owned after a Max withdrawal and MUST NOT be cleared.

Split:

```solidity
availableOut =
    Math.mulDiv(
        x,
        tick.availableSupply,
        activePrincipal
    );

workingToExit =
    x - availableOut;
```

Then:

```text
availableSupply -= availableOut
exitWorking += workingToExit
```

Active P unchanged.

Provider active principal becomes:

```text
providerPrincipalX36
- x * PRINCIPAL_PRECISION
```

If `workingToExit > 0`, add `workingToExit * PRINCIPAL_PRECISION` to the provider's synchronized Exit `principalX36` and take fresh Exit snapshots.

Transfer `availableOut`.

No Max dust-share special case exists.

---

# 15. Use

Use changes:

```text
availableSupply -= assetAmount
workingSupply += assetAmount
```

Active principal and active P are unchanged.

Store:

```text
quotePrincipal
fullTermYieldAsset
closeFee
```

Close fee:

```solidity
closeFee =
    Math.mulDiv(
        quotePrincipal,
        PROTOCOL_FEE_BPS,
        BPS
    );
```

Future Repay arithmetic representability MUST be checked at Use.

At minimum, require before mutation:

```text
durationDays <= MAX_DURATION_DAYS
openedAt + durationDays * SECONDS_PER_DAY <= MAX_TIMESTAMP
quotePrincipal <= MAX_ACCOUNTING_AMOUNT
fullTermYieldAsset <= MAX_ACCOUNTING_AMOUNT
```

Canonical `mulDiv` rounding-up arithmetic MUST guarantee for every future:

```text
1 <= billableElapsed <= termSeconds
```

that:

```text
grossYieldAsset =
    ceil(
        fullTermYieldAsset
        * billableElapsed
        / termSeconds
    )

grossYieldAsset <= fullTermYieldAsset
```

without intermediate overflow.

---

# 16. Repay

Calculate canonical:

```text
grossYieldAsset
yieldFeeAsset
netYieldAsset

exitFill
activeReturn

exitYieldAsset
activeYieldAsset
```

Transfer:

```text
Asset principal + gross Yield in
full Quote Principal out
Yield fee directly to FEE_TO
```

Exit domain:

```text
fund Exit Asset gain
fund Exit Yield gain
deplete Exit principal
update Exit P / generation
```

Active domain:

```text
active principal unchanged
fund active Yield gain
active P unchanged
```

Only net Yield enters provider liabilities.

---

# 17. Swap

Fund `providerSwapProceeds` into active Quote sum using pre-depletion P/principal.

Then:

```text
availableSupply -= assetAmount
```

Update active P.

If active principal becomes zero, finalize active generation.

Fee transfers directly to FEE_TO.

---

# 18. Close

Use stored `closeFee`.

Compute Exit/active split exactly as `spec/protocol.md`.

Fund Quote sums before each domain's principal depletion.

Then update Exit and active P independently.

A single Close may finalize both domains.

---

# 19. Collect

Collect:

```text
automatic settle one
sync active
sync Exit

Asset out =
    owedActiveYieldAsset
  + owedExitAsset
  + owedExitYieldAsset

Quote out =
    owedActiveQuote
  + owedExitQuote
```

Clear paid `owed*`.

No protocol fee at Collect.

---

# 20. Custody and liabilities

Aggregate token liability accounting remains mandatory:

```solidity
mapping(address => uint256) public tokenLiability;
```

Tick-level liabilities SHOULD remain explicit.

Asset liability includes:

```text
availableSupply
funded Exit Asset claims
funded active/Exit net Yield claims
```

Quote liability includes:

```text
ACTIVE Quote escrow
funded active/Exit Quote proceeds
```

After any mutation:

```text
physical token balance >= aggregate token liability
```

Unexpected donations create no claim.

---

# 21. Token support

ERC-20 only.

Unsupported:

```text
native ETH
fee-on-transfer
rebasing
callback/reentrant transfer semantics
non-exact token transfers
```

Use WETH for ETH.

Exact transfer balance checks are required where necessary.

There is no rescue/admin bypass for a token that later becomes incompatible, blacklists protocol/fee addresses, or stops exact transfers. An affected Tick may become permanently stuck; this MUST NOT be "fixed" by adding mutable rescue authority.

---

# 22. Reentrancy / Multicall

Economic entrypoints are individually guarded.

The delegatecall-based Multicall wrapper itself MUST NOT hold a `nonReentrant` guard across the batch. Each economic subcall enters and exits its own guard before the next sequential subcall executes. Economic functions SHOULD route through unguarded internal helpers where one economic action must invoke another internally.

Useful compositions:

```text
withdraw + collect
settle + collect
multiple Uses
multiple Swaps
multiple Repays / Closes
```

---

# 23. Position order

Keep:

```text
global nextPositionId
per-Tick nextPositionSeq
per-Tick settleCursor
tickPositionId[tickId][tickSeq]
```

Position IDs are permanent.

Cursor settlement stays O(1).

---

# 24. Events

Freeze at least:

```text
PairCreated
TickCreated

Supplied(
    tickId,
    supplier,
    assetAmount,
    referrer
)

Withdrawn(
    tickId,
    supplier,
    principalAmount,
    availableAssetOut,
    workingToExit
)

Collected(
    tickId,
    supplier,
    exitAsset,
    activeYieldAsset,
    exitYieldAsset,
    exitQuote,
    activeQuote,
    totalAssetOut,
    totalQuoteOut
)

UseOpened(
    positionId,
    tickId,
    tickSeq,
    user,
    assetAmount,
    quotePrincipal,
    fullTermYieldAsset,
    closeFee,
    openedAt,
    maturity,
    referrer
)

TermRepaid(
    positionId,
    tickId,
    tickSeq,
    user,
    assetAmount,
    quotePrincipal,
    grossYieldAsset,
    yieldFeeAsset,
    exitFill,
    activeReturn,
    exitYieldAsset,
    activeYieldAsset
)

TermClosed(
    positionId,
    tickId,
    tickSeq,
    user,
    caller,
    assetAmount,
    quotePrincipal,
    closeFee,
    providerSwapProceeds,
    exitFill,
    exitQuote,
    activeQuote
)

ImmediateSwap(
    tickId,
    taker,
    assetAmount,
    quotePrincipal,
    swapFee,
    providerSwapProceeds,
    referrer
)

DomainScaleChanged(
    tickId,
    domain,
    generation,
    oldScale,
    newScale,
    newP
)

DomainGenerationFinalized(
    tickId,
    domain,
    generation,
    finalScale
)
```

Scale/generation events are accounting metadata, not product actions.

---

# 25. Views / previews

Required:

```solidity
getPair(...)
getTick(...)
getEarnPosition(...)
getPosition(...)

getEarnPositions(...)
getUsePositions(...)

previewSupply(...)
previewWithdraw(...)
previewUse(...)
previewRepay(...)
previewSwap(...)
previewCollect(...)
```

All state-sensitive previews MUST project the same one-step settlement hook.

`getEarnPosition` exposes economic values:

```text
activePrincipal
activePrincipalX36 debug-only
activeAvailable equivalent
activeWorking equivalent

resolvingPrincipal

claimable active Yield
claimable Exit Asset
claimable Exit Yield
claimable active Quote
claimable Exit Quote
```

Debug/SDK views MAY expose P/scale/generation/sums.

`getEarnPositions(...)` / adapter enumeration MUST keep a provider Tick visible while any of:

```text
activePrincipalX36 > 0
exitPrincipalX36 > 0
any owed* > 0
unsynchronized historical gain exists
```

Whole-raw `activePrincipal == 0` is not sufficient to drop the position.

---

# 26. Product-Sum tests

In addition to protocol tests:

```text
P starts at P_PRECISION
Supply does not change P
Use does not change P
active Repay does not change P

Swap updates Quote sum before P
Close updates sums before P
Exit Repay updates Asset/Yield sums before P

new supplier after Swap receives no historical Quote
new supplier after Repay receives no historical Yield

1-raw + 1-raw provider fractional-principal vector
positive sub-raw principalX36 snapshot is preserved
Max Withdraw never clears positive sub-raw principalX36

provider top-up refreshes snapshot
partial Withdraw refreshes snapshot
Collect refreshes snapshot without changing principal

scale exact threshold
scale transition
multi-scale transition
historical scale claim

active generation reset
Exit generation reset
stale provider historical claims

historical Astra H-01 sequence
historical Exit share-inflation sequence

no share/capacity state exists
Supply remains available after adversarial depletions
Withdraw remains available after adversarial Exit resolutions
```

Stateful fuzz tests MUST compare against a high-precision reference model.

---

# 27. Deployment gate

Production remains disabled until:

```text
Product-Sum implementation complete
full unit + fuzz suite passes
EVM/Solana golden vectors frozen
FEE_TO frozen
bytecode frozen
CREATE2 address frozen
independent security review complete
```

All prior share-based deployment hashes/salts/addresses are obsolete.
