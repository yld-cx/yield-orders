# yld.cx — Yield Orders Protocol

**Ethereum / EVM Implementation Specification**  
**Version:** 0.3
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

One immutable `YieldOrders.sol` deployment contains all economic, custody, fee, settlement, and portfolio functions. `YieldMath`, `ProductSumMath`, `Uint512`, and `TickMath` are internal libraries, with no linked deployed library. There is no owner, fee setter, proxy, protocol-fee vault contract, or governance-controlled economics. `FEE_TO` MUST be nonzero and different from the deployed contract address.

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

`priceTick` defines Quote **raw units** per Asset **raw unit** through `priceX128`. Human-readable prices must adjust for both tokens' decimals.

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
    bool exists;

    uint256 availableSupply;
    uint256 workingSupply;
    uint256 exitWorking;

    Domain active;
    Domain exit;

    // Funded provider reserves and active Use escrow; separate from global fees.
    uint256 exitAssetReserve;
    uint256 yieldAssetReserve;
    uint256 exitQuoteReserve;
    uint256 activeQuoteReserve;
    uint256 quoteEscrow;

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

    // Persistent sub-raw gains: Active Yield/Quote; Exit Asset/Yield/Quote.
    // Each element is strictly less than PRINCIPAL_PRECISION.
    uint256[5] fractionalGainX36;

    uint256 timestamp;
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

Do not floor each scale's provider gain independently. The EVM implementation MUST retain the exact cross-scale fractional remainder with bounded `uint512` arithmetic and produce the same `providerGain` as the canonical rational expression. `Uint512.mulSmall` MUST revert if the high-limb addition overflows, as well as when the intermediate multiplication exceeds 512 bits.

All realization rounds DOWN.

A sync computes gains in X36 sub-raw units, adds each stream’s independent stored fractional remainder, credits whole raw units to `owed*`, retains the remainder, then refreshes snapshots. Array indices are fixed: `0=Active Yield`, `1=Active Quote`, `2=Exit Asset`, `3=Exit Yield`, `4=Exit Quote`. A positive sub-raw `principalX36` MUST remain snapshotted even when `principalRaw == 0`. Remainders also persist when principal reaches zero. The per-checkpoint precision loss is less than `1e-36` raw unit per stream; see the canonical dust bound in `spec/protocol.md` §9.

The provider `timestamp` also enforces the withdrawal cooldown. Supply and Collect reset it to `block.timestamp`; Withdraw checks `block.timestamp > timestamp` and does not reset it. Both chains implement the canonical vested-Yield calculations from `spec/protocol.md` §§19 and 22.

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
    uint256 principalAmount,
    uint256 minImmediateAssetOut,
    uint256 deadline
)

collect(
    uint256 tickId
)

quoteUse(uint256 tickId, uint256 assetAmount)
collectProtocolFees(address token)

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
) returns (RepayResult memory)

swap(
    uint256 tickId,
    uint256 assetAmount,
    uint256 maxQuoteIn,
    uint256 deadline,
    address referrer
)

close(
    uint256 positionId
) returns (CloseResult memory)

settle(
    uint256 tickId
)
```

`withdraw` now uses Asset-denominated active principal, not shares.

`referrer` in `supply`, `use`, and `swap` is metadata-only. Zero address is allowed. It MUST NOT alter fees, provider proceeds, Yield, settlement priority, ownership, or any protocol right. Implementations may emit it for attribution and analytics only.

`RepayResult` and `CloseResult` expose the canonical economic result required by integrators and simulation before the resolved Term Position storage is deleted. At minimum, `CloseResult` exposes the resolved position identity / Tick / sequence plus `closeFee`, provider Quote proceeds, `exitFill`, `activeFill`, `exitQuote`, and `activeQuote`. Exact struct naming MAY differ if the ABI exposes equivalent return fields.

`getPosition(positionId)` is an ACTIVE-state view only. A successfully Repayed or Closed position is no longer readable from Term Position storage.

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

timestamp = block.timestamp
```

Supply does not alter active P. Supply resets the shared provider `timestamp` even on an existing position, restarting vesting of all outstanding Yield; Collect beforehand is optional.

---

# 14. Withdraw

Require:

```text
principalAmount > 0
block.timestamp > timestamp
block.timestamp <= deadline
availableAssetOut >= minImmediateAssetOut
```

After settlement and synchronization:

```text
providerPrincipalX36 = current active principalX36
providerPrincipal =
    floor(providerPrincipalX36 / PRINCIPAL_PRECISION)

x = min(principalAmount, providerPrincipal)
```

Require after the `min` calculation:

```text
DproviderX36 = providerPrincipalX36
x > 0
DproviderX36 > 0
```

A provider with only sub-raw fixed-point principal cannot execute a zero-effect Withdraw. Max continues to use the whole-raw `providerPrincipal` preview.

The simulated Withdraw return MUST expose whole-raw-unit `providerPrincipal`; `getEarnPosition` provides current transferable principal before the simulation.

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

Apply canonical §19 Vested and Unvested Yield calculations after provider synchronization and before completing Withdraw:

```text
DproviderX36 = pre-withdraw compounded active principalX36
Y = synced owedActiveYieldAsset
durationSeconds = durationDays * SECONDS_PER_DAY
yieldForWithdraw = floor(Y * (x * PRINCIPAL_PRECISION) / DproviderX36)
elapsed = min(block.timestamp - timestamp, durationDays * SECONDS_PER_DAY)
yieldAssetOut = floor(yieldForWithdraw * elapsed / durationSeconds)
unvestedYield = yieldForWithdraw - yieldAssetOut
owedActiveYieldAsset -= yieldForWithdraw
```

Any positive Unvested Yield attributable to withdrawn principal is reclassified as Asset protocol fees. It is not redistributed through the Active Product-Sum domain. Reduce `yieldAssetReserve` by `unvestedYield` and accrue the same amount through the existing Asset protocol-fee accounting mechanism. The Active Yield sum is unchanged; no provider eligibility calculation or redistribution amount bound applies.

Transfer `availableOut + yieldAssetOut`. The `withdraw` return and `Withdrawn` event include `yieldAssetOut` and `unvestedYield`. Preserve the existing Exit principal split and sub-raw remainder.

Withdraw does not reset `timestamp`. Previously allocated Exit Yield and any retained Active Yield remain outstanding for later Collect.

No Max dust-share special case exists.

---

# 15. Use

Use changes:

```text
availableSupply -= assetAmount
workingSupply += assetAmount
```

Active principal and active P are unchanged.

Store an ACTIVE Term Position containing the fields required for Repay / Close, including:

```text
Tick / sequence
user
assetAmount
quotePrincipal
fullTermYieldAsset
closeFee
openedAt
maturity
```

The position storage exists only while ACTIVE.

Close fee:

```solidity
closeFee =
    Math.mulDiv(
        quotePrincipal,
        PROTOCOL_FEE_BPS,
        BPS
    );
```

Future Repay arithmetic representability MUST be checked at Use. The implementation MUST apply every canonical Use admission predicate from `spec/protocol.md` §17, including positive `assetAmount`, positive Quote Principal, positive full-term Yield, deadline validity, Available-liquidity bounds, and the shared timestamp domain.

At minimum, require before mutation:

```text
durationDays <= MAX_DURATION_DAYS
openedAt + durationDays * SECONDS_PER_DAY <= MAX_TIMESTAMP
quotePrincipal > 0
quotePrincipal <= MAX_ACCOUNTING_AMOUNT
fullTermYieldAsset > 0
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
Yield fee accrued in Asset-denominated protocol fees
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

After computing the return value and terminal event fields, remove the position from the user's active-position index in O(1), delete `tickPositionId[tickId][tickSeq]`, and `delete` the Term Position storage. If the target sequence equals `settleCursor`, advance the cursor exactly once as defined by `spec/protocol.md` §25.

No separate keeper payment or protocol-fee split is introduced. Any EVM storage refund resulting from deletion follows normal EVM transaction semantics and belongs to the transaction execution implicitly.

---

# 17. Swap

Fund `providerSwapProceeds` into active Quote sum using pre-depletion P/principal.

Then:

```text
availableSupply -= assetAmount
```

Update active P.

If active principal becomes zero, finalize active generation.

Fee accrues in Quote-denominated protocol fees; Close follows the same rule. A fee transfer is never part of ordinary settlement.

---

# 18. Close

Use stored `closeFee`.

Compute Exit/active split exactly as `spec/protocol.md`.

Fund Quote sums before each domain's principal depletion.

Then update Exit and active P independently.

A single Close may finalize both domains.

Return the canonical `CloseResult`, emit `TermClosed` using values captured before deletion, remove the position from the user's active-position index in O(1), delete `tickPositionId[tickId][tickSeq]`, and `delete` the Term Position storage. Cursor advancement follows `spec/protocol.md` §25.

There is no explicit keeper reward and no protocol-fee split for closing. Position deletion only removes no-longer-needed storage.

---

# 19. Collect

Collect:

```text
automatic settle one
sync active
sync Exit

elapsed = min(block.timestamp - timestamp, durationDays * SECONDS_PER_DAY)
activeYieldOut = floor(owedActiveYieldAsset * elapsed / durationSeconds)
exitYieldOut = floor(owedExitYieldAsset * elapsed / durationSeconds)

Asset out =
    activeYieldOut
  + owedExitAsset
  + exitYieldOut

Quote out =
    owedActiveQuote
  + owedExitQuote
```

Clear only the paid `owed*`; retain uncollected funded Yield. Reset `timestamp = block.timestamp` on every successful Collect, including one that pays zero. Repeat Collect at the same timestamp must not release additional Yield.

No protocol fee at Collect. Asset principal and Quote proceeds do not vest.

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

Accrued protocol fees are additional global per-token liabilities, **not** part of any Tick's Asset/Quote reserve. For each token, the accounting identity is `tokenLiability[token] = Σ all Tick liabilities denominated in token + accruedProtocolFees[token]`. When the same token acts as Asset in one Tick and Quote in another, include both. `collectProtocolFees(token)` reduces the accrued balance and aggregate liability before paying immutable `FEE_TO`; any transfer failure atomically restores both.

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

There is no rescue/admin bypass for an incompatible token. A token rejecting transfers to `FEE_TO` affects only `collectProtocolFees(token)` and MUST NOT prevent settlement, Swap, Repay, Withdraw, or Collect. A token blocking the protocol or user transfers can still stop those actions.

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

Multicall MAY batch additional explicit `settle(tickId)` calls, but it MUST NOT replace the mandatory one-sequence settlement path inside each economic action. Each explicit `settle` and each automatic settlement step remains independently bounded O(1).

---

# 23. Position order and active storage

Keep:

```text
global nextPositionId
per-Tick nextPositionSeq
per-Tick settleCursor
tickPositionId[tickId][tickSeq]   // ACTIVE positions only
```

Identifiers and Tick sequences are monotonically increasing and never reused. **Resolved Term Position storage is not permanent.**

On Use:

```text
positionId = nextPositionId++
tickSeq = nextPositionSeq++
tickPositionId[tickId][tickSeq] = positionId
create ACTIVE Position
append positionId to user's active-position list
```

On successful Repay / Close:

```text
capture return/event fields
remove positionId from user's active list via swap-and-pop
delete userPositionIndexPlusOne[positionId]
delete tickPositionId[tickId][tickSeq]
delete Position storage
```

The active user list MUST have an index mapping such as:

```text
userPositionIndexPlusOne[positionId]
```

so removal is O(1); no array scan is permitted.

When `settleCursor < nextPositionSeq`, `tickPositionId[tickId][settleCursor] == 0` means that sequence was created and has already been resolved / removed. `_settleOne` increments the cursor once and stops. It MUST NOT loop forward to find another live position.

For an ACTIVE cursor entry:

```text
not mature → no-op
mature     → canonical Close + delete position + cursor++
```

For Repay / Close:

```text
target seq == cursor
→ resolve target directly
→ delete target
→ cursor++

target seq != cursor
→ _settleOne() exactly once
→ resolve target
→ delete target
→ stop
```

Cursor settlement and active-list maintenance remain O(1). Historical position activity is reconstructed from events.

---

# 24. Events

Freeze at least:

```text
PairCreated
TickCreated
ProtocolFeesAccrued
ProtocolFeesCollected

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
    workingToExit,
    yieldAssetOut,
    unvestedYield
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
    activeFill,
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

`UseOpened`, `TermRepaid`, and `TermClosed` are the canonical onchain history for Term Positions. Terminal events MUST be emitted from values captured before resolved Position storage is deleted and MUST contain sufficient identity / sequence and economic fields for offchain history reconstruction.

---

# 25. Views and product simulations

Required views include `getPair`, `getTick`, `getEarnPosition`, `getPosition`, `getEarnPositions`, `getUsePositions`, `getDomain`, `nextPositionId`, `tokenLiability`, `accruedProtocolFees`, and `quoteUse`.

`getPosition(positionId)` exposes only an ACTIVE Term Position. Resolved IDs have no retained Term Position state. `getUsePositions(owner, ...)` enumerates ACTIVE position IDs only and MUST use O(1) add/remove bookkeeping; it is not a historical ledger.

The Solidity `preview*` methods and hypothetical settlement projection remain removed. The product simulates real economic calls through OpenZeppelin `multicall(bytes[])` in one `eth_call`. **Never prepend `settle()` as a requirement**; each economic action already attempts its mandatory one-sequence cursor step. Additional explicit `settle()` calls MAY be batched only when the caller intentionally wants extra cursor progress.

Simulation rules:

```text
Supply   → supply + getEarnPosition + getTick
Withdraw → withdraw + getEarnPosition + getTick
Collect  → collect + getEarnPosition
Use      → use + getPosition(newPositionId) + getTick
Repay    → repay return data + getTick / getDomain as needed
Swap     → swap + getTick
Close    → close return data + getTick / getDomain as needed
```

Because Repay and Close delete their Term Position storage, simulations MUST NOT depend on `getPosition(positionId)` after those calls. `repay` and `close` return the canonical result fields needed by the adapter. For Use, read `nextPositionId` before the simulation and append `getPosition(positionId)` for the newly ACTIVE position.

The call must use the intended caller and sufficient token balances and allowances. A failed call can mean allowance, balance, maturity, cooldown, slippage, deadline, or changed settlement state.

`quoteUse(tickId, assetAmount)` provides only current-state Quote Principal and full-term Yield before approval. It does not project an expired cursor Close. Market state can change between quotation, simulation, and execution; retain all execution-time limits and deadlines. `withdraw(tickId, principalAmount, minImmediateAssetOut, deadline)` may use zero minimum and a permissive deadline for unrestricted execution.

`collectProtocolFees(token)` is permissionless and sends the entire accrued balance only to immutable `FEE_TO`. `accruedProtocolFees(token)` is a separate, fully backed global token liability, never double-counted in Tick reserves. A failed claim reverts only that claim.

`getEarnPosition` exposes economic values:

```text
activePrincipal
activePrincipalX36 debug-only
activeAvailable equivalent
activeWorking equivalent

resolvingPrincipal

currently collectible active Yield
outstanding uncollected active Yield
claimable Exit Asset
currently collectible Exit Yield
outstanding uncollected Exit Yield
timestamp and vesting progress
claimable active Quote
claimable Exit Quote
```

Debug/SDK views MAY expose P/scale/generation/sums.

`getEarnPositions(...)` / adapter enumeration MUST keep a provider Tick visible while any of:

```text
activePrincipalX36 > 0
exitPrincipalX36 > 0
any owed* > 0
any fractionalGainX36[i] > 0
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
passive provider across 9+ scale transitions; verify dust bound

active generation reset
Exit generation reset
stale provider historical claims

repeated near-total depletion sequence
repeated Exit resolution sequence

no share/capacity state exists
Supply remains available after adversarial depletions
Withdraw remains available after adversarial Exit resolutions
Supply and Collect reset timestamp; same-timestamp Withdraw rejected
Collect time-weighted Active/Exit Yield, retains remainder and resets timestamp
Collect before top-up / top-up without Collect
partial/full Withdraw Yield release and Unvested Yield accrued as Asset protocol fees
all Working yet Active > 0; Unvested Yield -> accrued Asset protocol fee
Swap/Close exhaust Active; outstanding Yield still vests
partial withdrawal cannot reclaim Unvested Yield through withdrawing position's residual principal
Withdraw Unvested Yield leaves Active Yield sums and all provider timestamps unchanged
Withdraw Unvested Yield accounting with fractional principal and Product-Sum rounding remainder
funded Yield conservation after nearly depleted principal and complete claim collection
independent reference timestamps/vesting/Unvested Yield; do not seed expected state from emitted values
funded Yield reserve/fee/claim conservation after generation rollover and every claim
both directional price ticks and mixed-decimal reciprocal price vectors
out-of-order Repay/Close with pooled Exit-first funding and already-terminal cursor skips
fractional Yield rounding and repeated Collect
fraction-only provider Tick stays discoverable after all whole-raw claims are paid
future Supply retains its fractional carry without inheriting other providers' history

Use rejects zero full-term Yield before mutation
Withdraw rejects x == 0 after whole-raw min calculation
Withdraw Unvested Yield fee reclassification supports amounts above MAX_ACCOUNTING_AMOUNT
TermClosed event includes activeFill
active Term Position removed after Repay
active Term Position removed after Close
resolved position removed from getUsePositions in O(1)
position IDs / Tick sequences never reused
tickPositionId deleted on out-of-order resolution
deleted cursor sequence advances exactly once and stops
many deleted cursor gaps require one step per action, never a loop
non-cursor Repay/Close attempts exactly one _settleOne before target resolution
cursor-target Repay/Close advances directly exactly once
Multicall cannot bypass mandatory per-action settlement
Repay/Close simulations use return data, never deleted getPosition state
```

Stateful fuzz tests MUST compare against a high-precision reference model that independently computes timestamps, vesting, Unvested Yield, principal, gains, fees, and complete reserve conservation. Include all canonical acceptance requirements in `spec/protocol.md` §29.1.

---

# 27. Deployment gate

Production remains disabled until:

```text
Product-Sum implementation complete
full unit + fuzz suite passes, including independent vesting and reserve modeling
production runtime passes the EIP-170 24,576-byte size gate **after** final economic changes
EVM/Solana/reference SDK exact-X36 and directional-price golden vectors frozen
FEE_TO frozen
bytecode frozen
CREATE2 address frozen
independent security review complete
```

Deployment hashes, salts, and predicted addresses MUST be derived from the final production creation code and constructor arguments.
