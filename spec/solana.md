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

Permissionless infrastructure instructions `initialize_pair` and `initialize_tick` create canonical market accounts and vaults. They confer no economic privilege and are not user-facing Yield Order actions.

The Solana program MUST produce the same economic result as the EVM implementation for equivalent Pair, Direction, Price, Duration, amounts and ordering, subject only to deterministic chain-specific integer representation and transaction mechanics.

No Solana-specific feature may alter the economic meaning of a Yield Order.

---

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
BPS            = 10_000
FEE_BPS        = 1_000 // 10%
FEE_TO         = deployment-specific Pubkey
MIN_DAILY_FEE  = 0.01%
MAX_DAILY_FEE  = 1.00%
CURVE_EXPONENT = 3
```

There is no writable `GlobalConfig` in the production economic path, no `next_pair_id`, and no `next_position_id`.

There is no upgrade authority in the final immutable deployment. Development/test deployments may use upgradeability before code freeze, but the production v0.1 program MUST be made immutable.

## 3.2 Canonical scalar and wide-integer encoding

All PDA derivation and fixed-size account layouts use the following frozen encodings:

```text
direction          u8
price_tick         i32 little-endian
duration_days      u64 little-endian
generation_id      u64 little-endian
position_nonce     u64 little-endian
Pubkey / mint      raw 32 bytes
```

`mint0 < mint1` means unsigned lexicographic comparison of the raw 32-byte Pubkeys. Seed prefixes such as `"pair"`, `"tick"`, `"generation"` and `"position"` are their literal UTF-8 bytes. Numeric PDA seeds use exactly the little-endian byte encoding above.

Canonical stored wide integer:

```text
U256LE = [u64; 4]
```

with limb 0 least-significant and each limb Borsh-serialized little-endian. Arithmetic conversions between `U256LE` and the implementation's checked wide-integer type MUST preserve the unsigned 256-bit value exactly.

Unless stated otherwise, token transfer amounts are `u64`, timestamps are `i64`, status/direction are `u8`, and generations/nonces/durations are `u64`.

Provider `shares`, Tick `total_shares`, all X128 growth accumulators/checkpoints, finalized generation growth, and canonical `price_x128` are **U256LE**. Shares are intentionally not `u64`: pro-rata share minting can produce more share units than Asset raw units when `S/C > 1`. Any U256 overflow MUST revert.

## 3.3 Pair PDA

Canonical unordered mint combination.

Seeds:

```text
["pair", mint0, mint1]
```

where `mint0 < mint1` uses the frozen raw-byte comparison above.

Stores fixed-size fields:

```text
mint0: Pubkey
mint1: Pubkey
bump: u8
```

`initialize_pair(mint_a, mint_b)` is permissionless. It MUST:

```text
reject identical mints
canonicalize mint0 < mint1
validate supported token programs / Token-2022 extension policy
initialize only the canonical Pair PDA
assign no owner/admin/creator rights to the payer
```

The payer funds account rent only. The Pair PDA address is the canonical Solana pair identifier. Pair creation requires no global counter and does not serialize unrelated pair creation.

Client/SDK Pair lookup MUST expose the same chain-neutral operation used by the product:

```text
getPair(mintA, mintB)
```

The helper canonicalizes `mint0 < mint1`, derives `PDA(["pair", mint0, mint1])`, fetches the Pair account, and returns the Pair PDA together with the decoded Pair state in one call. `getPair(mintA, mintB)` and `getPair(mintB, mintA)` MUST resolve to the same Pair PDA and state. No additional onchain lookup instruction is required because the Pair address is already deterministic. A valid but uninitialized Pair is reported as non-existent; invalid identical mint input is rejected by the helper before transaction construction.

Enumerating every Pair that contains a given mint remains an indexer/client discovery concern; no unbounded mint→Pair account list is required in the program.

## 3.4 Tick PDA

A directional exact tick:

```text
Pair × Direction × Price Tick × DurationDays
```

Direction encoding is frozen:

```text
direction = 0 → Asset = mint0, Quote = mint1
direction = 1 → Asset = mint1, Quote = mint0
all other values → reject
```

Seeds use the frozen scalar byte layout:

```text
["tick", pair, direction:u8, price_tick:i32_le, duration_days:u64_le]
```

Stores fixed-size fields in this semantic domain:

```text
pair: Pubkey
direction: u8
asset_mint: Pubkey
quote_mint: Pubkey
price_tick: i32
price_x128: U256LE
duration_days: u64
available_supply: u64
working_supply: u64
total_shares: U256LE
yield_growth_x128: U256LE
swap_quote_growth_x128: U256LE
generation: u64
bump: u8
```

`initialize_tick(pair, direction, price_tick, duration_days)` is permissionless. It MUST validate the Pair/mints, `direction ∈ {0,1}`, canonical price-tick range, `duration_days > 0`, checked `duration_days * 86_400`, token compatibility, and uniqueness of the Tick PDA. It computes and stores canonical `price_x128` and initializes the three canonical Tick vault token accounts defined in §4. The payer funds rent only and receives no economic or administrative rights.

## 3.5 GenerationState PDA

One immutable finalized snapshot per exhausted generation.

Seeds:

```text
["generation", tick, generation_id:u64_le]
```

Stores fixed-size fields:

```text
tick: Pubkey
generation_id: u64
final_yield_growth_x128: U256LE
final_swap_quote_growth_x128: U256LE
bump: u8
```

The `swap` or `close` instruction that exhausts the generation MUST receive the canonical GenerationState PDA for the **current pre-increment generation**, initialize it in the same instruction, and persist final growth before resetting the Tick. The transaction caller/taker is the rent payer for this PDA in v0.1.

A provider can be behind by multiple Tick generations, but its shares belong to exactly one stored `provider.generation`. When `provider.generation < tick.generation`, any provider-mutating instruction (`supply`, `withdraw`, `collect`, or provider account close) MUST receive the GenerationState PDA derived from that stored provider generation. The program derives and validates the PDA; omission or substitution MUST fail.

Synchronization reads exactly one finalized snapshot and is O(1); it never walks intervening generations because the provider owned no shares in generations it did not join.

GenerationState PDAs are permanent protocol history in v0.1 and are not closed.

## 3.6 ProviderPosition PDA

One mutable provider position per:

```text
supplier × tick
```

Seeds:

```text
["provider", tick, supplier]
```

Stores fixed-size fields:

```text
supplier: Pubkey
tick: Pubkey
generation: u64
shares: U256LE
yield_growth_last_x128: U256LE
swap_quote_growth_last_x128: U256LE
owed_yield: u64
owed_swap_quote: u64
last_supply_slot: u64
bump: u8
```

On first initialization of a ProviderPosition, before any new shares are minted, set exactly:

```text
generation = tick.generation
shares = 0
owed_yield = 0
owed_swap_quote = 0
yield_growth_last_x128 = tick.yield_growth_x128
swap_quote_growth_last_x128 = tick.swap_quote_growth_x128
last_supply_slot = 0
```

This makes a new provider current by construction and prevents historical growth from being inherited.

A ProviderPosition MAY remain allocated indefinitely. If the supplier chooses to close it, the program MUST first synchronize any stale generation and current growth, then require:

```text
provider.generation == tick.generation
provider.shares == 0
provider.owed_yield == 0
provider.owed_swap_quote == 0
```

Only `supplier` may close the ProviderPosition. Rent is returned to `supplier`. Historical actions remain reconstructable from events.

## 3.7 TermPosition PDA

Permanent Use position.

The caller supplies a client-chosen `position_nonce: u64`. Seeds:

```text
["position", tick, user, position_nonce:u64_le]
```

Stores fixed-size fields:

```text
position_nonce: u64
tick: Pubkey
user: Pubkey
asset_amount: u64
quote_principal: u64
gross_yield_fee: u64
opened_at: i64
maturity: i64
status: u8 // 0 ACTIVE, 1 REPAID, 2 CLOSED
bump: u8
```

The full TermPosition PDA is the canonical Solana position identifier. A `(tick, user, position_nonce)` tuple may be initialized only once.

Client-chosen nonces remove the global writable position counter, allow independent Uses on unrelated ticks to execute in parallel, and allow multiple Use instructions in one transaction because every Position PDA is derivable before transaction construction.

TermPosition PDAs remain readable after settlement and are not closed in v0.1.

---

# 4. Token vaults

Each Tick uses three distinct canonical token-account PDAs; v0.1 does **not** use one shared ATA for these custody domains:

```text
Asset Vault          ["asset_vault", tick]
Quote Escrow Vault   ["quote_escrow", tick]
Quote Proceeds Vault ["quote_proceeds", tick]
```

`initialize_tick` creates and initializes these token accounts under the appropriate SPL Token / allowed Token-2022 program. Their token-account authority is the Tick PDA. Asset Vault mint is `asset_mint`; both Quote vault mints are `quote_mint`. The payer funds rent only.

Because SPL token accounts can receive unsolicited external transfers, raw vault balance equality is **not** a protocol invariant. Unsolicited excess is treated as unaccounted donation/dust: it creates no shares, position, growth, or claim and has no v0.1 sweep path.

## 4.1 Asset Vault

SPL token account controlled by Tick PDA authority.

Holds accounted currently Available Asset.

`working_supply` is accounting for Asset that has left the vault and is held by Use users.

Required solvency invariant:

```text
asset_vault.amount >= available_supply
```

Any balance above `available_supply` is unaccounted donation/dust and MUST NOT be included in Supply/Withdraw/Use/Swap accounting.

## 4.2 Quote Escrow Vault

Holds Quote Principal locked by ACTIVE Term Positions.

Escrowed Quote MUST NOT be used for provider claims or protocol fees before Repay/Close settlement.

Required solvency invariant:

```text
quote_escrow_vault.amount >= sum(quote_principal of ACTIVE positions for the tick)
```

The implementation does not iterate positions onchain to check this sum; conservation is proved by instruction accounting/property tests. External excess is unaccounted donation/dust.

## 4.3 Quote Proceeds Vault

Holds funded provider Quote claims:

```text
Gross Yield paid at Use opening
Net Swap proceeds from immediate Swap
Net Close proceeds
```

Accounting distinguishes:

```text
owed_yield
owed_swap_quote
```

although both may be physically held in the same Quote Proceeds Vault because they use the same Quote mint for the tick.

Required solvency invariant:

```text
quote_proceeds_vault.amount >= all funded but uncollected provider Quote claims
```

Growth rounding/dust may make the physical vault balance larger than currently claimable accounting. External excess is likewise not claimable.

Protocol fees MUST NOT remain in this vault after the fee-bearing instruction; they transfer directly to a token account whose owner is compile-time `FEE_TO` and whose mint is the Tick Quote mint.

---

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

For each tick:

```text
A = available_supply
W = working_supply
C = A + W
S = total_shares
```

Provider shares own proportional **current remaining Asset principal `C`** through one fungible share class. Shares do not separately identify Available and Working principal; those are pooled states.

Supply into a live tick therefore joins the current `A + W` principal exposure pro rata, including existing Working principal. Working is not permanently attached to the provider that supplied before a Use opened.

Realized Quote principal and Yield are separate historical receivables distributed through growth accounting and are not returned to Available liquidity. A later supplier checkpoints current growth before receiving shares and therefore receives no historical economics.

Before any share burn, accrued economics are synchronized into `owed_yield` / `owed_swap_quote`. Those balances remain claimable after `shares` reaches zero, while a zero-share provider receives no future growth.

The action split is:

```text
withdraw → Asset principal
collect  → realized Quote principal + earned Yield
```

---

# 7. Price and Yield pricing

## 7.1 Canonical tick price

`price_tick` is a signed `i32` constrained to the canonical TickMath range:

```text
-887272 <= price_tick <= 887272
```

For protocol economics it represents **raw Quote units per raw Asset unit** for this directional Tick. Direction chooses Asset/Quote; it does not invert the tick automatically.

Both EVM and Solana MUST use the same canonical integer mapping:

```text
sqrt_price_x96 = TickMath.getSqrtRatioAtTick(price_tick)
price_x128      = floor(sqrt_price_x96^2 / 2^64)
P               = price_x128 / 2^128
quote_principal = ceil(asset_amount * price_x128 / 2^128)
```

`price_x128` is stored as U256LE. `sqrt_price_x96^2`, price derivation, and `asset_amount * price_x128` MUST use checked sufficiently-wide intermediates (U512-style is acceptable) and MUST exactly match the shared golden vectors. `quote_principal` MUST be non-zero and fit `u64`.

Human display price is derived only in the product layer using token decimals:

```text
display Quote/Asset = (price_x128 / 2^128) * 10^asset_decimals / 10^quote_decimals
```

No oracle participates in this mapping.

## 7.2 Yield curve

Use the same canonical curve as EVM:

```text
MIN_DAILY_FEE  = 0.01%
MAX_DAILY_FEE  = 1.00%
CURVE_EXPONENT = 3
```

Working Share:

\[
u=W/(A+W)
\]

Marginal rate:

\[
r(u)=Min+(Max-Min)u^n
\]

Integrated Use fee over `u0 → u1`:

\[
I(u_0,u_1)=Min(u_1-u_0)+\frac{Max-Min}{n+1}(u_1^{n+1}-u_0^{n+1})
\]

For Price `P`, capacity `C`, duration `D` days:

\[
GrossYieldFee=P \times C \times D \times I(u_0,u_1)
\]

Canonical integer conversion matches EVM:

```text
Quote Principal                    → round UP to Quote smallest units
Gross Yield Fee                    → round UP to Quote smallest units
Reference Yield Fee for Swap       → round UP using the same quote path
Protocol fee derived from a source → round DOWN
```

The Rust fixed-point implementation MUST be deterministic, overflow-checked and split-resistant within documented rounding bounds. Final round-up conversion MUST use checked ceil division.

Use `u128`/`U256`-style checked intermediate arithmetic or a vetted wide-integer library where required. Silent saturation is forbidden.

---

# 8. Growth accounting

Use Q128-equivalent cumulative growth accounting:

```text
yield_growth_x128
swap_quote_growth_x128
```

Before provider share mutation or Collect:

```text
owed_yield += shares * (yield_growth_x128 - yield_growth_last_x128) / Q128
owed_swap_quote += shares * (swap_quote_growth_x128 - swap_quote_growth_last_x128) / Q128
```

Then checkpoints update.

A provider joining later checkpoints current growth before receiving shares, so it receives no historical economics.

Growth increments round down. Provider claim realization rounds down.

When a provider burns all shares, synchronization happens first. Existing `owed_*` survives for later Collect, while future growth contributes zero because the provider has zero shares.

Any instruction distributing growth MUST require `total_shares > 0`; silently skipping a zero denominator is forbidden.

---

# 9. supply instruction

Canonical product parameters:

```text
tick
asset_amount: u64
referrer
```

Before minting shares, synchronize provider accounting, including the provider's finalized GenerationState when stale. `referrer` is logged only and never stored.

If the tick is empty:

```text
S == 0
C == 0
shares_minted = asset_amount
```

otherwise:

\[
shares_minted=\lfloor asset_amount \times S/C \rfloor
\]

Require:

```text
asset_amount > 0
(S == 0) == (C == 0)
shares_minted > 0
```

CPI transfer exact Asset amount from supplier token account to Asset Vault.

Then:

```text
available_supply += asset_amount
total_shares += shares_minted
provider.shares += shares_minted
provider.last_supply_slot = current_slot
```

New Supply is immediately usable. It joins the current pooled `A + W` principal but receives no historical growth because the provider checkpoint was updated before share minting.

---

# 10. withdraw instruction

Withdraw removes only currently Available Asset.

Synchronize provider accounting first, including any required finalized GenerationState; do not pay Quote proceeds.

Requirements:

```text
asset_amount > 0
S > 0
C > 0
asset_amount <= available_supply
asset_amount <= floor(provider.shares * C / S)
current_slot > provider.last_supply_slot
```

Shares burned round up:

\[
shares_burned=\lceil asset_amount \times S/C \rceil
\]

Require `shares_burned <= provider.shares`.

Then:

```text
available_supply -= asset_amount
total_shares -= shares_burned
provider.shares -= shares_burned
Asset Vault → supplier Asset account
```

After mutation require:

```text
(available_supply + working_supply == 0) == (total_shares == 0)
asset_vault.amount >= available_supply
```

If Withdraw removes the final principal unit, it MUST burn the final share. Revert rather than leave `C == 0 && S > 0` or `C > 0 && S == 0`.

Solana uses a one-slot supplier cooldown as the chain-native equivalent of the EVM one-block cooldown. The cooldown does not reserve newly supplied Available liquidity for the new supplier.

A provider whose shares become zero keeps only already synchronized `owed_*` claims and receives no future Yield or Swap/Close growth.

---

# 11. use instruction

Inputs include:

```text
tick
asset_amount: u64
max_yield_fee: u64
deadline: i64
position_nonce: u64
referrer
```

Requirements:

```text
asset_amount > 0
asset_amount <= available_supply
C > 0
total_shares > 0
Clock.unix_timestamp <= deadline
quote_principal > 0
gross_yield_fee > 0
gross_yield_fee <= max_yield_fee
close_fee = floor(gross_yield_fee * FEE_BPS / BPS)
close_fee <= quote_principal
```

Time math:

```text
opened_at = Clock.unix_timestamp
term_seconds = checked(duration_days * 86_400)
maturity = checked(opened_at + term_seconds)
```

Reject any value that cannot be represented as the specified integer type. Slot is not used for maturity.

Execution:

```text
available_supply -= asset_amount
working_supply += asset_amount

Asset Vault → user Asset account
Quote user account → Quote Escrow Vault
Gross Yield user account → Quote Proceeds Vault
```

Yield growth:

```text
yield_growth_x128 += gross_yield_fee * Q128 / total_shares
```

Growth rounds down and uses the non-zero pre-existing `total_shares`.

Create the permanent TermPosition PDA:

```text
["position", tick, user, position_nonce]
```

The nonce is supplied by the client and MUST be unused for that `(tick, user)` tuple. No global writable counter is touched.

No protocol fee is transferred at Use opening.

---

# 12. repay instruction

Only the Term Position user may Repay before maturity.

Execution:

```text
user Asset account → Asset Vault
working_supply -= asset_amount
available_supply += asset_amount
Quote Escrow Vault → user Quote account
status = REPAID
```

No Repay fee.

Yield remains earned.

Remove the position from any active-user index/account structure if the implementation maintains one onchain; otherwise emit sufficient events and retain the permanent Position PDA.

---

# 13. close instruction

Permissionless when:

```text
status == ACTIVE
Clock.unix_timestamp >= maturity
total_shares > 0
```

Compute, rounding down:

\[
close_fee=gross_yield_fee \times FEE_BPS/BPS
\]

The Position was required at Use creation to satisfy `close_fee <= quote_principal`.

Execution:

```text
working_supply -= asset_amount
Quote Escrow Vault → FEE_TO Quote token account: close_fee
Quote Escrow Vault → Quote Proceeds Vault: quote_principal - close_fee
swap_quote_growth_x128 += provider_swap_proceeds * Q128 / total_shares
status = CLOSED
```

Growth uses pre-reset `total_shares` and rounds down.

If this Close makes `available_supply + working_supply == 0`, the same instruction MUST create/finalize the current GenerationState PDA and perform §16 rollover atomically.

No oracle is used.

The user keeps the Asset.

---

# 14. swap instruction

Immediate Swap accepts the predefined tick price with no Term Position.

Inputs include:

```text
tick
asset_amount: u64
max_quote_in: u64
deadline: i64
referrer
```

Requirements:

```text
asset_amount > 0
asset_amount <= available_supply
C > 0
total_shares > 0
Clock.unix_timestamp <= deadline
```

Compute Quote Principal from tick price, rounding up.

Compute Reference Yield Fee using the same pre-execution Use quote path, rounding up.

\[
swap_fee=\left\lfloor reference_yield_fee \times FEE_BPS/BPS \right\rfloor
\]

Require:

```text
quote_principal <= max_quote_in
swap_fee <= quote_principal
```

Execution:

```text
available_supply -= asset_amount
Asset Vault → taker Asset account
Taker Quote account → Quote Proceeds Vault / FEE_TO split
FEE_TO token account receives swap_fee
Quote Proceeds Vault receives quote_principal - swap_fee
swap_quote_growth_x128 += provider_swap_proceeds * Q128 / total_shares
```

Implementation may perform two Quote transfers or one transfer into protocol custody followed by a fee transfer in the same instruction. Final balances must match canonical economics atomically.

Growth uses pre-reset `total_shares` and rounds down.

If this Swap exhausts remaining principal, the same instruction MUST create/finalize the current GenerationState PDA and perform §16 rollover atomically.

No Working state and no Term Position are created.

---

# 15. collect instruction

Synchronize provider first, including the provider's finalized GenerationState when stale.

Let:

```text
gross_yield = owed_yield
swap_quote = owed_swap_quote
```

Compute protocol Yield fee, rounding down:

\[
yield_fee_to=gross_yield \times FEE_BPS/BPS
\]

Require `yield_fee_to <= gross_yield`.

Atomic CPI transfers:

```text
Quote Proceeds Vault → FEE_TO Quote token account: yield_fee_to
Quote Proceeds Vault → provider Quote account: (gross_yield - yield_fee_to) + swap_quote
```

Then zero:

```text
owed_yield
owed_swap_quote
```

Swap Quote is not charged again.

A supplier may Withdraw first and Collect later without losing accrued claims. `shares == 0` does not block Collect of historical `owed_*`; it only prevents future growth accrual.

---

# 16. Generation finalization

The post-state live-share invariant is:

```text
C = available_supply + working_supply
(C == 0) == (total_shares == 0)
```

Supply/Withdraw preserve this directly.

If Swap or Close would produce:

```text
available_supply + working_supply == 0
total_shares > 0 // pre-finalization shares
```

finalize the current generation after applying that instruction's final growth increment with the pre-reset non-zero `total_shares`.

The exhausting instruction MUST receive and initialize:

```text
["generation", tick, tick.generation]
```

with the caller/taker as rent payer, and store:

```text
tick
generation_id = tick.generation
final_yield_growth_x128
final_swap_quote_growth_x128
```

Then:

```text
available_supply = 0
working_supply = 0
total_shares = 0
generation += 1
yield_growth_x128 = 0
swap_quote_growth_x128 = 0
```

A ProviderPosition whose stored generation is older than `tick.generation` MUST be synchronized using the GenerationState PDA derived from `provider.generation`. Synchronization realizes that generation's final growth into `owed_*`, sets old shares to zero, advances `provider.generation` to the current generation, and checkpoints current growth before any new shares are minted.

A provider stale across many later generations still needs only its own stored generation snapshot and no iteration.

A full Withdraw with `W == 0` must burn all remaining shares when it removes all Available Asset. It does not create a GenerationState because no stale shares remain. Any attempted state with `C == 0 && S > 0` or `C > 0 && S == 0` MUST revert.

Generation synchronization/finalization MUST remain O(1) and require no provider iteration.

---

# 17. Duration and time

`duration_days` is a positive whole integer with no semantic maximum.

At Use:

```text
Clock.unix_timestamp <= deadline
opened_at = Clock.unix_timestamp
term_seconds = checked(duration_days * 86_400)
maturity = checked(opened_at + term_seconds)
```

All timestamp math uses signed `i64`-representable Unix seconds and checked conversion/multiplication/addition. Reject unrepresentable maturity.

At Swap:

```text
Clock.unix_timestamp <= deadline
```

Before maturity only Repay is valid; at/after maturity only Close is valid.

**Unix time controls deadline and maturity. Slot is used only for the Supply→Withdraw cooldown.**

---

# 18. Fee recipient

`FEE_TO` is a compile-time immutable production program constant.

For every Quote mint, fee-bearing instructions MUST receive a valid token account whose:

```text
owner == FEE_TO
mint  == tick.quote_mint
token program matches tick.quote_mint
```

The product SHOULD use the canonical Associated Token Account and create it before the fee-bearing action if necessary.

The program MUST derive/check the immutable `FEE_TO` owner and MUST NOT accept a caller-selected fee recipient.

There is no protocol-fee vault or later fee withdrawal instruction.

---

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
multiple independent Uses
multiple Swaps
Repay selected positions
Close selected positions
```

Each Use creates a separate TermPosition PDA using a client-supplied distinct `position_nonce`, so all Position PDAs are derivable before transaction construction. No instruction depends on a global mutable ID counter.

There is no program-level `batch_use` or similar requirement.

If account/compute/transaction-size limits prevent one transaction, the product must split the UX into multiple explicit transactions rather than changing protocol semantics.

---

# 21. Events

The Anchor event schema is frozen to mirror the EVM economic domain. Solana identifiers are Pubkeys/PDAs where EVM uses numeric IDs.

```text
PairCreated(
  pair, mint0, mint1
)

TickCreated(
  tick, pair, direction, price_tick, duration_days, asset_mint, quote_mint
)

Supplied(
  tick, supplier, asset_amount, shares_minted, referrer
)

Withdrawn(
  tick, supplier, asset_amount, shares_burned
)

Collected(
  tick, supplier,
  gross_yield, yield_fee_to, net_yield,
  swap_quote, total_quote_out
)

UseOpened(
  position, position_nonce, tick, user,
  asset_amount, quote_principal, gross_yield_fee,
  opened_at, maturity, referrer
)

TermRepaid(
  position, tick, user,
  asset_amount, quote_principal
)

TermClosed(
  position, tick, user, caller,
  asset_amount, quote_principal,
  close_fee, provider_swap_proceeds
)

ImmediateSwap(
  tick, taker,
  asset_amount, quote_principal,
  reference_yield_fee, swap_fee, provider_swap_proceeds,
  referrer
)

GenerationFinalized(
  tick, generation_id,
  final_yield_growth_x128, final_swap_quote_growth_x128
)
```

`referrer` is optional/zero Pubkey when absent and appears only on Supply, Use and Immediate Swap. It never changes economics.

---

# 22. Client-facing reads

RPC/account-readable canonical state is required. An indexer is optional for speed/search and MUST NOT be required to reconstruct current essential positions.

The SDK MUST expose `getPair(mintA, mintB)` as specified in §3.3: canonicalize the two mints, derive the unique Pair PDA, fetch the account, and return Pair identity + state in one operation. Input order MUST NOT affect the result.

All core v0.1 account structs used for discovery MUST be fixed-size Borsh/Anchor layouts with no variable-length `Vec`/`String` fields.

The SDK MUST publish stable memcmp/GPA filter offsets for at least:

```text
ProviderPosition.supplier
ProviderPosition.tick
ProviderPosition.generation

TermPosition.user
TermPosition.tick
TermPosition.status
```

This allows the reference frontend to discover connected-wallet Earn and Use state with RPC `getProgramAccounts`-style filtering and then fetch canonical accounts directly through Solana Kit.

The program/account model must expose enough canonical state for the product/shared math crate to derive:

```text
available liquidity
working liquidity
working share
current Yield quote
provider shares
provider claimable Yield
provider claimable Swap Quote
Term Position status/maturity
```

Canonical preview math MUST live in a shared deterministic Rust/TypeScript test-vector implementation matching EVM semantics. Dedicated onchain `preview_*` instructions are optional; if provided they MUST return the same integers.

Global Orders/search/history may use an indexer for UX acceleration, but current account state remains authoritative and directly RPC-readable.

---

# 23. Rounding

Match EVM economic direction exactly:

```text
Supply shares             → DOWN
Withdraw max principal    → DOWN
Withdraw shares burned    → UP
Quote Principal required  → UP
Gross Yield Fee           → UP
Reference Yield Fee       → UP
Growth increments         → DOWN
Provider claims           → DOWN
Protocol fees             → DOWN, fee <= source amount
```

Token transfer amounts (`asset_amount`, `quote_principal`, Yield, fees, payouts) are SPL raw amounts and therefore MUST fit `u64`. Any canonical computed transfer amount that does not fit `u64` MUST revert before state mutation.

`total_shares`, provider `shares`, `price_x128`, all growth accumulators/checkpoints, and finalized generation growth use the frozen U256LE storage domain. Multiplication/division intermediates use checked wider arithmetic where required (U512-style is acceptable). No narrowing conversion may truncate silently.

Cross-chain golden vectors MUST compare exact normalized integer outputs where token decimals and fixed-point representations are equivalent.

---

# 24. Security invariants

The Anchor program MUST prove/test:

1. PDA ownership and seeds cannot be substituted.
2. There is no global writable protocol counter/account in Supply/Use/Repay/Swap/Close/Withdraw/Collect paths.
3. Token accounts/mints/program IDs and extension allowlists are validated on every CPI path.
4. `available_supply + working_supply` Asset accounting is conserved.
5. After every successful state transition, `(available_supply + working_supply == 0) == (total_shares == 0)`.
6. `asset_vault.amount >= available_supply`; unsolicited excess creates no claim.
7. Escrow Quote cannot fund provider claims before settlement and active escrow liabilities never exceed escrow vault balance.
8. Quote Proceeds Vault cannot pay more than funded provider claims; unsolicited/dust excess creates no claim.
9. No provider iteration in Use/Repay/Swap/Close or generation synchronization.
10. No historical economics for later suppliers.
11. Withdraw synchronizes claims before burning shares; previously accrued Yield/Swap claims survive even when shares reach zero.
12. A zero-share provider receives no future Yield or Swap/Close growth.
13. Current shareholders receive later Swap/Close growth when existing Working principal resolves.
14. Swap/Close fees go only to immutable `FEE_TO` and never exceed Quote Principal.
15. Same-slot Supply→Withdraw is rejected for that provider position.
16. Generation rollover cannot leak old claims into new shares.
17. A stale provider can synchronize exactly its stored finalized generation in O(1), even if the Tick advanced many generations.
18. ProviderPosition cannot close with shares, owed claims, or unsynchronized generation state.
19. Position status changes exactly once.
20. Repay/Close maturity boundary is strict and deadlines use Unix time.
21. Unsupported Token-2022 behavior cannot corrupt balances.
22. Stored `price_x128` is the canonical value for `price_tick`; Quote Principal uses the frozen round-up formula.
23. U256 share/growth arithmetic is checked; representability overflow reverts before state mutation.
24. All token transfer amounts fit `u64`; all wider arithmetic/conversions are checked with no overflow, underflow, truncation, or silent saturation.
25. Growth distribution with `total_shares == 0` always reverts.
26. Multiple Uses in one transaction can pre-derive independent TermPosition PDAs with distinct nonces.

---

# 25. Required tests

Mirror the EVM economic suite plus Solana-specific cases:

```text
PDA seed canonicalization and frozen little-endian numeric encoding
U256LE limb/storage round-trip vectors
initialize_pair canonical mint ordering, token-policy validation and duplicate rejection
SDK getPair reversed-input equivalence, canonical Pair PDA derivation, initialized/uninitialized Pair behavior
initialize_tick direction mapping, TickMath range, duration, price_x128 and three-vault creation
new ProviderPosition initialization checkpoints current growth and inherits no history
Pair creation without a global counter
parallel Uses on unrelated ticks without a global writable account
multiple Use instructions in one transaction with preselected distinct nonces
duplicate position nonce rejection
wrong vault/mint/token-program rejection
wrong FEE_TO token-account owner rejection
wrong FEE_TO token-account mint rejection
legacy SPL Token path
Token-2022 no-extension path
Token-2022 MetadataPointer / TokenMetadata path
unsupported Token-2022 mint extension rejection
unsupported Token-2022 account extension rejection
unsolicited Asset Vault donation does not increase Available/shares
unsolicited Quote vault donation does not create claims
same-slot Supply/Withdraw rejection
atomic Withdraw + Collect transaction
full Withdraw → shares zero → historical Collect succeeds
full Withdraw → future growth gives withdrawn provider zero
supplier joins while Working > 0 and receives no historical Yield
existing Working Repay after share ownership changes
existing Working Close after share ownership changes
full generation exhaustion via Swap and restart
full generation exhaustion via Close and restart
correct GenerationState PDA creation/rent payer
missing/wrong GenerationState rejection for stale provider
provider stale across multiple later generations syncs only stored generation
ProviderPosition close blocked while shares/owed/stale; succeeds only when empty/current
permanent TermPosition PDA after REPAID/CLOSED
deadline exact-boundary and expired cases
maturity checked-math overflow rejection
Gross Yield / Reference Yield round-up vectors
protocol fee round-down vectors
CloseFee / SwapFee <= Quote Principal boundary
u64 transfer overflow rejection
share mint/result above u64 succeeds when within U256
U256 share overflow rejection
zero-total-shares growth rejection
transaction account-limit fallback behavior
fixed-layout GPA filters for supplier/user/status
cross-chain TickMath / price_x128 / Quote Principal golden vectors with EVM
cross-chain Yield/share/growth golden-vector parity with EVM
```

---

# 26. Out of scope v0.1

```text
oracle pricing
liquidations
LTV
variable debt
resting Demand orders
provider FIFO matching
upgradeable production program
governance economics
onchain referral rewards
protocol token
transferable LP/share token
external AMM deployment
automatic refinancing
portfolio margin
```

---

# 27. Canonical Solana mental model

```text
Supply   → Asset Vault / Available
Use      → Available → Working; Quote escrowed; Yield funded
Repay    → Working → Available; Quote escrow returned
Swap     → Available Asset leaves; net Quote becomes provider claim
Close    → Working resolves; net Quote becomes provider claim
Withdraw → Available Asset principal leaves Asset Vault
Collect  → realized Quote principal + earned Yield leave Quote Proceeds Vault
```

The Solana implementation is a runtime mapping of the same Yield Orders economics, not a different protocol.
