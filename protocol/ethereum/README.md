# Yield Orders v0.2 — Ethereum, Base, Robinhood Chain

Yield Orders pools ERC-20 **Asset** at an exact direction, price tick, and whole-day term. A taker may **Use** Asset temporarily by locking Quote, or **Swap** Asset immediately for Quote. Repay before maturity returns Asset plus elapsed Asset Yield and unlocks all Quote. At or after maturity, anyone may Close; the taker keeps Asset and the locked Quote settles to providers.

`YieldOrders.sol` is the only deployed protocol contract. `YieldMath`, `ProductSumMath`, `Uint512`, and `TickMath` are internal libraries compiled into it. The contract has no owner, proxy, mutable fee, oracle, liquidation, or rescue function. Each chain has independent liquidity. Amounts are raw smallest ERC-20 units. Use WETH for ETH. A price tick relates **raw Quote units per raw Asset unit**; applications must account for both tokens' decimals when displaying a human price.

## Integration

```ts
import yieldOrdersAbi from "@yld-cx/ethereum-protocol" with { type: "json" };
import { getContract, type Abi } from "viem";

const protocol = getContract({
  address: protocolAddress,
  abi: yieldOrdersAbi as Abi,
  client: { public: publicClient, wallet: walletClient },
});
```

No production address has been frozen or deployed. The ABI is also at `@yld-cx/ethereum-protocol/abi/YieldOrders.json`. [The Multicall integration tests](test/PreviewIntegration.ts) show exact viem simulations, result decoding, approvals, and transaction comparisons.

Create a pair with `createPair(tokenA, tokenB)`, then read its ID with `getPair(tokenA, tokenB)`. Direction `0` uses the lower-address token as Asset; direction `1` uses the other token. Call `createTick(pairId, direction, priceTick, durationDays)`. These calls are permissionless and give no creator rights. The price tick quotes raw Quote per raw Asset. Duration must be positive and no greater than `106751991167300` days; a Use must also mature by timestamp `9223372036854775807`.

| Action   | Calls and funds                                                                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supply   | Simulate `supply` + `getEarnPosition` + `getTick`; then approve Asset and execute.                                                                                                                                                                                                           |
| Withdraw | Simulate `withdraw(tickId, principalAmount, minImmediateAssetOut, deadline)` + `getEarnPosition` + `getTick`. Its return includes immediate Asset, Working moved to Exit, vested Yield, and forfeiture. Set `minImmediateAssetOut = 0` and a permissive deadline for unrestricted execution. |
| Collect  | Simulate `collect` + `getEarnPosition`. Its return includes Asset, Quote, vested Yield, and remaining claims.                                                                                                                                                                                |
| Use      | Read `quoteUse(tickId, assetAmount)` before approval for Quote Principal and full-term Yield. Approve Quote, then simulate `use` + `getPosition` + `getTick`. Read `nextPositionId` before the batch to identify the new position.                                                           |
| Repay    | Approve Asset principal plus gross accrued Yield; simulate `repay` + `getTick` + `getPosition`. The return includes gross Yield, fee, total Asset in, and Quote unlocked.                                                                                                                    |
| Swap     | Approve Quote; simulate `swap` + `getTick`. The return includes Quote required, fee, and provider proceeds.                                                                                                                                                                                  |
| Close    | At maturity simulate `close` + `getPosition` + `getTick` (and `getDomain` if needed). `close` has no return value.                                                                                                                                                                           |

`referrer` is optional metadata. Zero is valid. It changes no rights, fees, pricing, or settlement priority.

### Supplier state

`getTick(tickId)` shows Available, all In Use, Resolving In Use, active In Use, and Active principal. `getEarnPosition(supplier, tickId)` shows the provider's transferable whole-raw Active principal, proportional Available/In Use, Resolving principal, currently collectible balances, outstanding Yield, timestamp, and vesting progress. `getEarnPositions` enumerates supplier Tick IDs. `getUsePositions` returns every Use position ID in creation order, including Repaid and Closed positions; paginate it and call `getPosition` for current status. These views need no indexer.

Each simulation is one `eth_call` to OpenZeppelin `multicall(bytes[])` with the economic action **first** and post-action getters next. Do not prepend `settle`: economic actions already attempt one cursor step. Run simulations with the actual caller, balances, allowances, and a controlled pending block when time affects the result. ERC-20 allowance/balance, maturity, cooldown, deadline, and slippage failures are expected simulation failures. `quoteUse` is read-only and does not project settlement; state can change between quotation, simulation, and inclusion.

The protocol stores supplier principal at X36 precision. A position can remain discoverable while its displayed whole-raw principal is zero, because positive sub-raw principal or historical claims may still exist. The `activePrincipalX36` and `exitPrincipalX36` fields are for diagnostics; applications use whole-raw economic fields. `getDomain`, `scaleSums`, and `generationMeta` support accounting verification, not normal user flows.

`withdraw` takes the lesser of the requested Asset principal and the provider's currently transferable principal. A Max withdrawal uses `type(uint256).max`; positive sub-raw principal remains owned. Withdraw requires a timestamp strictly later than the provider's last Supply or Collect. `multicall(bytes[])` supports `withdraw + collect`, `settle + collect`, and sequential taker actions; each economic subcall has its own reentrancy guard.

### Yield and fees

The integrated utilization curve freezes full-term Asset Yield when Use opens. Repay charges elapsed Yield with a minimum of one billable second. Repay resolves Resolving principal first; the rest returns to Active Available. Close also resolves Resolving first. Swap and Close convert principal to Quote; Close pays no Asset Yield.

The immutable protocol fee is **1%** of Quote Principal on Swap and Close, and **1%** of gross Asset Yield on Repay. It accrues in `accruedProtocolFees(token)` and remains part of `tokenLiability(token)` until `collectProtocolFees(token)` transfers the balance exclusively to immutable `FEE_TO`. A failed claim reverts only the claim. Forfeited Withdraw Yield with no eligible other Active provider also accrues as an Asset fee. Repay Asset principal, Quote refunds, Withdraw principal, and Collect have no additional fee. Only net funded Yield or Quote becomes a provider claim.

Funded Asset Yield vests over the Tick duration from the provider's timestamp. Supply and Collect reset that timestamp, including when Collect pays nothing. Asset principal and Quote proceeds remain immediately collectible. Swap and Close do not reset vesting. Provider checkpoints retain independent X36 fractions for Active Yield/Quote and Exit Asset/Yield/Quote, so a zero-value Collect does not discard a later whole-unit claim.

A later block may change a time-dependent Repay amount or close an expired cursor position. Preserve execution-time slippage bounds and deadlines after simulation.

### Token and custody policy

Only exact-transfer ERC-20 tokens are supported. Native ETH, fee-on-transfer, rebasing, and callback/reentrant token behavior are unsupported. Balance checks reject observable non-exact transfers. The contract tracks aggregate `tokenLiability` and explicit per-Tick Asset/Quote reserves; physical balances must cover liabilities after every action. Donations create no claims.

## Build, test, and deployment preparation

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run build:production
npm run size
```
