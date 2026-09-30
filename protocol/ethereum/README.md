# Yield Orders v0.2 — Ethereum, Base, Robinhood Chain

Yield Orders pools ERC-20 **Asset** at an exact direction, price tick, and whole-day term. A taker may **Use** Asset temporarily by locking Quote, or **Swap** Asset immediately for Quote. Repay before maturity returns Asset plus elapsed Asset Yield and unlocks all Quote. At or after maturity, anyone may Close; the taker keeps Asset and the locked Quote settles to providers.

The contract has no owner, proxy, mutable fee, oracle, liquidation, or rescue function. Each chain has independent liquidity. Amounts are raw smallest ERC-20 units. Use WETH for ETH.

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

No production address has been frozen or deployed. The ABI is also at `@yld-cx/ethereum-protocol/abi/YieldOrders.json`. [The integration tests](test/YieldOrders.ts) show concrete viem calls, approvals, multicalls, views, and raw-unit examples.

Create a pair with `createPair(tokenA, tokenB)`, then read its ID with `getPair(tokenA, tokenB)`. Direction `0` uses the lower-address token as Asset; direction `1` uses the other token. Call `createTick(pairId, direction, priceTick, durationDays)`. These calls are permissionless and give no creator rights. The price tick quotes raw Quote per raw Asset. Duration must be positive and no greater than `106751991167300` days; a Use must also mature by timestamp `9223372036854775807`.

| Action   | Calls and funds                                                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supply   | Approve Asset, call `previewSupply(tickId, assetAmount)`, then `supply(tickId, assetAmount, referrer)`. Supply adds Available Asset.                                                                                                                                                |
| Withdraw | Read `getEarnPosition(supplier, tickId).activePrincipal`. Pass an **Asset principal amount** to `previewWithdraw(tickId, supplier, principalAmount)` and `withdraw(tickId, principalAmount)`. The Available portion is returned immediately; the In Use portion moves to Resolving. |
| Collect  | Call `previewCollect(tickId, supplier)` and `collect(tickId)` for funded Exit Asset, net Asset Yield, and Quote proceeds. Collect never reduces principal or charges a fee.                                                                                                         |
| Use      | Approve Quote, call `previewUse(tickId, assetAmount)`, then `use(tickId, assetAmount, maxFullTermYieldAsset, deadline, referrer)`. Read `UseOpened` for the permanent position ID. No Yield is paid at opening.                                                                     |
| Repay    | Before maturity, approve Asset principal plus gross accrued Yield. Call `previewRepay(positionId)` and `repay(positionId, maxYieldAsset)`. The full locked Quote is returned. The previewed Yield can grow before inclusion; set the max accordingly.                               |
| Swap     | Approve Quote, call `previewSwap(tickId, assetAmount)` and `swap(tickId, assetAmount, maxQuoteIn, deadline, referrer)`. Swap creates no term position.                                                                                                                              |
| Close    | At or after maturity anyone may call `close(positionId)`. `settle(tickId)` processes at most one cursor entry. Economic Tick actions also attempt one settlement step first.                                                                                                        |

`referrer` is optional metadata. Zero is valid. It changes no rights, fees, pricing, or settlement priority.

### Supplier state

`getTick(tickId)` shows Available, all In Use, Resolving In Use, active In Use, and Active principal. `getEarnPosition(supplier, tickId)` shows the provider's transferable whole-raw Active principal, proportional Available/In Use, Resolving principal, and claimable balances. `getEarnPositions` enumerates supplier Tick IDs. `getUsePositions` returns every Use position ID in creation order, including Repaid and Closed positions; paginate it and call `getPosition` for current status. These views need no indexer.

`previewSupply` takes the supplied Asset amount and returns the resulting provider Active principal and projected market Available. For the product's market In Use value, read `getTick(tickId).activeWorking` after execution, or use the pre-action value when no settlement is pending. A pending one-step Close changes In Use, so adapters should refresh `getTick` after submitting Supply.

The protocol stores supplier principal at X36 precision. A position can remain discoverable while its displayed whole-raw principal is zero, because positive sub-raw principal or historical claims may still exist. The `activePrincipalX36` and `exitPrincipalX36` fields are for diagnostics; applications use whole-raw economic fields. `getDomain`, `scaleSums`, and `generationMeta` support accounting verification, not normal user flows.

`withdraw` takes the lesser of the requested Asset principal and the provider's currently transferable principal. A Max withdrawal uses the previewed `activePrincipal`. Positive sub-raw principal remains owned. Supply and Withdraw cannot occur in the same block. `multicall(bytes[])` supports `withdraw + collect`, `settle + collect`, and sequential taker actions; each economic subcall has its own reentrancy guard.

### Yield and fees

The integrated utilization curve freezes full-term Asset Yield when Use opens. Repay charges elapsed Yield with a minimum of one billable second. Repay resolves Resolving principal first; the rest returns to Active Available. Close also resolves Resolving first. Swap and Close convert principal to Quote; Close pays no Asset Yield.

The immutable protocol fee is **1%** of Quote Principal on Swap and Close, and **1%** of gross Asset Yield on Repay. It is sent directly to immutable `FEE_TO`. Repay Asset principal, Quote refunds, Withdraw, and Collect have no fee. Only net funded Yield or Quote becomes a provider liability.

Every state-sensitive preview projects the same one-step settlement that execution would perform. A later block may change a time-dependent Repay quote or close an expired cursor position, so pass slippage bounds based on the transaction you intend to submit.

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
