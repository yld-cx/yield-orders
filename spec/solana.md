# yld.cx — Yield Orders Protocol

**Solana / Anchor Implementation Specification**  
**Version:** 0.2
**Depends on:** `spec/protocol.md`

---

# 1. Goal

Implement exactly the canonical YLD Product-Sum economics on Solana.

No Solana-specific feature may alter Yield pricing, the 1% fee model, Product-Sum accounting, Exit-first resolution, maturity semantics, rounding, or provider economics.

---

# 2. Runtime

Reference:

```text
Rust
Anchor
SPL Token
Token-2022 under frozen safe-extension allowlist
```

Production has no upgrade authority, writable GlobalConfig, or mutable economics.

---

# 3. Constants

Program constants:

```text
BPS = 10_000
Q128 = 2^128

PROTOCOL_FEE_BPS = 100

MAX_ACCOUNTING_AMOUNT = 10^30
PRINCIPAL_PRECISION = 10^36
P_PRECISION = 10^39
SCALE_FACTOR = 10^9
P_MIN = 10^30
MAX_SCALE_SPAN = 8
MAX_SCALE_JUMP = 4

MIN_DAILY_BPS = 1
MAX_DAILY_BPS = 100
CURVE_EXPONENT = 3
MIN_BILLABLE_SECONDS = 1

FEE_TO = immutable production Pubkey
```

All wide math MUST match EVM.

Canonical time domain:

```text
SECONDS_PER_DAY = 86_400
MAX_TIMESTAMP = 9_223_372_036_854_775_807
MAX_DURATION_DAYS = 106_751_991_167_300
```

Compute `duration_days * SECONDS_PER_DAY` and `opened_at + duration_seconds` in checked wide arithmetic before converting to Solana `i64` timestamps. Require non-negative `opened_at` and `maturity <= MAX_TIMESTAMP`.

---

# 4. Pair PDA

Canonical sorted mints:

```text
mint0 < mint1
```

Seeds:

```text
["pair", mint0, mint1]
```

Stores:

```text
mint0
mint1
bump
```

---

# 5. Tick PDA

Seeds:

```text
[
  "tick",
  pair,
  direction,
  price_tick_le,
  duration_days_le
]
```

Stores at least:

```text
pair
direction
asset_mint
quote_mint
price_tick
price_x128
duration_days

available_supply
working_supply
exit_working

// Funded provider reserves and active Use escrow
exit_asset_reserve
yield_asset_reserve
exit_quote_reserve
active_quote_reserve
quote_escrow

active_P
active_scale
active_generation
active_yield_sum
active_quote_sum

exit_P
exit_scale
exit_generation
exit_asset_sum
exit_yield_sum
exit_quote_sum

// independently backed fee balances, held in this Tick's existing vaults
accrued_asset_protocol_fees   // Asset Vault
accrued_quote_protocol_fees   // Quote Proceeds Vault

next_position_seq
settle_cursor

bump
```

Derived:

```text
active_working =
    working_supply - exit_working

active_principal =
    available_supply + active_working
```

Token amounts use checked native integers where representable. P/sums/price/Yield intermediates use canonical wide integers sufficient for EVM parity.

---

# 6. ProviderPosition PDA

Seeds:

```text
["provider", tick, supplier]
```

Stores:

```text
supplier
tick

active_initial_principal_x36
active_generation
active_scale
active_P_snapshot
active_yield_sum_snapshot
active_quote_sum_snapshot

exit_initial_principal_x36
exit_generation
exit_scale
exit_P_snapshot
exit_asset_sum_snapshot
exit_yield_sum_snapshot
exit_quote_sum_snapshot

owed_active_yield_asset
owed_active_quote

owed_exit_asset
owed_exit_yield_asset
owed_exit_quote

// [Active Yield, Active Quote, Exit Asset, Exit Yield, Exit Quote]
fractional_gain_x36: [u128; 5]

timestamp
bump
```

No shares. No Exit shares.

ProviderPosition is permanent in v0.2. The single non-negative `timestamp` replaces the slot cooldown field; Supply and Collect reset it from `Clock.unix_timestamp`, and Withdraw requires the current Unix timestamp to be strictly greater.

`*_initial_principal_x36` is Asset principal in `PRINCIPAL_PRECISION = 1e36` sub-raw units. It is not a share balance and has no global supply denominator. Positive sub-raw principal remains snapshotted even when its whole-raw-unit preview is zero. Each `fractional_gain_x36` element holds a value in `[0, 1e36)` and therefore fits `u128`; compounded principal and the Product-Sum history still require wider integer types. Preserve nonzero carry even if principal and whole-raw claims reach zero. A residual principal that finally rounds below one fixed-point unit is below `1e-36` raw Asset and, under the shared funded-gain bound, can receive less than `1e-6` raw units from any one funded distribution.

---

# 7. Historical ScaleState PDAs

Scale/generation history must remain available to stale providers.

Active scale:

```text
[
  "active_scale",
  tick,
  generation_le,
  scale_le
]
```

Exit scale:

```text
[
  "exit_scale",
  tick,
  generation_le,
  scale_le
]
```

ActiveScaleState stores:

```text
tick
generation
scale
final_yield_sum
final_quote_sum
bump
```

ExitScaleState stores:

```text
tick
generation
scale
final_asset_sum
final_yield_sum
final_quote_sum
bump
```

The scale being left is persisted when P re-denominates or when the generation ends.

If one depletion jumps over intermediate scales, those skipped scales canonically contain zero sums.

---

# 8. Generation metadata PDA

Active:

```text
[
  "active_generation",
  tick,
  generation_le
]
```

Exit:

```text
[
  "exit_generation",
  tick,
  generation_le
]
```

Stores at least:

```text
tick
generation
final_scale
bump
```

Created only when the corresponding domain principal reaches zero.

A stale provider therefore resolves its own historical generation directly, without walking later generations.

---

# 9. TermPosition PDA

Seeds:

```text
["position", tick, position_seq_le]
```

Stores:

```text
position_seq
tick
user

asset_amount
quote_principal
full_term_yield_asset
close_fee

opened_at
maturity
status

bump
```

Permanent in v0.2.

---

# 10. Vaults

Per Tick:

```text
Asset Vault
["asset_vault", tick]

Quote Escrow Vault
["quote_escrow", tick]

Quote Proceeds Vault
["quote_proceeds", tick]
```

Asset Vault holds:

```text
active Available
funded Exit Asset claims
funded net Asset Yield claims
```

Working Asset is held by Use users.

Quote Escrow holds ACTIVE Position Quote Principal.

Quote Proceeds holds active and Exit Swap/Close claims **plus this Tick's accrued Quote protocol fees**, which are tracked separately and are never provider claims. The Asset Vault also holds this Tick's accrued Asset protocol fees in addition to provider liquidity and funded claims. The Quote Escrow Vault holds **only** full Quote Principal locked by ACTIVE Uses; it holds no claimable protocol fee after Close.

### 10.1 Fee accrual and exact vault flows

The Tick stores `accrued_asset_protocol_fees` and `accrued_quote_protocol_fees`; there is no global custody account, additional fee vault, or requirement to touch another Tick's vault. A token used in multiple Ticks or in different directions has independent fee balances in each Tick. Any protocol-level per-mint total is an offchain sum of the corresponding Tick fields.

- **Repay:** the taker's Asset principal plus gross Yield enters this Tick's Asset Vault. Fund only net Yield for providers; increment `accrued_asset_protocol_fees` by the Asset-denominated 1% Yield fee.
- **Withdraw with no eligible other Active:** transfer the already-funded forfeited Yield from provider Yield liability to `accrued_asset_protocol_fees` in the *same* Asset Vault. No additional token transfer or newly funded liability is created.
- **Swap:** the taker's entire Quote Principal enters this Tick's Quote Proceeds Vault. Provider net Quote is reserved for providers; the Quote fee increments `accrued_quote_protocol_fees`.
- **Close:** move the full frozen Quote Principal from this Tick's Quote Escrow Vault to its Quote Proceeds Vault. Reserve only provider net Quote for providers; increment `accrued_quote_protocol_fees` by the frozen Close fee. Do not transfer any fee to `FEE_TO` during Close or automatic settlement.

The following per-Tick vault backing conditions MUST hold after each successful instruction:

```text
Asset Vault balance >= available_supply + exit_asset_reserve
                     + yield_asset_reserve + accrued_asset_protocol_fees
Quote Escrow Vault balance >= quote_escrow
Quote Proceeds Vault balance >= active_quote_reserve + exit_quote_reserve
                              + accrued_quote_protocol_fees
```

### 10.2 Permissionless fee claim

Implement `collect_protocol_fees(tick, denomination)` for exactly one Tick and either its Asset or Quote mint. The caller may be anyone, but the recipient MUST be immutable `FEE_TO`'s validated associated token account for the correct mint and token program. Claim the entire accrued balance for the selected denomination from the corresponding Asset or Quote Proceeds Vault, decrement the Tick's accrued balance, and preserve the vault backing invariant. A failed transfer or absent/uncreatable recipient ATA reverts only this claim transaction and leaves fees fully backed; it MUST NOT block settlement, Repay, Swap, Withdraw, Collect, or Close. ATA creation, if supported, occurs only during this claim.

No provider loop, cross-Tick loop, or direct fee-recipient transfer occurs during economic actions.

---

# 11. Token compatibility

Legacy SPL Token is supported.

Token-2022 is restricted to extensions that preserve exact deterministic accounting.

Reject:

```text
transfer fees
transfer hooks
confidential transfers
permanent delegates
interest-bearing/rebasing semantics
non-transferable behavior
default frozen/account-state behavior
pausable transfer behavior
equivalent future extensions
```

Every supplied account validates:

```text
mint
owner
authority
token program
PDA derivation
extension allowlist
```

Required `FEE_TO` ATAs must exist or be created/validated by the fee-claim instruction, not ordinary settlement. There is no mutable rescue authority if a mint later becomes incompatible or blocks protocol/user transfers. A recipient-only rejection stops only the fee claim; a blocked protocol or user transfer can still stop the affected Tick action.

---

# 12. Accounting bounds

Solana's executable SPL token amounts are additionally limited by `u64`, which is stricter than the shared `MAX_ACCOUNTING_AMOUNT`.

The shared Product-Sum invariants still apply:

```text
domain principal <= MAX_ACCOUNTING_AMOUNT
P >= P_MIN
positive whole-unit gain → positive sum increment
```

Provider synchronization uses at most nine canonical scale states per domain:

```text
snapshot scale + eight subsequent scales
```

Provider fixed-point principal is bounded by:

```text
MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION = 10^66
P_snapshot * PRINCIPAL_PRECISION <= 10^75
```

One depletion crosses at most `MAX_SCALE_JUMP = 4` scales under the shared accounting domain.

---

# 13. supply instruction

Inputs:

```text
tick
asset_amount
referrer
```

`referrer` is metadata-only. The default Pubkey/zero value is allowed. It has no fee split, ownership, settlement priority, or other economic right and MAY be emitted for attribution only.

Process:

```text
one settlement step
sync provider active
sync provider Exit if needed

exact Asset transfer in

available_supply += asset_amount

new provider active principal_x36 =
    compounded active principal_x36
    + asset_amount * PRINCIPAL_PRECISION

snapshot current active:
P
scale
generation
Yield sum
Quote sum

timestamp = Clock.unix_timestamp
```

Active P is unchanged. Every Supply resets `timestamp`, including top-ups, restarting outstanding Yield vesting.

---

# 14. withdraw instruction

Inputs:

```text
principal_amount
min_immediate_asset_out
deadline
```

No shares. Apply one canonical automatic settlement step before calculating immediate Asset output.

Require:

```text
principal_amount > 0
Clock.unix_timestamp > timestamp
Clock.unix_timestamp <= deadline
available_out >= min_immediate_asset_out
```

The minimum is evaluated against the **immediately transferable Available Asset** after settlement, not against Working moved to Resolving or Yield paid on Withdraw. Zero minimum with a permissive deadline allows unrestricted execution. Synchronize both domains before calculating the withdrawal split.

Compute:

```text
provider_principal_x36 =
    provider compounded active principal_x36

provider_principal =
    floor(
        provider_principal_x36
        / PRINCIPAL_PRECISION
    )

x =
    min(
        principal_amount,
        provider_principal
    )

available_out =
    floor(
        x
        * available_supply
        / active_principal
    )

working_to_exit =
    x - available_out
```

Mutate:

```text
available_supply -= available_out
exit_working += working_to_exit
```

Active P unchanged.

Refresh provider active snapshot with:

```text
provider_principal_x36
- x * PRINCIPAL_PRECISION
```

A positive sub-raw remainder remains snapshotted.

If `working_to_exit > 0`, add `working_to_exit * PRINCIPAL_PRECISION` to synchronized Exit principal_x36 and refresh Exit snapshot.

After provider synchronization, release and redistribute outstanding Active Yield attributable to the withdrawn principal using the exact formula in `spec/protocol.md` §19:

```text
duration_seconds = duration_days * SECONDS_PER_DAY
yield_for_withdraw = floor(owed_active_yield_asset * (x * PRINCIPAL_PRECISION) / provider_principal_x36)
elapsed = min(Clock.unix_timestamp - timestamp, duration_days * SECONDS_PER_DAY)
yield_asset_out = floor(yield_for_withdraw * elapsed / duration_seconds)
forfeited_yield = yield_for_withdraw - yield_asset_out
owed_active_yield_asset -= yield_for_withdraw
```

Apply canonical §19 X36 redistribution. After withdrawing principal, calculate `other_active_x36 = active_principal * PRINCIPAL_PRECISION - remaining_provider_principal_x36`. For positive `forfeited_yield`, if `other_active_x36 >= PRINCIPAL_PRECISION`, increase the Active Yield sum by `floor(forfeited_yield * active_P * PRINCIPAL_PRECISION / other_active_x36)` using checked wide arithmetic; otherwise reclassify the amount as this Tick's accrued Asset protocol fees and reduce its funded Yield reserve equally. Refresh the withdrawing position's Active gain checkpoint after funding; other eligible positions retain their existing vesting timestamps. The integer result MUST match EVM. No additional funded liability, fee-recipient ATA or vesting state is created. Preserve outstanding Exit Yield and do not reset `timestamp`.

Transfer `available_out + yield_asset_out` from Asset Vault. Previews and events MUST surface `yield_asset_out` and `forfeited_yield`.

---

# 15. use instruction

Use changes:

```text
available_supply -= asset_amount
working_supply += asset_amount
```

Active principal and active P are unchanged.

Transfer:

```text
Asset Vault → user
Quote user account → Quote Escrow Vault
```

Freeze:

```text
full_term_yield_asset
close_fee
```

Before mutation, require:

```text
quote_principal <= MAX_ACCOUNTING_AMOUNT
full_term_yield_asset <= MAX_ACCOUNTING_AMOUNT

duration_days <= MAX_DURATION_DAYS
opened_at + duration_days * SECONDS_PER_DAY <= MAX_TIMESTAMP
```

All time and future Repay arithmetic uses checked wide intermediates before conversion to stored/native integer types. Since canonical elapsed Yield is bounded by `full_term_yield_asset`, every future Repay remains representable.

Create TermPosition.

---

# 16. repay instruction

Calculate:

```text
gross_yield_asset
yield_fee_asset
net_yield_asset

exit_fill
active_return

exit_yield_asset
active_yield_asset
```

Transfer exact Asset principal + gross Yield to Asset Vault.

Return full Quote Principal.

Accrue the Yield fee as this Tick's `accrued_asset_protocol_fees` in the Asset Vault, separately from provider Yield reserves. No `FEE_TO` account is needed for Repay.

Exit:

```text
add Exit Asset gain at pre-depletion Exit P
add Exit Yield gain at pre-depletion Exit P
decrease Exit principal
update Exit P or finalize Exit generation
```

Active:

```text
working → available
active principal unchanged
add active Yield gain
active P unchanged
```

---

# 17. close instruction

Use frozen Close fee.

Split provider Quote into Exit and active portions.

For each nonzero domain portion:

```text
add Quote gain using pre-depletion P
then reduce principal
then update P / scale / generation
```

Move the **entire** Quote Principal from the Quote Escrow Vault into this Tick's Quote Proceeds Vault. Reserve provider net Quote there and accrue the frozen fee as `accrued_quote_protocol_fees` in the same vault. After this movement no fee remains in Escrow. No `FEE_TO` account is required for direct or automatic Close.

---

# 18. swap instruction

Immediate Swap:

```text
compute Quote Principal
compute fixed 1% fee
compute provider Quote

add active Quote gain
decrease available_supply
update active P / scale / generation
```

Transfer:

```text
Asset Vault → taker
taker full Quote Principal → this Tick's Quote Proceeds Vault
    provider net Quote → provider proceeds reserve
    Quote fee → accrued_quote_protocol_fees in the same vault
```

Exit is untouched.

---

# 19. collect instruction

One settlement step.

Synchronize active and Exit snapshots.

Transfer:

```text
Asset Vault:
    time-weighted collectible active Yield
    Exit Asset principal (fully collectible)
    time-weighted collectible Exit Yield

Quote Proceeds Vault:
    active Quote
    Exit Quote
```

```text
elapsed = min(Clock.unix_timestamp - timestamp, duration_days * SECONDS_PER_DAY)
active_yield_out = floor(owed_active_yield_asset * elapsed / duration_seconds)
exit_yield_out = floor(owed_exit_yield_asset * elapsed / duration_seconds)
```

Clear only paid Yield; retain the remainder. Clear fully paid Exit Asset and Quote claims. Reset `timestamp = Clock.unix_timestamp` on every successful Collect, including zero-value calls. Repeated Collect at the same timestamp MUST NOT release additional Yield.

No fee.

Principal snapshots remain active if unresolved principal remains.

---

# 20. Scale transition mechanics

When a non-empty depletion would push P below the safe precision threshold:

1. persist the scale being left;
2. multiply the P numerator by `SCALE_FACTOR`;
3. increment scale;
4. repeat if required;
5. new current-scale sums start at zero.

A single instruction may cross multiple scales.

The number of scale transitions per action MUST be bounded by canonical arithmetic limits.

The payer for new ScaleState PDAs receives no rights.

The SDK preview MUST surface any additional rent/account creation cost.

---

# 21. Provider synchronization account bundle

Provider sync remains bounded.

The client supplies canonical historical scale states required by the provider snapshot.

The program derives every expected PDA and rejects:

```text
substitution
wrong generation
wrong scale
wrong order
extra non-canonical protocol state
```

No provider enumeration.

No generation walk.

The maximum historical scale bundle is a protocol constant shared with EVM and SDK.

Provider gains MUST use the exact bounded cross-scale recurrence from `spec/protocol.md` §9.

The Solana implementation MUST preserve the same exact remainder across scales, then carry independent X36 sub-raw gain fractions across provider checkpoints for Active Yield/Quote and Exit Asset/Yield/Quote. Do not mix fractions with different snapshot denominators. Match the EVM/reference SDK integer result and the canonical `N / 1e36` raw-unit checkpoint dust bound in `spec/protocol.md` §9.

The program MUST retain a positive `principal_x36` snapshot even when `floor(principal_x36 / PRINCIPAL_PRECISION) == 0`.

---

ProviderPosition discovery / filtering MUST keep a provider Tick visible while any of:

```text
active principal_x36 > 0
Exit principal_x36 > 0
any owed_* > 0
unsynchronized historical gain exists
any fractional_gain_x36[i] > 0
```

A zero whole-raw preview MUST NOT make the position disappear.

Worst-case historical synchronization bundle per provider domain:

| State | ScaleState PDAs | Generation metadata |
|---|---:|---:|
| Current generation, maximum span | up to 8 historical ScaleState PDAs; current scale lives in Tick | 0 |
| Finalized historical generation, maximum span | up to 9 ScaleState PDAs (`k .. k+8`) | 1 |

Across Active + Exit, a stale provider may therefore require up to **18 ScaleState PDAs + 2 Generation metadata PDAs**, in addition to Tick, ProviderPosition, vault/token accounts, and any settlement accounts.

The SDK MUST derive this list canonically, preview any rent/account-creation requirement, and use versioned transactions / address lookup tables where needed by transaction-size constraints. Clients MUST NOT guess or truncate the account bundle.

# 22. Settlement account bundle

The one-position cursor model remains.

For a mature cursor Close, the transaction includes:

```text
cursor TermPosition
Quote Escrow Vault
Quote Proceeds Vault
Tick's accrued_quote_protocol_fees field (no additional fee PDA)

any ActiveScaleState required by scale transition
any ExitScaleState required by scale transition

ActiveGeneration metadata if active reaches zero
ExitGeneration metadata if Exit reaches zero
```

The bundle is canonical and simulation-derived.

If state changes make a different bundle necessary before inclusion, the transaction MUST fail and be rebuilt.

---

# 23. Fixed fees

```text
Swap  → floor(Quote Principal × 1%)
Close → frozen floor(Quote Principal × 1%)
Repay → floor(gross Asset Yield × 1%)
```

Principal is fee-free.

Collect is fee-free. Fees are accrued and claimed **per Tick and denomination**, not from a global multi-Tick vault: Asset fees remain in that Tick's Asset Vault, Quote fees in its Quote Proceeds Vault. `collect_protocol_fees(tick, denomination)` pays only the immutable recipient and cannot drain provider reserves. Claim failure affects only that claim.

---

# 24. Cross-chain parity

For equivalent representable inputs, EVM and Solana MUST match:

```text
Pair/direction semantics
Tick price
Quote Principal
Yield quote
elapsed Yield
fees

P updates
scale transitions
gain sums
provider compounded principal
provider realized gains
Yield vesting / Withdraw forfeiture / redistribution
Withdraw min-immediate-Asset and deadline semantics
per-Tick protocol-fee amounts and claimable backing, aggregated to equivalent per-mint economics

Exit split
maturity
settlement
```

Publish shared raw-unit golden vectors for directional price ticks, X36 forfeiture distribution, eligibility boundaries, vesting, Exit resolution and final reserve conservation.

---

# 25. Required Solana tests

Mirror EVM plus:

```text
PDA canonicalization
ScaleState creation
Generation metadata creation

multi-scale jump account bundle

missing historical scale account rejection
wrong scale/gen PDA rejection

fixed-size ProviderPosition filters

Token-2022 rejection matrix

exact vault solvency

transaction composition

cross-chain Product-Sum vectors
one provider timestamp per Tick; Supply and Collect reset it
same-timestamp Withdraw rejection
partial/full-term Collect and repeat Collect at same timestamp
partial/full Withdraw Yield release and post-withdrawal redistribution
Active entirely Working, no eligible other Active -> accrued Asset protocol fee
repeated partial Withdraw cannot reclaim forfeited Yield through residual Active
historical Yield collectible after Swap/Close and generation rollover
cross-chain vesting/forfeiture/rounding golden vectors
redistribution excludes withdrawing position; eligible recipients retain their vesting timestamps
exact-X36 redistribution with fractional eligible principal and eligibility boundaries
complete pool cleanup independently reconciles provider gains, precision dust, Tick reserves, fees and vault balances
independently calculated vesting/forfeiture timestamps and reserve reference state; never reuse contract outputs as expected values
both direction price ticks with decimal-adjusted reciprocal vectors; out-of-order Repay/Close and cursor terminal skips
passive provider across 9+ scale transitions
1-raw + 1-raw fractional-principal preservation
sub-raw provider snapshot retention
Max Withdraw preserves positive sub-raw principal_x36
fractional-only ProviderPosition stays discoverable and can combine carry with later gains
Withdraw minimum-immediate-output and deadline front-run protection
Close moves full escrowed Quote Principal into Quote Proceeds including accrued fee
blocked FEE_TO ATA causes fee-claim failure only, never settlement failure
multiple Ticks with the same mint retain independent fully backed fee claims
```

There is no upgrade authority in the final production deployment.
