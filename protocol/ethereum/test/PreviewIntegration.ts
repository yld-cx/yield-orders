import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseEventLogs, zeroAddress } from "viem";
import protocolAbiJson from "../abi/YieldOrders.json" with { type: "json" };
import type { YieldOrders$Type } from "../artifacts/contracts/YieldOrders.sol/artifacts.js";
import { mockERC20Abi } from "./abi/mocks.js";

const abi = protocolAbiJson as unknown as YieldOrders$Type["abi"];
const MAX = 2n ** 256n - 1n;
const E = 10n ** 18n;
const DAY = 86_400n;
type Call = { name: string; args: readonly unknown[] };
async function revertsAs(action: Promise<unknown>, expected: RegExp) {
  try {
    await action;
    assert.fail(`Expected ${expected} revert`);
  } catch (error) {
    assert.match(String(error), expected);
  }
}

describe("Multicall product previews", async () => {
  const { viem, networkHelpers } = await network.create();
  const [fee, alice, taker, keeper] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  async function setup() {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const market = getContract({ address: (await viem.deployContract("YieldOrders", [fee.account.address])).address, abi,
      client: { public: client, wallet: fee } });
    const ast = getContract({ address: asset.address, abi: mockERC20Abi, client: { public: client, wallet: fee } });
    const quo = getContract({ address: quote.address, abi: mockERC20Abi, client: { public: client, wallet: fee } });
    await market.write.createPair([ast.address, quo.address]);
    const [pairId] = await market.read.getPair([ast.address, quo.address]);
    const direction = ast.address.toLowerCase() < quo.address.toLowerCase() ? 0 : 1;
    const tickId = BigInt(keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
      [pairId, direction, 0, 1n],
    )));
    await market.write.createTick([pairId, direction, 0, 1n]);
    for (const actor of [alice, taker]) {
      await ast.write.mint([actor.account.address, 10n ** 25n]);
      await quo.write.mint([actor.account.address, 10n ** 25n]);
      await ast.write.approve([market.address, MAX], { account: actor.account });
      await quo.write.approve([market.address, MAX], { account: actor.account });
    }
    const call = (name: string, args: readonly unknown[]): Call => ({ name, args });
    const simulate = async (actor: typeof alice, calls: Call[]) => {
      const before = await market.read.getTick([tickId]);
      const positionCount = await market.read.nextPositionId();
      const assetBalance = await ast.read.balanceOf([market.address]);
      const quoteBalance = await quo.read.balanceOf([market.address]);
      const encoded = calls.map(({ name, args }) => encodeFunctionData({ abi, functionName: name as any, args: args as any }));
      const response = (await client.simulateContract({ address: market.address, abi, functionName: "multicall",
        args: [encoded], account: actor.account, blockTag: "pending" })).result;
      const decoded = response.map((bytes, i) => decodeFunctionResult({ abi, functionName: calls[i].name as any, data: bytes })) as any[];
      assert.deepEqual(await market.read.getTick([tickId]), before, "eth_call changed Tick state");
      assert.equal(await market.read.nextPositionId(), positionCount, "eth_call created a position");
      assert.equal(await ast.read.balanceOf([market.address]), assetBalance, "eth_call moved Asset");
      assert.equal(await quo.read.balanceOf([market.address]), quoteBalance, "eth_call moved Quote");
      return decoded;
    };
    const deadline = async () => (await client.getBlock()).timestamp + 2n * DAY;
    return { market, ast, quo, tickId, call, simulate, deadline };
  }

  it("decodes Supply, Use, Withdraw, Repay, Collect, Swap and Close from economic calls and getters", async () => {
    const { market, tickId, call, simulate, deadline } = await networkHelpers.loadFixture(setup);
    const supply = await simulate(alice, [call("supply", [tickId, 1_000n * E, zeroAddress]),
      call("getEarnPosition", [alice.account.address, tickId]), call("getTick", [tickId])]);
    assert.equal(supply[0], undefined); // Supply has no return; the appended getters provide the result.
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    assert.deepEqual(await market.read.getEarnPosition([alice.account.address, tickId]), supply[1]);
    assert.deepEqual(await market.read.getTick([tickId]), supply[2]);

    const [quotePrincipal, maximumYield] = await market.read.quoteUse([tickId, 400n * E]);
    assert.equal(quotePrincipal, 400n * E);
    const newId = await market.read.nextPositionId();
    const used = await simulate(taker, [call("use", [tickId, 400n * E, maximumYield, await deadline(), zeroAddress]),
      call("getPosition", [newId]), call("getTick", [tickId])]);
    assert.equal(used[0], newId);
    await market.write.use([tickId, 400n * E, maximumYield, await deadline(), zeroAddress], { account: taker.account });
    const position = await market.read.getPosition([newId]);
    assert.equal(position.quotePrincipal, used[1].quotePrincipal);
    assert.equal(position.fullTermYieldAsset, used[1].fullTermYieldAsset);
    assert.equal(position.closeFee, used[1].closeFee);
    assert.equal(position.maturity - position.openedAt, DAY);
    assert.deepEqual(await market.read.getTick([tickId]), used[2]);

    await networkHelpers.time.increase(2);
    const withdraw = await simulate(alice, [call("withdraw", [tickId, 500n * E, 300n * E, await deadline()]),
      call("getEarnPosition", [alice.account.address, tickId]), call("getTick", [tickId])]);
    assert.equal(withdraw[0].availableAssetOut, 300n * E);
    assert.equal(withdraw[0].workingToExit, 200n * E);
    const withdrawHash = await market.write.withdraw([tickId, 500n * E, 300n * E, await deadline()], { account: alice.account });
    const withdrawalEvent = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: withdrawHash })).logs,
      eventName: "Withdrawn" })[0].args;
    assert.equal(withdrawalEvent.availableAssetOut, withdraw[0].availableAssetOut);
    assert.equal(withdrawalEvent.workingToExit, withdraw[0].workingToExit);
    assert.equal(withdrawalEvent.yieldAssetOut, withdraw[0].yieldAssetOut);
    assert.equal(withdrawalEvent.forfeitedYield, withdraw[0].forfeitedYield);
    assert.deepEqual(await market.read.getEarnPosition([alice.account.address, tickId]), withdraw[1]);
    assert.deepEqual(await market.read.getTick([tickId]), withdraw[2]);

    await networkHelpers.time.increase(3_600);
    const repay = await simulate(taker, [call("repay", [newId, maximumYield]),
      call("getPosition", [newId]), call("getTick", [tickId])]);
    const repayHash = await market.write.repay([newId, maximumYield], { account: taker.account });
    const repayEvent = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: repayHash })).logs,
      eventName: "TermRepaid" })[0].args;
    assert.equal(repayEvent.grossYieldAsset, repay[0].grossYieldAsset);
    assert.equal(repayEvent.yieldFeeAsset, repay[0].yieldFeeAsset);
    assert.equal(repay[0].totalAssetIn, repay[0].assetPrincipal + repay[0].grossYieldAsset);
    assert.equal(repay[0].quotePrincipalUnlocked, position.quotePrincipal);
    assert.equal(repay[1].status, 2);
    assert.deepEqual(await market.read.getPosition([newId]), repay[1]);
    assert.deepEqual(await market.read.getTick([tickId]), repay[2]);

    const collect = await simulate(alice, [call("collect", [tickId]),
      call("getEarnPosition", [alice.account.address, tickId]), call("getTick", [tickId])]);
    const collectHash = await market.write.collect([tickId], { account: alice.account });
    const collectEvent = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: collectHash })).logs,
      eventName: "Collected" })[0].args;
    assert.equal(collectEvent.totalAssetOut, collect[0].totalAssetOut);
    assert.equal(collectEvent.totalQuoteOut, collect[0].totalQuoteOut);
    assert.deepEqual(await market.read.getEarnPosition([alice.account.address, tickId]), collect[1]);
    assert.deepEqual(await market.read.getTick([tickId]), collect[2]);

    const swap = await simulate(taker, [call("swap", [tickId, 100n * E, 100n * E, await deadline(), zeroAddress]),
      call("getTick", [tickId]), call("getEarnPosition", [alice.account.address, tickId])]);
    const swapHash = await market.write.swap([tickId, 100n * E, 100n * E, await deadline(), zeroAddress], { account: taker.account });
    const swapEvent = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: swapHash })).logs,
      eventName: "ImmediateSwap" })[0].args;
    assert.equal(swapEvent.quotePrincipal, swap[0].quotePrincipal);
    assert.equal(swapEvent.swapFee, swap[0].swapFee);
    assert.equal(swapEvent.providerSwapProceeds, swap[0].providerSwapProceeds);
    assert.deepEqual(await market.read.getTick([tickId]), swap[1]);
    assert.deepEqual(await market.read.getEarnPosition([alice.account.address, tickId]), swap[2]);

    const nextId = await market.read.nextPositionId();
    const [, nextYield] = await market.read.quoteUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, nextYield, await deadline(), zeroAddress], { account: taker.account });
    await networkHelpers.time.increase(Number(DAY));
    const closed = await simulate(keeper, [call("close", [nextId]), call("getPosition", [nextId]),
      call("getTick", [tickId]), call("getDomain", [tickId, 0])]);
    assert.equal(closed[0], undefined); // Close has no return; position and Tick getters describe its result.
    await market.write.close([nextId], { account: keeper.account });
    assert.equal(closed[1].status, 3);
    assert.deepEqual(await market.read.getPosition([nextId]), closed[1]);
    assert.deepEqual(await market.read.getTick([tickId]), closed[2]);
    assert.deepEqual(await market.read.getDomain([tickId, 0]), closed[3]);
  });

  it("simulates exactly one automatic settlement step and enforces withdrawal execution limits", async () => {
    const { market, tickId, call, simulate, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: alice.account });
    await networkHelpers.time.increase(1);
    const earlier = await simulate(alice, [call("withdraw", [tickId, 50n * E, 50n * E, await deadline()]),
      call("getTick", [tickId])]);
    assert.equal(earlier[0].availableAssetOut, 50n * E);
    const [, yieldQuote] = await market.read.quoteUse([tickId, 50n * E]);
    await market.write.use([tickId, 50n * E, yieldQuote, await deadline(), zeroAddress], { account: taker.account });
    await assert.rejects(market.write.withdraw([tickId, 50n * E, 50n * E, await deadline()], { account: alice.account }));
    const unrestricted = await simulate(alice, [call("withdraw", [tickId, 50n * E, 0n, await deadline()]),
      call("getTick", [tickId])]);
    assert.equal(unrestricted[0].availableAssetOut, 25n * E);
    await market.write.withdraw([tickId, 50n * E, 0n, await deadline()], { account: alice.account });
    assert.deepEqual(await market.read.getTick([tickId]), unrestricted[1]);
    await assert.rejects(market.write.withdraw([tickId, 1n, 0n, 0n], { account: alice.account }));

    await networkHelpers.time.increase(Number(DAY));
    const cursorBefore = (await market.read.getTick([tickId])).settleCursor;
    const settled = await simulate(alice, [call("collect", [tickId]), call("getTick", [tickId]),
      call("getPosition", [1n])]);
    assert.equal(settled[1].settleCursor, cursorBefore + 1n);
    assert.equal(settled[2].status, 3);
    await market.write.collect([tickId], { account: alice.account });
    assert.deepEqual(await market.read.getTick([tickId]), settled[1]);
  });

  it("quotes Use before approval and distinguishes expected ERC-20 and slippage failures", async () => {
    const { market, ast, quo, tickId, call, simulate, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: alice.account });
    const [principal, yieldLimit] = await market.read.quoteUse([tickId, 10n * E]);
    assert.equal(principal, 10n * E);
    await quo.write.approve([market.address, 0n], { account: taker.account });
    await revertsAs(simulate(taker, [call("use", [tickId, 10n * E, yieldLimit, await deadline(), zeroAddress])]), /ERC20InsufficientAllowance/);
    await quo.write.approve([market.address, MAX], { account: taker.account });
    await revertsAs(simulate(taker, [call("use", [tickId, 10n * E, yieldLimit - 1n, await deadline(), zeroAddress])]), /Slippage/);
    await revertsAs(simulate(taker, [call("use", [tickId, 101n * E, MAX, await deadline(), zeroAddress])]), /InsufficientLiquidity/);
    await revertsAs(simulate(taker, [call("use", [tickId, 10n * E, yieldLimit, 0n, zeroAddress])]), /Expired/);
    const quoteBalance = await quo.read.balanceOf([taker.account.address]);
    await quo.write.transfer([keeper.account.address, quoteBalance], { account: taker.account });
    await revertsAs(simulate(taker, [call("use", [tickId, 10n * E, yieldLimit, await deadline(), zeroAddress])]), /ERC20InsufficientBalance/);
    await quo.write.mint([taker.account.address, quoteBalance]);
    await ast.write.approve([market.address, 0n], { account: alice.account });
    await revertsAs(simulate(alice, [call("supply", [tickId, 1n, zeroAddress])]), /ERC20InsufficientAllowance/);
    await ast.write.approve([market.address, MAX], { account: alice.account });
    await revertsAs(simulate(alice, [call("supply", [tickId, 1n, zeroAddress]),
      call("withdraw", [tickId, 1n, 0n, MAX])]), /Cooldown/); // same simulated timestamp
    const result = await simulate(taker, [call("use", [tickId, 10n * E, yieldLimit, await deadline(), zeroAddress]),
      call("getPosition", [1n])]);
    assert.equal(result[1].fullTermYieldAsset, yieldLimit);
    await market.write.use([tickId, 10n * E, yieldLimit, await deadline(), zeroAddress], { account: taker.account });
    await networkHelpers.time.increase(Number(DAY));
    await revertsAs(simulate(taker, [call("repay", [1n, MAX])]), /InvalidState/);
  });
});
