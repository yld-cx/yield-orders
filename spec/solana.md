# yld.cx — Yield Orders Protocol

**Solana / Anchor Implementation Specification**
**Target:** Solana
**Version:** 0.1

---

# 1. Goal and parity

This specification maps the canonical Yield Orders v0.1 economics to Solana without changing the protocol model.

The economic invariant remains:

> **Asset moves. Quote locks.**

The canonical **economic** actions are:

```text
supply
withdraw
collect
use
repay
swap
close
```

A Use receives Asset and locks Quote only. The full-term Yield quote is frozen at opening in **Asset units**. No Yield is paid upfront. If the user Repays before maturity, Yield is prorated by elapsed time with a **1-second minimum billable interval** and paid in Asset together with the returned Asset principal. A same-timestamp Repay therefore pays 1 second of Yield rather than zero. If the user does not Repay, permissionless Close settles the predefined Quote Swap and no Asset Yield is owed.

Supplier liquidity revolves by default. `withdraw` burns a selected fraction of the supplier's **active shares**. Its proportional Available part leaves immediately; its proportional active Working claim is redirected into an internal **Exit settlement pool**.

The active market remains open while Exit exists: Supply, Use and immediate Swap continue against active liquidity. Repay and Close resolve Exit Working with priority. Repay Yield follows the same principal split, so Exit shares receive Asset Yield when Repay resolution is allocated to Exit.

Permissionless infrastructure instructions `initialize_pair`, `initialize_tick`, and `settle` create canonical market accounts or advance deterministic Tick settlement. They confer no economic privilege and are not user-facing Yield Order actions.

The Solana program MUST produce the same economic result as the EVM implementation for equivalent Pair, Direction, Price, Duration, amounts, timestamps and ordering, subject only to deterministic chain-specific integer representation and transaction mechanics.

No Solana-specific feature may alter the economic meaning of a Yield Order.

# 2. Runtime model

Recommended implementation:

```text
Rust
Anchor
SPL Token
Token-2022 where supported extensions preserve deterministic accounting
```

The program uses Program Derived Addresses (PDAs) instead of EVM mappings and dedicated SPL token vaults instead of contract-held ERC-20 balances.

Solana transaction composition replaces EVM Multicall: multiple independent program instructions may be included in one atomic transaction where account/compute/transaction-size limits permit.

---

# 3. Canonical accounts

## 3.1 Immutable deployment constants

Production v0.1 has **no global writable protocol account** and no mutable global counters.

The production program binary fixes:

```text
BPS               = 10_000
Q128              = 2^128
PROTOCOL_FEE_BPS = 100   // 1%
MAX_SHARES        = Q128 - 1 // u128::MAX
FEE_TO            = deployment-specific Pubkey
MIN_DAILY_BPS     = 1     // 0.01% / day
MAX_DAILY_BPS     = 100   // 1.00% / day
CURVE_EXPONENT    = 3
MIN_BILLABLE_SECONDS = 1
```

There is no writable `GlobalConfig`, no `next_pair_id`, and no **global** `next_position_id`. Position sequencing is local to each already-writable Tick through `next_position_seq`.

There is no upgrade authority in the final immutable deployment.

## 3.2 Canonical scalar and wide-integer encoding

Frozen encodings:

```text
direction          u8
price_tick         i32 little-endian
duration_days      u64 little-endian
generation_id      u64 little-endian
exit_generation_id u64 little-endian
position_seq       u64 little-endian
Pubkey / mint      raw 32 bytes
```

`mint0 < mint1` means unsigned lexicographic comparison of raw 32-byte Pubkeys. Numeric PDA seeds use the little-endian encodings above.

Canonical stored wide integer:

```text
U256LE = [u64; 4]
```

with limb 0 least-significant and each limb Borsh-serialized little-endian.

Unless stated otherwise, token transfer/principal/reserve amounts are `u64`, timestamps are `i64`, status/direction are `u8`, and generations/position sequences/durations are `u64`.

The following are `U256LE`:

```text
ProviderPosition.shares
ProviderPosition.exit_shares
Tick.total_shares
Tick.total_exit_shares
price_x128

yield_asset_growth_x128
swap_quote_growth_x128
exit_asset_growth_x128
exit_yield_asset_growth_x128
exit_quote_growth_x128

all corresponding provider checkpoints
all finalized active/Exit growth snapshots
```

Any overflow, underflow, or narrowing truncation MUST revert.

## 3.3 Pair PDA

Canonical unordered mint combination.

Seeds:

```text
["pair", mint0, mint1]
```

where `mint0 < mint1` uses the frozen raw-byte comparison.

Stores:

```text
mint0: Pubkey
mint1: Pubkey
bump: u8
```

`initialize_pair(mint_a, mint_b)` is permissionless. It rejects identical mints, canonicalizes ordering, validates supported token programs/extensions, initializes only the canonical Pair PDA, and grants no creator rights.

The SDK `getPair(mintA, mintB)` canonicalizes, derives and fetches this PDA. Reversed input MUST resolve identically. Pair discovery across all markets remains an indexer/client concern.

## 3.4 Tick PDA

Seeds:

```text
["tick", pair, direction:u8, price_tick:i32_le, duration_days:u64_le]
```

Stores fixed-size fields:

```text
pair: Pubkey
direction: u8
asset_mint: Pubkey
quote_mint: Pubkey
price_tick: i32
price_x128: U256LE
duration_days: u64

// active + total Working state
available_supply: u64
working_supply: u64
exit_working: u64

total_shares: U256LE
yield_asset_growth_x128: U256LE
swap_quote_growth_x128: U256LE
generation: u64

// Exit settlement state
total_exit_shares: U256LE
exit_asset_growth_x128: U256LE
exit_yield_asset_growth_x128: U256LE
exit_quote_growth_x128: U256LE
exit_generation: u64

// funded reserves
exit_asset_reserve: u64
yield_asset_reserve: u64
exit_quote_reserve: u64

// deterministic Term Position order
next_position_seq: u64
settle_cursor: u64

bump: u8
```

Derived active values are not stored separately:

```text
active_working   = working_supply - exit_working
active_principal = available_supply + active_working
```

`initialize_tick(...)` validates Pair/direction/price/duration/token policy, stores canonical `price_x128`, initializes every active/Exit/reserve/cursor field to zero, and creates the three Tick vaults in §4.

## 3.5 GenerationState PDA

Immutable snapshot of an exhausted **active** generation.

Seeds:

```text
["generation", tick, generation_id:u64_le]
```

Stores:

```text
tick: Pubkey
generation_id: u64
final_yield_asset_growth_x128: U256LE
final_swap_quote_growth_x128: U256LE
bump: u8
```

A Swap, Close, or Repay that exhausts active principal while active shares still exist MUST initialize the current GenerationState in the same instruction after the final active growth increment.

A stale ProviderPosition synchronizes exactly its stored active generation snapshot in O(1).

## 3.6 ExitGenerationState PDA

Immutable snapshot of an exhausted **Exit** generation.

Seeds:

```text
["exit_generation", tick, exit_generation_id:u64_le]
```

Stores:

```text
tick: Pubkey
exit_generation_id: u64
final_exit_asset_growth_x128: U256LE
final_exit_yield_asset_growth_x128: U256LE
final_exit_quote_growth_x128: U256LE
bump: u8
```

A Repay or Close that reduces `exit_working` to zero while Exit shares still exist MUST initialize the current ExitGenerationState after the final Exit growth increment and before resetting current Exit-share/growth state.

A stale provider synchronizes exactly its stored Exit generation snapshot in O(1).

Active and Exit generation snapshots are independent and permanent in v0.1.

## 3.7 ProviderPosition PDA

One mutable provider position per:

```text
supplier × tick
```

Seeds:

```text
["provider", tick, supplier]
```

Stores:

```text
supplier: Pubkey
tick: Pubkey

// active
active_generation: u64
shares: U256LE
yield_asset_growth_last_x128: U256LE
swap_quote_growth_last_x128: U256LE
owed_yield_asset: u64
owed_swap_quote: u64

// Exit
exit_generation: u64
exit_shares: U256LE
exit_asset_growth_last_x128: U256LE
exit_yield_asset_growth_last_x128: U256LE
exit_quote_growth_last_x128: U256LE
owed_exit_asset: u64
owed_exit_yield_asset: u64
owed_exit_quote: u64

last_supply_slot: u64
bump: u8
```

On first initialization, set both generation IDs to the current Tick generation IDs, all shares/owed balances to zero, and every growth checkpoint to the corresponding current Tick accumulator.

`ProviderPosition` is permanent in v0.1 and MUST NOT be closed. Growth checkpoints and previously funded claims remain synchronized across generations.

## 3.8 TermPosition PDA

Permanent Use position.

Each Tick assigns a monotonically increasing local `position_seq: u64`.

The client supplies the expected current sequence and the program requires:

```text
position_seq == tick.next_position_seq
```

Seeds:

```text
["position", tick, position_seq:u64_le]
```

Stores:

```text
position_seq: u64
tick: Pubkey
user: Pubkey

asset_amount: u64
quote_principal: u64
full_term_yield_asset: u64
close_fee: u64

opened_at: i64
maturity: i64
status: u8 // 0 ACTIVE, 1 REPAID, 2 CLOSED
bump: u8
```

On successful Use:

```text
position_seq = tick.next_position_seq
tick.next_position_seq = checked_add(1)
```

The Position PDA is the canonical Solana position identifier. Same-Tick Uses already serialize on the writable Tick account; the local sequence introduces no additional cross-Tick contention.

TermPosition PDAs remain readable after settlement and are not closed in v0.1.

# 4. Token vaults

Each Tick uses three canonical token-account PDAs:

```text
Asset Vault          ["asset_vault", tick]
Quote Escrow Vault   ["quote_escrow", tick]
Quote Proceeds Vault ["quote_proceeds", tick]
```

Their authority is the Tick PDA. Asset Vault mint is `asset_mint`; both Quote vaults use `quote_mint`.

External unsolicited transfers create no shares or claims and are treated as unaccounted donation/dust.

## 4.1 Asset Vault

The Asset Vault holds all accounted Asset that is physically inside the program:

```text
active Available Asset
funded but uncollected Exit Asset principal
funded but uncollected net Asset Yield
```

`working_supply` is Asset outside the vault in ACTIVE Uses.

Required solvency:

```text
asset_vault.amount
    >= available_supply
     + exit_asset_reserve
     + yield_asset_reserve
```

These are distinct accounting buckets:

- `available_supply` may be consumed by Use/Swap.
- `exit_asset_reserve` is already-resolved Exit principal and MUST never be reused.
- `yield_asset_reserve` backs net active + Exit Yield claims funded by Repay after the 1% Yield fee is transferred to `FEE_TO`; it MUST never be reused.

Any physical balance above the accounted sum is donation/dust.

## 4.2 Quote Escrow Vault

Holds Quote Principal locked by ACTIVE Term Positions.

No Yield is deposited here.

Required solvency:

```text
quote_escrow_vault.amount >= sum(quote_principal of ACTIVE positions for the tick)
```

The program proves this by instruction conservation rather than iteration.

## 4.3 Quote Proceeds Vault

Holds funded Quote claims:

```text
active net Immediate Swap proceeds
active net Close proceeds
Exit net Close proceeds
```

It does **not** hold Yield; Yield is Asset-denominated in v0.1.

Required solvency includes all funded active Quote claims plus:

```text
exit_quote_reserve
```

Close/Swap protocol fees leave Quote custody in the fee-bearing instruction and go directly to the validated Quote account owned by immutable `FEE_TO`.

# 5. Token compatibility

Core v0.1 supports:

```text
Legacy SPL Token mints
Token-2022 mints only under the frozen allowlist below
```

### Token-2022 mint-extension allowlist

Accepted mint extensions in v0.1:

```text
none
MetadataPointer
TokenMetadata
```

All other mint extensions are rejected in v0.1 unless a future protocol version explicitly adds them. In particular the core MUST reject extensions that can change transfer amount, authority, transferability, visibility, account state, or execute transfer-time logic, including transfer fees, transfer hooks, confidential-transfer features, permanent delegate, interest-bearing semantics, non-transferable semantics, default frozen/account-state behavior, pausable behavior, and equivalent future extensions.

### Token-account extension allowlist

Protocol/user token accounts may use:

```text
no Token-2022 account extension
ImmutableOwner
```

Other token-account extensions are rejected in v0.1.

Every token account supplied to an instruction MUST be validated for:

```text
correct mint
correct owner/authority
correct PDA derivation where protocol-owned
correct token program matching the mint
allowed extension set
```

Every transfer path MUST verify that the exact canonical raw token amount was debited/credited. Unsupported behavior MUST fail before economic state is committed.

---

# 6. Shared tick economics

For each Tick:

```text
A  = available_supply
W  = working_supply
E  = exit_working
Wa = W - E
Ca = A + Wa
S  = total_shares
X  = total_exit_shares
```

Active shares own `Ca`. Exit shares own the unresolved Exit Working pool `E` plus Exit growth already created for their generation.

Required bounds:

```text
0 <= E <= W
(Ca == 0) == (S == 0)
(E  == 0) == (X == 0)
X >= E whenever E > 0
```

Supply, Use and Swap operate only on the active pool. Use never changes `E`; Swap never touches Exit. Withdraw burns active shares and redirects only their proportional `Wa` into Exit. Repay/Close resolve Exit first.

Yield is always denominated in **Asset**. A Use freezes its full-term Asset Yield quote but funds no Yield at opening. If the Use Repays, actual Asset Yield is prorated by elapsed time and funded then. Repay Yield follows the same Exit/active principal split as the returned Asset.

This gives a non-blocking market while preserving the two clear outcomes:

```text
Repay → Asset principal + accrued Asset Yield
Close → Quote at the posted price
```

# 7. Price and Yield pricing

## 7.1 Canonical tick price

`price_tick` is signed `i32` constrained to:

```text
-887272 <= price_tick <= 887272
```

It represents raw Quote units per raw Asset unit.

```text
sqrt_price_x96 = TickMath.getSqrtRatioAtTick(price_tick)
price_x128      = floor(sqrt_price_x96^2 / 2^64)
quote_principal = ceil(asset_amount * price_x128 / 2^128)
```

All wide arithmetic is checked and MUST match EVM golden vectors. `quote_principal` must be non-zero and fit `u64`.

Human display conversion belongs to the product layer. No oracle participates.

## 7.2 Yield curve

Yield uses **active liquidity only**:

```text
Wa = working_supply - exit_working
Ca = available_supply + Wa
u  = Wa / Ca
```

The theoretical curve is:

```text
MIN_DAILY_BPS  = 1    // 0.01% / day
MAX_DAILY_BPS  = 100  // 1.00% / day
CURVE_EXPONENT = 3
```

For Use amount `x`:

```text
u0 = Wa / Ca
u1 = (Wa + x) / Ca
```

and:

\[
I(u_0,u_1)=Min(u_1-u_0)+\frac{Max-Min}{4}(u_1^4-u_0^4)
\]

For duration `D` days:

\[
FullTermYieldAsset=Ca \times D \times I(u_0,u_1)
\]

### Canonical integer algorithm

Solana MUST execute the exact same normative Q128 sequence as EVM:

```text
Q128 = 2^128
minBps = 1
maxBps = 100

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

full_term_yield_asset = ceil(
    Ca * durationCurveNumerator / curveDenominator
)
```

The Q128 utilization calculations and both `pow4X128` multiplications round DOWN exactly where shown. The final full-term Yield division rounds UP. No other intermediate division is permitted. Rust MUST use checked `U256`/wider intermediates sufficient to match the EVM golden vectors exactly; narrowing to `u64` occurs only after the final result is proven to fit.

If the canonical Yield result is zero, Use for that amount rejects. Swap has no Yield calculation. The SDK uses the same algorithm for Use previews. Display-only marginal `Current Yield` may evaluate `Min + (Max-Min)u^3`, but `full_term_yield_asset` is authoritative for a concrete Use amount.

Canonical conversions match EVM:

```text
Quote Principal                    → UP
Q128 utilization / powers          → DOWN at the exact steps above
Full-Term Yield Asset              → UP only at final formula
Repay billable-time Yield Asset    → UP
Swap/Close fee on Quote Principal  → DOWN
Repay fee on gross Asset Yield     → DOWN once at Repay
```

At Use, `full_term_yield_asset` is frozen and no Yield is transferred.

At Repay:

```text
term_seconds     = maturity - opened_at
elapsed          = Clock.unix_timestamp - opened_at
billable_elapsed = max(MIN_BILLABLE_SECONDS, elapsed)
```

with `0 <= elapsed < term_seconds`, and:

```text
gross_yield_asset =
    ceil(full_term_yield_asset * billable_elapsed / term_seconds)
```

Require:

```text
gross_yield_asset <= full_term_yield_asset
```

The Yield curve prices Asset rental only. The single protocol fee is `floor(fee_base * PROTOCOL_FEE_BPS / BPS)`: Quote Principal for Immediate Swap or Use→Close, and accrued gross Asset Yield for Use→Repay. Returned Asset principal and the Quote refund on Repay have no fee. There is no minimum fee; raw bases `1, 99, 100, 101, 10_000` produce fees `0, 0, 1, 1, 100` respectively.

Canonical outcomes: Use→Repay gives providers all Asset principal and 99%+ of accrued Yield, pays 1% of Yield to `FEE_TO` in Asset, and refunds all Quote Principal to the taker. Immediate Swap and Use→Close pay 1% of Quote Principal to `FEE_TO` in Quote and give providers 99%+ of Quote Principal. `99%+` accounts for fee rounding down.

Exit Working MUST NOT affect active utilization or the full-term Yield quote of a new Use.

# 8. Growth accounting

Two share domains and three economic growth streams are required.

Active:

```text
yield_asset_growth_x128
swap_quote_growth_x128
```

Provider synchronization:

```text
owed_yield_asset += shares * (yield_asset_growth_x128 - yield_asset_growth_last_x128) / Q128
owed_swap_quote  += shares * (swap_quote_growth_x128 - swap_quote_growth_last_x128) / Q128
```

Exit:

```text
exit_asset_growth_x128
exit_yield_asset_growth_x128
exit_quote_growth_x128
```

Provider synchronization:

```text
owed_exit_asset += exit_shares * (exit_asset_growth_x128 - exit_asset_growth_last_x128) / Q128
owed_exit_yield_asset += exit_shares * (exit_yield_asset_growth_x128 - exit_yield_asset_growth_last_x128) / Q128
owed_exit_quote += exit_shares * (exit_quote_growth_x128 - exit_quote_growth_last_x128) / Q128
```

New active shares checkpoint active growth before minting. New Exit shares checkpoint all Exit growth before minting.

No Yield growth is created at Use opening.

Repay may create:

```text
Exit Asset principal growth
Exit Asset Yield growth
active Asset Yield growth
```

Close may create:

```text
Exit Quote growth
active Quote growth
```

Growth increments and realization round down. A non-zero growth distribution MUST have the corresponding non-zero share denominator. Active and Exit growth never cross-distribute.

# 9. supply instruction

Inputs:

```text
tick
asset_amount: u64
referrer
```

Perform one settlement step, then synchronize the provider's active and Exit accounting as required.

Define:

```text
Ca = available_supply + working_supply - exit_working
S = total_shares
```

If empty:

```text
S == 0
Ca == 0
shares_minted = asset_amount
```

otherwise:

\[
shares_minted=\lfloor asset_amount \times S/Ca \rfloor
\]

Require `asset_amount > 0`, `(S == 0) == (Ca == 0)`, `shares_minted > 0`, and `shares_minted <= MAX_SHARES - total_shares`. Apply the same explicit capacity check in Supply preview and execution.

Transfer exact Asset into Asset Vault, then:

```text
available_supply += asset_amount
total_shares += shares_minted
provider.shares += shares_minted
provider.last_supply_slot = current_slot
```

Supply does not change Working, Exit, or Yield reserves. It is allowed while Exit exists and joins only active principal.

# 10. withdraw instruction

Canonical protocol input:

```text
tick
shares_to_withdraw: U256LE
```

Product UX exposes percentages / Max and converts them to active shares; users do not enter raw share units.

Perform one settlement step, then synchronize both active and Exit provider growth.

Pre-withdraw:

```text
A  = available_supply
Wa = working_supply - exit_working
Ca = A + Wa
S  = total_shares
x  = shares_to_withdraw
```

Require:

```text
x > 0
x <= provider.shares
S > 0
Ca > 0
current_slot > provider.last_supply_slot
```

Compute:

\[
principal_claim=\lfloor x \times Ca/S \rfloor
\]

\[
available_out=\lfloor x \times A/S \rfloor
\]

```text
working_to_exit = principal_claim - available_out
```

Normally require non-zero `principal_claim`, plus `available_out <= A` and `working_to_exit <= Wa`.

The only exception is a Max/full-provider-share withdrawal where `x == provider.shares` and `principal_claim == 0` after rounding. That call MAY burn the provider's remaining sub-unit active-share dust with `available_out = 0` and `working_to_exit = 0`. Partial zero-principal withdrawals MUST reject.

Burn active shares immediately:

```text
available_supply -= available_out
total_shares -= x
provider.shares -= x
```

Redirect Working ownership without changing `working_supply`:

```text
exit_working += working_to_exit
```

If `working_to_exit > 0`, mint Exit shares against the pre-add Exit pool:

```text
if pre_exit_working == 0:
    require pre_total_exit_shares == 0
    exit_shares_minted = working_to_exit
else:
    exit_shares_minted = floor(
        working_to_exit * pre_total_exit_shares / pre_exit_working
    )
    require exit_shares_minted > 0
```

Require `exit_shares_minted > 0` and `exit_shares_minted <= MAX_SHARES - tick.total_exit_shares` in both Withdraw preview and execution.

Then:

```text
provider.exit_shares += exit_shares_minted
tick.total_exit_shares += exit_shares_minted
```

New Exit shares checkpoint current Exit principal/Yield/Quote growth and inherit no historical claims.

CPI transfer `available_out` from Asset Vault to supplier. `working_supply` remains unchanged.

Post-state invariants:

```text
exit_working <= working_supply
(active_principal == 0) == (total_shares == 0)
(exit_working == 0) == (total_exit_shares == 0)
total_exit_shares >= exit_working whenever exit_working > 0

asset_vault.amount
    >= available_supply
     + exit_asset_reserve
     + yield_asset_reserve
```

A full active withdrawal may leave `provider.shares == 0` and `provider.exit_shares > 0`.

Exit shares do not participate in new Use opening. If later Repay resolution is allocated to Exit, they receive both the resolved Asset principal and the corresponding Asset Yield.

Exit is one-way in v0.1: there is no Exit→Active conversion; re-entry uses a new Supply.

The one-slot Supply→Withdraw cooldown remains mandatory.

# 11. use instruction

Inputs include:

```text
tick
asset_amount: u64
max_full_term_yield_asset: u64
deadline: i64
position_seq: u64
referrer
```

Perform one settlement step first.

Define active state:

```text
Wa = working_supply - exit_working
Ca = available_supply + Wa
```

Require:

```text
asset_amount > 0
asset_amount <= available_supply
Ca > 0
total_shares > 0
Clock.unix_timestamp <= deadline
quote_principal > 0
full_term_yield_asset > 0
full_term_yield_asset <= max_full_term_yield_asset
position_seq == tick.next_position_seq
```

Compute:

```text
close_fee =
    floor(quote_principal * PROTOCOL_FEE_BPS / BPS)
```

Require:

```text
close_fee <= quote_principal
```

Exit never blocks Use.

Execution:

```text
available_supply -= asset_amount
working_supply += asset_amount
exit_working unchanged

Asset Vault → user Asset account
Quote user account → Quote Escrow Vault
```

No Yield is transferred and no Yield growth is created at Use opening.

Create `PDA(["position", tick, position_seq])`, storing:

```text
asset_amount
quote_principal
full_term_yield_asset
close_fee
opened_at
maturity
status = ACTIVE
```

then increment `next_position_seq` with checked arithmetic.

# 12. repay instruction

Only the Term Position user may Repay before maturity. v0.1 is full repayment.

Canonical inputs include:

```text
position
max_yield_asset: u64
```

Apply the settlement hook unless this Position is the current cursor entry.

Let:

```text
x = position.asset_amount
term_seconds = position.maturity - position.opened_at
elapsed = Clock.unix_timestamp - position.opened_at
billable_elapsed = max(MIN_BILLABLE_SECONDS, elapsed)

gross_yield_asset =
    ceil(position.full_term_yield_asset * billable_elapsed / term_seconds)
```

Require:

```text
0 <= elapsed < term_seconds
gross_yield_asset <= position.full_term_yield_asset
gross_yield_asset <= max_yield_asset
```

Principal resolution:

```text
exit_fill = min(x, exit_working)
active_return = x - exit_fill
```

Yield split:

```text
yield_fee_asset = floor(gross_yield_asset * PROTOCOL_FEE_BPS / BPS)
net_yield_asset = gross_yield_asset - yield_fee_asset
exit_yield_asset = floor(net_yield_asset * exit_fill / x)
active_yield_asset = net_yield_asset - exit_yield_asset
```

Execution:

```text
user Asset account → Asset Vault:
    x + gross_yield_asset

working_supply -= x
exit_working -= exit_fill
available_supply += active_return

Quote Escrow Vault → user Quote account:
    quote_principal

status = REPAID
```

Funded accounting:

```text
if exit_fill > 0:
    exit_asset_reserve += exit_fill
    exit_asset_growth_x128 += exit_fill * Q128 / total_exit_shares

if net_yield_asset > 0:
    yield_asset_reserve += net_yield_asset

FEE_TO Asset ATA receives yield_fee_asset in Repay

if exit_yield_asset > 0:
    exit_yield_asset_growth_x128 += exit_yield_asset * Q128 / total_exit_shares

if active_yield_asset > 0:
    yield_asset_growth_x128 += active_yield_asset * Q128 / total_shares
```

Required denominator rules:

```text
exit_fill > 0 or exit_yield_asset > 0 → total_exit_shares > 0
active_yield_asset > 0               → total_shares > 0
total_shares == 0                    → active_return == 0
                                      and active_yield_asset == 0
```

Repay sends the 1% Yield fee directly to the validated `FEE_TO` Asset ATA; only net Yield enters provider growth and reserve. Asset principal and the full Quote refund are fee-free.

If `exit_working` becomes zero, finalize the Exit generation atomically after final Exit principal/Yield growth.

If active principal becomes zero while active shares still exist, finalize the active generation after final active Yield growth.

If this Position is the cursor entry after any pre-step, increment `settle_cursor` exactly once.

# 13. close instruction

Permissionless when:

```text
status == ACTIVE
Clock.unix_timestamp >= maturity
```

Apply the settlement hook unless this Position is the current cursor entry.

Close is the predefined Swap outcome. The Use user keeps the Asset and pays no Asset Yield.

Use the `close_fee` frozen in the Position at Use opening.

Compute:

```text
provider_swap_proceeds = quote_principal - close_fee
x = asset_amount
exit_fill = min(x, exit_working)
active_fill = x - exit_fill

exit_quote =
    floor(provider_swap_proceeds * exit_fill / x)

active_quote =
    provider_swap_proceeds - exit_quote
```

Execution:

```text
working_supply -= x
exit_working -= exit_fill

Quote Escrow Vault → FEE_TO Quote account:
    close_fee

status = CLOSED
```

Route net Quote:

```text
exit_quote   → Quote Proceeds Vault
active_quote → Quote Proceeds Vault
```

Accounting/growth:

```text
if exit_quote > 0:
    exit_quote_reserve += exit_quote
    exit_quote_growth_x128 += exit_quote * Q128 / total_exit_shares

if active_quote > 0:
    swap_quote_growth_x128 += active_quote * Q128 / total_shares
```

A non-zero Exit distribution requires `total_exit_shares > 0`; a non-zero active distribution requires `total_shares > 0`. In particular, `total_shares == 0` MUST imply `active_quote == 0`.

Close creates no Asset Yield growth.

Finalize Exit and/or active generations if their respective principal reaches zero with shares still live. Both may finalize in one Close.

No oracle is used.

If this Position is the cursor entry after any pre-step, increment `settle_cursor` exactly once.

# 14. swap instruction

Immediate Swap accepts the predefined Tick price with no Term Position.

Inputs:

```text
tick
asset_amount: u64
max_quote_in: u64
deadline: i64
referrer
```

Perform one settlement step first.

Require:

```text
asset_amount > 0
asset_amount <= available_supply
active_principal > 0
total_shares > 0
Clock.unix_timestamp <= deadline
```

Exit never blocks Swap.

Compute Quote Principal.

Compute the fee from Quote Principal alone, independent of the Yield curve, duration and utilization:

```text
swap_fee = floor(quote_principal * PROTOCOL_FEE_BPS / BPS)
provider_swap_proceeds = quote_principal - swap_fee
quote_principal <= max_quote_in
```

The same Quote Principal produces the same Immediate Swap fee and frozen Close fee.

Execution:

```text
available_supply -= asset_amount
Asset Vault → taker
FEE_TO Quote account receives swap_fee
Quote Proceeds Vault receives provider_swap_proceeds
swap_quote_growth_x128 += provider_swap_proceeds * Q128 / total_shares
```

`exit_working` and Exit growth/reserves remain unchanged.

If active principal is exhausted while active shares remain, finalize the active generation atomically.

# 15. collect instruction

`collect` is a supplier action. It performs one settlement step, synchronizes the supplier's active and Exit generation/growth accounting, and transfers everything currently claimable.

Let:

```text
exit_asset = owed_exit_asset
active_yield_asset = owed_yield_asset
exit_yield_asset = owed_exit_yield_asset
exit_quote = owed_exit_quote
swap_quote = owed_swap_quote

total_asset_out = exit_asset + active_yield_asset + exit_yield_asset
total_quote_out = exit_quote + swap_quote
```

All Yield claims are already net of the fee paid at Repay. Collect transfers `total_asset_out` from the Asset Vault and `total_quote_out` from the Quote Proceeds Vault to the supplier. It clears the matching owed balances and reduces reserves by exactly the transferred amount. Collect calculates and charges no protocol fee. Splitting claims across Collect calls cannot change the Repay fee.

Collect may transfer both Asset and Quote. It does not require Exit to be fully resolved; current Exit shares may remain for future Repay/Close resolution.

`collect` is supplier-authorized in v0.1; it is not permissionless and cannot redirect another supplier's proceeds.

# 16. Active and Exit generation finalization

## 16.1 Active generation

Define:

```text
active_principal = available_supply + working_supply - exit_working
```

Invariant:

```text
(active_principal == 0) == (total_shares == 0)
```

If Swap, Close, or Repay makes active principal zero while active shares still exist, the instruction MUST initialize:

```text
["generation", tick, tick.generation]
```

after the final active Yield/Quote growth increment, storing:

```text
final_yield_asset_growth_x128
final_swap_quote_growth_x128
```

then:

```text
total_shares = 0
generation += 1
yield_asset_growth_x128 = 0
swap_quote_growth_x128 = 0
```

Do **not** zero `working_supply`, `exit_working`, or `yield_asset_reserve`: remaining Working may belong entirely to Exit and funded Yield claims may remain uncollected.

A Withdraw that directly burns the final active shares needs no GenerationState snapshot because no stale active shares remain.

## 16.2 Exit generation

Invariant:

```text
(exit_working == 0) == (total_exit_shares == 0)
total_exit_shares >= exit_working whenever exit_working > 0
```

If Repay or Close makes `exit_working == 0` while Exit shares still exist, after the final Exit principal/Yield/Quote growth increment initialize:

```text
["exit_generation", tick, tick.exit_generation]
```

and persist:

```text
final_exit_asset_growth_x128
final_exit_yield_asset_growth_x128
final_exit_quote_growth_x128
```

then:

```text
total_exit_shares = 0
exit_generation += 1
exit_asset_growth_x128 = 0
exit_yield_asset_growth_x128 = 0
exit_quote_growth_x128 = 0
```

Do not zero `exit_asset_reserve`, `yield_asset_reserve`, or `exit_quote_reserve`; they back funded but uncollected claims.

Stale provider synchronization reads exactly one stored active snapshot and/or one stored Exit snapshot. No generation walk is permitted.

Neither generation finalization changes `settle_cursor`.

# 17. Settlement cursor, duration and time

Each Tick stores:

```text
next_position_seq
settle_cursor
```

and each TermPosition PDA is directly derivable as:

```text
["position", tick, position_seq]
```

All Uses in one Tick share the same `duration_days`, so Position maturity is non-decreasing with sequence.

## 17.1 `settle` instruction

`settle` is permissionless and touches at most one cursor Position.

Conceptually:

```text
if settle_cursor == next_position_seq:
    no-op

position = PDA(["position", tick, settle_cursor])

if position.status != ACTIVE:
    settle_cursor += 1
    return

if Clock.unix_timestamp < position.maturity:
    return

Close(position) using canonical Close economics
settle_cursor += 1
```

The caller supplies the canonical current cursor Position account and any deterministic generation-snapshot / fee accounts required if that Close exhausts active or Exit state. The program derives and validates every PDA.

### 17.1.1 Canonical settlement account bundle

Each instruction appends a canonical **settlement remaining-account bundle** after its instruction-specific accounts:

```text
queue empty (settle_cursor == next_position_seq):
    []

cursor exists and is terminal OR ACTIVE but not mature:
    [cursor_position]

cursor is ACTIVE and mature:
    [cursor_position,
     quote_escrow_vault,
     quote_proceeds_vault,
     fee_to_quote_account,
     optional_active_generation_state,
     optional_exit_generation_state]
```

Rules:

- `cursor_position` MUST equal `PDA(["position", tick, settle_cursor])`.
- The two Quote vaults MUST be the canonical Tick vault PDAs.
- `fee_to_quote_account` MUST satisfy §18 even when `close_fee == 0`; a zero fee simply transfers nothing.
- `optional_active_generation_state` is present iff this Close exhausts active principal while current active shares are live, and MUST equal `PDA(["generation", tick, generation])`.
- `optional_exit_generation_state` is present iff this Close exhausts `exit_working` while current Exit shares are live, and MUST equal `PDA(["exit_generation", tick, exit_generation])`.
- If only one generation snapshot is required, it occupies the next account slot directly; clients insert no placeholders.
- The program MUST reject missing, extra, substituted, wrongly ordered, or non-canonical settlement accounts.

The SDK MUST construct this bundle from fresh Tick/cursor state and simulation. If state changes before inclusion such that a different bundle is required, the instruction MUST revert rather than silently skip or alter settlement.

## 17.2 Automatic one-step settlement hook

Every economic Tick instruction attempts one settlement step before its own mutation. `repay`/`close` skip the pre-step when targeting the current cursor Position and advance it themselves on success.

A step never loops. No hosted indexer is needed: the next Position PDA is derived directly from `settle_cursor`.

Because Exit does not block Use/Swap, normal successful market actions can both advance settlement and continue trading.

## 17.3 Duration, Yield time and maturity

`duration_days` is a positive whole integer with no semantic maximum.

At Use:

```text
opened_at = Clock.unix_timestamp
term_seconds = checked(duration_days * 86_400)
maturity = checked(opened_at + term_seconds)
```

At Repay:

```text
elapsed = Clock.unix_timestamp - opened_at
0 <= elapsed < term_seconds
billable_elapsed = max(MIN_BILLABLE_SECONDS, elapsed)
gross_yield_asset =
    ceil(full_term_yield_asset * billable_elapsed / term_seconds)
```

with `MIN_BILLABLE_SECONDS = 1`. A same-timestamp Repay is therefore billed as exactly 1 second. Because `full_term_yield_asset > 0`, every successful Repay owes at least 1 raw Asset unit under canonical round-up.

The Position's full-term Yield is frozen at opening. Only elapsed time changes the amount owed.

Before maturity only Repay is valid; at/after maturity only Close is valid. Unix time controls maturity/deadlines/Yield proration; slot is used only for Supply→Withdraw cooldown.

Exit is pooled priority settlement, not tagged Working. `exit_working` grows on Withdraw and shrinks on Repay/Close; new Uses never increase an existing Exit claim. Any later Repay/Close may satisfy Exit first, including resolution of a Use opened after the Withdraw. Later Withdraws may join the same live Exit generation, so v0.1 does not promise a per-provider Exit completion timestamp or term horizon.

# 18. Fee recipient

`FEE_TO` is a compile-time immutable production program constant.

Fee denomination depends on the economic source:

```text
Repay Yield fee  → Asset token
Close fee         → Quote token
Immediate Swap fee → Quote token
```

For any instruction that may transfer a protocol fee, the program MUST receive and validate the required FEE_TO token account(s).

Asset fee account requirements:

```text
owner == FEE_TO
mint  == tick.asset_mint
token program matches tick.asset_mint
```

Quote fee account requirements:

```text
owner == FEE_TO
mint  == tick.quote_mint
token program matches tick.quote_mint
```

Because automatic settlement may Close a mature Position inside another economic action, adapters MUST prepare the Quote FEE_TO account whenever the current cursor Position may be mature.

`repay` requires the Asset FEE_TO account when its accrued Yield fee is nonzero; `collect` requires no Asset fee account except one needed by its automatic Close settlement hook.

The program MUST NOT accept a caller-selected fee recipient.

There is no protocol-fee vault or later fee withdrawal instruction.

# 19. Referral attribution

`supply`, `use`, and `swap` accept an optional/referrer Pubkey for event attribution.

The referrer:

```text
is never stored
never changes economics
never receives onchain payout in v0.1
```

Events must include it when supplied.

---

# 20. Atomic composition

Solana natively allows multiple instructions in one transaction.

Product flows may compose:

```text
withdraw + collect
settle + collect
multiple independent Uses
multiple Swaps
Repay selected positions
Close selected positions
```

Each Use creates a separate TermPosition PDA using the Tick-local `position_seq`. For multiple Uses on the same Tick in one transaction, the client pre-reads `next_position_seq` and derives consecutive Position PDAs; each instruction validates the sequence it observes after the preceding instruction.

There is no program-level `batch_use`, `batch_close`, or `batch_settle` requirement.

The automatic one-step settlement hook is part of each economic instruction. Explicit `settle(tick)` remains available when callers want to advance the cursor without another economic action.

If account/compute/transaction-size limits prevent one transaction, the product must split the UX into multiple explicit transactions rather than changing protocol semantics.

---

# 21. Events

Canonical Anchor economic events:

```text
PairCreated(pair, mint0, mint1)

TickCreated(
  tick, pair, direction, price_tick, duration_days, asset_mint, quote_mint
)

Supplied(
  tick, supplier, asset_amount, shares_minted, referrer
)

Withdrawn(
  tick, supplier,
  shares_burned,
  principal_claim,
  available_asset_out,
  working_to_exit,
  exit_shares_minted
)

Collected(
  tick, supplier,
  exit_asset,
  active_yield_asset, exit_yield_asset,
  exit_quote, swap_quote,
  total_asset_out, total_quote_out
)

UseOpened(
  position, position_seq, tick, user,
  asset_amount, quote_principal,
  full_term_yield_asset, close_fee,
  opened_at, maturity, referrer
)

TermRepaid(
  position, tick, position_seq, user,
  asset_amount, quote_principal,
  gross_yield_asset, yield_fee_asset,
  exit_fill, active_return,
  exit_yield_asset, active_yield_asset
)

TermClosed(
  position, tick, position_seq, user, caller,
  asset_amount, quote_principal,
  close_fee, provider_swap_proceeds,
  exit_fill, exit_quote, active_quote
)

ImmediateSwap(
  tick, taker,
  asset_amount, quote_principal,
  swap_fee, provider_swap_proceeds,
  referrer
)

GenerationFinalized(
  tick, generation_id,
  final_yield_asset_growth_x128,
  final_swap_quote_growth_x128
)

ExitGenerationFinalized(
  tick, exit_generation_id,
  final_exit_asset_growth_x128,
  final_exit_yield_asset_growth_x128,
  final_exit_quote_growth_x128
)
```

`settle` emits no separate event when it only advances past an already-terminal Position; a settlement Close emits canonical `TermClosed`.

# 22. Client-facing reads

RPC/account-readable canonical state is required. An indexer is optional for discovery/search and MUST NOT be required for current state or Tick settlement.

The SDK MUST expose `getPair(mintA, mintB)` by canonical PDA derivation.

All discovery account structs are fixed-size. Publish stable GPA/memcmp offsets for at least:

```text
ProviderPosition.supplier
ProviderPosition.tick
ProviderPosition.active_generation
ProviderPosition.exit_generation

TermPosition.user
TermPosition.tick
TermPosition.status
```

SDK/domain reads must derive at least:

```text
available liquidity
active Working = working_supply - exit_working
Exit Working
active principal

current Yield rate from active liquidity

provider active shares
provider Exit shares
claimable Exit Asset principal
claimable active Asset Yield
claimable Exit Asset Yield
claimable Exit Quote
claimable active Swap Quote

Term Position:
  status
  maturity
  full_term_yield_asset
  current accrued Yield if Repay were submitted now

next_position_seq
settle_cursor
```

Canonical preview helpers MUST apply the same one-step automatic settlement hook as the corresponding instruction before quoting action-specific values. A mature cursor Close must be reflected in the returned state/quote.

Canonical preview helpers SHOULD expose the same fields as EVM:

```text
previewSupply
previewWithdraw
previewUse
previewRepay
previewSwap
previewCollect
```

The current settlement Position is derived directly as `PDA(["position", tick, settle_cursor])`; no indexer lookup is needed.

# 23. Rounding

Match EVM directions exactly:

```text
Supply active shares                    → DOWN
Withdraw active principal claim         → DOWN
Withdraw immediate Available component  → DOWN
Working→Exit component                  → claim - Available
Exit shares minted                      → DOWN

Quote Principal                         → UP
Full-Term Yield Asset                   → UP
Repay billable-time Yield Asset         → UP

Repay Yield allocated to Exit           → DOWN
Repay active Yield                      → exact remainder

Close net Quote allocated to Exit        → DOWN
Close active Quote                       → exact remainder

Active/Exit growth increments            → DOWN
Provider claims                          → DOWN
Protocol fees                            → DOWN
```

All token transfer/reserve amounts MUST fit `u64`. Shares/growth/price use U256LE with checked wider intermediates where required. No silent saturation or truncation.

Rounding MUST NOT create:

```text
gross_yield_asset > full_term_yield_asset
active_yield_asset > 0 with total_shares == 0
Exit growth with total_exit_shares == 0
unfunded Asset/Quote claims
```

# 24. Security invariants

The Anchor program MUST prove/test:

1. PDA ownership/seeds cannot be substituted.
2. There is no global writable protocol counter/account in economic paths.
3. Token programs/mints/accounts/extensions are validated on every CPI path.
4. `exit_working <= working_supply` always.
5. `active_principal = available_supply + working_supply - exit_working` never underflows.
6. `(active_principal == 0) == (total_shares == 0)`.
7. `(exit_working == 0) == (total_exit_shares == 0)` and `total_exit_shares >= exit_working` whenever `exit_working > 0`.
8. Asset Vault covers `available_supply + exit_asset_reserve + yield_asset_reserve`.
9. Quote Escrow covers every ACTIVE Position's Quote Principal by conservation.
10. Quote Proceeds covers funded active + Exit Quote claims.
11. Withdraw burns active shares and redirects only proportional active Working; it does not change `working_supply`.
12. Use creates no Yield transfer/growth and freezes `full_term_yield_asset`.
13. Exit Working never affects new Use Yield pricing.
14. Repay Yield uses frozen full-term Yield and `billable_elapsed = max(1, actual elapsed Unix seconds)` only.
15. `0 < gross_yield_asset <= full_term_yield_asset` for every successful Repay; same-timestamp Repay is billed as 1 second.
16. Repay returns Quote and transfers Asset principal + accrued Asset Yield.
17. Repay and Close consume Exit Working first.
18. Repay charges 1% on gross Yield and splits the remaining net Yield by the principal resolution ratio; Exit plus active Yield equals net Yield exactly.
19. Exit shares may receive Repay Yield but receive no new Use-opening or Immediate-Swap economics.
20. Close creates no Asset Yield.
21. Close net proceeds split exactly into Exit + active portions.
22. Use/Swap/Supply remain executable while Exit exists when ordinary active constraints pass.
23. Use and Swap never change `exit_working`.
24. Exit is pooled priority settlement, not tagged Working.
25. No provider iteration in Use/Repay/Swap/Close/settle/generation synchronization.
26. Active and Exit generation snapshots cannot leak historical claims.
27. Stale provider sync reads at most one stored snapshot per generation domain.
28. ProviderPosition is permanent in v0.1; growth checkpoints and funded claims persist across generations.
29. Position status changes exactly once and maturity boundary is strict.
30. `position_seq` is unique/monotonic per Tick.
31. `settle_cursor <= next_position_seq` always and never decreases.
32. Cursor Position PDA is directly derivable and `settle` touches at most one entry.
33. Automatic settlement uses canonical Close economics/events.
34. Generation finalization never resets/skips `settle_cursor`.
35. Same-slot Supply→Withdraw is rejected.
36. Yield protocol fee is charged once in Asset at Repay; provider growth is net.
37. Close/Swap protocol fees are charged in Quote only.
38. FEE_TO Asset/Quote accounts are validated against immutable `FEE_TO`.
39. Unsupported Token-2022 behavior cannot corrupt accounting.
40. All wide arithmetic/conversions are checked.
41. Growth with zero corresponding share denominator always reverts.
42. Cross-chain normalized economic outputs match EVM golden vectors.
43. The canonical Q128 Yield algorithm matches EVM at every intermediate/final rounding vector.
44. Collect charges no additional fee; partial claims do not change the Repay fee.
45. Active and Exit share supplies never exceed `MAX_SHARES`.
46. A zero-principal Withdraw is possible only for Max/full-provider-share dust burn and transfers no Asset/Exit ownership.
47. Automatic settlement rejects any missing/extra/substituted/out-of-order account bundle.
48. Swap rejects after `deadline` exactly like EVM.
49. `MAX_SHARES` is an internal precision bound only; approaching it cannot create an indefinite admission DoS for otherwise-valid Supply or Withdraw.
50. Any share normalization/compaction used to preserve precision is O(1), provider-loop-free, economically neutral within canonical dust bounds, preserves accrued claims and generation isolation, preserves Exit-first settlement priority, and remains cross-chain equivalent to EVM.
51. Repeated partial Swap/Close/Repay/Withdraw sequences cannot permanently poison a Tick or require unrelated suppliers to wait for an attacker-controlled Position to mature before Supply/Withdraw can make progress.

# 25. Required tests

## Share capacity, recoverability, and cross-chain vectors

`MAX_SHARES = Q128 - 1 = u128::MAX` is the canonical bound even if account fields use `U256LE`. Supply and Withdraw deliberately check both nonzero minted shares and remaining active/Exit capacity in preview and instruction paths. With `funded_amount >= 1` and `share_supply <= MAX_SHARES`, `floor(funded_amount * Q128 / share_supply) >= 1`. Active Yield/Quote and Exit Asset/Yield/Quote growth MUST be positive for every positive funded amount. Funded provider value must be solvent and claimable; token balance covering liability alone is insufficient.

Live `total_shares >= active_principal` and `total_exit_shares >= exit_working`, so minted shares are at least input principal units. Check input units against remaining capacity before full-precision mint multiplication, then check computed shares. Even very large inputs must produce an explicit capacity error.

Provider-level Q128 checkpoint floors can leave deterministic dust. For one distribution shared by `n` positive-share providers, dust is at most `min(funded_amount, n)` raw units: each provider floor loses less than one unit and growth rounding loses less than one unit. A positive economically meaningful distribution may never disappear because its entire accumulator increment rounded to zero.

`MAX_SHARES` is an internal precision-safety bound, not a user-facing admission limit. Capacity handling MUST preserve bounded progress for both active and Exit domains. An otherwise-valid Supply or Withdraw MUST NOT become indefinitely unavailable solely because internal share magnitude approaches `MAX_SHARES`.

Any canonical normalization, compaction, or admission mechanism used to maintain the bound MUST be O(1), provider-loop-free, preserve proportional ownership and already-funded claims, preserve active/Exit generation isolation and Exit-first settlement priority, and match EVM economic outputs within the canonical rounding rules. Adversarial repeated partial-conversion and partial-resolution sequences MUST prove both recoverability and liveness: they may not strand funded value, permanently poison a Tick, or require waiting for an attacker-controlled Position to mature before unrelated suppliers can Supply or Withdraw.

Matching EVM/Solana raw-unit vectors; the first column is Quote Principal for Swap/Close and gross Asset Yield for Repay:

| Quote Principal / Gross Yield | Swap Fee | Provider Swap Quote | Close Fee | Provider Close Quote | Yield Fee | Provider Net Yield |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0 | 1 | 0 | 1 | 0 | 1 |
| 99 | 0 | 99 | 0 | 99 | 0 | 99 |
| 100 | 1 | 99 | 1 | 99 | 1 | 99 |
| 101 | 1 | 100 | 1 | 100 | 1 | 100 |
| 10,000 | 100 | 9,900 | 100 | 9,900 | 100 | 9,900 |

Active and Exit domains accept `MAX_SHARES - 1 + 1 = MAX_SHARES` and reject any additional share mint. There is no protocol-fee vault or later fee withdrawal instruction.

Mirror the EVM suite plus Solana-specific cases:

```text
PDA seed canonicalization and little-endian encoding
U256LE round-trip vectors
initialize_pair canonical ordering / policy / duplicate rejection
initialize_tick active/Exit/reserve/cursor zero state and three vault creation
GenerationState and ExitGenerationState canonical PDA creation
new ProviderPosition checkpoints all active and Exit growth domains
no global writable counter
parallel Uses on unrelated Ticks
same-Tick position_seq assignment and consecutive pre-derivation
wrong/stale position_seq rejection
wrong cursor Position PDA rejection
wrong vault/mint/token-program/FEE_TO account rejection
Token / allowed Token-2022 paths and unsupported extension rejection
unsolicited vault donations create no claims

Supply/Withdraw percentage-share vectors matching EVM
mixed Available + active Working withdrawal
full active withdrawal leaving Exit shares
partial zero-principal Withdraw rejection
Max/full-share zero-principal dust burn
multiple Exit providers / same provider repeated withdrawal
Exit share minting after partial Exit resolution
Exit invariant total_exit_shares >= exit_working
Use/Swap/Supply while Exit exists

Use transfers Asset out and Quote Principal into escrow only
Use transfers no Yield
canonical Q128 Yield intermediate-rounding + full_term_yield_asset cross-chain vectors
Use max_full_term_yield_asset bound
Close fee frozen at Use opening

Repay same timestamp (= 1 billable second) / one-second / partial-day / near-maturity Yield vectors
Repay max_yield_asset bound
Repay rate unaffected by later utilization
Repay Asset principal + Yield exact transfer
Repay Exit-first principal allocation
Repay Exit/active Yield split
Repay yield_asset_reserve solvency
Repay with total_shares == 0 implies zero active Yield
newer Use Repay may satisfy older Exit

Close Exit-first proportional Quote split
Close creates no Asset Yield
Close uses stored close_fee
Close with total_shares == 0 requires active_quote == 0
simultaneous active + Exit generation finalization

Immediate Swap fixed 1% Quote fee vectors and Swap/Close symmetry
Swap while Exit exists

Collect Exit Asset only
Collect active Asset Yield only
Collect Exit Asset Yield only
Collect mixed active + Exit Yield
Collect Exit/active Quote
Yield fee paid in Asset at Repay; Collect does not charge again
Asset Vault reserve solvency after partial/full Collect
Use/Swap cannot spend exit_asset_reserve or yield_asset_reserve
Quote Proceeds reserve solvency

active generation restart while Exit continues
Exit generation restart while old claims remain uncollected
stale provider active/Exit snapshots

settle empty / terminal / non-mature / mature cursor cases
settle Close with active generation snapshot creation
settle Close with Exit generation snapshot creation
settle Close with both snapshot creations
settlement account omission/substitution/order/extra-account rejection
automatic settlement before economic instructions
settle cursor survives active/Exit generation rollovers

TickMath / price_x128 / Quote Principal golden vectors
full-term Asset Yield golden vectors
elapsed Repay Yield golden vectors
Exit principal/Yield/Quote growth golden vectors
Asset and Quote protocol fee vectors
Swap deadline exact-boundary / expired vectors
u64 transfer/reserve overflow rejection
U256 share/growth overflow rejection
fixed-layout GPA filters
cross-chain full action-sequence parity with EVM
```

# 26. Out of scope v0.1

```text
oracle pricing
liquidations
LTV
variable debt
resting Demand orders
provider FIFO matching
provider-specific Working-position assignment
provider Exit FIFO queues
Exit cancellation / Exit→Active conversion
upgradeable production program
governance economics
onchain referral rewards
protocol token
transferable LP/share token
external AMM deployment
offchain indexer dependency for settlement
automatic refinancing
portfolio margin
```

---

# 27. Canonical Solana mental model

```text
Supply   → Asset Vault / active Available

Use      → active Available → active Working
           Asset Vault → taker
           Quote → Quote Escrow Vault
           freeze full-term Asset Yield
           no Yield paid yet

Repay    → taker returns Asset principal + accrued Asset Yield
           Quote escrow → taker
           principal:
             ├─ Exit first → Exit Asset reserve/growth
             └─ excess → active Available
           Yield:
             ├─ Exit portion → Exit Yield growth
             └─ active portion → active Yield growth

Swap     → active Available → active provider Quote

Close    → Working resolves to net Quote
           no Asset Yield
           ├─ Exit first → Exit Quote reserve/growth
           └─ excess → active provider Quote growth

Withdraw → burn selected active shares
           ├─ proportional Available → supplier immediately
           └─ proportional active Working → Exit Working

Settle   → derive one Position from settle_cursor; close if mature

Collect  → Exit Asset principal
           + net Asset Yield
           + Exit Quote
           + active Swap/Close Quote
```

The active market never pauses merely because Exit exists. Exit is a pooled priority-settlement domain for Working ownership removed from active shares; it is not tagged inventory.

> **Return → Asset + Asset Yield. Swap → Quote.**

Yield is funded only on Repay and grows with elapsed Use time subject to the 1-second minimum billable interval. No oracle or hosted indexer is required for correctness.
