import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getContract,
  keccak256,
  zeroAddress,
  type Abi,
} from "viem";
import manifest from "../deployments/config.json" with { type: "json" };
import protocolAbiJson from "../abi/YieldOrders.json" with { type: "json" };
import type { YieldOrders$Type } from "../artifacts/contracts/YieldOrders.sol/artifacts.js";
import { CREATE_X_ADDRESS, guardSalt, predict, readArtifact } from "../scripts/deployment.js";
import { feeOnTransferTokenAbi, mockERC20Abi, reentrantTokenAbi } from "./abi/mocks.js";

const yieldOrdersAbi = protocolAbiJson as unknown as YieldOrders$Type["abi"];

// All amounts below are raw ERC-20 units. Both example tokens use 18 decimals.
const E = 10n ** 18n;
const DAY = 86_400;

describe("yld.cx integration", async () => {
  const { viem, networkHelpers } = await network.create();
  const [deployer, supplier, taker, keeper, secondSupplier] = await viem.getWalletClients();
  const client = await viem.getPublicClient();

  async function setup() {
    const assetDeployment = await viem.deployContract("MockERC20", ["Asset", "AST", 18]);
    const quoteDeployment = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const marketDeployment = await viem.deployContract("YieldOrders", [deployer.account.address]);
    const asset = getContract({
      address: assetDeployment.address,
      abi: mockERC20Abi,
      client: { public: client, wallet: deployer },
    });
    const quote = getContract({
      address: quoteDeployment.address,
      abi: mockERC20Abi,
      client: { public: client, wallet: deployer },
    });
    const market = getContract({
      address: marketDeployment.address,
      abi: yieldOrdersAbi,
      client: { public: client, wallet: deployer },
    });

    await market.write.createPair([asset.address, quote.address]);
    const [pairId] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const priceTick = 0; // 1 raw Quote unit per 1 raw Asset unit.
    const durationDays = 1n;
    const tickId = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pairId, direction, priceTick, durationDays],
        ),
      ),
    );
    await market.write.createTick([pairId, direction, priceTick, durationDays]);

    await asset.write.mint([supplier.account.address, 2_000n * E]);
    await asset.write.mint([secondSupplier.account.address, 1_000n * E]);
    await quote.write.mint([taker.account.address, 2_000n * E]);
    // Supply and Repay require Asset approval. Use and Swap require Quote approval.
    await asset.write.approve([market.address, 2_000n * E], { account: supplier.account });
    await asset.write.approve([market.address, 1_000n * E], { account: secondSupplier.account });
    await asset.write.approve([market.address, 2_000n * E], { account: taker.account });
    await quote.write.approve([market.address, 2_000n * E], { account: taker.account });
    return { asset, quote, market, pairId, tickId };
  }

  function eventNames(
    receipt: Awaited<ReturnType<typeof client.waitForTransactionReceipt>>,
    abi: Abi,
    address: string,
  ) {
    return receipt.logs
      .filter((log) => log.address.toLowerCase() === address.toLowerCase())
      .flatMap((log) => {
        try {
          return [String(decodeEventLog({ abi, data: log.data, topics: log.topics }).eventName)];
        } catch {
          return [];
        }
      });
  }

  it("creates a pair and tick, supplies, uses, withdraws, repays, collects, and swaps", async () => {
    const { asset, quote, market, pairId, tickId } = await networkHelpers.loadFixture(setup);
    const reversed = await market.read.getPair([quote.address, asset.address]);
    assert.equal(reversed[0], pairId);
    assert.equal(reversed[3], true);
    const [initialTick, , initialPrincipal] = await market.read.getTick([tickId]);
    assert.equal(initialTick.priceX128, 1n << 128n);
    assert.equal(initialPrincipal, 0n);

    const supplyAmount = 1_000n * E;
    const supplyQuote = await market.read.previewSupply([tickId, supplyAmount]);
    assert.equal(supplyQuote, supplyAmount);
    const supplyHash = await market.write.supply([tickId, supplyAmount, zeroAddress], { account: supplier.account });
    const supplyReceipt = await client.waitForTransactionReceipt({ hash: supplyHash });
    assert.ok(eventNames(supplyReceipt, market.abi, market.address).includes("Supplied"));
    const [afterSupply, , activePrincipal] = await market.read.getTick([tickId]);
    assert.equal(afterSupply.availableSupply, supplyAmount);
    assert.equal(activePrincipal, supplyAmount);

    const assetToUse = 400n * E;
    const useQuote = await market.read.previewUse([tickId, assetToUse]);
    assert.equal(useQuote.quotePrincipal, assetToUse);
    assert.equal(useQuote.fullTermYieldAsset, 103_360_000_000_000_000n); // Q128 integrated curve golden vector.
    const deadline = BigInt((await client.getBlock()).timestamp) + 300n;
    const useHash = await market.write.use([tickId, assetToUse, useQuote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    const useReceipt = await client.waitForTransactionReceipt({ hash: useHash });
    assert.ok(eventNames(useReceipt, market.abi, market.address).includes("UseOpened"));
    const positionId = 1n;
    const position = await market.read.getPosition([positionId]);
    assert.equal(position.assetAmount, assetToUse);
    assert.equal(position.quotePrincipal, useQuote.quotePrincipal);
    assert.equal(await market.read.tickPositionId([tickId, 0n]), positionId);
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), [positionId]);
    const [afterUse] = await market.read.getTick([tickId]);
    assert.equal(afterUse.availableSupply, 600n * E);
    assert.equal(afterUse.workingSupply, assetToUse);
    assert.equal(afterUse.yieldAssetReserve, 0n); // Yield is funded only at Repay.
    assert.equal((await market.read.previewUse([tickId, 200n * E])).fullTermYieldAsset, 277_400_000_000_000_000n);

    // Product UIs convert a percentage to active shares. Here 50% is 500e18 shares.
    const withdrawal = await market.read.previewWithdraw([tickId, supplier.account.address, 500n * E]);
    assert.equal(withdrawal.availableAssetOut, 300n * E);
    assert.equal(withdrawal.workingToExit, 200n * E);
    const withdrawHash = await market.write.withdraw([tickId, 500n * E], { account: supplier.account });
    const withdrawReceipt = await client.waitForTransactionReceipt({ hash: withdrawHash });
    assert.ok(eventNames(withdrawReceipt, market.abi, market.address).includes("Withdrawn"));
    const [afterWithdraw] = await market.read.getTick([tickId]);
    assert.equal(afterWithdraw.workingSupply, assetToUse);
    assert.equal(afterWithdraw.exitWorking, 200n * E);

    await asset.write.mint([taker.account.address, 10n * E]); // Taker needs Asset Yield on top of principal.
    await networkHelpers.time.increase(3_600); // One hour of the one-day term has elapsed.
    const repayQuote = await market.read.previewRepay([positionId]);
    assert.equal(repayQuote.exitFill, 200n * E);
    assert.equal(repayQuote.activeReturn, 200n * E);
    const repayHash = await market.write.repay([positionId, repayQuote.grossYieldAsset + E], {
      account: taker.account,
    });
    const repayReceipt = await client.waitForTransactionReceipt({ hash: repayHash });
    assert.ok(eventNames(repayReceipt, market.abi, market.address).includes("TermRepaid"));
    assert.equal((await market.read.getPosition([positionId])).status, 2);
    assert.deepEqual(await market.read.getUsePositions([taker.account.address, 0n, 10n]), []);

    const claim = await market.read.previewCollect([tickId, supplier.account.address]);
    assert.equal(claim.exitAsset, 200n * E);
    assert.ok(claim.grossYieldAsset > 0n);
    const collectHash = await market.write.collect([tickId], { account: supplier.account });
    const collectReceipt = await client.waitForTransactionReceipt({ hash: collectHash });
    assert.ok(eventNames(collectReceipt, market.abi, market.address).includes("Collected"));
    assert.equal((await market.read.previewCollect([tickId, supplier.account.address])).totalAssetOut, 0n);

    const swapQuote = await market.read.previewSwap([tickId, 100n * E]);
    const swapHash = await market.write.swap(
      [tickId, 100n * E, swapQuote.quotePrincipal, deadline + 10_000n, zeroAddress],
      { account: taker.account },
    );
    const swapReceipt = await client.waitForTransactionReceipt({ hash: swapHash });
    assert.ok(eventNames(swapReceipt, market.abi, market.address).includes("ImmediateSwap"));
    assert.equal(await quote.read.balanceOf([deployer.account.address]), swapQuote.swapFee);
  });

  it("closes at maturity through a permissionless keeper and settles one cursor entry", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const quote = await market.read.previewUse([tickId, 250n * E]);
    const deadline = BigInt((await client.getBlock()).timestamp) + 60n;
    await market.write.use([tickId, 250n * E, quote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await assert.rejects(market.write.close([1n], { account: keeper.account })); // Before maturity.
    await networkHelpers.time.increase(DAY);
    await assert.rejects(market.write.repay([1n, quote.fullTermYieldAsset], { account: taker.account }));
    const hash = await market.write.settle([tickId], { account: keeper.account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.ok(eventNames(receipt, market.abi, market.address).includes("TermClosed"));
    assert.equal((await market.read.getPosition([1n])).status, 3);
    const [tick] = await market.read.getTick([tickId]);
    assert.equal(tick.settleCursor, 1n);
    await market.write.settle([tickId], { account: keeper.account }); // Empty queue is a no-op.
    assert.equal((await market.read.getPosition([1n])).status, 3);
  });

  it("uses multicall for withdraw + collect and rejects same-block supply + withdraw", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    const supplyData = encodeFunctionData({
      abi: market.abi,
      functionName: "supply",
      args: [tickId, 1_000n * E, zeroAddress],
    });
    const withdrawData = encodeFunctionData({ abi: market.abi, functionName: "withdraw", args: [tickId, 1_000n * E] });
    await assert.rejects(market.write.multicall([[supplyData, withdrawData]], { account: supplier.account }));
    assert.equal((await market.read.getEarnPosition([supplier.account.address, tickId])).provider.shares, 0n);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const collectData = encodeFunctionData({ abi: market.abi, functionName: "collect", args: [tickId] });
    await market.write.multicall([[withdrawData, collectData]], { account: supplier.account });
    assert.deepEqual(await market.read.getEarnPositions([supplier.account.address, 0n, 10n]), []);
  });

  it("projects automatic maturity settlement in previews and permits a new supplier", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const quote = await market.read.previewUse([tickId, 250n * E]);
    const deadline = BigInt((await client.getBlock()).timestamp) + 60n;
    await market.write.use([tickId, 250n * E, quote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(DAY);

    // Both previews include the Close that the corresponding write will perform first.
    const claim = await market.read.previewCollect([tickId, supplier.account.address]);
    assert.ok(claim.swapQuote > 0n);
    assert.equal(await market.read.previewSupply([tickId, 75n * E]), 100n * E);
    const collectHash = await market.write.collect([tickId], { account: supplier.account });
    const receipt = await client.waitForTransactionReceipt({ hash: collectHash });
    assert.deepEqual(eventNames(receipt, market.abi, market.address), ["TermClosed", "Collected"]);
    assert.equal((await market.read.getPosition([1n])).status, 3);
    await market.write.supply([tickId, 75n * E, zeroAddress], { account: secondSupplier.account });
    assert.equal(
      (await market.read.getEarnPosition([secondSupplier.account.address, tickId])).provider.shares,
      100n * E,
    );
    assert.equal((await market.read.getEarnPosition([secondSupplier.account.address, tickId])).claimableSwapQuote, 0n);
  });

  it("direct Close pays Exit first, finalizes Exit shares, and preserves claimable proceeds", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const quote = await market.read.previewUse([tickId, 400n * E]);
    const deadline = BigInt((await client.getBlock()).timestamp) + 60n;
    await market.write.use([tickId, 400n * E, quote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await market.write.withdraw([tickId, 500n * E], { account: supplier.account });
    await networkHelpers.time.increase(DAY);
    const hash = await market.write.close([1n], { account: keeper.account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.ok(eventNames(receipt, market.abi, market.address).includes("ExitGenerationFinalized"));
    const [tick] = await market.read.getTick([tickId]);
    assert.equal(tick.exitWorking, 0n);
    assert.equal(tick.totalExitShares, 0n);
    assert.equal(tick.exitGeneration, 1n);
    const claim = await market.read.previewCollect([tickId, supplier.account.address]);
    assert.ok(claim.exitQuote > 0n && claim.swapQuote > 0n);
    await market.write.collect([tickId], { account: supplier.account });
  });

  it("rejects fee-on-transfer funding and ignores unsolicited Asset", async () => {
    const { asset, quote, market, tickId } = await networkHelpers.loadFixture(setup);
    await asset.write.transfer([market.address, 10n * E], { account: supplier.account });
    const [before] = await market.read.getTick([tickId]);
    assert.equal(before.availableSupply, 0n);
    await assert.rejects(market.write.use([tickId, E, E, 2n ** 255n, zeroAddress], { account: taker.account }));

    const feeTokenDeployment = await viem.deployContract("FeeOnTransferToken");
    const otherMarketDeployment = await viem.deployContract("YieldOrders", [deployer.account.address]);
    const feeToken = getContract({
      address: feeTokenDeployment.address,
      abi: feeOnTransferTokenAbi,
      client: { public: client, wallet: deployer },
    });
    const otherMarket = getContract({
      address: otherMarketDeployment.address,
      abi: yieldOrdersAbi,
      client: { public: client, wallet: deployer },
    });
    await otherMarket.write.createPair([feeToken.address, quote.address]);
    const [pairId] = await otherMarket.read.getPair([feeToken.address, quote.address]);
    const direction = feeToken.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const badTick = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pairId, direction, 0, 1n],
        ),
      ),
    );
    await otherMarket.write.createTick([pairId, direction, 0, 1n]);
    await feeToken.write.mint([supplier.account.address, 100n * E]);
    await feeToken.write.approve([otherMarket.address, 100n * E], { account: supplier.account });
    await assert.rejects(otherMarket.write.supply([badTick, 10n * E, zeroAddress], { account: supplier.account }));
  });

  it("blocks callback reentrancy during token transfer", async () => {
    const quoteDeployment = await viem.deployContract("MockERC20", ["Quote", "QUO", 18]);
    const assetDeployment = await viem.deployContract("ReentrantToken");
    const marketDeployment = await viem.deployContract("YieldOrders", [deployer.account.address]);
    const quote = getContract({
      address: quoteDeployment.address,
      abi: mockERC20Abi,
      client: { public: client, wallet: deployer },
    });
    const asset = getContract({
      address: assetDeployment.address,
      abi: reentrantTokenAbi,
      client: { public: client, wallet: deployer },
    });
    const market = getContract({
      address: marketDeployment.address,
      abi: yieldOrdersAbi,
      client: { public: client, wallet: deployer },
    });
    await market.write.createPair([asset.address, quote.address]);
    const [pairId] = await market.read.getPair([asset.address, quote.address]);
    const direction = asset.address.toLowerCase() < quote.address.toLowerCase() ? 0 : 1;
    const tickId = BigInt(
      keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint8" }, { type: "int32" }, { type: "uint64" }],
          [pairId, direction, 0, 1n],
        ),
      ),
    );
    await market.write.createTick([pairId, direction, 0, 1n]);
    await asset.write.mint([supplier.account.address, 100n * E]);
    await asset.write.approve([market.address, 100n * E], { account: supplier.account });
    const callback = encodeFunctionData({ abi: market.abi, functionName: "collect", args: [tickId] });
    await asset.write.arm([market.address, callback]);
    await market.write.supply([tickId, 100n * E, zeroAddress], { account: supplier.account });
    assert.equal(await asset.read.attempted(), true);
    assert.equal(await asset.read.succeeded(), false);
    assert.equal((await market.read.getTick([tickId]))[0].availableSupply, 100n * E);
  });

  it("keeps the 10% Asset Yield fee invariant across separate Collect calls", async () => {
    const { asset, market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    await asset.write.mint([taker.account.address, 100n * E]);
    const deadline = BigInt((await client.getBlock()).timestamp) + 10_000n;
    const firstQuote = await market.read.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, firstQuote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await market.write.repay([1n, firstQuote.fullTermYieldAsset], { account: taker.account });
    const firstClaim = await market.read.previewCollect([tickId, supplier.account.address]);
    await market.write.collect([tickId], { account: supplier.account });

    const secondQuote = await market.read.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, secondQuote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await market.write.repay([2n, secondQuote.fullTermYieldAsset], { account: taker.account });
    const secondClaim = await market.read.previewCollect([tickId, supplier.account.address]);
    await market.write.collect([tickId], { account: supplier.account });

    const totalGross = firstClaim.grossYieldAsset + secondClaim.grossYieldAsset;
    assert.equal(await asset.read.balanceOf([deployer.account.address]), totalGross / 10n);
    const provider = (await market.read.getEarnPosition([supplier.account.address, tickId])).provider;
    assert.equal(provider.yieldFeeCarry, (totalGross * 1_000n) % 10_000n);
  });

  it("lets a new active supplier trade while an older Exit is unresolved", async () => {
    const { asset, market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const deadline = BigInt((await client.getBlock()).timestamp) + 10_000n;
    const oldQuote = await market.read.previewUse([tickId, 1_000n * E]);
    await market.write.use([tickId, 1_000n * E, oldQuote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await market.write.withdraw([tickId, 1_000n * E], { account: supplier.account });
    const [exited] = await market.read.getTick([tickId]);
    assert.equal(exited.totalShares, 0n);
    assert.equal(exited.exitWorking, 1_000n * E);

    await market.write.supply([tickId, 200n * E, zeroAddress], { account: secondSupplier.account });
    const newQuote = await market.read.previewUse([tickId, 100n * E]);
    await market.write.use([tickId, 100n * E, newQuote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await asset.write.mint([taker.account.address, 100n * E]);
    const newerRepay = await market.read.previewRepay([2n]);
    assert.equal(newerRepay.exitFill, 100n * E); // Exit priority is pooled; position 2 was opened later.
    assert.equal(newerRepay.activeReturn, 0n);
    await market.write.repay([2n, newQuote.fullTermYieldAsset], { account: taker.account });
    const oldProviderClaim = await market.read.previewCollect([tickId, supplier.account.address]);
    const newProviderClaim = await market.read.previewCollect([tickId, secondSupplier.account.address]);
    assert.ok(oldProviderClaim.exitYieldAsset > 0n);
    assert.equal(newProviderClaim.activeYieldAsset, 0n);
    assert.equal((await market.read.getTick([tickId]))[0].availableSupply, 100n * E);

    const oldRepay = await market.read.previewRepay([1n]);
    assert.equal(oldRepay.exitFill, 900n * E);
    assert.equal(oldRepay.activeReturn, 100n * E);
    await market.write.repay([1n, oldQuote.fullTermYieldAsset], { account: taker.account });
    const [after] = await market.read.getTick([tickId]);
    assert.equal(after.exitWorking, 0n);
    assert.equal(after.totalExitShares, 0n);
    assert.equal(after.availableSupply, 200n * E);
  });

  it("keeps old active Quote claims separate across generation rollover", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const deadline = BigInt((await client.getBlock()).timestamp) + 10_000n;
    const first = await market.read.previewSwap([tickId, 1_000n * E]);
    await market.write.swap([tickId, 1_000n * E, first.quotePrincipal, deadline, zeroAddress], {
      account: taker.account,
    });
    assert.equal((await market.read.getTick([tickId]))[0].generation, 1n);

    await market.write.supply([tickId, 900n * E, zeroAddress], { account: secondSupplier.account });
    const second = await market.read.previewSwap([tickId, 900n * E]);
    await market.write.swap([tickId, 900n * E, second.quotePrincipal, deadline, zeroAddress], {
      account: taker.account,
    });
    assert.equal((await market.read.getTick([tickId]))[0].generation, 2n);
    const firstClaim = await market.read.previewCollect([tickId, supplier.account.address]);
    const secondClaim = await market.read.previewCollect([tickId, secondSupplier.account.address]);
    assert.ok(first.providerSwapProceeds - firstClaim.swapQuote <= 1n); // One raw-unit growth dust is allowed.
    assert.ok(second.providerSwapProceeds - secondClaim.swapQuote <= 1n);
    assert.ok(firstClaim.swapQuote > secondClaim.swapQuote); // Old shares never earn from generation 1.
    await market.write.collect([tickId], { account: supplier.account });
    await market.write.collect([tickId], { account: secondSupplier.account });
  });

  it("preserves uncollected Exit claims while the supplier joins a new Exit generation", async () => {
    const { asset, market, tickId } = await networkHelpers.loadFixture(setup);
    await asset.write.mint([taker.account.address, 100n * E]);
    await asset.write.approve([market.address, 2_100n * E], { account: taker.account });
    const deadline = BigInt((await client.getBlock()).timestamp) + 10_000n;
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const first = await market.read.previewUse([tickId, 1_000n * E]);
    await market.write.use([tickId, 1_000n * E, first.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await market.write.withdraw([tickId, 1_000n * E], { account: supplier.account });
    await market.write.repay([1n, first.fullTermYieldAsset], { account: taker.account });
    assert.equal((await market.read.getTick([tickId]))[0].exitGeneration, 1n);

    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const second = await market.read.previewUse([tickId, 1_000n * E]);
    await market.write.use([tickId, 1_000n * E, second.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await market.write.withdraw([tickId, 1_000n * E], { account: supplier.account });
    await market.write.repay([2n, second.fullTermYieldAsset], { account: taker.account });
    assert.equal((await market.read.getTick([tickId]))[0].exitGeneration, 2n);
    const claim = await market.read.previewCollect([tickId, supplier.account.address]);
    assert.equal(claim.exitAsset, 2_000n * E);
    assert.ok(claim.exitYieldAsset > 0n);
    await market.write.collect([tickId], { account: supplier.account });
  });

  it("bills exactly one second for same-timestamp Use and Repay in one multicall", async () => {
    const { asset, market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    await asset.write.mint([taker.account.address, E]);
    const fullTerm = (await market.read.previewUse([tickId, 400n * E])).fullTermYieldAsset;
    assert.equal(fullTerm, 103_360_000_000_000_000n);
    const useData = encodeFunctionData({
      abi: yieldOrdersAbi,
      functionName: "use",
      args: [tickId, 400n * E, fullTerm, 2n ** 255n, zeroAddress],
    });
    const repayData = encodeFunctionData({
      abi: yieldOrdersAbi,
      functionName: "repay",
      args: [1n, fullTerm],
    });
    const hash = await market.write.multicall([[useData, repayData]], { account: taker.account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const repaidLog = receipt.logs.find((log) => {
      try {
        return decodeEventLog({ abi: yieldOrdersAbi, data: log.data, topics: log.topics }).eventName === "TermRepaid";
      } catch {
        return false;
      }
    });
    assert.ok(repaidLog);
    const decoded = decodeEventLog({
      abi: yieldOrdersAbi,
      eventName: "TermRepaid",
      data: repaidLog.data,
      topics: repaidLog.topics,
    });
    assert.equal(decoded.args.grossYieldAsset, 1_196_296_296_297n);
    assert.equal((await market.read.getPosition([1n])).status, 2);
  });

  it("composes permissionless settle and provider collect in one multicall", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const useQuote = await market.read.previewUse([tickId, 250n * E]);
    const deadline = BigInt((await client.getBlock()).timestamp) + 300n;
    await market.write.use([tickId, 250n * E, useQuote.fullTermYieldAsset, deadline, zeroAddress], {
      account: taker.account,
    });
    await networkHelpers.time.increase(DAY);

    const projected = await market.read.previewCollect([tickId, supplier.account.address]);
    assert.ok(projected.swapQuote > 0n);
    const settleData = encodeFunctionData({ abi: yieldOrdersAbi, functionName: "settle", args: [tickId] });
    const collectData = encodeFunctionData({ abi: yieldOrdersAbi, functionName: "collect", args: [tickId] });
    const hash = await market.write.multicall([[settleData, collectData]], { account: supplier.account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.deepEqual(eventNames(receipt, market.abi, market.address), ["TermClosed", "Collected"]);
    assert.equal((await market.read.getTick([tickId]))[0].settleCursor, 1n);
    assert.equal((await market.read.previewCollect([tickId, supplier.account.address])).totalQuoteOut, 0n);
  });

  it("opens multiple Use positions in order and reverts an overfilled multicall atomically", async () => {
    const { market, tickId } = await networkHelpers.loadFixture(setup);
    await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
    const deadline = BigInt((await client.getBlock()).timestamp) + 300n;
    const tooLargeFirst = encodeFunctionData({
      abi: yieldOrdersAbi,
      functionName: "use",
      args: [tickId, 600n * E, 2n ** 255n, deadline, zeroAddress],
    });
    const tooLargeSecond = encodeFunctionData({
      abi: yieldOrdersAbi,
      functionName: "use",
      args: [tickId, 500n * E, 2n ** 255n, deadline, zeroAddress],
    });
    await assert.rejects(market.write.multicall([[tooLargeFirst, tooLargeSecond]], { account: taker.account }));
    assert.equal(await market.read.nextPositionId(), 1n);
    assert.equal((await market.read.getTick([tickId]))[0].quoteEscrow, 0n);

    const firstUse = encodeFunctionData({
      abi: yieldOrdersAbi,
      functionName: "use",
      args: [tickId, 200n * E, 2n ** 255n, deadline, zeroAddress],
    });
    const secondUse = encodeFunctionData({
      abi: yieldOrdersAbi,
      functionName: "use",
      args: [tickId, 300n * E, 2n ** 255n, deadline, zeroAddress],
    });
    const hash = await market.write.multicall([[firstUse, secondUse]], { account: taker.account });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.deepEqual(eventNames(receipt, market.abi, market.address), ["UseOpened", "UseOpened"]);
    assert.equal(await market.read.tickPositionId([tickId, 0n]), 1n);
    assert.equal(await market.read.tickPositionId([tickId, 1n]), 2n);
    assert.equal((await market.read.getTick([tickId]))[0].workingSupply, 500n * E);
  });

  for (const action of ["supply", "withdraw", "collect", "use", "swap"] as const) {
    it(`projects and performs one mature-cursor settlement before ${action}`, async () => {
      const { market, tickId } = await networkHelpers.loadFixture(setup);
      await market.write.supply([tickId, 1_000n * E, zeroAddress], { account: supplier.account });
      const originalQuote = await market.read.previewUse([tickId, 250n * E]);
      const originalDeadline = BigInt((await client.getBlock()).timestamp) + 300n;
      await market.write.use([tickId, 250n * E, originalQuote.fullTermYieldAsset, originalDeadline, zeroAddress], {
        account: taker.account,
      });
      await networkHelpers.time.increase(DAY);
      assert.equal((await market.read.getTick([tickId]))[0].settleCursor, 0n);

      let hash: `0x${string}`;
      if (action === "supply") {
        const projectedShares = await market.read.previewSupply([tickId, 75n * E]);
        hash = await market.write.supply([tickId, 75n * E, zeroAddress], { account: secondSupplier.account });
        assert.equal(
          (await market.read.getEarnPosition([secondSupplier.account.address, tickId])).provider.shares,
          projectedShares,
        );
      } else if (action === "withdraw") {
        const projected = await market.read.previewWithdraw([tickId, supplier.account.address, 100n * E]);
        hash = await market.write.withdraw([tickId, 100n * E], { account: supplier.account });
        assert.equal((await market.read.getTick([tickId]))[0].availableSupply, 750n * E - projected.availableAssetOut);
      } else if (action === "collect") {
        const projected = await market.read.previewCollect([tickId, supplier.account.address]);
        hash = await market.write.collect([tickId], { account: supplier.account });
        assert.equal((await market.read.previewCollect([tickId, supplier.account.address])).totalQuoteOut, 0n);
        assert.ok(projected.swapQuote > 0n);
      } else if (action === "use") {
        const projected = await market.read.previewUse([tickId, 100n * E]);
        const deadline = BigInt((await client.getBlock()).timestamp) + 300n;
        hash = await market.write.use([tickId, 100n * E, projected.fullTermYieldAsset, deadline, zeroAddress], {
          account: taker.account,
        });
        assert.equal((await market.read.getPosition([2n])).fullTermYieldAsset, projected.fullTermYieldAsset);
      } else {
        const projected = await market.read.previewSwap([tickId, 100n * E]);
        const deadline = BigInt((await client.getBlock()).timestamp) + 300n;
        hash = await market.write.swap([tickId, 100n * E, projected.quotePrincipal, deadline, zeroAddress], {
          account: taker.account,
        });
        assert.equal((await market.read.getTick([tickId]))[0].availableSupply, 650n * E);
      }
      const receipt = await client.waitForTransactionReceipt({ hash });
      const names = eventNames(receipt, market.abi, market.address);
      assert.equal(names[0], "TermClosed");
      assert.equal((await market.read.getTick([tickId]))[0].settleCursor, 1n);
      assert.equal((await market.read.getPosition([1n])).status, 3);
    });
  }

  it("pins the same 0x0000 CREATE2 address for Ethereum, Base, and Robinhood", async () => {
    const artifact = await readArtifact();
    assert.deepEqual(yieldOrdersAbi, artifact.abi);
    const result = predict(artifact, manifest.feeTo as `0x${string}`, manifest.rawSalt as `0x${string}`);
    assert.equal(result.address, manifest.address);
    assert.equal(result.guardedSalt, guardSalt(manifest.rawSalt as `0x${string}`));
    assert.ok(result.address.toLowerCase().startsWith("0x0000"));
    assert.deepEqual(manifest.networks, { ethereum: 1, base: 8453, robinhood: 4663 });
    assert.equal(CREATE_X_ADDRESS, "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed");
    const local = await viem.deployContract("YieldOrders", [manifest.feeTo as `0x${string}`]);
    const runtime = await client.getCode({ address: local.address });
    assert.ok(runtime);
    assert.equal(keccak256(runtime), manifest.runtimeCodeHash);
  });
});
