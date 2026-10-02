import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseEventLogs, zeroAddress } from "viem";
import protocolAbiJson from "../abi/YieldOrders.json" with { type: "json" };
import type { YieldOrders$Type } from "../artifacts/contracts/YieldOrders.sol/artifacts.js";
import { mockERC20Abi } from "./abi/mocks.js";
import { withSimulatedActions } from "./simulation.js";

const abi = protocolAbiJson as unknown as YieldOrders$Type["abi"];
const E = 10n ** 18n;
const DAY = 86_400n;
const MAX = 2n ** 256n - 1n;
const X = 10n ** 36n;

describe("provider Yield vesting", async () => {
  const { viem, networkHelpers } = await network.create();
  const [fee, alice, bob, taker] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  async function setup() {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const deployed = await viem.deployContract("YieldOrders", [fee.account.address]);
    const market = withSimulatedActions(
      getContract({ address: deployed.address, abi, client: { public: client, wallet: fee } }),
      client,
      abi,
      alice.account.address,
      taker.account.address,
    );
    const ast = getContract({ address: asset.address, abi: mockERC20Abi, client: { public: client, wallet: fee } });
    const quo = getContract({ address: quote.address, abi: mockERC20Abi, client: { public: client, wallet: fee } });
    await market.write.createPair([ast.address, quo.address]);
    const [pairId] = await market.read.getPair([ast.address, quo.address]);
    const direction = ast.address.toLowerCase() < quo.address.toLowerCase() ? 0 : 1;
    const tickId = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pairId, direction, 0, 1n],
        ),
      ),
    );
    await market.write.createTick([pairId, direction, 0, 1n]);
    for (const who of [alice, bob, taker]) {
      await ast.write.mint([who.account.address, 10n ** 30n]);
      await quo.write.mint([who.account.address, 10n ** 30n]);
      await ast.write.approve([market.address, MAX], { account: who.account });
      await quo.write.approve([market.address, MAX], { account: who.account });
    }
    const deadline = async () => (await client.getBlock()).timestamp + 2n * DAY;
    const fund = async (amount = 100n * E) => {
      const q = await market.simulate.previewUse([tickId, amount]);
      await market.write.use([tickId, amount, q.fullTermYieldAsset, await deadline(), zeroAddress], {
        account: taker.account,
      });
      await networkHelpers.time.increase(3_600);
      await market.write.repay([(await market.read.nextPositionId()) - 1n, q.fullTermYieldAsset], {
        account: taker.account,
      });
    };
    const checkAsset = async () => {
      const t = await market.read.getTick([tickId]);
      assert.ok((await market.read.tokenLiability([ast.address])) >= t.availableSupply);
      assert.ok((await ast.read.balanceOf([market.address])) >= (await market.read.tokenLiability([ast.address])));
    };
    const withdrawn = async (hash: `0x${string}`) =>
      parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash })).logs, eventName: "Withdrawn" })[0]
        .args;
    const collected = async (hash: `0x${string}`) =>
      parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash })).logs, eventName: "Collected" });
    return { market, ast, tickId, deadline, fund, checkAsset, withdrawn, collected };
  }

  it("resets Supply and Collect timestamps and blocks same-timestamp Withdraw", async () => {
    const { market, tickId, collected } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: alice.account });
    let p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(p.timestamp, (await client.getBlock()).timestamp);
    assert.equal(p.vestingElapsedSeconds, 0n);
    await assert.rejects(
      market.write.multicall(
        [
          [
            encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
            encodeFunctionData({ abi, functionName: "withdraw", args: [tickId, 1n, 0n, MAX] }),
          ],
        ],
        { account: alice.account },
      ),
    );
    const hash = await market.write.collect([tickId], { account: alice.account });
    assert.equal((await collected(hash)).length, 1);
    p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(p.timestamp, (await client.getBlock()).timestamp);
    await market.write.withdraw([tickId, 1n], { account: alice.account });
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).timestamp, p.timestamp);
  });

  it("collects zero, partial-term and full-term Yield while retaining unpaid Yield", async () => {
    const { market, tickId, fund, collected, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    await fund();
    let p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.ok(p.outstandingActiveYieldAsset > 0n);
    assert.equal(
      p.claimableActiveYieldAsset,
      (BigInt(p.outstandingActiveYieldAsset) * BigInt(p.vestingElapsedSeconds)) / DAY,
    );
    const before = await market.simulate.previewCollect([tickId, alice.account.address]);
    assert.equal(before.outstandingActiveYieldAsset, p.outstandingActiveYieldAsset - before.activeYieldAsset);
    assert.equal(before.vestingRemainingSeconds, DAY);
    const hash = await market.write.multicall(
      [
        [
          encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
          encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
        ],
      ],
      { account: alice.account },
    );
    const paid = await collected(hash);
    assert.ok(paid[0].args.activeYieldAsset > 0n);
    assert.equal(paid[1].args.activeYieldAsset, 0n);
    p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(p.claimableActiveYieldAsset, 0n);
    assert.ok(p.outstandingActiveYieldAsset > 0n);
    assert.deepEqual(await market.read.getEarnPositions([alice.account.address, 0n, 10n]), [tickId]);
    await networkHelpers.time.increase(Number(DAY));
    const full = await market.simulate.previewCollect([tickId, alice.account.address]);
    assert.equal(full.activeYieldAsset, p.outstandingActiveYieldAsset);
    assert.equal(full.vestingRemainingSeconds, 0n);
    await market.write.collect([tickId], { account: alice.account });
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingActiveYieldAsset, 0n);
    await checkAsset();
  });

  it("vests newly repaid Yield from the provider timestamp and restarts after a zero-value Collect", async () => {
    const { market, tickId, deadline, collected, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    const supplied = await market.read.getEarnPosition([alice.account.address, tickId]);
    const [, full] = await market.read.quoteUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, full, await deadline(), zeroAddress], { account: taker.account });
    await networkHelpers.time.increase(12 * 3_600);
    await market.write.repay([1n, full], { account: taker.account });
    const funded = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(funded.timestamp, supplied.timestamp);
    assert.ok(funded.outstandingActiveYieldAsset > 0n);
    assert.equal(
      funded.claimableActiveYieldAsset,
      (BigInt(funded.outstandingActiveYieldAsset) * BigInt(funded.vestingElapsedSeconds)) / DAY,
    );
    assert.ok(funded.vestingElapsedSeconds >= DAY / 2n);
    const first = await market.write.multicall(
      [
        [
          encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
          encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
        ],
      ],
      { account: alice.account },
    );
    const events = await collected(first);
    const firstEvent = events[0].args;
    assert.equal(
      firstEvent.activeYieldAsset,
      (funded.outstandingActiveYieldAsset * ((await client.getBlock()).timestamp - supplied.timestamp)) / DAY,
    );
    assert.equal(events[1].args.activeYieldAsset, 0n);
    const remaining = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.ok(remaining.outstandingActiveYieldAsset > 0n);
    const afterReset = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(afterReset.timestamp, (await client.getBlock()).timestamp);
    assert.equal(afterReset.claimableActiveYieldAsset, 0n);
    assert.equal(afterReset.outstandingActiveYieldAsset, remaining.outstandingActiveYieldAsset);
    await networkHelpers.time.increase(Number(DAY));
    assert.equal(
      (await market.read.getEarnPosition([alice.account.address, tickId])).claimableActiveYieldAsset,
      remaining.outstandingActiveYieldAsset,
    );
    await market.write.collect([tickId], { account: alice.account });
    await checkAsset();
  });

  it("restarts outstanding Yield on additional Supply with and without preceding Collect", async () => {
    const { market, tickId, fund } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    await fund();
    const old = await market.read.getEarnPosition([alice.account.address, tickId]);
    await market.write.supply([tickId, 10n * E, zeroAddress], { account: alice.account });
    let p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(p.outstandingActiveYieldAsset, old.outstandingActiveYieldAsset);
    assert.equal(p.claimableActiveYieldAsset, 0n);
    await networkHelpers.time.increase(3_600);
    const claim = await market.simulate.previewCollect([tickId, alice.account.address]);
    const hash = await market.write.collect([tickId], { account: alice.account });
    assert.ok(hash);
    p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.ok(p.outstandingActiveYieldAsset < old.outstandingActiveYieldAsset);
    assert.ok(claim.activeYieldAsset > 0n);
    await market.write.supply([tickId, 10n * E, zeroAddress], { account: alice.account });
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).claimableActiveYieldAsset, 0n);
  });

  it("releases attributable Yield and redistributes forfeiture without self-recapture", async () => {
    const { market, ast, tickId, fund, withdrawn, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: bob.account });
    await fund();
    const before = await market.read.getEarnPosition([alice.account.address, tickId]);
    const sumBefore = (await market.read.getDomain([tickId, 0])).yieldSum;
    const balanceBefore = await ast.read.balanceOf([alice.account.address]);
    const hash = await market.write.withdraw([tickId, 500n * E], { account: alice.account });
    const w = await withdrawn(hash);
    const block = await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber });
    const elapsed = block.timestamp - before.timestamp;
    const attributable = before.outstandingActiveYieldAsset / 2n;
    assert.equal(w.yieldAssetOut, (attributable * elapsed) / DAY);
    assert.equal(w.forfeitedYield, attributable - w.yieldAssetOut);
    assert.equal(
      (await ast.read.balanceOf([alice.account.address])) - balanceBefore,
      w.availableAssetOut + w.yieldAssetOut,
    );
    const after = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(after.outstandingActiveYieldAsset, before.outstandingActiveYieldAsset - attributable);
    assert.equal(
      (await market.read.getDomain([tickId, 0])).yieldSum - sumBefore,
      (w.forfeitedYield * (await market.read.getDomain([tickId, 0])).P) / (1_000n * E),
    );
    assert.ok(
      (await market.read.getEarnPosition([bob.account.address, tickId])).outstandingActiveYieldAsset >
        (await market.read.getEarnPosition([bob.account.address, tickId])).claimableActiveYieldAsset,
    );
    const second = await market.write.withdraw([tickId, MAX], { account: alice.account });
    const secondEvent = await withdrawn(second);
    assert.ok(secondEvent.forfeitedYield > 0n);
    assert.equal(secondEvent.forfeitedYield + secondEvent.yieldAssetOut, after.outstandingActiveYieldAsset);
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).activePrincipal, 0n);
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingActiveYieldAsset, 0n);
    await checkAsset();
  });

  it("redistributes with only Working liquidity and uses FEE_TO with no other Active provider", async () => {
    const { market, ast, tickId, fund, deadline, withdrawn, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: alice.account });
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: bob.account });
    await fund(100n * E);
    const q = await market.simulate.previewUse([tickId, 200n * E]);
    await market.write.use([tickId, 200n * E, q.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    assert.equal((await market.read.getTick([tickId])).availableSupply, 0n);
    const liabilityBefore = await market.read.tokenLiability([ast.address]);
    const hash = await market.write.withdraw([tickId, 100n * E], { account: alice.account });
    const w = await withdrawn(hash);
    assert.equal(w.availableAssetOut, 0n);
    assert.equal(w.workingToExit, 100n * E);
    assert.ok(w.forfeitedYield > 0n);
    assert.equal(await market.read.tokenLiability([ast.address]), liabilityBefore - w.yieldAssetOut);
    assert.ok((await market.read.getEarnPosition([bob.account.address, tickId])).outstandingActiveYieldAsset > 0n);
    await checkAsset();
    const p = await market.read.getPosition([2n]);
    await market.write.repay([2n, p.fullTermYieldAsset], { account: taker.account });
    assert.ok((await market.simulate.previewCollect([tickId, alice.account.address])).exitAsset > 0n);
    assert.ok((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingExitYieldAsset > 0n);
    await market.write.collect([tickId], { account: alice.account });
    assert.ok((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingExitYieldAsset > 0n);
    await networkHelpers.time.increase(Number(DAY));
    await market.write.collect([tickId], { account: alice.account });
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingExitYieldAsset, 0n);
    await checkAsset();
    // A separate Tick state with only one supplier sends forfeiture to the immutable fee recipient.
    const solo = await networkHelpers.loadFixture(setup);
    await solo.market.write.supply([solo.tickId, 100n * E, zeroAddress], { account: alice.account });
    await solo.fund(50n * E);
    const feeBefore = await solo.market.read.accruedProtocolFees([solo.ast.address]);
    const soloHash = await solo.market.write.withdraw([solo.tickId, MAX], { account: alice.account });
    const forfeited = (await solo.withdrawn(soloHash)).forfeitedYield;
    assert.ok(forfeited > 0n);
    assert.equal((await solo.market.read.accruedProtocolFees([solo.ast.address])) - feeBefore, forfeited);
    await solo.checkAsset();
  });

  it("retains funded Yield through complete Swap and Active generation rollover", async () => {
    const { market, tickId, fund, deadline, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    await fund();
    const originalTimestamp = (await market.read.getEarnPosition([alice.account.address, tickId])).timestamp;
    await market.write.swap([tickId, 1_000n * E, 1_000n * E, await deadline(), zeroAddress], {
      account: taker.account,
    });
    assert.equal((await market.read.getDomain([tickId, 0])).generation, 1n);
    const p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(p.timestamp, originalTimestamp);
    assert.equal(p.activePrincipal, 0n);
    assert.ok(p.outstandingActiveYieldAsset > 0n);
    assert.deepEqual(await market.read.getEarnPositions([alice.account.address, 0n, 10n]), [tickId]);
    await networkHelpers.time.increase(Number(DAY));
    assert.equal(
      (await market.simulate.previewCollect([tickId, alice.account.address])).activeYieldAsset,
      p.outstandingActiveYieldAsset,
    );
    await market.write.collect([tickId], { account: alice.account });
    await checkAsset();
  });

  it("retains previously allocated Yield after complete Close", async () => {
    const { market, tickId, fund, deadline, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    await fund();
    const original = await market.read.getEarnPosition([alice.account.address, tickId]);
    const q = await market.simulate.previewUse([tickId, 1_000n * E]);
    await market.write.use([tickId, 1_000n * E, q.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    const position = await market.read.getPosition([2n]);
    await networkHelpers.time.setNextBlockTimestamp(Number(position.maturity));
    await market.write.close([2n], { account: taker.account });
    const p = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(p.timestamp, original.timestamp);
    assert.equal(p.activePrincipal, 0n);
    assert.equal(p.outstandingActiveYieldAsset, original.outstandingActiveYieldAsset);
    assert.equal(p.claimableActiveYieldAsset, p.outstandingActiveYieldAsset);
    await market.write.collect([tickId], { account: alice.account });
    assert.equal((await market.read.getEarnPosition([alice.account.address, tickId])).outstandingActiveYieldAsset, 0n);
    await checkAsset();
  });

  it("uses the exact X36 other-provider denominator with fractional principal", async () => {
    const { market, ast, tickId, fund, deadline, withdrawn, checkAsset } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 2n * E, zeroAddress], { account: alice.account });
    await market.write.supply([tickId, 1n * E, zeroAddress], { account: bob.account });
    await fund(1n * E);
    await market.write.swap([tickId, 1n * E, 1n * E, await deadline(), zeroAddress], { account: taker.account });
    const prior = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.notEqual(prior.activePrincipalX36 % X, 0n);
    const feeBefore = await ast.read.balanceOf([fee.account.address]);
    const liabilityBefore = await market.read.tokenLiability([ast.address]);
    const sumBefore = (await market.read.getDomain([tickId, 0])).yieldSum;
    const hash = await market.write.withdraw([tickId, 1n * E], { account: alice.account });
    const w = await withdrawn(hash);
    const after = await market.read.getEarnPosition([alice.account.address, tickId]);
    const tick = await market.read.getTick([tickId]);
    const d = await market.read.getDomain([tickId, 0]);
    const eligibleX36 = tick.activePrincipal * X - after.activePrincipalX36;
    assert.ok(w.forfeitedYield > 0n);
    assert.equal(d.yieldSum - sumBefore, (w.forfeitedYield * d.P * X) / eligibleX36);
    assert.equal(await ast.read.balanceOf([fee.account.address]), feeBefore);
    assert.equal(
      await market.read.tokenLiability([ast.address]),
      liabilityBefore - w.availableAssetOut - w.yieldAssetOut,
    );
    await checkAsset();
  });
});
