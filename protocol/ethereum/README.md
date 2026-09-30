# Yield Orders on Ethereum / EVM L2s

Yield Orders lets suppliers post ERC-20 **Asset** liquidity at a fixed price and term. A taker either swaps against that liquidity immediately or opens a **Use** position: they receive Asset and lock **Quote**. Before maturity, the taker can repay Asset plus time accrued Asset yield to recover their Quote. At maturity, anyone can close the position and the locked Quote becomes the swap payment.

The same immutable contract is intended for Ethereum Mainnet, Base, and Robinhood Chain. Each market tick is identified by a token pair, Asset direction, price tick, and duration in days. Amounts passed to the contract are **raw token units**; the price tick prices raw Quote units per raw Asset unit.

## Connect

Install `@yld-cx/ethereum-protocol` and import its published ABI. Supply the contract address for the chain you are using; no production address has been finalized yet.

```ts
import yieldOrdersAbi from "@yld-cx/ethereum-protocol" with { type: "json" };
import { getContract, type Abi } from "viem";

const protocol = getContract({
  address: protocolAddress, // 0x-prefixed address of the deployed protocol
  abi: yieldOrdersAbi as Abi,
  client: { public: publicClient, wallet: walletClient },
});
```

The JSON ABI is also available at `@yld-cx/ethereum-protocol/abi/YieldOrders.json`. See [YieldOrders.ts](test/YieldOrders.ts) for complete viem transactions, approvals, events, and state reads.

## Use a tick

Anyone can call `createPair(tokenA, tokenB)` and `createTick(pairId, direction, priceTick, durationDays)`. Call `getPair(tokenA, tokenB)` to obtain the canonical pair ID. Direction `0` makes the lower-address token the Asset; direction `1` makes the other token the Asset. `priceTick` is an `int32` in `[-887272, 887272]`; `durationDays` is a positive `uint64`. Pair and tick creation are permissionless and give the creator no special rights.

| Goal                  | Calls and funds needed                                                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supply Asset          | Approve the Asset token, then `previewSupply(tickId, amount)` and `supply(tickId, amount, referrer)`.                                                                                                                                           |
| Withdraw liquidity    | Read `getEarnPosition(supplier, tickId)`, then `previewWithdraw(tickId, supplier, shares)` and `withdraw(tickId, shares)`. Shares are **not** an Asset amount. Available Asset leaves immediately; the working portion becomes an Exit claim.   |
| Collect proceeds      | `previewCollect(tickId, supplier)` followed by `collect(tickId)` receives already-net Asset yield, Exit Asset, and Quote proceeds.                                                                                                              |
| Open a term position  | Approve Quote, then `previewUse(tickId, assetAmount)` and `use(tickId, assetAmount, maxFullTermYieldAsset, deadline, referrer)`. The taker receives Asset and locks the quoted Quote principal. Read the `UseOpened` event for the position ID. |
| Repay before maturity | Approve enough Asset for principal **and** accrued yield, then `previewRepay(positionId)` and `repay(positionId, maxYieldAsset)`. Only the position taker can repay; Quote is returned.                                                         |
| Swap immediately      | Approve Quote, then `previewSwap(tickId, assetAmount)` and `swap(tickId, assetAmount, maxQuoteIn, deadline, referrer)`. This creates no term position.                                                                                          |
| Settle at maturity    | Anyone can call `close(positionId)` or `settle(tickId)`. `settle` advances at most one position in tick order; it is safe to repeat. Repay is unavailable from maturity onward.                                                                 |

Use `getTick`, `getPosition`, `getEarnPositions`, and `getUsePositions` to read current state and portfolio IDs. Previews include the same single maturity settlement step that a write would perform. `multicall(bytes[])` can compose actions such as withdraw and collect, but supply and withdraw cannot occur in the same block. The protocol supports exact-transfer ERC-20s; native ETH and fee-on-transfer tokens are not supported.
