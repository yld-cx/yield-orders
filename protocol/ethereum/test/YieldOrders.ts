import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseEventLogs, zeroAddress } from "viem";
import protocolAbiJson from "../abi/YieldOrders.json" with { type: "json" };
import type { YieldOrders$Type } from "../artifacts/contracts/YieldOrders.sol/artifacts.js";
import { SALT_NAMESPACE } from "../hardhat.config.js";
import { feeOnTransferTokenAbi, mockERC20Abi, reentrantTokenAbi } from "./abi/mocks.js";
import { TickModel, X, P0, F, MAX, fullTermYield } from "./reference.js";
import { candidateSalt, guardSalt, NETWORKS, predict, readArtifact } from "../scripts/deployment.js";
import { withSimulatedActions } from "./simulation.js";
import v03 from "../vectors/golden-v03.json" with { type: "json" };

const abi = protocolAbiJson as unknown as YieldOrders$Type["abi"];
const E = 10n ** 18n;
const DAY = 86_400n;
const max = 2n ** 256n - 1n;

describe("Yield Orders Product-Sum", async () => {
  const { viem, networkHelpers } = await network.create();
  const [deployer, a, b, taker, keeper] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  it("exports the shared Product-Sum invariant error only once", () => {
    assert.equal(abi.filter((entry) => entry.type === "error" && entry.name === "Invariant").length, 1);
  });

  it("keeps 1% floor fee parity at raw-unit boundaries", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, MAX, zeroAddress], { account: a.account });
    assert.equal(0n * 100n / 10_000n, 0n);
    await assert.rejects(market.simulate.previewSwap([tickId, 0n]));
    for (const amount of [1n, 99n, 100n, 101n, MAX]) {
      const result = await client.simulateContract({ address: market.address, abi, functionName: "swap",
        args: [tickId, amount, max, await deadline(), zeroAddress], account: taker.account });
      assert.equal(result.result.quotePrincipal, amount);
      assert.equal(result.result.swapFee, amount / 100n);
      assert.equal(result.result.providerSwapProceeds, amount - amount / 100n);
    }
  });

  async function setup() {
    const asset = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quote = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const deployed = await viem.deployContract("YieldOrders", [deployer.account.address]);
    const market = withSimulatedActions(
      getContract({ address: deployed.address, abi, client: { public: client, wallet: deployer } }),
      client,
      abi,
      a.account.address,
      taker.account.address,
    );
    const ast = getContract({
      address: asset.address,
      abi: mockERC20Abi,
      client: { public: client, wallet: deployer },
    });
    const quo = getContract({
      address: quote.address,
      abi: mockERC20Abi,
      client: { public: client, wallet: deployer },
    });
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
    for (const w of [a, b, taker, keeper]) {
      await ast.write.mint([w.account.address, 10n ** 33n]);
      await quo.write.mint([w.account.address, 10n ** 33n]);
      await ast.write.approve([market.address, max], { account: w.account });
      await quo.write.approve([market.address, max], { account: w.account });
    }
    const deadline = async () => (await client.getBlock()).timestamp + 1_000_000n;
    const checkCustody = async () => {
      const tick = await market.read.getTick([tickId]);
      assert.ok((await ast.read.balanceOf([market.address])) >= (await market.read.tokenLiability([ast.address])));
      assert.ok((await quo.read.balanceOf([market.address])) >= (await market.read.tokenLiability([quo.address])));
      assert.ok(tick.exitWorking <= tick.workingSupply);
      assert.equal(tick.activePrincipal, tick.availableSupply + tick.workingSupply - tick.exitWorking);
      assert.ok((await market.read.getDomain([tickId, 0])).P >= 10n ** 30n);
      assert.ok((await market.read.getDomain([tickId, 1])).P >= 10n ** 30n);
    };
    return { market, ast, quo, tickId, pairId, deadline, checkCustody };
  }

  it("golden A: keeps both fractional principals and discovery after one raw swap", async () => {
    const { market, ast, quo, tickId, deadline, checkCustody } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1n, zeroAddress], { account: a.account });
    await market.write.supply([tickId, 1n, zeroAddress], { account: b.account });
    await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
    const tick = await market.read.getTick([tickId]);
    const d = await market.read.getDomain([tickId, 0]);
    assert.equal(tick.activePrincipal, 1n);
    assert.equal(d.P, P0 / 2n);
    assert.equal(d.scale, 0n);
    assert.equal(d.generation, 0n);
    assert.equal(d.assetSum, 0n);
    assert.equal(d.yieldSum, 0n);
    assert.equal(d.quoteSum, P0 / 2n);
    for (const who of [a, b]) {
      await market.write.collect([tickId], { account: who.account });
      const view = await market.read.getEarnPosition([who.account.address, tickId]);
      assert.equal(view.activePrincipalX36, X / 2n);
      assert.equal(view.claimableActiveQuote, 0n);
      assert.equal(view.claimableActiveYieldAsset, 0n);
      assert.equal(view.claimableExitAsset, 0n);
      assert.equal(view.claimableExitYieldAsset, 0n);
      assert.equal(view.claimableExitQuote, 0n);
      assert.equal(view.activePrincipal, 0n);
      assert.deepEqual(await market.read.getEarnPositions([who.account.address, 0n, 10n]), [tickId]);
    }
    assert.equal(await market.read.tokenLiability([ast.address]), 1n);
    assert.equal(await market.read.tokenLiability([quo.address]), 1n);
    await checkCustody();
  });

  it("keeps only ACTIVE Uses and updates a moved index after middle removal", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    for (let i = 0; i < 3; i++) {
      await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], {
        account: taker.account,
      });
    }
    const owner = taker.account.address;
    assert.deepEqual(await market.read.getUsePositions([owner, 0n, 10n]), [1n, 2n, 3n]);
    await market.write.repay([2n, max], { account: taker.account });
    await assert.rejects(market.read.getPosition([2n]), /NotFound/);
    assert.deepEqual(await market.read.getUsePositions([owner, 0n, 10n]), [1n, 3n]);
    assert.equal(await market.read.tickPositionId([tickId, 1n]), 0n);
    await market.write.repay([3n, max], { account: taker.account });
    await assert.rejects(market.read.getPosition([3n]), /NotFound/);
    assert.deepEqual(await market.read.getUsePositions([owner, 0n, 10n]), [1n]);
    await networkHelpers.time.increase(Number(DAY));
    await market.write.close([1n], { account: keeper.account });
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    assert.deepEqual(await market.read.getUsePositions([owner, 0n, 10n]), []);
    assert.equal(await market.read.tickPositionId([tickId, 0n]), 0n);
    assert.equal(await market.read.nextPositionId(), 4n);
  });

  it("returns RepayResult, emits terminal history, and advances deleted cursor gaps one at a time", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    for (let i = 0; i < 5; i++) {
      await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], { account: taker.account });
      assert.equal((await market.read.getPosition([BigInt(i + 1)])).status, 1);
      assert.equal(await market.read.tickPositionId([tickId, BigInt(i)]), BigInt(i + 1));
    }
    const simulated = await client.simulateContract({
      address: market.address,
      abi,
      functionName: "repay",
      args: [3n, max],
      account: taker.account,
    });
    assert.equal(simulated.result.positionId, BigInt(v03.terminalRepay.positionId));
    assert.equal(simulated.result.tickId, tickId);
    assert.equal(simulated.result.tickSeq, BigInt(v03.terminalRepay.tickSeq));
    assert.equal(simulated.result.assetPrincipal, BigInt(v03.terminalRepay.assetPrincipal));
    assert.equal(simulated.result.exitFill, BigInt(v03.terminalRepay.exitFill));
    assert.equal(simulated.result.activeReturn, BigInt(v03.terminalRepay.activeReturn));
    assert.equal(simulated.result.yieldFeeAsset, simulated.result.grossYieldAsset / 100n);
    assert.equal(simulated.result.totalAssetIn, simulated.result.assetPrincipal + simulated.result.grossYieldAsset);
    assert.equal(simulated.result.exitFill + simulated.result.activeReturn, simulated.result.assetPrincipal);
    const hash = await market.write.repay([3n, max], { account: taker.account });
    const event = parseEventLogs({
      abi,
      logs: (await client.getTransactionReceipt({ hash })).logs,
      eventName: "TermRepaid",
    })[0].args;
    assert.equal(event.positionId, simulated.result.positionId);
    assert.equal(event.tickSeq, simulated.result.tickSeq);
    assert.equal(event.assetAmount, simulated.result.assetPrincipal);
    assert.equal(event.exitFill, simulated.result.exitFill);
    assert.equal(event.activeReturn, simulated.result.activeReturn);
    await assert.rejects(market.read.getPosition([3n]), /NotFound/);
    assert.equal(await market.read.tickPositionId([tickId, 2n]), BigInt(v03.terminalRepay.deletedTickPositionId));
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), [1n, 2n, 5n, 4n]);
    assert.equal((await market.read.getTick([tickId])).settleCursor,
      BigInt(v03.terminalRepay.cursorAfterOutOfOrder), "live, non-mature cursor stays put");

    await market.write.repay([2n, max], { account: taker.account });
    await market.write.repay([4n, max], { account: taker.account });
    await market.write.repay([1n, max], { account: taker.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor,
      BigInt(v03.deletedCursorGaps.afterCursorTargetRepay), "cursor-target Repay advances directly");
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), [5n]);
    await market.write.multicall([[encodeFunctionData({ abi, functionName: "supply",
      args: [tickId, E, zeroAddress] })]], { account: a.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor,
      BigInt(v03.deletedCursorGaps.afterOneGapSkip), "Multicall Supply skips one deleted entry");
    await market.write.multicall([[encodeFunctionData({ abi, functionName: "collect",
      args: [tickId] })]], { account: a.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor,
      BigInt(v03.deletedCursorGaps.afterSecondGapSkip), "Multicall Collect skips one deleted entry");
    await market.write.repay([5n, max], { account: taker.account });
    assert.equal(
      (await market.read.getTick([tickId])).settleCursor,
      BigInt(v03.deletedCursorGaps.afterNonCursorRepay),
      "non-cursor Repay skips one gap before resolving its target",
    );
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), []);
    await market.write.settle([tickId]);
    assert.equal((await market.read.getTick([tickId])).settleCursor, BigInt(v03.deletedCursorGaps.afterFinalGapSkip));
    await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], { account: taker.account });
    assert.equal(await market.read.nextPositionId(), 7n);
    assert.equal((await market.read.getPosition([6n])).tickSeq, 5n);
    assert.equal(await market.read.tickPositionId([tickId, 5n]), 6n);
  });

  it("returns CloseResult, includes activeFill, and deletes both direct and automatic Closes", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    for (let i = 0; i < 3; i++) {
      await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], { account: taker.account });
    }
    await networkHelpers.time.increase(Number(DAY));
    const simulated = await client.simulateContract({
      address: market.address,
      abi,
      functionName: "close",
      args: [3n],
      account: keeper.account,
    });
    assert.equal(simulated.result.positionId, BigInt(v03.terminalClose.positionId));
    assert.equal(simulated.result.tickId, tickId);
    assert.equal(simulated.result.tickSeq, BigInt(v03.terminalClose.tickSeq));
    assert.equal(simulated.result.exitFill, BigInt(v03.terminalClose.exitFill));
    assert.equal(simulated.result.activeFill, BigInt(v03.terminalClose.activeFill));
    assert.equal(simulated.result.exitFill + simulated.result.activeFill, 10n * E);
    assert.equal(simulated.result.exitQuote + simulated.result.activeQuote, simulated.result.providerSwapProceeds);
    const hash = await market.write.close([3n], { account: keeper.account });
    const events = parseEventLogs({
      abi,
      logs: (await client.getTransactionReceipt({ hash })).logs,
      eventName: "TermClosed",
    });
    assert.equal(events.length, 2, "one automatic cursor Close plus requested non-cursor Close");
    assert.deepEqual(
      events.map((entry) => entry.args.positionId),
      [1n, 3n],
    );
    assert.equal(events[1].args.activeFill, simulated.result.activeFill);
    assert.equal(events[1].args.providerSwapProceeds, simulated.result.providerSwapProceeds);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 1n);
    for (const [id, seq] of [
      [1n, 0n],
      [3n, 2n],
    ] as const) {
      await assert.rejects(market.read.getPosition([id]), /NotFound/);
      assert.equal(await market.read.tickPositionId([tickId, seq]), BigInt(v03.terminalClose.deletedTickPositionId));
    }
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), [2n]);
    await market.write.close([2n], { account: keeper.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor, 2n, "cursor-target Close advances once");
    await assert.rejects(market.read.getPosition([2n]), /NotFound/);
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), []);
    await market.write.settle([tickId]);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 3n, "deleted non-cursor Close skips once");
  });

  it("does not double-advance when a non-cursor Close becomes the cursor after one gap skip", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    for (let i = 0; i < 3; i++) {
      await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], { account: taker.account });
    }
    await market.write.repay([2n, max], { account: taker.account });
    await market.write.repay([1n, max], { account: taker.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor, 1n);
    await networkHelpers.time.increase(Number(DAY));
    const hash = await market.write.close([3n], { account: keeper.account });
    const events = parseEventLogs({ abi, logs: (await client.getTransactionReceipt({ hash })).logs,
      eventName: "TermClosed" });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.positionId, 3n);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 2n);
    await assert.rejects(market.read.getPosition([3n]), /NotFound/);
    await market.write.settle([tickId]);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 3n);
  });

  it("matches an independent active-list and cursor model across seeded out-of-order Repays", async () => {
    for (let seed = 1n; seed <= 8n; seed++) {
      const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
      await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
      const active = new Set<bigint>();
      const list: bigint[] = [];
      for (let i = 1n; i <= 8n; i++) {
        await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], { account: taker.account });
        active.add(i);
        list.push(i);
      }
      let cursor = 0n;
      let random = seed;
      while (list.length !== 0) {
        random = (random * 1_103_515_245n + 12_345n) % (1n << 31n);
        const index = Number(random % BigInt(list.length));
        const id = list[index];
        const seq = id - 1n;
        if (seq === cursor) cursor += 1n;
        else if (!active.has(cursor + 1n)) cursor += 1n;
        const last = list[list.length - 1];
        list[index] = last;
        list.pop();
        active.delete(id);
        await market.write.repay([id, max], { account: taker.account });
        assert.equal((await market.read.getTick([tickId])).settleCursor, cursor);
        assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), list);
        assert.deepEqual(await market.read.getUsePositions([taker.account.address, 1n, 3n]), list.slice(1, 4));
        assert.equal(await market.read.tickPositionId([tickId, seq]), 0n);
        await assert.rejects(market.read.getPosition([id]), /NotFound/);
      }
      while (cursor < 8n) {
        await market.write.settle([tickId]);
        cursor += 1n;
        assert.equal((await market.read.getTick([tickId])).settleCursor, cursor);
      }
      assert.equal(await market.read.nextPositionId(), 9n);
    }
  });

  it("Supply, Use, Withdraw, Exit-first Repay, Collect and immutable fees", async () => {
    const { market, tickId, deadline, ast, quo, checkCustody } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: a.account });
    assert.equal((await market.read.getDomain([tickId, 0])).P, P0);
    const useQuote = await market.simulate.previewUse([tickId, 400n * E]);
    assert.equal(useQuote.quotePrincipal, 400n * E);
    assert.equal(useQuote.fullTermYieldAsset, 103_360_000_000_000_000n);
    await market.write.use([tickId, 400n * E, useQuote.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    assert.equal((await market.read.getDomain([tickId, 0])).P, P0);
    assert.equal((await market.read.getTick([tickId])).activePrincipal, 1_000n * E);
    const before = await market.simulate.previewWithdraw([tickId, a.account.address, 500n * E]);
    assert.equal(before.availableAssetOut, 300n * E);
    assert.equal(before.workingToExit, 200n * E);
    await market.write.withdraw([tickId, 500n * E], { account: a.account });
    assert.equal((await market.read.getTick([tickId])).exitWorking, 200n * E);
    await networkHelpers.time.increase(3_600);
    const repay = await market.simulate.previewRepay([1n]);
    assert.equal(repay.exitFill, 200n * E);
    assert.equal(repay.activeReturn, 200n * E);
    await market.write.repay([1n, useQuote.fullTermYieldAsset], { account: taker.account });
    assert.equal((await market.read.getDomain([tickId, 0])).P, P0);
    assert.equal((await market.read.getDomain([tickId, 1])).generation, 1n);
    assert.ok((await market.read.accruedProtocolFees([ast.address])) >= repay.yieldFeeAsset);
    const claim = await market.simulate.previewCollect([tickId, a.account.address]);
    assert.equal(claim.exitAsset, 200n * E);
    assert.ok(claim.activeYieldAsset + claim.exitYieldAsset > 0n);
    await market.write.collect([tickId], { account: a.account });
    assert.equal((await market.simulate.previewCollect([tickId, a.account.address])).activeYieldAsset, 0n);
    assert.ok((await market.read.getEarnPosition([a.account.address, tickId])).outstandingActiveYieldAsset > 0n);
    assert.equal(await quo.read.balanceOf([taker.account.address]), 10n ** 33n);
    await checkCustody();
  });

  it("Swap and Close fund sums before depletion; new supplier inherits no old Quote", async () => {
    const { market, tickId, deadline, checkCustody } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1000n * E, zeroAddress], { account: a.account });
    const swap = await market.simulate.previewSwap([tickId, 400n * E]);
    await market.write.swap([tickId, 400n * E, swap.quotePrincipal, await deadline(), zeroAddress], {
      account: taker.account,
    });
    let d = await market.read.getDomain([tickId, 0]);
    assert.equal(d.quoteSum, (swap.providerSwapProceeds * P0) / (1000n * E));
    assert.equal(d.P, (P0 * 600n) / 1000n);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: b.account });
    assert.equal((await market.simulate.previewCollect([tickId, b.account.address])).activeQuote, 0n);
    const uq = await market.simulate.previewUse([tickId, 500n * E]);
    await market.write.use([tickId, 500n * E, uq.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(Number(DAY));
    await market.write.close([1n], { account: keeper.account });
    d = await market.read.getDomain([tickId, 0]);
    assert.equal(d.P, (((P0 * 600n) / 1000n) * 200n) / 700n);
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    const claimA = await market.simulate.previewCollect([tickId, a.account.address]);
    const claimB = await market.simulate.previewCollect([tickId, b.account.address]);
    assert.ok(claimA.activeQuote > claimB.activeQuote);
    await checkCustody();
  });

  it("golden C: generation rollover preserves historical proceeds", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    await market.write.swap([tickId, 100n * E, 100n * E, await deadline(), zeroAddress], { account: taker.account });
    assert.equal((await market.read.getDomain([tickId, 0])).generation, 1n);
    assert.equal((await market.read.generationMeta([tickId, 0, 0n]))[1], true);
    await market.write.supply([tickId, 50n * E, zeroAddress], { account: b.account });
    const old = await market.simulate.previewCollect([tickId, a.account.address]);
    assert.equal(old.activeQuote, 99n * E);
    assert.equal((await market.simulate.previewCollect([tickId, b.account.address])).activeQuote, 0n);
    await market.write.collect([tickId], { account: a.account });
    assert.equal((await market.read.getEarnPosition([a.account.address, tickId])).activePrincipalX36, 0n);
  });

  it("golden B: cross-scale rational carry, skipped scales, and bounded eight-scale history", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    const model = new TickModel();
    model.supply(a.account.address, MAX - 1n);
    model.supply(b.account.address, 1n);
    await market.write.supply([tickId, MAX - 1n, zeroAddress], { account: a.account });
    await market.write.supply([tickId, 1n, zeroAddress], { account: b.account });
    for (let i = 0; i < 8; i++) {
      const leave = i === 0 ? 10n ** 20n : 10n ** 21n;
      const amount = model.active.principal - leave;
      const proceeds = amount - amount / 100n;
      model.swap(amount, proceeds);
      await market.write.swap([tickId, amount, amount, await deadline(), zeroAddress], { account: taker.account });
      const d = await market.read.getDomain([tickId, 0]);
      assert.equal(d.P, model.active.P);
      assert.equal(Number(d.scale), model.active.scale);
      assert.equal(d.quoteSum, model.active.sums.quote);
      const expected = model.active.sync(model.get(a.account.address).active);
      const preview = await market.simulate.previewCollect([tickId, a.account.address]);
      assert.equal(preview.activeQuote, expected.gains.quote);
      assert.equal(
        (await market.read.getEarnPosition([a.account.address, tickId])).activePrincipalX36,
        model.active.principalX36(model.get(a.account.address).active),
      );
      if (i < 7) {
        const refill = MAX - model.active.principal;
        model.supply(b.account.address, refill);
        await market.write.supply([tickId, refill, zeroAddress], { account: b.account });
      }
    }
    assert.equal(model.active.scale, 8);
    model.swap(1n, 1n);
    await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
    const oldSnapshot = model.get(a.account.address).active;
    const firstSum = model.active.history.get("0:0")?.quote ?? 0n;
    assert.notEqual((oldSnapshot.initial * (firstSum - oldSnapshot.sums.quote)) % (oldSnapshot.P * X), 0n);
    assert.ok((model.active.history.get("0:1")?.quote ?? 0n) > 0n);
    assert.ok(model.active.sums.quote > 0n);
    const preview = await market.simulate.previewCollect([tickId, a.account.address]);
    assert.equal(preview.activeQuote, model.active.gain(model.get(a.account.address).active, "quote"));
    const finalAmount = model.active.principal;
    model.swap(finalAmount, finalAmount - finalAmount / 100n);
    await market.write.swap([tickId, finalAmount, finalAmount, await deadline(), zeroAddress], {
      account: taker.account,
    });
    assert.equal((await market.read.getDomain([tickId, 0])).generation, 1n);
    assert.equal((await market.read.generationMeta([tickId, 0, 0n]))[0], 8n);
    assert.equal((await market.read.generationMeta([tickId, 0, 0n]))[1], true);
    assert.equal(
      (await market.simulate.previewCollect([tickId, a.account.address])).activeQuote,
      model.active.gain(model.get(a.account.address).active, "quote"),
    );
    await market.write.collect([tickId], { account: a.account });
    const p = await market.read.getEarnPosition([a.account.address, tickId]);
    assert.equal(p.activePrincipalX36, model.active.principalX36(model.get(a.account.address).active));
  });

  it("handles exact scale threshold and a bounded multi-scale jump", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, MAX, zeroAddress], { account: a.account });
    await market.write.swap([tickId, MAX - 10n ** 21n, MAX, await deadline(), zeroAddress], { account: taker.account });
    let d = await market.read.getDomain([tickId, 0]);
    assert.equal(d.P, 10n ** 30n);
    assert.equal(d.scale, 0n);
    await market.write.supply([tickId, MAX - 10n ** 21n, zeroAddress], { account: b.account });
    await market.write.swap([tickId, MAX - 1n, MAX, await deadline(), zeroAddress], { account: taker.account });
    d = await market.read.getDomain([tickId, 0]);
    assert.equal(d.P, 10n ** 36n);
    assert.equal(d.scale, 4n);
    assert.equal((await market.read.scaleSums([tickId, 0, 0n, 0n]))[3], true);
  });

  it("keeps same-timestamp withdrawal restriction and preserves sub-raw Max remainder", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    const sameBlock = [
      encodeFunctionData({ abi, functionName: "supply", args: [tickId, 1n, zeroAddress] }),
      encodeFunctionData({ abi, functionName: "withdraw", args: [tickId, 1n, 0n, max] }),
    ];
    await assert.rejects(market.write.multicall([sameBlock], { account: a.account }));
    await market.write.supply([tickId, 2n, zeroAddress], { account: a.account });
    await market.write.supply([tickId, 1n, zeroAddress], { account: b.account });
    await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
    const before = await market.read.getEarnPosition([a.account.address, tickId]);
    assert.equal(before.activePrincipal, 1n);
    const preview = await market.simulate.previewWithdraw([tickId, a.account.address, max]);
    assert.equal(preview.principalAmount, 1n);
    await market.write.withdraw([tickId, max], { account: a.account });
    const after = await market.read.getEarnPosition([a.account.address, tickId]);
    assert.ok(after.activePrincipalX36 > 0n && after.activePrincipalX36 < X);
    assert.deepEqual(await market.read.getEarnPositions([a.account.address, 0n, 10n]), [tickId]);
    await assert.rejects(market.write.withdraw([tickId, max], { account: a.account }), /InvalidInput/);
  });

  it("hard-reverts Withdraw if the checked X36 domain invariant is corrupted", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    await networkHelpers.time.increase(1);
    // Locate the first word of the nested provider mapping without depending on
    // its compiler-assigned root slot. Valid actions cannot create this fault.
    let providerSlot: `0x${string}` | undefined;
    for (let mappingSlot = 0n; mappingSlot < 32n; mappingSlot++) {
      const providerOuter = BigInt(keccak256(encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }], [tickId, mappingSlot],
      )));
      const candidate = keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }], [a.account.address, providerOuter],
      ));
      const word = await client.getStorageAt({ address: market.address, slot: candidate });
      if (BigInt(word ?? "0x0") === 100n * E * X) {
        providerSlot = candidate;
        break;
      }
    }
    assert.ok(providerSlot, "provider principal storage word found");
    await networkHelpers.setStorageAt(market.address, providerSlot, 101n * E * X);
    assert.equal((await market.read.getEarnPosition([a.account.address, tickId])).activePrincipal, 101n * E);
    const before = await market.read.getTick([tickId]);
    await assert.rejects(market.write.withdraw([tickId, E], { account: a.account }), /Invariant/);
    assert.deepEqual(await market.read.getTick([tickId]), before);
  });

  it("charges each frozen 1% fee exactly once and never charges Collect", async () => {
    const { market, ast, quo, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1000n * E, zeroAddress], { account: a.account });
    const swap = await market.simulate.previewSwap([tickId, 100n * E]);
    await market.write.swap([tickId, 100n * E, swap.quotePrincipal, await deadline(), zeroAddress], {
      account: taker.account,
    });
    assert.equal(swap.swapFee, 1n * E);
    assert.equal(await market.read.accruedProtocolFees([quo.address]), swap.swapFee);
    const q = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(3_600);
    const beforeAsset = await ast.read.balanceOf([taker.account.address]);
    await market.write.repay([1n, q.fullTermYieldAsset], { account: taker.account });
    const afterAsset = await ast.read.balanceOf([taker.account.address]);
    const gross = beforeAsset - afterAsset - 100n * E;
    assert.equal(await market.read.accruedProtocolFees([ast.address]), gross / 100n);
    const q2 = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q2.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(Number(DAY));
    await market.write.close([2n], { account: keeper.account });
    assert.equal(await market.read.accruedProtocolFees([quo.address]), 2n * E);
    const feeAsset = await market.read.accruedProtocolFees([ast.address]);
    const feeQuote = await market.read.accruedProtocolFees([quo.address]);
    await market.write.collect([tickId], { account: a.account });
    assert.equal(await market.read.accruedProtocolFees([ast.address]), feeAsset);
    assert.equal(await market.read.accruedProtocolFees([quo.address]), feeQuote);
  });

  it("gives a supplier joining after Repay no historical Yield", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1000n * E, zeroAddress], { account: a.account });
    const q = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(3600);
    await market.write.repay([1n, q.fullTermYieldAsset], { account: taker.account });
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: b.account });
    assert.equal((await market.read.getEarnPosition([b.account.address, tickId])).claimableActiveYieldAsset, 0n);
    assert.ok((await market.read.getEarnPosition([a.account.address, tickId])).claimableActiveYieldAsset > 0n);
  });

  it("rejects a Use whose fixed term exceeds the cross-chain timestamp domain", async () => {
    const { market, pairId, tickId } = await networkHelpers.loadFixture(setup);
    const current = await market.read.getTick([tickId]);
    const direction = current.asset.toLowerCase() < current.quote.toLowerCase() ? 0 : 1;
    const duration = 106_751_991_167_300n;
    const id = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pairId, direction, 0, duration],
        ),
      ),
    );
    await market.write.createTick([pairId, direction, 0, duration]);
    await market.write.supply([id, 1n, zeroAddress], { account: a.account });
    await assert.rejects(market.write.use([id, 1n, max, max, zeroAddress], { account: taker.account }));
  });

  it("rejects zero Asset and stores only positive full-term Yield", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1n, zeroAddress], { account: a.account });
    const before = await market.read.getTick([tickId]);
    await assert.rejects(market.write.use([tickId, 0n, max, await deadline(), zeroAddress],
      { account: taker.account }), /InvalidInput/);
    assert.equal(await market.read.nextPositionId(), 1n);
    assert.deepEqual(await market.read.getTick([tickId]), before);
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), []);
    const [, fullYield] = await market.read.quoteUse([tickId, 1n]);
    assert.ok(fullYield > 0n, "canonical rounding makes every positive valid Use quote positive");
    await market.write.use([tickId, 1n, fullYield, await deadline(), zeroAddress], { account: taker.account });
    assert.equal((await market.read.getPosition([1n])).fullTermYieldAsset, fullYield);
  });

  it("bills one second for same-timestamp Repay, permits near-maturity Repay, and Closes at maturity", async () => {
    const { market, ast, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1000n * E, zeroAddress], { account: a.account });
    const q = await market.simulate.previewUse([tickId, 100n * E]);
    const beforeAsset = await ast.read.balanceOf([taker.account.address]);
    await market.write.multicall(
      [
        [
          encodeFunctionData({
            abi,
            functionName: "use",
            args: [tickId, 100n * E, q.fullTermYieldAsset, await deadline(), zeroAddress],
          }),
          encodeFunctionData({ abi, functionName: "repay", args: [1n, q.fullTermYieldAsset] }),
        ],
      ],
      { account: taker.account },
    );
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    const oneSecondYield = (q.fullTermYieldAsset + DAY - 1n) / DAY;
    assert.equal(beforeAsset - (await ast.read.balanceOf([taker.account.address])), oneSecondYield);
    const q2 = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q2.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    const p2 = await market.read.getPosition([2n]);
    await networkHelpers.time.setNextBlockTimestamp(Number(p2.maturity - 1n));
    await market.write.repay([2n, q2.fullTermYieldAsset], { account: taker.account });
    await assert.rejects(market.read.getPosition([2n]), /NotFound/);
    const q3 = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q3.fullTermYieldAsset, (await deadline()) + DAY, zeroAddress], {
      account: taker.account,
    });
    const p3 = await market.read.getPosition([3n]);
    await networkHelpers.time.setNextBlockTimestamp(Number(p3.maturity));
    await market.write.close([3n], { account: keeper.account });
    await assert.rejects(market.read.getPosition([3n]), /NotFound/);
    const q4 = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q4.fullTermYieldAsset, (await deadline()) + DAY, zeroAddress], {
      account: taker.account,
    });
    const p4 = await market.read.getPosition([4n]);
    await networkHelpers.time.setNextBlockTimestamp(Number(p4.maturity));
    await assert.rejects(market.write.repay([4n, q4.fullTermYieldAsset], { account: taker.account }));
  });

  it("resolves Exit first on Close and keeps Exit generation proceeds collectible", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    const q = await market.simulate.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, q.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await market.write.withdraw([tickId, 100n * E], { account: a.account });
    assert.equal((await market.read.getTick([tickId])).exitWorking, 100n * E);
    await networkHelpers.time.increase(Number(DAY));
    await market.write.settle([tickId], { account: keeper.account });
    assert.equal((await market.read.getDomain([tickId, 1])).generation, 1n);
    const claim = await market.simulate.previewCollect([tickId, a.account.address]);
    assert.equal(claim.exitQuote, 99n * E);
    assert.equal(claim.activeQuote, 0n);
    await market.write.collect([tickId], { account: a.account });
    assert.equal((await market.simulate.previewCollect([tickId, a.account.address])).totalQuoteOut, 0n);
  });

  it("accepts a new Exit deposit after partial resolution and allocates later Close proceeds", async () => {
    const { market, tickId, deadline, checkCustody } = await networkHelpers.loadFixture(setup);
    const model = new TickModel();
    for (const who of [a, b]) {
      model.supply(who.account.address, 1000n * E);
      await market.write.supply([tickId, 1000n * E, zeroAddress], { account: who.account });
    }
    for (const amount of [200n * E, 400n * E]) {
      const q = await market.simulate.previewUse([tickId, amount]);
      model.use(amount);
      await market.write.use([tickId, amount, q.fullTermYieldAsset, await deadline(), zeroAddress], {
        account: taker.account,
      });
    }
    model.withdraw(a.account.address, 1000n * E);
    await market.write.withdraw([tickId, 1000n * E], { account: a.account });
    assert.equal((await market.read.getTick([tickId])).exitWorking, 300n * E);
    const p1 = await market.read.getPosition([1n]);
    const hash = await market.write.repay([1n, p1.fullTermYieldAsset], { account: taker.account });
    const receipt = await client.getTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const term = BigInt(p1.maturity) - BigInt(p1.openedAt);
    const elapsed = block.timestamp - BigInt(p1.openedAt);
    const gross = (BigInt(p1.fullTermYieldAsset) * (elapsed > 0n ? elapsed : 1n) + term - 1n) / term;
    model.repay(200n * E, gross - gross / 100n);
    assert.equal((await market.read.getTick([tickId])).exitWorking, 100n * E);
    model.withdraw(b.account.address, 500n * E);
    await market.write.withdraw([tickId, 500n * E], { account: b.account });
    assert.equal((await market.read.getTick([tickId])).exitWorking, model.exitWorking);
    const p2 = await market.read.getPosition([2n]);
    await networkHelpers.time.setNextBlockTimestamp(Number(p2.maturity));
    model.close(400n * E, BigInt(p2.quotePrincipal) - BigInt(p2.closeFee));
    await market.write.close([2n], { account: keeper.account });
    const exit = await market.read.getDomain([tickId, 1]);
    assert.equal(exit.P, model.exit.P);
    assert.equal(Number(exit.generation), model.exit.generation);
    for (const who of [a, b]) {
      const ref = model.get(who.account.address);
      const v = await market.read.getEarnPosition([who.account.address, tickId]);
      assert.equal(
        v.claimableExitAsset,
        ref.owedExitAsset + model.exit.gainWithFraction(ref.exit, "asset", ref.exitFractions.asset),
      );
      assert.equal(
        v.claimableExitQuote,
        ref.owedExitQuote + model.exit.gainWithFraction(ref.exit, "quote", ref.exitFractions.quote),
      );
    }
    await checkCustody();
  });

  const fuzzSeeds = Number(process.env.YLD_FUZZ_SEEDS ?? 128);
  for (const seedIndex of Array.from({ length: fuzzSeeds }, (_, i) => i)) {
    const initialSeed = 0x51a7n + BigInt(seedIndex) * 0x9e3779b1n;
    it(`compares seeded stateful actions against a rational Product-Sum model (${initialSeed})`, async () => {
      const { market, ast, quo, tickId, deadline, checkCustody } = await networkHelpers.loadFixture(setup);
      const model = new TickModel();
      const providers = [a, b, keeper] as const;
      const takers = [taker, keeper] as const;
      const positions = new Map<
        bigint,
        { amount: bigint; full: bigint; opened: bigint; maturity: bigint; quote: bigint; closeFee: bigint }
      >();
      let seed = initialSeed;
      const draw = () => {
        seed = (seed * 1103515245n + 12345n) % 2n ** 31n;
        return seed;
      };
      async function check() {
        const tick = await market.read.getTick([tickId]);
        assert.equal(tick.availableSupply, model.available);
        assert.equal(tick.workingSupply, model.working);
        assert.equal(tick.exitWorking, model.exitWorking);
        assert.equal(tick.activePrincipal, model.active.principal);
        assert.ok(tick.exitWorking <= tick.workingSupply);
        assert.equal(tick.activePrincipal, tick.availableSupply + tick.workingSupply - tick.exitWorking);
        for (const [kind, ref] of [
          [0, model.active],
          [1, model.exit],
        ] as const) {
          const d = await market.read.getDomain([tickId, kind]);
          assert.equal(d.P, ref.P);
          assert.equal(Number(d.scale), ref.scale);
          assert.equal(Number(d.generation), ref.generation);
          assert.equal(d.assetSum, ref.sums.asset);
          assert.equal(d.yieldSum, ref.sums.yield);
          assert.equal(d.quoteSum, ref.sums.quote);
          if (ref.principal > 0n) assert.ok(d.P >= 10n ** 30n);
        }
        let activeX36 = 0n;
        let exitX36 = 0n;
        const now = (await client.getBlock()).timestamp;
        for (const who of providers) {
          const ref = model.get(who.account.address);
          const v = await market.read.getEarnPosition([who.account.address, tickId]);
          const activeYield =
            ref.owedActiveYield + model.active.gainWithFraction(ref.active, "yield", ref.activeFractions.yield);
          const exitYield = ref.owedExitYield + model.exit.gainWithFraction(ref.exit, "yield", ref.exitFractions.yield);
          assert.equal(v.activePrincipalX36, model.active.principalX36(ref.active));
          assert.equal(v.exitPrincipalX36, model.exit.principalX36(ref.exit));
          assert.equal(v.outstandingActiveYieldAsset, activeYield);
          assert.equal(
            v.claimableActiveQuote,
            ref.owedActiveQuote + model.active.gainWithFraction(ref.active, "quote", ref.activeFractions.quote),
          );
          assert.equal(
            v.claimableExitAsset,
            ref.owedExitAsset + model.exit.gainWithFraction(ref.exit, "asset", ref.exitFractions.asset),
          );
          assert.equal(v.outstandingExitYieldAsset, exitYield);
          assert.equal(
            v.claimableExitQuote,
            ref.owedExitQuote + model.exit.gainWithFraction(ref.exit, "quote", ref.exitFractions.quote),
          );
          const elapsed = now - ref.timestamp < DAY ? now - ref.timestamp : DAY;
          assert.equal(v.timestamp, ref.timestamp);
          assert.equal(v.vestingElapsedSeconds, elapsed);
          assert.equal(v.claimableActiveYieldAsset, (activeYield * elapsed) / DAY);
          assert.equal(v.claimableExitYieldAsset, (exitYield * elapsed) / DAY);
          activeX36 += v.activePrincipalX36;
          exitX36 += v.exitPrincipalX36;
          if (v.activePrincipalX36 > 0n && v.activePrincipalX36 < X)
            assert.deepEqual(await market.read.getEarnPositions([who.account.address, 0n, 10n]), [tickId]);
        }
        assert.ok(activeX36 <= model.active.principal * X);
        assert.ok(exitX36 <= model.exit.principal * X);
        assert.equal(await market.read.accruedProtocolFees([ast.address]), model.assetFees);
        assert.equal(await market.read.accruedProtocolFees([quo.address]), model.quoteFees);
        assert.equal(await market.read.tokenLiability([ast.address]), model.assetLiability());
        assert.equal(await market.read.tokenLiability([quo.address]), model.quoteLiability());
        assert.equal(await ast.read.balanceOf([market.address]), model.assetLiability());
        assert.equal(await quo.read.balanceOf([market.address]), model.quoteLiability());
        await checkCustody();
      }
      for (const [who, amount] of [
        [a, 700n * E],
        [b, 300n * E],
      ] as const) {
        const hash = await market.write.supply([tickId, amount, zeroAddress], { account: who.account });
        const receipt = await client.getTransactionReceipt({ hash });
        model.supply(
          who.account.address,
          amount,
          (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp,
        );
        await check();
      }
      for (let round = 0; round < 12; round++) {
        if (draw() % 2n === 0n) {
          const amount = (10n + (draw() % 31n)) * E;
          const supplier = providers[Number(draw() % 3n)];
          const beforeP = (await market.read.getDomain([tickId, 0])).P;
          const hash = await market.write.supply([tickId, amount, zeroAddress], { account: supplier.account });
          const receipt = await client.getTransactionReceipt({ hash });
          model.supply(
            supplier.account.address,
            amount,
            (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp,
          );
          assert.equal((await market.read.getDomain([tickId, 0])).P, beforeP);
          await check();
        }
        if (model.available > 10n * E && draw() % 3n !== 0n) {
          const requested = (1n + (draw() % 20n)) * E;
          const amount = requested < model.available ? requested : model.available;
          const q = await market.simulate.previewSwap([tickId, amount]);
          const before = model.active.principal;
          const fee = amount / 100n;
          assert.equal(q.quotePrincipal, amount);
          assert.equal(q.swapFee, fee);
          model.swap(amount, amount - fee);
          model.quoteFees += fee;
          const buyer = takers[Number(draw() % 2n)];
          await market.write.swap([tickId, amount, q.quotePrincipal, await deadline(), zeroAddress], {
            account: buyer.account,
          });
          assert.equal((await market.read.getTick([tickId])).activePrincipal, before - amount);
          await check();
        }
        if (model.available > 50n * E && round % 2 === 0) {
          const amount = (20n + (draw() % 30n)) * E;
          const full = fullTermYield(model.available, model.working - model.exitWorking, amount);
          assert.deepEqual(await market.read.quoteUse([tickId, amount]), [amount, full]);
          const beforeP = (await market.read.getDomain([tickId, 0])).P;
          model.use(amount);
          const positionId = await market.read.nextPositionId();
          const positionTaker = takers[Number(draw() % 2n)];
          const useHash = await market.write.use([tickId, amount, full, await deadline(), zeroAddress], {
            account: positionTaker.account,
          });
          const useReceipt = await client.getTransactionReceipt({ hash: useHash });
          const opened = (await client.getBlock({ blockNumber: useReceipt.blockNumber })).timestamp;
          positions.set(positionId, {
            amount,
            full,
            opened,
            maturity: opened + DAY,
            quote: amount,
            closeFee: amount / 100n,
          });
          assert.equal((await market.read.getDomain([tickId, 0])).P, beforeP);
          await check();
          const withdrawer = providers[Number(draw() % 3n)];
          const providerRaw = model.active.principalX36(model.get(withdrawer.account.address).active) / X;
          if (providerRaw > 10n * E) {
            const requested = providerRaw / 5n;
            const beforePrincipal = model.active.principal;
            const beforeX36 = model.active.principalX36(model.get(withdrawer.account.address).active);
            const hash = await market.write.withdraw([tickId, requested], { account: withdrawer.account });
            const receipt = await client.getTransactionReceipt({ hash });
            const now = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
            const withdrawn = model.withdraw(withdrawer.account.address, requested, now);
            const event = parseEventLogs({ abi, logs: receipt.logs, eventName: "Withdrawn" })[0].args;
            assert.equal(event.yieldAssetOut, withdrawn.yieldOut);
            assert.equal(event.forfeitedYield, withdrawn.forfeited);
            assert.equal((await market.read.getTick([tickId])).activePrincipal, beforePrincipal - withdrawn.x);
            assert.equal(
              (await market.read.getEarnPosition([withdrawer.account.address, tickId])).activePrincipalX36,
              beforeX36 - withdrawn.x * X,
            );
            await check();
          }
          if (round % 4 === 0) {
            const p = positions.get(positionId)!;
            await networkHelpers.time.setNextBlockTimestamp(Number(p.maturity));
            const beforeActive = model.active.principal;
            const beforeExit = model.exit.principal;
            model.close(amount, p.quote - p.closeFee);
            model.quoteFees += p.closeFee;
            await market.write.settle([tickId], { account: keeper.account });
            assert.equal(
              (await market.read.getTick([tickId])).activePrincipal,
              beforeActive - (amount - (beforeExit - model.exit.principal)),
            );
            await check();
          } else {
            const p = positions.get(positionId)!;
            const hash = await market.write.repay([positionId, p.full], {
              account: positionTaker.account,
            });
            const receipt = await client.getTransactionReceipt({ hash });
            const block = await client.getBlock({ blockNumber: receipt.blockNumber });
            const elapsed = block.timestamp - p.opened;
            const billable = elapsed > 0n ? elapsed : 1n;
            const term = p.maturity - p.opened;
            const gross = (p.full * billable + term - 1n) / term;
            model.assetFees += gross / 100n;
            const beforeP = (await market.read.getDomain([tickId, 0])).P;
            model.repay(amount, gross - gross / 100n);
            assert.equal((await market.read.getDomain([tickId, 0])).P, beforeP);
            await check();
          }
        }
        if (round % 3 === 0) {
          const who = providers[Number(draw() % 3n)];
          const hash = await market.write.collect([tickId], { account: who.account });
          const receipt = await client.getTransactionReceipt({ hash });
          const now = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
          const predicted = model.collect(who.account.address, now);
          const event = parseEventLogs({ abi, logs: receipt.logs, eventName: "Collected" })[0].args;
          assert.equal(event.activeYieldAsset, predicted.activeYield);
          assert.equal(event.exitYieldAsset, predicted.exitYield);
          assert.equal(event.exitAsset, predicted.exitAsset);
          assert.equal(event.activeQuote, predicted.activeQuote);
          assert.equal(event.exitQuote, predicted.exitQuote);
          await check();
        }
        await market.write.settle([tickId], { account: keeper.account });
        await check();
        if (round % 6 === 5 && model.working === 0n && model.available > 0n) {
          const amount = model.available;
          const q = await market.simulate.previewSwap([tickId, amount]);
          const fee = amount / 100n;
          model.swap(amount, amount - fee);
          model.quoteFees += fee;
          await market.write.swap([tickId, amount, q.quotePrincipal, await deadline(), zeroAddress], {
            account: taker.account,
          });
          await check();
          for (const supplier of [a, keeper]) {
            const hash = await market.write.supply([tickId, 1n, zeroAddress], { account: supplier.account });
            const receipt = await client.getTransactionReceipt({ hash });
            model.supply(
              supplier.account.address,
              1n,
              (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp,
            );
            await check();
          }
          model.swap(1n, 1n);
          await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
          await check();
        }
      }
      // Terminal reconciliation for a fixed subset of the deterministic seeds.
      if (seedIndex < 8) {
        await networkHelpers.time.increase(Number(DAY));
        while ((await market.read.getTick([tickId])).settleCursor < BigInt(positions.size)) {
          const hash = await market.write.settle([tickId], { account: keeper.account });
          const receipt = await client.getTransactionReceipt({ hash });
          for (const event of parseEventLogs({ abi, logs: receipt.logs, eventName: "TermClosed" })) {
            const p = positions.get(event.args.positionId)!;
            model.close(p.amount, p.quote - p.closeFee);
            model.quoteFees += p.closeFee;
          }
          await check();
        }
        assert.equal(model.working, 0n);
        assert.equal(model.exitWorking, 0n);
        for (const who of providers) {
          const transferable = (await market.read.getEarnPosition([who.account.address, tickId])).activePrincipal;
          if (transferable === 0n) continue;
          const hash = await market.write.withdraw([tickId, transferable, 0n, max], { account: who.account });
          const now = (await client.getBlock({ blockNumber: (await client.getTransactionReceipt({ hash })).blockNumber })).timestamp;
          const predicted = model.withdraw(who.account.address, transferable, now);
          assert.equal(predicted.x, transferable);
          await check();
        }
        await networkHelpers.time.increase(Number(DAY));
        for (const who of providers) {
          const hash = await market.write.collect([tickId], { account: who.account });
          const receipt = await client.getTransactionReceipt({ hash });
          const now = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
          const predicted = model.collect(who.account.address, now);
          const event = parseEventLogs({ abi, logs: receipt.logs, eventName: "Collected" })[0].args;
          assert.equal(event.activeYieldAsset, predicted.activeYield);
          assert.equal(event.exitYieldAsset, predicted.exitYield);
          assert.equal(event.exitAsset, predicted.exitAsset);
          assert.equal(event.activeQuote, predicted.activeQuote);
          assert.equal(event.exitQuote, predicted.exitQuote);
          const claim = await market.read.getEarnPosition([who.account.address, tickId]);
          assert.equal(claim.claimableActiveYieldAsset + claim.claimableExitYieldAsset + claim.claimableExitAsset
            + claim.claimableActiveQuote + claim.claimableExitQuote, 0n);
          await check();
        }
        await market.write.collectProtocolFees([ast.address]);
        model.assetFees = 0n;
        await market.write.collectProtocolFees([quo.address]);
        model.quoteFees = 0n;
        await check();
        const tick = await market.read.getTick([tickId]);
        assert.equal(tick.workingSupply, 0n);
        assert.equal(tick.exitWorking, 0n);
        assert.equal(tick.availableSupply, model.available);
        // With no escrow or fees, liability is exactly the remaining reserves and principal.
        assert.equal(await market.read.tokenLiability([ast.address]),
          model.available + model.exitAssetReserve + model.fundedYield - model.paidYield - model.forfeitureFees);
        assert.equal(await market.read.tokenLiability([quo.address]),
          model.activeQuoteReserve + model.exitQuoteReserve);
        assert.ok(model.available <= BigInt(providers.length), "only fixed-point principal dust may remain");
        const dustLimit = BigInt(providers.length) * BigInt(positions.size + 24);
        assert.ok(model.exitAssetReserve + model.fundedYield - model.paidYield - model.forfeitureFees <= dustLimit,
          "unclaimed Asset reserves stay within per-distribution fixed-point dust");
        assert.ok(model.activeQuoteReserve + model.exitQuoteReserve <= dustLimit,
          "unclaimed Quote reserves stay within per-distribution fixed-point dust");
      }
    });
  }

  it("supports Multicall withdrawal plus collection and exact one-position settlement", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    const uq = await market.simulate.previewUse([tickId, 20n * E]);
    await market.write.use([tickId, 20n * E, uq.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(Number(DAY));
    const before = await market.simulate.previewCollect([tickId, a.account.address]);
    assert.ok(before.activeQuote > 0n);
    const calls = [
      encodeFunctionData({ abi, functionName: "withdraw", args: [tickId, 50n * E, 0n, max] }),
      encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
    ];
    await market.write.multicall([calls], { account: a.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor, 1n);
    assert.equal((await market.simulate.previewCollect([tickId, a.account.address])).totalQuoteOut, 0n);
  });

  it("supports settle plus collect and multiple mature Closes in one Multicall", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    for (let i = 0; i < 2; i++)
      await market.write.use([tickId, 10n * E, max, await deadline(), zeroAddress], { account: taker.account });
    await networkHelpers.time.increase(Number(DAY));
    await market.write.multicall(
      [
        [
          encodeFunctionData({ abi, functionName: "close", args: [1n] }),
          encodeFunctionData({ abi, functionName: "close", args: [2n] }),
        ],
      ],
      { account: keeper.account },
    );
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    await assert.rejects(market.read.getPosition([2n]), /NotFound/);
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), []);
    await market.write.multicall(
      [
        [
          encodeFunctionData({ abi, functionName: "settle", args: [tickId] }),
          encodeFunctionData({ abi, functionName: "collect", args: [tickId] }),
        ],
      ],
      { account: a.account },
    );
    assert.equal((await market.simulate.previewCollect([tickId, a.account.address])).totalQuoteOut, 0n);
  });

  it("simulates the same one-step Close in state-sensitive actions", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    const useQuote = await market.simulate.previewUse([tickId, 20n * E]);
    await market.write.use([tickId, 20n * E, useQuote.fullTermYieldAsset, await deadline(), zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(Number(DAY));
    const supply = await market.simulate.previewSupply([tickId, 10n * E], { account: a.account });
    const withdrawal = await market.simulate.previewWithdraw([tickId, a.account.address, 100n * E]);
    const use = await market.simulate.previewUse([tickId, 10n * E]);
    const claim = await market.simulate.previewCollect([tickId, a.account.address]);
    assert.equal(supply.resultingActivePrincipal, 90n * E);
    assert.equal(supply.marketAvailable, 90n * E);
    assert.equal(withdrawal.providerPrincipal, 80n * E);
    assert.equal(withdrawal.availableAssetOut, 80n * E);
    assert.equal(use.assetAmount, 10n * E);
    assert.equal(claim.activeQuote, useQuote.quotePrincipal - useQuote.closeFee);
    await market.write.supply([tickId, 10n * E, zeroAddress], { account: a.account });
    assert.equal(
      (await market.read.getEarnPosition([a.account.address, tickId])).activePrincipal,
      supply.resultingActivePrincipal,
    );
    assert.equal((await market.read.getTick([tickId])).settleCursor, 1n);
    assert.equal((await market.read.getTick([tickId])).activeWorking, 0n);
  });

  it("matches every simulated Tick action after one Exit-first Close", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    for (const supplier of [a, b]) {
      await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    }
    await market.write.use([tickId, 400n * E, max, await deadline(), zeroAddress], { account: taker.account });
    await market.write.withdraw([tickId, 500n * E], { account: a.account });
    assert.ok((await market.read.getTick([tickId])).exitWorking > 0n);

    await networkHelpers.time.increase(100);
    await market.write.use([tickId, 100n * E, max, await deadline(), zeroAddress], { account: taker.account });
    const first = await market.read.getPosition([1n]);
    const second = await market.read.getPosition([2n]);
    assert.ok(second.maturity > first.maturity);
    await networkHelpers.time.increaseTo(Number(first.maturity));

    const before = {
      supply: await market.simulate.previewSupply([tickId, 10n * E], { account: b.account }),
      withdraw: await market.simulate.previewWithdraw([tickId, b.account.address, 50n * E]),
      use: await market.simulate.previewUse([tickId, 10n * E]),
      swap: await market.simulate.previewSwap([tickId, 10n * E]),
      collectA: await market.simulate.previewCollect([tickId, a.account.address]),
      collectB: await market.simulate.previewCollect([tickId, b.account.address]),
      repay: await market.simulate.previewRepay([2n]),
    };
    assert.ok(before.collectA.exitQuote > 0n);
    assert.ok(before.collectB.activeQuote > 0n);

    await market.write.settle([tickId], { account: keeper.account });
    assert.equal((await market.read.getTick([tickId])).settleCursor, 1n);
    assert.equal((await market.read.getPosition([2n])).status, 1);
    assert.deepEqual(await market.simulate.previewSupply([tickId, 10n * E], { account: b.account }), before.supply);
    assert.deepEqual(await market.simulate.previewWithdraw([tickId, b.account.address, 50n * E]), before.withdraw);
    assert.deepEqual(await market.simulate.previewSwap([tickId, 10n * E]), before.swap);
    assert.deepEqual(await market.simulate.previewCollect([tickId, a.account.address]), before.collectA);
    assert.deepEqual(await market.simulate.previewCollect([tickId, b.account.address]), before.collectB);
    const afterUse = await market.simulate.previewUse([tickId, 10n * E]);
    assert.deepEqual({ ...afterUse, maturity: 0n, openedAt: 0n }, { ...before.use, maturity: 0n, openedAt: 0n });
    const afterRepay = await market.simulate.previewRepay([2n]);
    assert.equal(afterRepay.exitFill, before.repay.exitFill);
    assert.equal(afterRepay.activeReturn, before.repay.activeReturn);
    assert.equal(afterRepay.quotePrincipalUnlocked, before.repay.quotePrincipalUnlocked);
  });

  it("supports sequential Uses, Swaps, and Repays in one Multicall", async () => {
    const { market, tickId, deadline } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1000n * E, zeroAddress], { account: a.account });
    const useQuote = await market.simulate.previewUse([tickId, 100n * E]);
    const swapQuote = await market.simulate.previewSwap([tickId, 20n * E]);
    const dl = await deadline();
    const calls = [
      encodeFunctionData({ abi, functionName: "use", args: [tickId, 100n * E, max, dl, zeroAddress] }),
      encodeFunctionData({ abi, functionName: "use", args: [tickId, 100n * E, max, dl, zeroAddress] }),
      encodeFunctionData({
        abi,
        functionName: "swap",
        args: [tickId, 20n * E, swapQuote.quotePrincipal, dl, zeroAddress],
      }),
      encodeFunctionData({
        abi,
        functionName: "swap",
        args: [tickId, 20n * E, swapQuote.quotePrincipal, dl, zeroAddress],
      }),
      encodeFunctionData({ abi, functionName: "repay", args: [1n, max] }),
      encodeFunctionData({ abi, functionName: "repay", args: [2n, max] }),
    ];
    await market.write.multicall([calls], { account: taker.account });
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    await assert.rejects(market.read.getPosition([2n]), /NotFound/);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 2n);
    assert.equal((await market.read.getTick([tickId])).activePrincipal, 960n * E);
    assert.ok(useQuote.fullTermYieldAsset > 0n);
  });

  it("rejects fee-on-transfer and callback token behavior", async () => {
    const bad = await viem.deployContract("FeeOnTransferToken");
    const other = await viem.deployContract("MockERC20", ["Quote", "Q", 18]);
    const m = await viem.deployContract("YieldOrders", [deployer.account.address]);
    const market = getContract({ address: m.address, abi, client: { public: client, wallet: deployer } });
    const token = getContract({
      address: bad.address,
      abi: feeOnTransferTokenAbi,
      client: { public: client, wallet: deployer },
    });
    await market.write.createPair([bad.address, other.address]);
    const [pair] = await market.read.getPair([bad.address, other.address]);
    const id = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pair, bad.address.toLowerCase() < other.address.toLowerCase() ? 0 : 1, 0, 1n],
        ),
      ),
    );
    await market.write.createTick([pair, bad.address.toLowerCase() < other.address.toLowerCase() ? 0 : 1, 0, 1n]);
    await token.write.mint([a.account.address, 100n * E]);
    await token.write.approve([market.address, max], { account: a.account });
    await assert.rejects(market.write.supply([id, 100n * E, zeroAddress], { account: a.account }));
    const reentrant = await viem.deployContract("ReentrantToken");
    const rt = getContract({
      address: reentrant.address,
      abi: reentrantTokenAbi,
      client: { public: client, wallet: deployer },
    });
    await market.write.createPair([reentrant.address, other.address]);
    const [pair2] = await market.read.getPair([reentrant.address, other.address]);
    const dir2 = reentrant.address.toLowerCase() < other.address.toLowerCase() ? 0 : 1;
    const id2 = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pair2, dir2, 0, 1n],
        ),
      ),
    );
    await market.write.createTick([pair2, dir2, 0, 1n]);
    await rt.write.mint([a.account.address, 100n * E]);
    await rt.write.approve([market.address, max], { account: a.account });
    await rt.write.arm([market.address, encodeFunctionData({ abi, functionName: "collect", args: [id2] })]);
    await market.write.supply([id2, 100n * E, zeroAddress], { account: a.account });
    assert.equal(await rt.read.attempted(), true);
    assert.equal(await rt.read.succeeded(), false);
  });

  it("creates no claim from donations and rejects an observable rebasing deficit", async () => {
    const { market, ast, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: a.account });
    await ast.write.mint([market.address, 10n * E]);
    assert.equal(await market.read.tokenLiability([ast.address]), 100n * E);
    assert.equal((await market.read.getEarnPosition([a.account.address, tickId])).activePrincipal, 100n * E);
    const rebasing = await viem.deployContract("BalanceReducingToken");
    const quote = await viem.deployContract("MockERC20", ["Quote", "Q", 18]);
    const deployed = await viem.deployContract("YieldOrders", [deployer.account.address]);
    const protocol = getContract({ address: deployed.address, abi, client: { public: client, wallet: deployer } });
    await protocol.write.createPair([rebasing.address, quote.address]);
    const [pair] = await protocol.read.getPair([rebasing.address, quote.address]);
    const direction = rebasing.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const id = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pair, direction, 0, 1n],
        ),
      ),
    );
    await protocol.write.createTick([pair, direction, 0, 1n]);
    await rebasing.write.mint([a.account.address, 100n * E]);
    await rebasing.write.approve([protocol.address, max], { account: a.account });
    await protocol.write.supply([id, 50n * E, zeroAddress], { account: a.account });
    await rebasing.write.reduceBalance([protocol.address, 1n]);
    await assert.rejects(protocol.write.supply([id, 1n, zeroAddress], { account: a.account }));
  });

  it("uses deterministic initcode and guarded salt for equal cross-chain CREATE2 predictions", async () => {
    const artifact = await readArtifact();
    assert.deepEqual((artifact as any).linkReferences, {});
    assert.deepEqual((artifact as any).deployedLinkReferences, {});
    const salt = candidateSalt(42n);
    assert.equal(salt, keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }], [SALT_NAMESPACE, 42n],
    )));
    const one = predict(artifact, deployer.account.address, salt);
    const perNetwork = Object.values(NETWORKS).map(() => predict(artifact, deployer.account.address, salt));
    const two = perNetwork[1];
    assert.equal(one.address, two.address);
    assert.equal(one.guardedSalt, guardSalt(salt));
    assert.equal(one.creationCodeHash, two.creationCodeHash);
    assert.ok(
      perNetwork.every((entry) => entry.address === one.address && entry.runtimeCodeHash === one.runtimeCodeHash),
    );
  });
});
