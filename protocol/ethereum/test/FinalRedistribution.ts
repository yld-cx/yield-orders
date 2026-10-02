import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getContract, keccak256, parseEventLogs, zeroAddress } from "viem";
import protocolAbiJson from "../abi/YieldOrders.json" with { type: "json" };
import type { YieldOrders$Type } from "../artifacts/contracts/YieldOrders.sol/artifacts.js";
import { mockERC20Abi } from "./abi/mocks.js";
import { TickModel, X } from "./reference.js";
import vectors from "../vectors/golden-v03.json" with { type: "json" };

const abi = protocolAbiJson as unknown as YieldOrders$Type["abi"];
const MAX = 2n ** 256n - 1n;
const DAY = 86_400n;
const Q = 1n << 128n;
const TOTAL = 10n ** 30n;
const BOB = 25n * 10n ** 28n;

// A separate integer formulation of the one-day cubic yield integral.
function fullYield(amount: bigint): bigint {
  const u = (amount * Q) / TOTAL;
  const square = (u * u) / Q;
  const fourth = (square * square) / Q;
  const curve = 4n * (u) + 99n * fourth;
  return (TOTAL * curve + 4n * 10_000n * Q - 1n) / (4n * 10_000n * Q);
}

describe("final X36 withdrawal redistribution", async () => {
  const { viem, networkHelpers } = await network.create();
  const [fee, alice, bob, taker] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  it("publishes reproducible raw-unit parity vectors", () => {
    const v = vectors.withdrawal;
    const attributable = BigInt(v.owedActiveYieldRaw) * BigInt(v.withdrawRaw) * X / BigInt(v.providerBeforeX36);
    const paid = attributable * BigInt(v.elapsedSeconds) / BigInt(v.durationSeconds);
    const forfeited = attributable - paid;
    assert.equal(attributable, BigInt(v.yieldForWithdrawRaw));
    assert.equal(paid, BigInt(v.yieldOutRaw));
    assert.equal(forfeited, BigInt(v.forfeitedYieldRaw));
    assert.equal(BigInt(v.remainingActiveRaw) * X - BigInt(v.remainingProviderX36), BigInt(v.otherActiveX36));
    assert.equal(forfeited * BigInt(v.activeP) * X / BigInt(v.otherActiveX36), BigInt(v.yieldSumIncrement));
    for (const boundary of vectors.eligibility) {
      const other = BigInt(boundary.otherActiveX36);
      const fee = other < X ? BigInt(boundary.forfeitedYieldRaw) : 0n;
      const increment = other < X ? 0n : BigInt(boundary.forfeitedYieldRaw) * BigInt(boundary.activeP) * X / other;
      assert.equal(fee, BigInt(boundary.assetFeeRaw));
      assert.equal(increment, BigInt(boundary.yieldSumIncrement));
    }
    for (const direction of vectors.directions) {
      const numerator = BigInt(direction.assetRaw) * 10_001n ** BigInt(direction.priceTick);
      const denominator = 10_000n ** BigInt(direction.priceTick);
      assert.equal(BigInt(direction.quotePrincipalRaw), (numerator + denominator - 1n) / denominator);
      assert.equal(BigInt(direction.swapFeeRaw), BigInt(direction.quotePrincipalRaw) / 100n);
    }
    const exit = vectors.exitFirstRepay;
    assert.equal(BigInt(exit.exitFillRaw), BigInt(exit.exitWorkingRaw));
    assert.equal(BigInt(exit.activeReturnRaw), BigInt(exit.returnedAssetRaw) - BigInt(exit.exitFillRaw));
    assert.equal(BigInt(exit.exitYieldRaw), BigInt(exit.netYieldRaw) * BigInt(exit.exitFillRaw) / BigInt(exit.returnedAssetRaw));
    assert.equal(BigInt(exit.activeYieldRaw), BigInt(exit.netYieldRaw) - BigInt(exit.exitYieldRaw));
  });

  async function setup() {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 6]);
    const market = getContract({ address: (await viem.deployContract("YieldOrders", [fee.account.address])).address,
      abi, client: { public: client, wallet: fee } });
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
    for (const who of [alice, bob, taker]) {
      await ast.write.mint([who.account.address, 10n ** 33n]);
      await quo.write.mint([who.account.address, 10n ** 33n]);
      await ast.write.approve([market.address, MAX], { account: who.account });
      await quo.write.approve([market.address, MAX], { account: who.account });
    }
    const time = async (hash: `0x${string}`) =>
      (await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber })).timestamp;
    const deadline = async () => (await client.getBlock()).timestamp + 2n * DAY;
    return { market, ast, quo, tickId, time, deadline };
  }

  it("keeps independent Quote-per-Asset prices for both directions with 18/6 decimals", async () => {
    const { market, ast, quo, deadline } = await networkHelpers.loadFixture(setup);
    const [pairId] = await market.read.getPair([ast.address, quo.address]);
    const ids: bigint[] = [];
    for (const direction of [0, 1] as const) {
      const id = BigInt(keccak256(encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
        [pairId, direction, 1_000, 1n],
      )));
      await market.write.createTick([pairId, direction, 1_000, 1n]);
      ids.push(id);
      await market.write.supply([id, 1_000_000_000n, zeroAddress], { account: alice.account });
    }
    const first = await market.read.getTick([ids[0]]);
    const second = await market.read.getTick([ids[1]]);
    assert.equal(first.asset, second.quote);
    assert.equal(first.quote, second.asset);
    assert.equal(first.priceX128, second.priceX128);
    assert.ok(first.priceX128 > Q);
    for (let i = 0; i < ids.length; i++) {
      assert.equal((await market.read.quoteUse([ids[i], BigInt(vectors.directions[i].assetRaw)]))[0],
        BigInt(vectors.directions[i].quotePrincipalRaw));
    }
    const quotes = await Promise.all(ids.map((id) => market.read.quoteUse([id, 100_000_000n])));
    assert.deepEqual(quotes[0], quotes[1]);
    assert.ok(quotes[0][0] > 100_000_000n);
    for (const id of ids) {
      const hash = await market.write.swap([id, 100_000_000n, quotes[0][0], await deadline(), zeroAddress],
        { account: taker.account });
      const actual = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash })).logs,
        eventName: "ImmediateSwap" })[0].args;
      assert.equal(actual.quotePrincipal, quotes[0][0]);
      assert.equal(actual.swapFee, quotes[0][0] / 100n);
    }
    assert.equal(await market.read.accruedProtocolFees([ast.address]), quotes[0][0] / 100n);
    assert.equal(await market.read.accruedProtocolFees([quo.address]), quotes[0][0] / 100n);
  });

  it("resolves out-of-order Repay and Close through the pooled Exit before advancing the cursor", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000_000_000n, zeroAddress], { account: alice.account });
    for (const amount of [100_000_000n, 100_000_000n, 50_000_000n]) {
      const [, full] = await market.read.quoteUse([tickId, amount]);
      await market.write.use([tickId, amount, full, await deadline(), zeroAddress], { account: taker.account });
    }
    const withdrawal = await market.write.withdraw([tickId, 300_000_000n, 0n, MAX], { account: alice.account });
    const w = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: withdrawal })).logs,
      eventName: "Withdrawn" })[0].args;
    assert.equal(w.availableAssetOut, 225_000_000n);
    assert.equal(w.workingToExit, 75_000_000n);
    const third = await market.read.getPosition([3n]);
    const repaid = await market.write.repay([3n, third.fullTermYieldAsset], { account: taker.account });
    const r = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: repaid })).logs,
      eventName: "TermRepaid" })[0].args;
    assert.equal(r.exitFill, 50_000_000n);
    assert.equal(r.activeReturn, 0n);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 0n);
    assert.equal((await market.read.getTick([tickId])).exitWorking, 25_000_000n);
    await networkHelpers.time.increase(Number(DAY));
    const closeHash = await market.write.close([2n], { account: fee.account });
    const closed = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash: closeHash })).logs,
      eventName: "TermClosed" });
    assert.equal(closed.length, 2);
    assert.equal(closed[0].args.positionId, 1n);
    assert.equal(closed[0].args.exitFill, 25_000_000n);
    assert.equal(closed[1].args.positionId, 2n);
    assert.equal(closed[1].args.exitFill, 0n);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 1n);
    await market.write.settle([tickId]);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 2n);
    await market.write.settle([tickId]);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 3n);
    assert.equal((await market.read.getDomain([tickId, 1])).generation, 1n);
  });

  async function historicalYield(remaining: bigint, bobAmount = BOB) {
    const f = await networkHelpers.loadFixture(setup);
    const { market, tickId, time, deadline } = f;
    const model = new TickModel();
    const bobSupply = await market.write.supply([tickId, bobAmount, zeroAddress], { account: bob.account });
    model.supply(bob.account.address, bobAmount, await time(bobSupply));
    await networkHelpers.time.increase(1_000);
    const aliceAmount = TOTAL - bobAmount;
    const aliceSupply = await market.write.supply([tickId, aliceAmount, zeroAddress], { account: alice.account });
    model.supply(alice.account.address, aliceAmount, await time(aliceSupply));
    const useAmount = TOTAL / 2n;
    const expectedFull = fullYield(useAmount);
    assert.deepEqual(await market.read.quoteUse([tickId, useAmount]), [useAmount, expectedFull]);
    model.use(useAmount);
    const useHash = await market.write.use([tickId, useAmount, expectedFull, await deadline(), zeroAddress],
      { account: taker.account });
    const opened = await time(useHash);
    await networkHelpers.time.increase(3_600);
    const repayHash = await market.write.repay([1n, expectedFull], { account: taker.account });
    const elapsed = await time(repayHash) - opened;
    const gross = (expectedFull * elapsed + DAY - 1n) / DAY;
    const repayFee = gross / 100n;
    model.assetFees += repayFee;
    model.repay(useAmount, gross - repayFee);
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    assert.equal(await market.read.accruedProtocolFees([f.ast.address]), repayFee);
    const swapAmount = TOTAL - remaining;
    const swapFee = swapAmount / 100n;
    model.swap(swapAmount, swapAmount - swapFee);
    model.quoteFees += swapFee;
    await market.write.swap([tickId, swapAmount, swapAmount, await deadline(), zeroAddress],
      { account: taker.account });
    assert.equal((await market.read.getDomain([tickId, 0])).P, model.active.P);
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).activePrincipalX36,
      model.active.principalX36(model.get(alice.account.address).active));
    assert.equal((await market.read.getEarnPosition([bob.account.address, tickId])).activePrincipalX36,
      model.active.principalX36(model.get(bob.account.address).active));
    return { ...f, model, repayFee };
  }

  it("uses the exact 1.5 raw-unit denominator, excludes retained 0.5 and keeps the older wallet's vesting", async () => {
    const { market, ast, tickId, model, time, deadline, repayFee } = await historicalYield(6n);
    assert.equal(model.active.principalX36(model.get(alice.account.address).active), 45n * X / 10n);
    assert.equal(model.active.principalX36(model.get(bob.account.address).active), 15n * X / 10n);
    const beforeSum = model.active.sums.yield;
    const hash = await market.write.withdraw([tickId, 4n, 0n, MAX], { account: alice.account });
    const predicted = model.withdraw(alice.account.address, 4n, await time(hash));
    const event = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash })).logs,
      eventName: "Withdrawn" })[0].args;
    assert.equal(event.yieldAssetOut, predicted.yieldOut);
    assert.equal(event.forfeitedYield, predicted.forfeited);
    assert.ok(predicted.forfeited > 0n);
    assert.equal(model.active.sums.yield - beforeSum,
      (predicted.forfeited * model.active.P * X) / (15n * X / 10n));
    assert.equal((await market.read.getDomain([tickId, 0])).yieldSum, model.active.sums.yield);
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).activePrincipalX36, X / 2n);
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingActiveYieldAsset,
      model.get(alice.account.address).owedActiveYield);
    const bobView = await market.read.getEarnPosition([bob.account.address, tickId]);
    const bobModel = model.get(bob.account.address);
    assert.equal(bobView.outstandingActiveYieldAsset,
      bobModel.owedActiveYield + model.active.gainWithFraction(bobModel.active, "yield", bobModel.activeFractions.yield));
    assert.equal(bobView.timestamp, bobModel.timestamp);
    assert.ok(bobView.vestingElapsedSeconds >
      (await market.read.getEarnPosition([alice.account.address, tickId])).vestingElapsedSeconds);
    assert.equal(bobView.claimableActiveYieldAsset,
      bobView.outstandingActiveYieldAsset * bobView.vestingElapsedSeconds / DAY);

    model.swap(2n, 2n);
    await market.write.swap([tickId, 2n, 2n, await deadline(), zeroAddress], { account: taker.account });
    assert.equal((await market.read.getDomain([tickId, 0])).generation, 1n);
    await networkHelpers.time.increase(Number(DAY));
    for (const who of [bob, alice]) {
      const claim = await market.write.collect([tickId], { account: who.account });
      const expected = model.collect(who.account.address, await time(claim));
      const receipt = await client.getTransactionReceipt({ hash: claim });
      const actual = parseEventLogs({ abi, logs: receipt.logs, eventName: "Collected" })[0].args;
      assert.equal(actual.activeYieldAsset, expected.activeYield);
      assert.equal(actual.activeQuote, expected.activeQuote);
    }
    const remainingYield = model.fundedYield - model.paidYield - model.forfeitureFees;
    assert.ok(remainingYield >= 0n && remainingYield <= 3n, `unassigned funded Yield: ${remainingYield}`);
    assert.equal(await market.read.tokenLiability([ast.address]), repayFee + model.available + remainingYield);
    assert.equal(await market.read.accruedProtocolFees([ast.address]), repayFee);
    assert.equal(await ast.read.balanceOf([market.address]), await market.read.tokenLiability([ast.address]));
  });

  for (const [remaining, withdrawal, eligible] of [[4n, 2n, true], [3n, 2n, false]] as const) {
    it(`applies the one raw-unit eligibility boundary with ${remaining} remaining raw units`, async () => {
      const { market, ast, tickId, model, time, repayFee } = await historicalYield(remaining);
      const beforeSum = model.active.sums.yield;
      const hash = await market.write.withdraw([tickId, withdrawal, 0n, MAX], { account: alice.account });
      const expected = model.withdraw(alice.account.address, withdrawal, await time(hash));
      const actual = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash })).logs,
        eventName: "Withdrawn" })[0].args;
      assert.equal(actual.forfeitedYield, expected.forfeited);
      assert.ok(expected.forfeited > 0n);
      assert.equal((await market.read.getDomain([tickId, 0])).yieldSum, model.active.sums.yield);
      assert.equal(eligible, model.active.sums.yield > beforeSum);
      assert.equal(await market.read.accruedProtocolFees([ast.address]), model.assetFees);
      assert.equal(model.assetFees, repayFee + (eligible ? 0n : expected.forfeited));
      assert.equal(await market.read.tokenLiability([ast.address]),
        model.available + model.fundedYield - model.paidYield + repayFee);
    });
  }

  for (const [remaining, eligible] of [[10n ** 12n + 1n, true], [10n ** 12n - 1n, false]] as const) {
    it(`handles other ownership within 10^-12 raw units of the threshold (${eligible ? "above" : "below"})`, async () => {
      const { market, ast, tickId, model, time } = await historicalYield(remaining, 10n ** 18n);
      const bobX36 = model.active.principalX36(model.get(bob.account.address).active);
      assert.equal(bobX36 >= X, eligible);
      const before = model.active.sums.yield;
      const hash = await market.write.withdraw([tickId, MAX, 0n, MAX], { account: alice.account });
      const expected = model.withdraw(alice.account.address, MAX, await time(hash));
      assert.ok(expected.forfeited > 0n);
      assert.equal((await market.read.getDomain([tickId, 0])).yieldSum, model.active.sums.yield);
      assert.equal(model.active.sums.yield > before, eligible);
      assert.equal(await market.read.accruedProtocolFees([ast.address]), model.assetFees);
      assert.equal(await market.read.tokenLiability([ast.address]), model.assetLiability());
    });
  }
});
