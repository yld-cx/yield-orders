import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getContract, getContractAddress, keccak256, parseEventLogs, zeroAddress } from "viem";
import protocolAbiJson from "../abi/YieldOrders.json" with { type: "json" };
import type { YieldOrders$Type } from "../artifacts/contracts/YieldOrders.sol/artifacts.js";
import { mockERC20Abi } from "./abi/mocks.js";

const abi = protocolAbiJson as unknown as YieldOrders$Type["abi"];
const MAX = 2n ** 256n - 1n;
const E = 10n ** 18n;
const DAY = 86_400n;

describe("audit regressions", async () => {
  const { viem, networkHelpers } = await network.create();
  const [fee, alice, bob, taker, keeper] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  it("rejects zero and self fee recipients", async () => {
    await assert.rejects(viem.deployContract("YieldOrders", [zeroAddress]));
    const nonce = await client.getTransactionCount({ address: fee.account.address });
    const ownAddress = getContractAddress({ from: fee.account.address, nonce: BigInt(nonce) });
    await assert.rejects(viem.deployContract("YieldOrders", [ownAddress]));
  });

  async function setup(blocked: "quote" | "asset" | "none" = "none") {
    const makeToken = async (name: string, symbol: string, shouldBlock: boolean) =>
      shouldBlock
        ? viem.deployContract("BlockingRecipientToken", [fee.account.address])
        : viem.deployContract("MockERC20", [name, symbol, 18]);
    const asset: any = await makeToken("Asset", "AST", blocked === "asset");
    const quote: any = await makeToken("Quote", "QUO", blocked === "quote");
    const market = getContract({
      address: (await viem.deployContract("YieldOrders", [fee.account.address])).address,
      abi,
      client: { public: client, wallet: fee },
    });
    await market.write.createPair([asset.address, quote.address]);
    const [pairId] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const createTick = async (days: bigint) => {
      const id = BigInt(
        keccak256(
          encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
            [pairId, direction, 0, days],
          ),
        ),
      );
      await market.write.createTick([pairId, direction, 0, days]);
      return id;
    };
    const tickId = await createTick(1n);
    const secondTick = await createTick(2n);
    for (const actor of [alice, bob, taker]) {
      await asset.write.mint([actor.account.address, 10n ** 27n]);
      await quote.write.mint([actor.account.address, 10n ** 27n]);
      await asset.write.approve([market.address, MAX], { account: actor.account });
      await quote.write.approve([market.address, MAX], { account: actor.account });
    }
    const deadline = async () => (await client.getBlock()).timestamp + 3n * DAY;
    const backed = async () => {
      assert.ok((await asset.read.balanceOf([market.address])) >= (await market.read.tokenLiability([asset.address])));
      assert.ok((await quote.read.balanceOf([market.address])) >= (await market.read.tokenLiability([quote.address])));
    };
    return { market, asset, quote, tickId, secondTick, deadline, backed };
  }

  it("accrues all Unvested Yield despite unowned principal and exhausts funded Yield claims", async () => {
    const { market, asset, quote, tickId } = await setup();
    const M = 10n ** 30n;
    const X = 10n ** 36n;
    for (const actor of [alice, taker]) {
      await asset.write.mint([actor.account.address, 10n ** 33n]);
      await quote.write.mint([actor.account.address, 10n ** 33n]);
    }
    await market.write.supply([tickId, M - 123n, zeroAddress], { account: alice.account });
    await market.write.swap([tickId, M - 123n - 2n * 10n ** 21n, MAX, MAX, zeroAddress], {
      account: taker.account,
    });
    await market.write.supply([tickId, M - 2n * 10n ** 21n, zeroAddress], { account: alice.account });
    for (let i = 0; i < 4; i++) {
      const { availableSupply } = await market.read.getTick([tickId]);
      await market.write.swap([tickId, availableSupply / 100n + BigInt(i * 199 + 1), MAX, MAX, zeroAddress], {
        account: taker.account,
      });
    }
    const tick = await market.read.getTick([tickId]);
    const principal = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.ok(tick.activePrincipal * X - principal.activePrincipalX36 > X, "audit principal gap exceeds one raw unit");

    // Independently calculate funding at full utilization and its elapsed Repay fee.
    const fullYield = (tick.availableSupply * 103n + 39_999n) / 40_000n;
    const positionId = await market.read.nextPositionId();
    await market.write.use([tickId, tick.availableSupply, fullYield, MAX, zeroAddress], { account: taker.account });
    const position = await market.read.getPosition([positionId]);
    assert.equal(position.fullTermYieldAsset, fullYield);
    await networkHelpers.time.increase(3_600);
    const repay = await market.write.repay([positionId, fullYield], { account: taker.account });
    const repayReceipt = await client.getTransactionReceipt({ hash: repay });
    const elapsed = (await client.getBlock({ blockNumber: repayReceipt.blockNumber })).timestamp - position.openedAt;
    const grossYield = (fullYield * elapsed + DAY - 1n) / DAY;
    const repayFee = grossYield / 100n;
    const netYield = grossYield - repayFee;
    assert.equal(await market.read.accruedProtocolFees([asset.address]), repayFee);
    assert.equal(
      (await market.read.tokenLiability([asset.address])) - (await market.read.getTick([tickId])).availableSupply,
      grossYield,
    );
    await assert.rejects(market.read.getPosition([positionId]), /NotFound/);
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), []);

    const sumBefore = (await market.read.getDomain([tickId, 0])).yieldSum;
    const aliceBefore = await asset.read.balanceOf([alice.account.address]);
    const withdraw = await market.write.withdraw([tickId, MAX, 0n, MAX], { account: alice.account });
    const w = parseEventLogs({
      abi,
      logs: (await client.getTransactionReceipt({ hash: withdraw })).logs,
      eventName: "Withdrawn",
    })[0].args;
    assert.ok(w.unvestedYield > 0n);
    assert.equal((await market.read.accruedProtocolFees([asset.address])) - repayFee, w.unvestedYield);
    assert.equal((await market.read.getDomain([tickId, 0])).yieldSum, sumBefore);
    assert.equal(w.principalAmount, principal.activePrincipal);
    assert.equal(w.availableAssetOut, principal.activePrincipal);
    assert.equal(w.workingToExit, 0n);
    await networkHelpers.time.increase(Number(DAY));
    await market.write.collect([tickId], { account: alice.account });
    const paidYield =
      BigInt(await asset.read.balanceOf([alice.account.address])) - BigInt(aliceBefore) - principal.activePrincipal;
    const claim = await market.read.getEarnPosition([alice.account.address, tickId]);
    assert.equal(claim.activePrincipal, 0n);
    assert.equal(claim.resolvingPrincipal, 0n);
    assert.equal(claim.outstandingActiveYieldAsset + claim.outstandingExitYieldAsset, 0n);
    assert.equal(claim.claimableExitAsset + claim.claimableActiveQuote + claim.claimableExitQuote, 0n);
    const fees = await market.read.accruedProtocolFees([asset.address]);
    const feeBalanceBefore = await asset.read.balanceOf([fee.account.address]);
    await market.write.collectProtocolFees([asset.address]);
    await market.write.collectProtocolFees([quote.address]);
    assert.equal((await asset.read.balanceOf([fee.account.address])) - feeBalanceBefore, fees);
    assert.equal(await market.read.accruedProtocolFees([asset.address]), 0n);

    // Claimant conservation: exclude remaining principal, then bound the unclaimed Yield itself.
    // This check uses independently calculated funding and actual provider/fee payouts, not the reference model.
    const terminal = await market.read.getTick([tickId]);
    assert.equal(terminal.workingSupply, 0n);
    assert.equal(terminal.exitWorking, 0n);
    const residualYield = (await asset.read.balanceOf([market.address])) - terminal.availableSupply;
    assert.ok(residualYield >= 0n && residualYield <= 1n, `orphan Yield exceeds rounding dust: ${residualYield}`);
    assert.equal(netYield, paidYield + (fees - repayFee) + residualYield);
    assert.equal(await market.read.tokenLiability([asset.address]), terminal.availableSupply + residualYield);
    assert.ok((await quote.read.balanceOf([market.address])) <= 6n, "only per-swap Quote rounding dust remains");
  });

  it("preserves half-raw Quote proceeds across zero-value Collects and generation rollover", async () => {
    const run = async (checkpoint: boolean) => {
      const { market, quote, tickId, deadline } = await setup();
      await market.write.supply([tickId, 1n, zeroAddress], { account: alice.account });
      await market.write.supply([tickId, 1n, zeroAddress], { account: bob.account });
      await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
      if (checkpoint) {
        for (const actor of [alice, bob]) {
          const before = await quote.read.balanceOf([actor.account.address]);
          await market.write.collect([tickId], { account: actor.account });
          await market.write.collect([tickId], { account: actor.account });
          assert.equal(await quote.read.balanceOf([actor.account.address]), before);
        }
      }
      await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
      assert.equal((await market.read.getDomain([tickId, 0])).generation, 1n);
      const results: bigint[] = [];
      for (const actor of [alice, bob]) {
        const before = await quote.read.balanceOf([actor.account.address]);
        await market.write.collect([tickId], { account: actor.account });
        results.push(BigInt(await quote.read.balanceOf([actor.account.address])) - BigInt(before));
      }
      return results;
    };
    const checkpointed = await run(true);
    assert.deepEqual(checkpointed, [1n, 1n]);
    assert.deepEqual(await run(false), checkpointed);
  });

  it("keeps earned fractions when a supplier adds principal without giving new funds historical gains", async () => {
    const { market, quote, tickId, deadline } = await setup();
    await market.write.supply([tickId, 1n, zeroAddress], { account: alice.account });
    await market.write.supply([tickId, 1n, zeroAddress], { account: bob.account });
    await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
    await market.write.collect([tickId], { account: alice.account });
    await market.write.supply([tickId, 1n, zeroAddress], { account: alice.account });
    await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
    await market.write.collect([tickId], { account: alice.account });
    await market.write.collect([tickId], { account: bob.account });
    assert.equal(await quote.read.balanceOf([alice.account.address]), 10n ** 27n + 1n);
    assert.equal(await quote.read.balanceOf([bob.account.address]), 10n ** 27n);
    await market.write.swap([tickId, 1n, 1n, await deadline(), zeroAddress], { account: taker.account });
    await market.write.collect([tickId], { account: alice.account });
    await market.write.collect([tickId], { account: bob.account });
    assert.equal(await quote.read.balanceOf([alice.account.address]), 10n ** 27n + 2n);
    assert.equal(await quote.read.balanceOf([bob.account.address]), 10n ** 27n + 1n);
  });

  it("keeps Close, automatic settlement, Withdraw and Collect live when Quote fee transfers fail", async () => {
    const { market, asset, quote, tickId, secondTick, deadline, backed } = await setup("quote");
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    await market.write.supply([secondTick, 500n * E, zeroAddress], { account: bob.account });
    await market.write.swap([secondTick, 100n * E, 100n * E, await deadline(), zeroAddress], {
      account: taker.account,
    });
    for (let i = 0; i < 2; i++) {
      const [, maxYield] = await market.read.quoteUse([tickId, 100n * E]);
      await market.write.use([tickId, 100n * E, maxYield, await deadline(), zeroAddress], { account: taker.account });
    }
    await networkHelpers.time.increase(Number(DAY));
    await market.write.close([1n], { account: keeper.account });
    await assert.rejects(market.read.getPosition([1n]), /NotFound/);
    const withdrawal = await market.write.withdraw([tickId, 100n * E, 0n, MAX], { account: alice.account });
    await assert.rejects(market.read.getPosition([2n]), /NotFound/);
    assert.equal((await market.read.getTick([tickId])).settleCursor, 2n);
    assert.equal(
      parseEventLogs({
        abi,
        logs: (await client.getTransactionReceipt({ hash: withdrawal })).logs,
        eventName: "Withdrawn",
      }).length,
      1,
    );
    await market.write.collect([tickId], { account: alice.account });
    assert.equal(await market.read.accruedProtocolFees([quote.address]), 3n * E);
    await backed();
    const liability = await market.read.tokenLiability([quote.address]);
    await assert.rejects(market.write.collectProtocolFees([quote.address]));
    assert.equal(await market.read.tokenLiability([quote.address]), liability);
    assert.equal(await market.read.accruedProtocolFees([quote.address]), 3n * E);
    await market.write.supply([secondTick, 1n * E, zeroAddress], { account: bob.account });
    await backed();
    await quote.write.setBlocking([false]);
    const before = await quote.read.balanceOf([fee.account.address]);
    await market.write.collectProtocolFees([quote.address]);
    assert.equal((await quote.read.balanceOf([fee.account.address])) - before, 3n * E);
    assert.equal(await market.read.accruedProtocolFees([quote.address]), 0n);
    await backed();
    assert.ok((await asset.read.balanceOf([market.address])) >= (await market.read.tokenLiability([asset.address])));
  });

  it("accrues backed Asset Repay fees and Unvested Yield without requiring the fee recipient", async () => {
    const { market, asset, tickId, deadline, backed } = await setup("asset");
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: alice.account });
    const [, maxYield] = await market.read.quoteUse([tickId, 500n * E]);
    await market.write.use([tickId, 500n * E, maxYield, await deadline(), zeroAddress], { account: taker.account });
    await networkHelpers.time.increase(3_600);
    const repayHash = await market.write.repay([1n, maxYield], { account: taker.account });
    const feeOnRepay = parseEventLogs({
      abi,
      logs: (await client.getTransactionReceipt({ hash: repayHash })).logs,
      eventName: "TermRepaid",
    })[0].args.yieldFeeAsset;
    assert.ok(feeOnRepay > 0n);
    const withdrawal = await market.write.withdraw([tickId, MAX, 0n, MAX], { account: alice.account });
    const unvested = parseEventLogs({
      abi,
      logs: (await client.getTransactionReceipt({ hash: withdrawal })).logs,
      eventName: "Withdrawn",
    })[0].args.unvestedYield;
    assert.ok(unvested > 0n);
    assert.equal(await market.read.accruedProtocolFees([asset.address]), feeOnRepay + unvested);
    await backed();
    await assert.rejects(market.write.collectProtocolFees([asset.address]));
    await market.write.collect([tickId], { account: alice.account });
    await backed();
    await asset.write.setBlocking([false]);
    const before = await asset.read.balanceOf([fee.account.address]);
    await market.write.collectProtocolFees([asset.address]);
    assert.equal((await asset.read.balanceOf([fee.account.address])) - before, feeOnRepay + unvested);
    await backed();
  });
});
