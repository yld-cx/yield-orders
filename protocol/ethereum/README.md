# Yield Orders v0.3 — Ethereum / EVM L2s

> Provide or rent tokens at your price.

Yield Orders is an immutable, permissionless protocol for supplying, using, or swapping ERC-20 tokens at a chosen price and duration. A user can return rented tokens with Yield before maturity or settle at the agreed price. There are no oracles, liquidations, or admin controls.

Visit [yld.cx](https://yld.cx) to learn about the product, or integrate directly with the contract using the published ABI.

## Deployments

The same v0.3 contract is deployed at **`0x0000014563b23D9ac3aC11Fe68D63cdfC19A43db`** on:

| Network         | Chain ID | Verified contract                                                                               |
| --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| Ethereum        | `1`      | [Etherscan](https://etherscan.io/address/0x0000014563b23d9ac3ac11fe68d63cdfc19a43db#code)       |
| Base            | `8453`   | [BaseScan](https://basescan.org/address/0x0000014563b23d9ac3ac11fe68d63cdfc19a43db#code)        |
| Robinhood Chain | `4663`   | [RobinScan](https://robin.etherscan.io/address/0x0000014563b23d9ac3ac11fe68d63cdfc19a43db#code) |

**Each chain has independent liquidity and positions.** Identify markets and positions by chain ID, contract address, and ID. A common contract address does not bridge funds between chains.

`YieldOrders.sol` is the only deployed protocol contract; its libraries are compiled into it. There is no owner, proxy, upgrade mechanism, mutable fee, or rescue function. See the [deployment manifest](https://github.com/yld-cx/yield-orders/blob/main/protocol/ethereum/deployments/config.json) for immutable settings and bytecode hashes.

## How it works

A liquidity rental market, called a **Tick**, specifies an **Asset** token, a **Quote** token, a price, and a duration in whole days. Suppliers pool Asset liquidity in that exact Tick.

| Action       | What happens                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Supply**   | Deposit Asset at a chosen price and duration. Available liquidity can be Used or Swapped.                                                        |
| **Use**      | Receive Asset now and lock 100% of Quote principal at the posted price. Full-term Asset Yield is fixed at opening.                               |
| **Repay**    | Before maturity, return Asset plus elapsed Asset Yield and unlock all Quote. Only the position's user can Repay.                                 |
| **Swap**     | Pay Quote and receive available Asset immediately. Suppliers receive Quote proceeds after the protocol fee.                                      |
| **Close**    | At or after maturity, the user keeps the Asset and locked Quote settles to suppliers. Anyone may Close. No Asset Yield or keeper reward is paid. |
| **Withdraw** | Withdraw Active principal. The Available portion returns immediately; the In Use portion becomes **Resolving** until Repay or Close.             |
| **Collect**  | Claim resolved Asset, Quote proceeds, and vested Asset Yield.                                                                                    |

**Important for suppliers:** liquidity can settle in **either Asset or Quote**. Repay returns Asset and funds Yield; Swap and Close convert principal into Quote at the chosen price. Withdrawing cannot recall Asset still In Use.

Funded Asset Yield vests over the Tick duration, measured from the supplier's last Supply or Collect. **Both Supply and Collect reset this vesting timestamp**, even if Collect pays nothing. Withdraw pays vested Yield attributable to the withdrawn principal; its unvested funded Yield accrues to protocol fees. Resolved Asset and Quote are immediately collectible. Repay and Close resolve Resolving principal first.

## Integrate with viem

```sh
npm i @yld-cx/ethereum-protocol viem
```

The package exports the contract's ABI as JSON (also available at `@yld-cx/ethereum-protocol/abi/YieldOrders.json`), deployment configuration at `@yld-cx/ethereum-protocol/deployments/config.json`, Solidity source under `contracts/*`, and rounding vectors under `vectors/*`. Node-based tooling requires Node.js 24+. The package does **not** include RPC clients or a transaction SDK.

The following TypeScript examples share this setup. They use an injected EIP-1193 wallet; replace `window.ethereum` with your wallet connector's provider where needed. **Configure an RPC URL for the selected chain** before running them.

```ts
import yieldOrdersAbi from "@yld-cx/ethereum-protocol" with { type: "json" };
import deployments from "@yld-cx/ethereum-protocol/deployments/config.json" with { type: "json" };
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getContract,
  http,
  keccak256,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { base } from "viem/chains"; // Select mainnet or another supported chain as needed.

const chain = base;
if (!Object.values(deployments.networks).includes(chain.id)) {
  throw new Error("No protocol deployment for the selected chain");
}
const rpcUrl = "https://YOUR_RPC_URL"; // Replace with an RPC endpoint for this chain.
const protocolAddress = deployments.address as Address;
const abi = yieldOrdersAbi as Abi;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
if (!provider) throw new Error("Connect an Ethereum wallet first");
const walletClient = createWalletClient({ chain, transport: custom(provider) });
const [account] = await walletClient.requestAddresses();
if (!account) throw new Error("No wallet account connected");
if ((await publicClient.getChainId()) !== chain.id) throw new Error("Incorrect RPC chain");
if ((await walletClient.getChainId()) !== chain.id) throw new Error("Switch your wallet to the selected chain");

const protocol = getContract({ address: protocolAddress, abi, client: publicClient });

async function confirm(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return receipt;
}
```

All amounts and IDs use `bigint`. Casting a JSON ABI to `Abi` does not preserve literal ABI types; generate typed ABI bindings in your application if you need compile-time argument/result checks.

### Find or create a market

Discover markets through `PairCreated` and `TickCreated` events. There is no global Pair/Tick enumeration method. For known tokens, `getPair(tokenA, tokenB)` returns `[pairId, token0, token1, exists]`, even before creation.

Anyone can call `createPair(tokenA, tokenB)` and then `createTick(pairId, direction, priceTick, durationDays)`. Creation grants no special rights. Simulate writes, confirm receipts, and handle `AlreadyExists` if another transaction creates the market first.

- `direction = 0`: Asset is `token0` (lower-address token); Quote is `token1`.
- `direction = 1`: Asset is `token1`; Quote is `token0`.
- `priceTick`: integer from `-887272` to `887272`; raw Quote/Asset price is approximately `1.0001 ** priceTick`.
- `durationDays`: positive whole days. One day is exactly `86400` seconds; the protocol enforces duration and maturity bounds.

Compute the Tick ID locally, then call `getTick(tickId)` to check whether it exists:

```ts
function tickIdFor(pairId: bigint, direction: 0 | 1, priceTick: number, durationDays: bigint) {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
        [pairId, direction, priceTick, durationDays],
      ),
    ),
  );
}
```

**All execution amounts and prices use raw token units.** `getTick` exposes `priceX128` (raw Quote units per raw Asset unit):

```text
quotePrincipal = ceil(assetAmount * priceX128 / 2^128)
human Quote per Asset = (priceX128 / 2^128) * 10^(assetDecimals - quoteDecimals)
```

For example, price tick `0` gives one raw Quote unit per raw Asset unit. With an 18-decimal Asset and 6-decimal Quote, that means `10^12` whole Quote tokens per whole Asset token. Account for **both token decimals** before displaying or selecting a price. Use integer arithmetic, `quoteUse`, and transaction simulations for exact rounded amounts.

### Read a market and quote a Use

For an existing Tick with available liquidity:

```ts
const tickId = 123n; // Replace with an existing Tick ID on the selected chain.
const assetAmount = 10n ** 18n; // Example: 1 Asset for an 18-decimal token.
const tick = await protocol.read.getTick([tickId]);
const [quotePrincipal, fullTermYieldAsset] = (await protocol.read.quoteUse([tickId, assetAmount])) as readonly [
  bigint,
  bigint,
];
console.log({ tick, quotePrincipal, fullTermYieldAsset });
```

`quoteUse` shows the current locked Quote and full-term Asset Yield; it does not reserve liquidity or project settlement. Actual results may change before execution.

### Preview and submit transactions

Use `simulateContract` to preview without changing state. Simulate with the actual account, balances, and allowances. **Approve the protocol address** for the required ERC-20 amount, wait for confirmation, and re-simulate before submission. Tokens requiring allowance resets may need `approve(spender, 0)` first.

There are no dedicated `preview*` methods. To preview an action **and its resulting balances**, simulate `multicall(bytes[])` with the economic action first and getters after it. Each result is separately ABI-encoded. Do not prepend `settle` to an ordinary action preview: economic actions already attempt at most one settlement-cursor step.

#### Supply and preview the resulting balance

```ts
async function supplyAsset(tickId: bigint, assetAmount: bigint) {
  const tick = (await protocol.read.getTick([tickId])) as { asset: Address };
  await confirm(
    await walletClient.writeContract({
      account,
      address: tick.asset,
      abi: erc20Abi,
      functionName: "approve",
      args: [protocolAddress, assetAmount],
    }),
  );

  const calls = [
    encodeFunctionData({ abi, functionName: "supply", args: [tickId, assetAmount, zeroAddress] }),
    encodeFunctionData({ abi, functionName: "getEarnPosition", args: [account, tickId] }),
    encodeFunctionData({ abi, functionName: "getTick", args: [tickId] }),
  ];
  const { result, request } = await publicClient.simulateContract({
    account,
    address: protocolAddress,
    abi,
    functionName: "multicall",
    args: [calls],
    blockTag: "pending",
  });
  const results = result as readonly Hex[];
  // Supply returns no value; the getters show the resulting state.
  console.log(decodeFunctionResult({ abi, functionName: "getEarnPosition", data: results[1] }));
  console.log(decodeFunctionResult({ abi, functionName: "getTick", data: results[2] }));

  // Show the preview and obtain the user's approval before sending in a UI.
  return confirm(await walletClient.writeContract(request));
}
```

#### Use Asset and recover the confirmed position ID

`quoteUse(tickId, assetAmount)` returns Quote principal and full-term Asset Yield before approval. **Only Quote principal is locked on Use; Asset Yield is paid on Repay.** Full-term Yield is determined by the utilization curve, not a supplier-selected rate. Repay prorates this fixed Yield by elapsed seconds, rounded up to raw Asset units, with a minimum of one billable second.

Choose an acceptable maximum Yield and a short deadline. This example accepts exactly the quoted Yield, so an increase before submission causes `Slippage`.

```ts
async function useAsset(tickId: bigint, assetAmount: bigint) {
  const tick = (await protocol.read.getTick([tickId])) as { quote: Address };
  const [quotePrincipal, maxFullTermYieldAsset] = (await protocol.read.quoteUse([tickId, assetAmount])) as readonly [
    bigint,
    bigint,
  ];
  await confirm(
    await walletClient.writeContract({
      account,
      address: tick.quote,
      abi: erc20Abi,
      functionName: "approve",
      args: [protocolAddress, quotePrincipal],
    }),
  );

  const deadline = (await publicClient.getBlock()).timestamp + 300n;
  const { result: simulatedPositionId, request } = await publicClient.simulateContract({
    account,
    address: protocolAddress,
    abi,
    functionName: "use",
    args: [tickId, assetAmount, maxFullTermYieldAsset, deadline, zeroAddress],
    blockTag: "pending",
  });
  console.log({ simulatedPositionId, quotePrincipal, maxFullTermYieldAsset, deadline });

  const receipt = await confirm(await walletClient.writeContract(request));
  const [opened] = parseEventLogs({
    abi,
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === protocolAddress.toLowerCase()),
    eventName: "UseOpened",
  });
  if (!opened) throw new Error("UseOpened event missing from receipt");
  return (opened.args as { positionId: bigint }).positionId;
}
```

**Use the confirmed `UseOpened` event for the actual position ID.** A simulated ID can change if other transactions open positions first. For a `use + getPosition` preview, use `nextPositionId` from the same simulated state. Re-simulate after approvals or state changes, retain slippage bounds and deadlines, and check receipts before updating the UI. Repay Yield grows over time, so an exact simulated repayment cap may fail in a later block.

### Other actions

Follow the same **simulate → review → submit → receipt** flow. `referrer` is optional metadata; `zeroAddress` is valid and does not change fees or user rights.

| Method                                                              | Approval                      | Key behavior                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withdraw(tickId, principalAmount, minImmediateAssetOut, deadline)` | None                          | Immediately returns Available Asset; moves remaining withdrawn In Use principal to Resolving. Returns vested Yield; unvested funded Yield accrues to protocol fees. `minImmediateAssetOut` protects immediately returned principal (excluding Yield). |
| `collect(tickId)`                                                   | None                          | Claims available Asset/Yield/Quote and reports remaining Resolving principal and outstanding Yield. Resets Yield vesting time.                                                                                                                        |
| `repay(positionId, maxYieldAsset)`                                  | Asset principal + gross Yield | Returns `totalAssetIn`, gross Yield, fee, Quote unlocked, and allocation. Only the position's user may Repay, strictly before maturity. The cap limits Yield, not principal.                                                                          |
| `swap(tickId, assetAmount, maxQuoteIn, deadline, referrer)`         | Quote                         | Returns `quotePrincipal`, `swapFee`, and `providerSwapProceeds`. The 1% fee is **deducted from supplier proceeds**, not added to the taker's Quote payment.                                                                                           |
| `close(positionId)`                                                 | None                          | Anyone may Close at or after maturity. Locked Quote settles to suppliers after the fee.                                                                                                                                                               |
| `settle(tickId)`                                                    | None                          | Advances at most one cursor step (skips a removed position or Closes a mature one); does not drain the entire queue.                                                                                                                                  |

Withdraw is permitted only when the blockchain timestamp is **strictly later** than the supplier's last Supply or Collect. Use `maxUint256` for `principalAmount` to withdraw all transferable whole-raw Active principal. Setting `minImmediateAssetOut = 0` allows even a fully Resolving withdrawal; make that outcome clear to users. `multicall` supports `withdraw + collect` and `settle + collect`. Resolved claims do not require another Withdraw.

## Portfolio reads and event history

An indexer is **not required** to show current orders:

| Read                                     | Purpose                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getTick(tickId)`                        | Asset/Quote, term, price, Available, In Use, Resolving, and Active liquidity.                         |
| `getEarnPositions(owner, offset, limit)` | Page through a supplier's Tick IDs; use `getEarnPosition(owner, tickId)` for balances.                |
| `getEarnPosition(owner, tickId)`         | Active and Resolving principal, claimable Asset/Yield/Quote, outstanding Yield, and vesting progress. |
| `getUsePositions(owner, offset, limit)`  | Page through active Use position IDs; use `getPosition(positionId)` for details.                      |
| `getPosition(positionId)`                | User, Tick, Asset principal, locked Quote, full-term Yield, opening time, and maturity.               |

For a supplier, currently claimable Asset is `claimableExitAsset + claimableActiveYieldAsset + claimableExitYieldAsset`; claimable Quote is `claimableActiveQuote + claimableExitQuote`. Available Active principal is **Withdrawn**, not Collected. Economic transaction simulations include a settlement step that ordinary getter reads do not.

Pin paginated reads to one block because positions can be removed and indices reordered. Repay and Close remove the active Use position; subsequent `getPosition` calls revert `NotFound`. For history, index `UseOpened`, `TermRepaid`, `TermClosed`, `Supplied`, `Withdrawn`, `Collected`, and `ImmediateSwap` events.

**Do not hide a supplier's claims just because displayed Active principal is zero.** Internal fractional principal or pending historical claims may still exist. Use whole-raw economic fields for UI balances; detailed X36 accounting is documented in the [EVM specification](https://github.com/yld-cx/yield-orders/blob/main/spec/ethereum.md).

## Fees and token compatibility

Estimated **Yield and Quote proceeds** include the **1%** immutable protocol fee. On Withdraw, funded unvested Yield attributable to withdrawn principal also accrues to protocol fees. There are no additional protocol fees on Repay principal, Quote refunds, Withdraw principal, or Collect. Network gas fees are separate.

Only **exact-transfer ERC-20 tokens** are supported. Use WETH rather than native ETH. Fee-on-transfer, rebasing, and callback/reentrant token behavior are unsupported. Permissionless market creation **does not certify token safety or compatibility**. The contract checks observable transfer amounts and tracked liabilities; direct token donations create no claim and there is no rescue function.

## Troubleshooting

| Revert                              | Suggested response                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `InsufficientLiquidity`             | Refresh Available liquidity or reduce the amount.                                   |
| `Slippage`                          | Re-quote and ask the user to review changed amounts.                                |
| `Expired`                           | Refresh the deadline and re-simulate.                                               |
| `Cooldown`                          | Wait until blockchain time is later than the last Supply or Collect.                |
| `InvalidState`                      | Refresh the position; it may be resolved, too early to Close, or too late to Repay. |
| `Unauthorized`                      | Repay using the position owner's wallet.                                            |
| `NotFound` / `AlreadyExists`        | Refresh market/position state; another transaction may have changed it.             |
| `InvalidInput` / `UnsupportedToken` | Check bounds, amounts, and token transfer compatibility.                            |

ERC-20 balance or allowance failures can also originate in the token contract. Preserve the user's limits when retrying.

## References and development

- [Multicall integration tests](https://github.com/yld-cx/yield-orders/blob/main/protocol/ethereum/test/PreviewIntegration.ts) — simulations, decoding, approvals, and real transaction comparisons.
- [Protocol specification](https://github.com/yld-cx/yield-orders/blob/main/spec/protocol.md) and [EVM specification](https://github.com/yld-cx/yield-orders/blob/main/spec/ethereum.md) — exact rules and accounting.
- [Product specification](https://github.com/yld-cx/yield-orders/blob/main/spec/product.md) — UI terminology and behavior.
- [v0.3 rounding vectors](https://github.com/yld-cx/yield-orders/blob/main/protocol/ethereum/vectors/golden-v03.json) — raw-unit boundary cases, also exported as `@yld-cx/ethereum-protocol/vectors/golden-v03.json`.

To develop or test the protocol itself, clone the repo and run from `protocol/ethereum`:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run build:production
```
