// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {YieldOrders} from "../YieldOrders.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20, BalanceReducingToken} from "./MockERC20.sol";

interface Vm {
    function prank(address) external;
    function roll(uint256) external;
    function warp(uint256) external;
    function assume(bool) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

/// @notice Solidity lifecycle, accounting, and randomized invariant tests.
contract YieldOrdersTest is YieldOrders {
    MockERC20 private tokenA;
    MockERC20 private tokenB;
    MockERC20 private tokenC;
    uint256 private tickAB;
    uint256 private tickCA;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    YieldOrders private protocol;
    MockERC20 private asset;
    MockERC20 private quote;
    uint256 private tickId;
    address private constant PROVIDER = address(0xA11CE);
    address private constant OTHER_PROVIDER = address(0xCAFE);
    address private constant TAKER = address(0xB0B);
    address private constant OTHER_TAKER = address(0xD00D);

    constructor() YieldOrders(address(0xBEEF)) {}

    function setUp() public {
        protocol = new YieldOrders(FEE_TO);
        asset = new MockERC20("Asset", "AST", 18);
        quote = new MockERC20("Quote", "QUO", 18);
        uint256 pairId = protocol.createPair(address(asset), address(quote));
        uint8 direction = address(asset) < address(quote) ? 0 : 1;
        tickId = protocol.createTick(pairId, direction, 0, 1);
        asset.mint(PROVIDER, 2_000 ether);
        quote.mint(TAKER, 3_000 ether);
        vm.prank(PROVIDER);
        asset.approve(address(protocol), type(uint256).max);
        vm.prank(TAKER);
        quote.approve(address(protocol), type(uint256).max);
        vm.prank(TAKER);
        asset.approve(address(protocol), type(uint256).max);
    }

    function _supply() internal {
        vm.prank(PROVIDER);
        protocol.supply(tickId, 1_000 ether, address(0));
    }

    function testPairAndTickIdentity() public view {
        (uint256 pairId, address token0, address token1, bool exists) = protocol.getPair(
            address(quote),
            address(asset)
        );
        require(exists && token0 < token1, "canonical pair");
        require(pairId == uint256(keccak256(abi.encode(token0, token1))), "pair hash");
        (YieldOrders.Tick memory tick, uint256 wa, uint256 ca) = protocol.getTick(tickId);
        require(tick.priceX128 == protocol.Q128(), "unit price");
        require(wa == 0 && ca == 0 && tick.totalShares == 0, "zero tick");
    }

    function testPairAndTickBoundaryReverts() public {
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.createPair(address(0), address(asset));
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.createPair(address(asset), address(asset));
        vm.expectRevert(YieldOrders.AlreadyExists.selector);
        protocol.createPair(address(asset), address(quote));
        (uint256 pairId, , , ) = protocol.getPair(address(asset), address(quote));
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.createTick(pairId, 2, 0, 1);
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.createTick(pairId, 0, 887273, 1);
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.createTick(pairId, 0, 0, 0);
        uint256 lowId = protocol.createTick(pairId, 0, -887272, 1);
        uint256 highId = protocol.createTick(pairId, 0, 887272, 1);
        (YieldOrders.Tick memory low, , ) = protocol.getTick(lowId);
        (YieldOrders.Tick memory high, , ) = protocol.getTick(highId);
        require(low.priceX128 > 0 && high.priceX128 > low.priceX128, "extreme TickMath price");
    }

    function testPriceX128GoldenVectors() public {
        (uint256 pairId, , , ) = protocol.getPair(address(asset), address(quote));
        uint256 negative = protocol.createTick(pairId, 0, -1, 1);
        uint256 positive = protocol.createTick(pairId, 0, 1, 1);
        (YieldOrders.Tick memory low, , ) = protocol.getTick(negative);
        (YieldOrders.Tick memory high, , ) = protocol.getTick(positive);
        require(low.priceX128 == 340248342086729790484326174821992218696, "tick -1 Q128 vector");
        require(high.priceX128 == 340316395157630557309720944898007205646, "tick +1 Q128 vector");
    }

    function testSwapQuoteAndFeeGoldenVector() public {
        (uint256 pairId, , , ) = protocol.getPair(address(asset), address(quote));
        uint8 direction = address(asset) < address(quote) ? 0 : 1;
        uint256 pricedTick = protocol.createTick(pairId, direction, 1, 1);
        vm.prank(PROVIDER);
        protocol.supply(pricedTick, 1 ether, address(0));
        YieldOrders.SwapPreview memory q = protocol.previewSwap(pricedTick, 1 ether);
        require(q.quotePrincipal == 1_000_100_000_000_000_001, "Quote Principal rounds up");
        require(q.referenceFullTermYieldAsset == 2_575_000_000_000_000, "full-term Yield vector");
        require(q.referenceYieldQuote == 2_575_257_500_000_001, "Yield Quote rounds up");
        require(q.swapFee == 257_525_750_000_000, "Swap fee rounds down");
        require(q.providerSwapProceeds == 999_842_474_250_000_001, "net Quote conserved");
    }

    function testFuzz_PairOrdering(address a, address b) public {
        vm.assume(a != address(0) && b != address(0) && a != b);
        (uint256 id1, address low1, address high1, ) = protocol.getPair(a, b);
        (uint256 id2, address low2, address high2, ) = protocol.getPair(b, a);
        require(id1 == id2 && low1 == low2 && high1 == high2, "pair ordering");
    }

    function testSupplyUseRepayExitInvariants() public {
        _supply();
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, 400 ether, type(uint256).max, block.timestamp, address(0));
        (YieldOrders.Tick memory beforeTick, , ) = protocol.getTick(tickId);
        require(beforeTick.availableSupply == 600 ether && beforeTick.workingSupply == 400 ether, "use accounting");
        require(beforeTick.yieldAssetReserve == 0 && beforeTick.yieldAssetGrowthX128 == 0, "no upfront yield");
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory withdrawal = protocol.withdraw(tickId, 500 ether);
        require(withdrawal.availableAssetOut == 300 ether && withdrawal.workingToExit == 200 ether, "withdraw split");
        asset.mint(TAKER, 10 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        YieldOrders.RepayPreview memory repaid = protocol.repay(positionId, type(uint256).max);
        require(repaid.exitFill == 200 ether && repaid.activeReturn == 200 ether, "exit priority");
        require(repaid.exitYieldAsset + repaid.activeYieldAsset == repaid.grossYieldAsset, "yield conserved");
        (YieldOrders.Tick memory afterTick, , uint256 activePrincipal) = protocol.getTick(tickId);
        require(afterTick.exitWorking == 0 && afterTick.totalExitShares == 0, "exit generation complete");
        require(activePrincipal == 500 ether && afterTick.totalShares == 500 ether, "active invariant");
        require(
            afterTick.availableSupply + afterTick.exitAssetReserve + afterTick.yieldAssetReserve <=
                asset.balanceOf(address(protocol)),
            "asset solvent"
        );
        vm.prank(PROVIDER);
        YieldOrders.CollectPreview memory collected = protocol.collect(tickId);
        require(collected.exitAsset == 200 ether && collected.grossYieldAsset > 0, "funded collection");
    }

    function testSameBlockSupplyWithdrawReverts() public {
        _supply();
        vm.prank(PROVIDER);
        vm.expectRevert(YieldOrders.Cooldown.selector);
        protocol.withdraw(tickId, 1 ether);
    }

    function testPartialZeroPrincipalWithdrawalRevertsButMaxBurnsDust() public {
        vm.prank(PROVIDER);
        protocol.supply(tickId, 100, address(0));
        vm.prank(TAKER);
        protocol.swap(tickId, 99, 99, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.withdraw(tickId, 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory max = protocol.withdraw(tickId, 100);
        require(max.principalClaim == 1 && max.availableAssetOut == 1, "Max returns remaining unit");
    }

    function testMaxMayBurnZeroPrincipalProviderDust() public {
        address other = address(0xCAFE);
        asset.mint(other, 99);
        vm.prank(other);
        asset.approve(address(protocol), 99);
        vm.prank(PROVIDER);
        protocol.supply(tickId, 1, address(0));
        vm.prank(other);
        protocol.supply(tickId, 99, address(0));
        vm.prank(TAKER);
        protocol.swap(tickId, 99, 99, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory max = protocol.withdraw(tickId, 1);
        require(max.principalClaim == 0 && max.availableAssetOut == 0 && max.workingToExit == 0, "zero dust burn");
        (YieldOrders.Tick memory t, , uint256 ca) = protocol.getTick(tickId);
        require(ca == 1 && t.totalShares == 99, "remaining provider owns unit");
    }

    function testMaturityCloseAndFee() public {
        _supply();
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, 1_000 ether, type(uint256).max, block.timestamp, address(0));
        YieldOrders.Position memory position = protocol.getPosition(positionId);
        vm.warp(position.maturity);
        protocol.settle(tickId);
        YieldOrders.Position memory closed = protocol.getPosition(positionId);
        require(uint8(closed.status) == uint8(YieldOrders.Status.CLOSED), "closed");
        (YieldOrders.Tick memory tick, , uint256 ca) = protocol.getTick(tickId);
        require(ca == 0 && tick.totalShares == 0 && tick.generation == 1, "active generation");
        require(quote.balanceOf(FEE_TO) == position.closeFee, "fee paid");
    }

    function testFuzz_ExitResolutionPreservesAccounting(uint96 seedSupply, uint96 seedUse, uint96 seedWithdraw) public {
        uint256 supplied = 1 + (uint256(seedSupply) % (1_000 ether));
        uint256 used = 1 + (uint256(seedUse) % supplied);
        uint256 burned = 1 + (uint256(seedWithdraw) % supplied);
        vm.prank(PROVIDER);
        protocol.supply(tickId, supplied, address(0));
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, used, type(uint256).max, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, burned);
        (YieldOrders.Tick memory beforeRepay, , ) = protocol.getTick(tickId);
        require(beforeRepay.exitWorking <= beforeRepay.workingSupply, "exit bound before repay");
        require(beforeRepay.totalExitShares >= beforeRepay.exitWorking, "exit share bound before repay");
        asset.mint(TAKER, 1_000 ether);
        vm.warp(block.timestamp + 1);
        vm.prank(TAKER);
        protocol.repay(positionId, type(uint256).max);
        (YieldOrders.Tick memory t, uint256 wa, uint256 ca) = protocol.getTick(tickId);
        require(t.exitWorking <= t.workingSupply, "exit bound");
        require(wa == t.workingSupply - t.exitWorking && ca == t.availableSupply + wa, "active formulas");
        require((ca == 0) == (t.totalShares == 0), "active generation bound");
        require((t.exitWorking == 0) == (t.totalExitShares == 0), "exit generation bound");
        require(t.totalExitShares >= t.exitWorking, "exit share bound");
        require(
            asset.balanceOf(address(protocol)) >= t.availableSupply + t.exitAssetReserve + t.yieldAssetReserve,
            "custody"
        );
        require(
            protocol.tokenLiability(address(asset)) == t.availableSupply + t.exitAssetReserve + t.yieldAssetReserve,
            "aggregate Asset liability"
        );
        require(
            protocol.tokenLiability(address(quote)) == t.quoteEscrow + t.exitQuoteReserve + t.activeQuoteReserve,
            "aggregate Quote liability"
        );
    }

    function testNegativeRebaseCannotSpendAnotherTicksCollateral() public {
        BalanceReducingToken token = new BalanceReducingToken();
        uint256 pairId = protocol.createPair(address(token), address(quote));
        uint8 direction = address(token) < address(quote) ? 0 : 1;
        uint256 first = protocol.createTick(pairId, direction, 0, 1);
        uint256 second = protocol.createTick(pairId, direction, 0, 2);
        token.mint(PROVIDER, 200);
        vm.prank(PROVIDER);
        token.approve(address(protocol), 200);
        vm.prank(PROVIDER);
        protocol.supply(first, 100, address(0));
        vm.prank(PROVIDER);
        protocol.supply(second, 100, address(0));
        require(protocol.tokenLiability(address(token)) == 200, "two Tick liabilities");

        token.reduceBalance(address(protocol), 50);
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        vm.expectRevert(YieldOrders.Invariant.selector);
        protocol.withdraw(first, 100);
        require(protocol.tokenLiability(address(token)) == 200, "failed withdrawal leaves liabilities intact");
        require(token.balanceOf(address(protocol)) == 150, "rebase loss remains observable");
    }

    function testLiabilityIncludesTokenUsedAsAssetAndQuote() public {
        BalanceReducingToken token = new BalanceReducingToken();
        MockERC20 otherAsset = new MockERC20("Other Asset", "OTH", 18);
        uint256 assetPair = protocol.createPair(address(token), address(quote));
        uint8 tokenDirection = address(token) < address(quote) ? 0 : 1;
        uint256 assetTick = protocol.createTick(assetPair, tokenDirection, 0, 1);
        uint256 quotePair = protocol.createPair(address(token), address(otherAsset));
        uint8 otherDirection = address(otherAsset) < address(token) ? 0 : 1;
        uint256 quoteTick = protocol.createTick(quotePair, otherDirection, 0, 1);

        token.mint(PROVIDER, 100);
        vm.prank(PROVIDER);
        token.approve(address(protocol), 100);
        vm.prank(PROVIDER);
        protocol.supply(assetTick, 100, address(0));
        otherAsset.mint(PROVIDER, 100);
        vm.prank(PROVIDER);
        otherAsset.approve(address(protocol), 100);
        vm.prank(PROVIDER);
        protocol.supply(quoteTick, 100, address(0));
        token.mint(TAKER, 100);
        vm.prank(TAKER);
        token.approve(address(protocol), 100);
        vm.prank(TAKER);
        protocol.use(quoteTick, 100, type(uint256).max, block.timestamp, address(0));
        require(protocol.tokenLiability(address(token)) == 200, "Asset plus Quote escrow");

        token.reduceBalance(address(protocol), 50);
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        vm.expectRevert(YieldOrders.Invariant.selector);
        protocol.withdraw(assetTick, 100);
        require(protocol.tokenLiability(address(token)) == 200, "cross-role liability preserved");
    }

    function testFullPrecisionYieldFeeAndCarryAtMaxAmount() public pure {
        uint256 gross = type(uint256).max;
        (uint256 fee, uint256 carry) = _yieldFee(gross, 999);
        require(fee == gross / 10, "large fee quotient");
        require(carry == (gross % 10) * 1_000 + 999, "large fee carry");
        (fee, carry) = _yieldFee(1, carry);
        require(fee == 0 && carry == 6_999, "carry accumulation");
        (fee, carry) = _yieldFee(4, carry);
        require(fee == 1 && carry == 999, "carry rollover");
    }

    function testOneUnitUseRepayAndCollectRounding() public {
        vm.prank(PROVIDER);
        protocol.supply(tickId, 1, address(0));
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, 1, 1, block.timestamp, address(0));
        YieldOrders.Position memory p = protocol.getPosition(positionId);
        require(p.quotePrincipal == 1 && p.fullTermYieldAsset == 1, "one-unit quotes round up");
        asset.mint(TAKER, 1);
        vm.prank(TAKER);
        YieldOrders.RepayPreview memory r = protocol.repay(positionId, 1);
        require(r.grossYieldAsset == 1 && r.totalAssetIn == 2, "minimum billable Yield");
        YieldOrders.CollectPreview memory preview = protocol.previewCollect(tickId, PROVIDER);
        require(preview.grossYieldAsset == 1 && preview.yieldFeeAsset == 0, "fee rounds down with carry");
        vm.prank(PROVIDER);
        protocol.collect(tickId);
        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        require(t.availableSupply == 1 && t.yieldAssetReserve == 0, "one-unit reserve conservation");
        require(protocol.tokenLiability(address(asset)) == 1, "one-unit global liability");
    }

    function testDeadlineBoundaryAndPositionIdAfterRevert() public {
        _supply();
        require(protocol.nextPositionId() == 1, "first position ID");
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.Expired.selector);
        protocol.use(tickId, 1 ether, type(uint256).max, block.timestamp - 1, address(0));
        require(protocol.nextPositionId() == 1, "revert preserves ID");
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, 1 ether, type(uint256).max, block.timestamp, address(0));
        require(positionId == 1 && protocol.nextPositionId() == 2, "exact deadline succeeds");
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.Slippage.selector);
        protocol.use(tickId, 1 ether, 0, block.timestamp, address(0));
        require(protocol.nextPositionId() == 2, "slippage preserves ID");
    }

    function _checkRepayElapsed(uint256 secondsElapsed, uint256 expectedYield) internal {
        _supply();
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, 400 ether, type(uint256).max, block.timestamp, address(0));
        YieldOrders.Position memory p = protocol.getPosition(positionId);
        require(p.fullTermYieldAsset == 103_360_000_000_000_000, "frozen Yield vector");
        asset.mint(TAKER, 1 ether);
        vm.warp(p.openedAt + secondsElapsed);
        YieldOrders.RepayPreview memory preview = protocol.previewRepay(positionId);
        require(preview.grossYieldAsset == expectedYield, "elapsed Yield vector");
        vm.prank(TAKER);
        YieldOrders.RepayPreview memory repaid = protocol.repay(positionId, expectedYield);
        require(repaid.grossYieldAsset == expectedYield, "Repay matches preview");
        require(repaid.grossYieldAsset <= p.fullTermYieldAsset, "no more than full-term Yield");
    }

    function testRepayAfterOneSecond() public {
        _checkRepayElapsed(1, 1_196_296_296_297);
    }
    function testRepayAfterHalfDay() public {
        _checkRepayElapsed(43_200, 51_680_000_000_000_000);
    }
    function testRepayOneSecondBeforeMaturity() public {
        _checkRepayElapsed(86_399, 103_358_803_703_703_704);
    }

    function testWithdrawWhenAllAssetIsAvailable() public {
        _supply();
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory q = protocol.withdraw(tickId, 1_000 ether);
        require(q.availableAssetOut == 1_000 ether && q.workingToExit == 0, "immediate full withdrawal");
        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        require(t.totalShares == 0 && t.totalExitShares == 0, "no live shares");
        require(protocol.tokenLiability(address(asset)) == 0, "no remaining Asset liability");
    }

    function testWithdrawWhenAllAssetIsWorking() public {
        _supply();
        vm.prank(TAKER);
        protocol.use(tickId, 1_000 ether, type(uint256).max, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory q = protocol.withdraw(tickId, 1_000 ether);
        require(q.availableAssetOut == 0 && q.workingToExit == 1_000 ether, "all Working enters Exit");
        (YieldOrders.Tick memory t, , uint256 ca) = protocol.getTick(tickId);
        require(ca == 0 && t.totalShares == 0 && t.generation == 0, "no active principal or shares");
        require(t.exitWorking == 1_000 ether && t.totalExitShares == 1_000 ether, "full Exit claim");
        require(protocol.tokenLiability(address(asset)) == 0, "Asset remains with taker");
    }

    function testExtremeQuoteAmountFailsWithoutOverflowingAccounting() public {
        MockERC20 largeAsset = new MockERC20("Large Asset", "LARGE", 18);
        uint256 pairId = protocol.createPair(address(largeAsset), address(quote));
        uint8 direction = address(largeAsset) < address(quote) ? 0 : 1;
        uint256 extremeTick = protocol.createTick(pairId, direction, 887272, 1);
        largeAsset.mint(PROVIDER, type(uint256).max);
        vm.prank(PROVIDER);
        largeAsset.approve(address(protocol), type(uint256).max);
        vm.prank(PROVIDER);
        protocol.supply(extremeTick, type(uint256).max, address(0));
        bool reverted;
        try protocol.previewUse(extremeTick, type(uint256).max) returns (YieldOrders.UsePreview memory) {
            reverted = false;
        } catch {
            reverted = true;
        }
        require(reverted, "unrepresentable Quote reverts");
        require(protocol.tokenLiability(address(largeAsset)) == type(uint256).max, "large supply remains intact");
    }

    function _setupRepayCapacityMarket() internal returns (MockERC20 hugeAsset, MockERC20 tinyQuote, uint256 lowTick) {
        hugeAsset = new MockERC20("Huge Asset", "HUGE", 18);
        tinyQuote = new MockERC20("Tiny Quote", "TINY", 18);
        uint256 pairId = protocol.createPair(address(hugeAsset), address(tinyQuote));
        uint8 direction = address(hugeAsset) < address(tinyQuote) ? 0 : 1;
        lowTick = protocol.createTick(pairId, direction, -887272, 1);
        hugeAsset.mint(PROVIDER, type(uint256).max);
        tinyQuote.mint(TAKER, type(uint256).max);
        vm.prank(PROVIDER);
        hugeAsset.approve(address(protocol), type(uint256).max);
        vm.prank(TAKER);
        hugeAsset.approve(address(protocol), type(uint256).max);
        vm.prank(TAKER);
        tinyQuote.approve(address(protocol), type(uint256).max);
        vm.prank(PROVIDER);
        protocol.supply(lowTick, type(uint256).max, address(0));
    }

    function testUseRepayCapacityExactBoundary() public {
        (MockERC20 hugeAsset, , uint256 lowTick) = _setupRepayCapacityMarket();
        uint256 principal = 115496865684420085078288223316955053204900112972514152743266012636331840087102;
        uint256 expectedYield = 295223552896110345282761691732854648369871693126411296191571371581289552833;
        require(principal + expectedYield == type(uint256).max, "exact representable boundary");
        YieldOrders.UsePreview memory valid = protocol.previewUse(lowTick, principal);
        require(valid.fullTermYieldAsset == expectedYield, "canonical full-term Yield at boundary");

        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.previewUse(lowTick, principal + 1);
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.use(lowTick, principal + 1, type(uint256).max, block.timestamp, address(0));
        require(protocol.nextPositionId() == 1, "rejected Use creates no Position");

        vm.prank(TAKER);
        uint256 positionId = protocol.use(lowTick, principal, expectedYield, block.timestamp, address(0));
        require(protocol.getPosition(positionId).fullTermYieldAsset == expectedYield, "frozen boundary Yield");
        YieldOrders.RepayPreview memory repayQuote = protocol.previewRepay(positionId);
        require(repayQuote.totalAssetIn <= type(uint256).max, "same-timestamp Repay representable");
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory exit = protocol.withdraw(lowTick, type(uint256).max);
        require(exit.availableAssetOut == type(uint256).max - principal, "remaining Asset released");
        vm.prank(PROVIDER);
        hugeAsset.transfer(TAKER, exit.availableAssetOut);
        vm.prank(TAKER);
        protocol.repay(positionId, repayQuote.grossYieldAsset);
        require(protocol.getPosition(positionId).status == YieldOrders.Status.REPAID, "boundary Use can Repay");
    }

    function testExtremeSwapDoesNotRequireRepayCapacity() public {
        (, MockERC20 tinyQuote, uint256 lowTick) = _setupRepayCapacityMarket();
        uint256 principal = type(uint256).max;
        YieldOrders.SwapPreview memory swapQuote = protocol.previewSwap(lowTick, principal);
        require(swapQuote.referenceFullTermYieldAsset > type(uint256).max - principal, "Repay would overflow");
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.previewUse(lowTick, principal);
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.InvalidInput.selector);
        protocol.use(lowTick, principal, type(uint256).max, block.timestamp, address(0));

        vm.prank(TAKER);
        YieldOrders.SwapPreview memory received = protocol.swap(
            lowTick,
            principal,
            swapQuote.quotePrincipal,
            block.timestamp,
            address(0)
        );
        require(received.quotePrincipal == swapQuote.quotePrincipal, "extreme Swap still succeeds");
        require(tinyQuote.balanceOf(FEE_TO) == swapQuote.swapFee, "Swap fee still paid");
        require(protocol.nextPositionId() == 1, "Swap creates no Position");
    }

    function _checkWithdrawFraction(uint256 shares) internal {
        _supply();
        vm.prank(TAKER);
        protocol.use(tickId, 400 ether, type(uint256).max, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory q = protocol.withdraw(tickId, shares);
        require(q.principalClaim == shares, "proportional principal");
        require(q.availableAssetOut == (shares * 6) / 10, "available split");
        require(q.workingToExit == (shares * 4) / 10, "working split");
        require(q.availableAssetOut + q.workingToExit == q.principalClaim, "split conservation");
        (YieldOrders.Tick memory t, uint256 wa, uint256 ca) = protocol.getTick(tickId);
        require(t.workingSupply == 400 ether && t.exitWorking == q.workingToExit, "working custody");
        require(t.totalExitShares >= t.exitWorking, "Exit share bound");
        require(wa == 400 ether - q.workingToExit && ca == 1_000 ether - shares, "active principal");
        require(protocol.tokenLiability(address(asset)) == t.availableSupply, "aggregate Asset after withdrawal");
        YieldOrders.EarnPositionView memory p = protocol.getEarnPosition(PROVIDER, tickId);
        require(p.provider.shares == 1_000 ether - shares, "active shares burned");
        require(p.provider.exitShares == q.exitSharesMinted, "Exit shares minted");
    }

    function testWithdraw25Percent() public {
        _checkWithdrawFraction(250 ether);
    }
    function testWithdraw50Percent() public {
        _checkWithdrawFraction(500 ether);
    }
    function testWithdraw75Percent() public {
        _checkWithdrawFraction(750 ether);
    }
    function testWithdraw100Percent() public {
        _checkWithdrawFraction(1_000 ether);
    }

    function testTwoProvidersShareExitGeneration() public {
        vm.prank(PROVIDER);
        protocol.supply(tickId, 500 ether, address(0));
        asset.mint(OTHER_PROVIDER, 500 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 500 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 500 ether, address(0));
        vm.prank(TAKER);
        uint256 positionId = protocol.use(tickId, 600 ether, type(uint256).max, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory first = protocol.withdraw(tickId, 250 ether);
        vm.prank(OTHER_PROVIDER);
        YieldOrders.WithdrawPreview memory second = protocol.withdraw(tickId, 250 ether);
        require(first.workingToExit == 150 ether && second.workingToExit == 150 ether, "same Exit pool");
        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        require(t.exitWorking == 300 ether && t.totalExitShares == 300 ether, "pooled Exit shares");
        asset.mint(TAKER, 10 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        YieldOrders.RepayPreview memory repaid = protocol.repay(positionId, type(uint256).max);
        require(repaid.exitFill == 300 ether && repaid.activeReturn == 300 ether, "Exit first");
        require(repaid.exitYieldAsset + repaid.activeYieldAsset == repaid.grossYieldAsset, "Yield conserved");
        YieldOrders.CollectPreview memory claimA = protocol.previewCollect(tickId, PROVIDER);
        YieldOrders.CollectPreview memory claimB = protocol.previewCollect(tickId, OTHER_PROVIDER);
        require(claimA.exitAsset == 150 ether && claimB.exitAsset == 150 ether, "pooled principal claims");
        require(claimA.exitYieldAsset > 0 && claimB.exitYieldAsset > 0, "pooled Yield claims");
    }

    function testUncollectedClaimsSurviveTwoExitGenerations() public {
        _supply();
        vm.prank(TAKER);
        uint256 first = protocol.use(tickId, 400 ether, type(uint256).max, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 1_000 ether);
        asset.mint(OTHER_PROVIDER, 500 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 500 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 500 ether, address(0));
        asset.mint(TAKER, 10 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(first, type(uint256).max);
        (YieldOrders.Tick memory afterFirst, , ) = protocol.getTick(tickId);
        require(afterFirst.exitGeneration == 1, "first Exit generation finished");
        require(protocol.previewCollect(tickId, PROVIDER).exitAsset == 400 ether, "old claim remains");

        vm.prank(TAKER);
        uint256 second = protocol.use(tickId, 100 ether, type(uint256).max, block.timestamp, address(0));
        YieldOrders.EarnPositionView memory beforeWithdraw = protocol.getEarnPosition(OTHER_PROVIDER, tickId);
        vm.roll(beforeWithdraw.provider.lastSupplyBlock + 1);
        vm.prank(OTHER_PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(second, type(uint256).max);
        (YieldOrders.Tick memory afterSecond, , ) = protocol.getTick(tickId);
        require(afterSecond.exitGeneration == 2, "second Exit generation finished");
        YieldOrders.CollectPreview memory oldClaim = protocol.previewCollect(tickId, PROVIDER);
        YieldOrders.CollectPreview memory newClaim = protocol.previewCollect(tickId, OTHER_PROVIDER);
        require(oldClaim.exitAsset == 400 ether && newClaim.exitAsset == 100 ether, "generations stay separate");
        require(oldClaim.exitYieldAsset > 0 && newClaim.exitYieldAsset > 0, "each generation earns its Yield");
        vm.prank(PROVIDER);
        protocol.collect(tickId);
        vm.prank(OTHER_PROVIDER);
        protocol.collect(tickId);
        require(protocol.tokenLiability(address(asset)) <= 2, "only growth-rounding dust remains");
    }

    function _checkResolutionBoundary(uint256 firstAmount, bool repayFirst) internal {
        _supply();
        vm.prank(TAKER);
        uint256 firstPosition = protocol.use(tickId, firstAmount, type(uint256).max, block.timestamp, address(0));
        vm.prank(TAKER);
        protocol.use(tickId, 400 ether - firstAmount, type(uint256).max, block.timestamp, address(0));
        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        uint256 expectedExit = firstAmount < 200 ether ? firstAmount : 200 ether;
        if (repayFirst) {
            asset.mint(TAKER, 10 ether);
            vm.warp(block.timestamp + 100);
            vm.prank(TAKER);
            YieldOrders.RepayPreview memory q = protocol.repay(firstPosition, type(uint256).max);
            require(q.exitFill == expectedExit && q.activeReturn == firstAmount - expectedExit, "Repay boundary");
            require(q.exitYieldAsset + q.activeYieldAsset == q.grossYieldAsset, "Repay Yield split");
        } else {
            YieldOrders.Position memory p = protocol.getPosition(firstPosition);
            vm.warp(p.maturity);
            protocol.close(firstPosition);
            (YieldOrders.Tick memory closedTick, , ) = protocol.getTick(tickId);
            uint256 expectedExitQuote = ((p.quotePrincipal - p.closeFee) * expectedExit) / firstAmount;
            require(closedTick.exitQuoteReserve == expectedExitQuote, "Close Exit boundary");
            require(
                closedTick.activeQuoteReserve == p.quotePrincipal - p.closeFee - expectedExitQuote,
                "Close active split"
            );
        }
        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        require(t.exitWorking == 200 ether - expectedExit, "remaining Exit Working");
        require(t.totalExitShares >= t.exitWorking, "Exit shares cover Working");
        require(asset.balanceOf(address(protocol)) >= protocol.tokenLiability(address(asset)), "Asset solvent");
        require(quote.balanceOf(address(protocol)) >= protocol.tokenLiability(address(quote)), "Quote solvent");
    }

    function testRepayBelowExitWorking() public {
        _checkResolutionBoundary(100 ether, true);
    }
    function testRepayExactlyExitWorking() public {
        _checkResolutionBoundary(200 ether, true);
    }
    function testRepayAboveExitWorking() public {
        _checkResolutionBoundary(300 ether, true);
    }
    function testCloseBelowExitWorking() public {
        _checkResolutionBoundary(100 ether, false);
    }
    function testCloseExactlyExitWorking() public {
        _checkResolutionBoundary(200 ether, false);
    }
    function testCloseAboveExitWorking() public {
        _checkResolutionBoundary(300 ether, false);
    }

    function _assertTwoTickLiabilities(uint256 otherTick) internal view {
        (YieldOrders.Tick memory a, , ) = protocol.getTick(tickId);
        (YieldOrders.Tick memory b, , ) = protocol.getTick(otherTick);
        uint256 assetDue = a.availableSupply + a.exitAssetReserve + a.yieldAssetReserve;
        assetDue += b.availableSupply + b.exitAssetReserve + b.yieldAssetReserve;
        uint256 quoteDue = a.quoteEscrow + a.exitQuoteReserve + a.activeQuoteReserve;
        quoteDue += b.quoteEscrow + b.exitQuoteReserve + b.activeQuoteReserve;
        require(protocol.tokenLiability(address(asset)) == assetDue, "aggregate Asset exact");
        require(protocol.tokenLiability(address(quote)) == quoteDue, "aggregate Quote exact");
        require(asset.balanceOf(address(protocol)) >= assetDue, "aggregate Asset solvent");
        require(quote.balanceOf(address(protocol)) >= quoteDue, "aggregate Quote solvent");
        require(a.exitWorking <= a.workingSupply && b.exitWorking <= b.workingSupply, "Exit Working bounds");
        require(a.totalExitShares >= a.exitWorking && b.totalExitShares >= b.exitWorking, "Exit share bounds");
    }

    function testFuzz_TwoTickActionSequencePreservesGlobalLiabilities(
        uint32 supplyASeed,
        uint32 supplyBSeed,
        uint32 useASeed,
        uint32 useBSeed,
        uint32 withdrawASeed,
        uint32 withdrawBSeed
    ) public {
        uint256 supplyA = ((uint256(supplyASeed) % 500) + 1) * 1 ether;
        uint256 supplyB = ((uint256(supplyBSeed) % 500) + 1) * 1 ether;
        uint256 useA = ((uint256(useASeed) % (supplyA / 1 ether)) + 1) * 1 ether;
        uint256 useB = ((uint256(useBSeed) % (supplyB / 1 ether)) + 1) * 1 ether;
        uint256 withdrawA = ((uint256(withdrawASeed) % (supplyA / 1 ether)) + 1) * 1 ether;
        uint256 withdrawB = ((uint256(withdrawBSeed) % (supplyB / 1 ether)) + 1) * 1 ether;
        (uint256 pairId, , , ) = protocol.getPair(address(asset), address(quote));
        uint8 direction = address(asset) < address(quote) ? 0 : 1;
        uint256 otherTick = protocol.createTick(pairId, direction, 0, 2);

        vm.prank(PROVIDER);
        protocol.supply(tickId, supplyA, address(0));
        _assertTwoTickLiabilities(otherTick);
        vm.prank(PROVIDER);
        protocol.supply(otherTick, supplyB, address(0));
        _assertTwoTickLiabilities(otherTick);
        vm.prank(TAKER);
        uint256 positionA = protocol.use(tickId, useA, type(uint256).max, block.timestamp, address(0));
        _assertTwoTickLiabilities(otherTick);
        vm.prank(TAKER);
        uint256 positionB = protocol.use(otherTick, useB, type(uint256).max, block.timestamp, address(0));
        _assertTwoTickLiabilities(otherTick);

        vm.roll(block.number + 1);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, withdrawA);
        _assertTwoTickLiabilities(otherTick);
        vm.prank(PROVIDER);
        protocol.withdraw(otherTick, withdrawB);
        _assertTwoTickLiabilities(otherTick);
        asset.mint(TAKER, 1_000 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(positionB, type(uint256).max);
        _assertTwoTickLiabilities(otherTick);
        vm.prank(TAKER);
        protocol.repay(positionA, type(uint256).max);
        _assertTwoTickLiabilities(otherTick);
        vm.prank(PROVIDER);
        protocol.collect(otherTick);
        _assertTwoTickLiabilities(otherTick);
        vm.prank(PROVIDER);
        protocol.collect(tickId);
        _assertTwoTickLiabilities(otherTick);
    }
    function _supply(uint256 amount) internal {
        vm.prank(PROVIDER);
        protocol.supply(tickId, amount, address(0));
    }

    function _use(uint256 amount) internal returns (uint256) {
        vm.prank(TAKER);
        return protocol.use(tickId, amount, type(uint256).max, block.timestamp, address(0));
    }

    function _rollPastSupply(address supplier) internal {
        YieldOrders.EarnPositionView memory p = protocol.getEarnPosition(supplier, tickId);
        vm.roll(p.provider.lastSupplyBlock + 1);
    }

    function _cursor() internal view returns (uint64) {
        (YieldOrders.Tick memory tick, , ) = protocol.getTick(tickId);
        return tick.settleCursor;
    }

    function testRepayAndSwapTransactionBounds() public {
        _supply(1_000 ether);
        uint256 positionId = _use(400 ether);
        asset.mint(TAKER, 10 ether);
        vm.warp(block.timestamp + 100);
        uint256 gross = protocol.previewRepay(positionId).grossYieldAsset;
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.Slippage.selector);
        protocol.repay(positionId, gross - 1);
        require(protocol.getPosition(positionId).status == YieldOrders.Status.ACTIVE, "failed Repay stays active");
        vm.prank(TAKER);
        protocol.repay(positionId, gross);

        uint256 quoteIn = protocol.previewSwap(tickId, 100 ether).quotePrincipal;
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.Slippage.selector);
        protocol.swap(tickId, 100 ether, quoteIn - 1, block.timestamp, address(0));
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.Expired.selector);
        protocol.swap(tickId, 100 ether, quoteIn, block.timestamp - 1, address(0));
        vm.prank(TAKER);
        protocol.swap(tickId, 100 ether, quoteIn, block.timestamp, address(0));
    }

    function testUsePositionRetainsFrozenTermsAfterUtilizationChanges() public {
        _supply(1_000 ether);
        uint256 first = _use(400 ether);
        YieldOrders.Position memory opened = protocol.getPosition(first);
        uint256 later = _use(300 ether);
        require(
            protocol.getPosition(later).fullTermYieldAsset > (opened.fullTermYieldAsset * 3) / 4,
            "curve reprices new Use"
        );
        asset.mint(OTHER_PROVIDER, 500 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 500 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 500 ether, address(0));
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 200 ether);
        YieldOrders.Position memory afterChanges = protocol.getPosition(first);
        require(afterChanges.fullTermYieldAsset == opened.fullTermYieldAsset, "full-term Yield frozen");
        require(afterChanges.closeFee == opened.closeFee, "Close fee frozen");
        require(afterChanges.maturity == opened.maturity, "maturity frozen");
        vm.warp(opened.openedAt + 43_200);
        uint256 expectedYield = (opened.fullTermYieldAsset + 1) / 2;
        require(protocol.previewRepay(first).grossYieldAsset == expectedYield, "Repay schedule frozen");
    }

    function testExitDoesNotBlockActiveSupplyUseOrSwap() public {
        _supply(1_000 ether);
        _use(400 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        (YieldOrders.Tick memory before, , ) = protocol.getTick(tickId);
        require(before.exitWorking == 200 ether, "Exit established");

        asset.mint(OTHER_PROVIDER, 200 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 200 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 200 ether, address(0));
        (YieldOrders.Tick memory afterSupply, , ) = protocol.getTick(tickId);
        require(afterSupply.exitWorking == before.exitWorking, "Supply preserves Exit Working");

        _use(100 ether);
        (YieldOrders.Tick memory afterUse, , ) = protocol.getTick(tickId);
        require(afterUse.workingSupply == before.workingSupply + 100 ether, "new Use adds Working");
        require(afterUse.exitWorking == before.exitWorking, "new Use does not join old Exit");

        vm.prank(TAKER);
        protocol.swap(tickId, 100 ether, type(uint256).max, block.timestamp, address(0));
        (YieldOrders.Tick memory afterSwap, , ) = protocol.getTick(tickId);
        require(afterSwap.exitWorking == before.exitWorking, "Swap preserves Exit Working");
        require(afterSwap.workingSupply == afterUse.workingSupply, "Swap does not touch Working");
    }

    function testRepeatedWithdrawalMintsExitSharesInSameGeneration() public {
        _supply(1_000 ether);
        _use(600 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory first = protocol.withdraw(tickId, 250 ether);
        vm.prank(PROVIDER);
        YieldOrders.WithdrawPreview memory second = protocol.withdraw(tickId, 250 ether);
        YieldOrders.EarnPositionView memory provider = protocol.getEarnPosition(PROVIDER, tickId);
        (YieldOrders.Tick memory tick, , ) = protocol.getTick(tickId);
        require(first.workingToExit == 150 ether && second.workingToExit == 150 ether, "both join live Exit");
        require(provider.provider.exitShares == first.exitSharesMinted + second.exitSharesMinted, "shares aggregate");
        require(tick.exitGeneration == 0, "same Exit generation");
    }

    function testOneRawWorkingUnitMintsSharesInLiveExit() public {
        _supply(100);
        _use(100);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 50);
        asset.mint(OTHER_PROVIDER, 1);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 1);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 1, address(0));
        _rollPastSupply(OTHER_PROVIDER);
        vm.prank(OTHER_PROVIDER);
        YieldOrders.WithdrawPreview memory q = protocol.withdraw(tickId, 1);
        require(q.workingToExit == 1 && q.exitSharesMinted == 1, "one raw Working unit mints Exit share");
        (YieldOrders.Tick memory tick, , ) = protocol.getTick(tickId);
        require(tick.exitWorking == 51 && tick.totalExitShares == 51, "Exit invariant preserved");
    }

    function testPairLookupAndDeterministicTickInitialization() public {
        MockERC20 unrelated = new MockERC20("Unrelated", "UNR", 18);
        (uint256 uninitialized, address low, address high, bool exists) = protocol.getPair(
            address(quote),
            address(unrelated)
        );
        require(!exists && low < high, "valid uninitialized pair");
        require(uninitialized == uint256(keccak256(abi.encode(low, high))), "deterministic uninitialized ID");
        (uint256 reversed, address reverseLow, address reverseHigh, bool reversedExists) = protocol.getPair(
            address(unrelated),
            address(quote)
        );
        require(
            reversed == uninitialized && reverseLow == low && reverseHigh == high && !reversedExists,
            "reversed lookup"
        );
        uint256 created = protocol.createPair(address(unrelated), address(quote));
        require(created == uninitialized, "creation uses predicted ID");
        uint8 direction = address(asset) < address(quote) ? 0 : 1;
        (uint256 pairId, , , ) = protocol.getPair(address(asset), address(quote));
        uint256 expectedTick = uint256(keccak256(abi.encode(pairId, direction, int32(0), uint64(1))));
        require(tickId == expectedTick, "canonical Tick ID");
        vm.expectRevert(YieldOrders.AlreadyExists.selector);
        protocol.createTick(pairId, direction, 0, 1);
        (YieldOrders.Tick memory tick, uint256 working, uint256 principal) = protocol.getTick(tickId);
        require(working == 0 && principal == 0 && tick.settleCursor == 0 && tick.nextPositionSeq == 0, "zero cursor");
        require(
            tick.exitWorking == 0 && tick.totalExitShares == 0 && tick.generation == 0 && tick.exitGeneration == 0,
            "zero generations"
        );
        require(
            tick.exitAssetReserve == 0 &&
                tick.yieldAssetReserve == 0 &&
                tick.exitQuoteReserve == 0 &&
                tick.activeQuoteReserve == 0 &&
                tick.quoteEscrow == 0,
            "zero reserves"
        );
    }

    function _openPartialExit() internal returns (uint256 first, uint256 second) {
        _supply(1_000 ether);
        first = _use(100 ether);
        second = _use(300 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        asset.mint(TAKER, 10 ether);
    }

    function testUseAndSwapCannotConsumeFundedExitOrYieldReserves() public {
        _supply(1_000 ether);
        uint256 positionId = _use(400 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        asset.mint(TAKER, 10 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(positionId, type(uint256).max);
        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        require(t.exitAssetReserve == 200 ether && t.yieldAssetReserve > 0, "both reserves funded");
        uint256 unavailable = t.availableSupply + 1;
        require(asset.balanceOf(address(protocol)) >= unavailable, "physical balance appears sufficient");
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.InsufficientLiquidity.selector);
        protocol.use(tickId, unavailable, type(uint256).max, block.timestamp, address(0));
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.InsufficientLiquidity.selector);
        protocol.swap(tickId, unavailable, type(uint256).max, block.timestamp, address(0));
        (YieldOrders.Tick memory afterAttempts, , ) = protocol.getTick(tickId);
        require(afterAttempts.exitAssetReserve == t.exitAssetReserve, "Exit reserve isolated");
        require(afterAttempts.yieldAssetReserve == t.yieldAssetReserve, "Yield reserve isolated");
    }

    function testCollectPartiallyResolvedExitThenCollectRemainder() public {
        (uint256 first, uint256 second) = _openPartialExit();
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(first, type(uint256).max);
        (YieldOrders.Tick memory partialTick, , ) = protocol.getTick(tickId);
        require(
            partialTick.exitWorking == 100 ether && partialTick.exitAssetReserve == 100 ether,
            "partial Exit resolved"
        );
        require(partialTick.exitAssetGrowthX128 == protocol.Q128() / 2, "exact half Exit Asset growth");
        vm.prank(PROVIDER);
        YieldOrders.CollectPreview memory firstClaim = protocol.collect(tickId);
        require(firstClaim.exitAsset == 100 ether && firstClaim.exitYieldAsset > 0, "first claim paid");
        YieldOrders.EarnPositionView memory remaining = protocol.getEarnPosition(PROVIDER, tickId);
        require(remaining.provider.exitShares == 200 ether, "unresolved Exit shares remain");

        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(second, type(uint256).max);
        (YieldOrders.Tick memory settled, , ) = protocol.getTick(tickId);
        require(settled.exitWorking == 0 && settled.exitGeneration == 1, "Exit finally resolved");
        (uint256 assetGrowth, , ) = protocol.finalExit(tickId, 0);
        require(assetGrowth == protocol.Q128(), "exact full Exit Asset growth");
        vm.prank(PROVIDER);
        YieldOrders.CollectPreview memory secondClaim = protocol.collect(tickId);
        require(secondClaim.exitAsset == 100 ether && secondClaim.exitYieldAsset > 0, "remaining claim paid");
        require(firstClaim.exitAsset + secondClaim.exitAsset == 200 ether, "principal paid once");
    }

    function testCanonicalUtilizationRepayAndExitYieldGrowthVectors() public {
        _supply(1_000 ether);
        YieldOrders.UsePreview memory quoted = protocol.previewUse(tickId, 400 ether);
        require(quoted.activeWorkingShareBefore == 0, "starting utilization");
        require(
            quoted.activeWorkingShareAfter == 136112946768375385385349842972707284582,
            "Q128 utilization rounds down"
        );
        uint256 u2 = Math.mulDiv(quoted.activeWorkingShareAfter, quoted.activeWorkingShareAfter, protocol.Q128());
        require(u2 == 54445178707350154154139937189082913832, "Q128 square rounds down");
        require(
            Math.mulDiv(u2, u2, protocol.Q128()) == 8711228593176024664662389950253266212,
            "Q128 fourth power rounds down"
        );
        require(quoted.fullTermYieldAsset == 103360000000000000, "full-term Yield rounds up");
        require(quoted.quotePrincipal == 400 ether && quoted.closeFee == 10336000000000000, "Quote and fee");

        uint256 positionId = _use(400 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        asset.mint(TAKER, 1 ether);
        vm.warp(block.timestamp + 100);
        YieldOrders.RepayPreview memory beforeRepay = protocol.previewRepay(positionId);
        require(beforeRepay.grossYieldAsset == 119629629629630, "elapsed Repay Yield rounds up");
        require(beforeRepay.exitFill == 200 ether && beforeRepay.activeReturn == 200 ether, "principal split");
        require(
            beforeRepay.exitYieldAsset == 59814814814815 && beforeRepay.activeYieldAsset == 59814814814815,
            "Yield split"
        );
        vm.prank(TAKER);
        protocol.repay(positionId, beforeRepay.grossYieldAsset);
        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        (uint256 exitAssetGrowth, uint256 exitYieldGrowth, ) = protocol.finalExit(tickId, 0);
        require(exitAssetGrowth == protocol.Q128(), "Exit Asset growth exact");
        require(exitYieldGrowth == 101769633810614318500960110313819, "Exit Yield growth rounds down");
        require(t.yieldAssetGrowthX128 == 40707853524245727400384044125527, "active Yield growth rounds down");
        YieldOrders.CollectPreview memory claim = protocol.previewCollect(tickId, PROVIDER);
        require(claim.exitAsset == 200 ether, "Exit principal claim");
        require(claim.exitYieldAsset == 59814814814814, "Exit Yield claim double rounding");
        require(claim.activeYieldAsset == 59814814814814, "active Yield claim double rounding");
        require(claim.yieldFeeAsset == 11962962962962, "protocol Yield fee rounds down");
    }

    function testExitQuoteGrowthAndCloseFeeGoldenVector() public {
        _supply(1_000 ether);
        uint256 positionId = _use(400 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        vm.warp(protocol.getPosition(positionId).maturity);
        protocol.close(positionId);

        (YieldOrders.Tick memory t, , ) = protocol.getTick(tickId);
        (, , uint256 exitQuoteGrowth) = protocol.finalExit(tickId, 0);
        require(t.exitQuoteReserve == 199994832000000000000, "Exit Quote reserve");
        require(t.activeQuoteReserve == 199994832000000000000, "active Quote reserve");
        require(exitQuoteGrowth == 340273574024577226413478713831912174565, "Exit Quote growth rounds down");
        require(t.swapQuoteGrowthX128 == 136109429609830890565391485532764869826, "active Quote growth rounds down");
        require(quote.balanceOf(FEE_TO) == 10336000000000000, "Close fee charged once");
        YieldOrders.CollectPreview memory claim = protocol.previewCollect(tickId, PROVIDER);
        require(claim.exitQuote == 199994831999999999999, "Exit Quote claim rounds down");
        require(claim.swapQuote == 199994831999999999999, "active Quote claim rounds down");
        require(claim.totalQuoteOut == 399989663999999999998, "combined Quote payout");
    }

    function testYieldFeeCarrySurvivesZeroClaimsAndNextGeneration() public {
        _supply(1);
        uint256 first = _use(1);
        asset.mint(TAKER, 1);
        vm.prank(TAKER);
        protocol.repay(first, 1);
        vm.prank(PROVIDER);
        YieldOrders.CollectPreview memory firstClaim = protocol.collect(tickId);
        require(firstClaim.grossYieldAsset == 1 && firstClaim.yieldFeeAsset == 0, "first fractional fee carried");
        vm.prank(TAKER);
        protocol.swap(tickId, 1, 1, block.timestamp, address(0));
        (YieldOrders.Tick memory afterSwap, , ) = protocol.getTick(tickId);
        require(afterSwap.generation == 1, "active generation rolled");
        vm.prank(PROVIDER);
        protocol.collect(tickId);
        YieldOrders.EarnPositionView memory empty = protocol.getEarnPosition(PROVIDER, tickId);
        require(empty.provider.shares == 0 && empty.provider.exitShares == 0, "no live shares");
        require(empty.provider.owedYieldAsset == 0 && empty.provider.owedSwapQuote == 0, "no owed claims");
        require(empty.provider.yieldFeeCarry == 1_000, "fee carry persists after pruning");

        vm.prank(PROVIDER);
        protocol.supply(tickId, 1, address(0));
        for (uint256 i; i < 9; ++i) {
            uint256 positionId = _use(1);
            asset.mint(TAKER, 1);
            vm.prank(TAKER);
            protocol.repay(positionId, 1);
            vm.prank(PROVIDER);
            YieldOrders.CollectPreview memory claim = protocol.collect(tickId);
            require(claim.grossYieldAsset == 1, "one raw Yield per split Collect");
            require(claim.yieldFeeAsset == (i == 8 ? 1 : 0), "fee paid on tenth raw Yield");
        }
        YieldOrders.EarnPositionView memory afterCollects = protocol.getEarnPosition(PROVIDER, tickId);
        require(afterCollects.provider.yieldFeeCarry == 0, "carry reset after whole fee");
        require(asset.balanceOf(FEE_TO) == 1, "split Collects equal one 10-unit fee");
    }

    function testNewExitSharesDoNotInheritFundedAssetYieldOrQuoteGrowth() public {
        _supply(1_000 ether);
        uint256 first = _use(100 ether);
        uint256 second = _use(100 ether);
        vm.warp(block.timestamp + 1);
        uint256 third = _use(200 ether); // Matures after the first two Positions.
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 750 ether);
        asset.mint(TAKER, 10 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(first, type(uint256).max);
        YieldOrders.Position memory secondPosition = protocol.getPosition(second);
        vm.warp(secondPosition.maturity);
        protocol.close(second);
        YieldOrders.CollectPreview memory historical = protocol.previewCollect(tickId, PROVIDER);
        require(historical.exitAsset == 100 ether - 1 && historical.exitYieldAsset > 0, "old Repay growth funded");
        require(historical.exitQuote > 0, "old Close growth funded");

        asset.mint(OTHER_PROVIDER, 100 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 100 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 100 ether, address(0));
        _rollPastSupply(OTHER_PROVIDER);
        vm.prank(OTHER_PROVIDER);
        YieldOrders.WithdrawPreview memory joined = protocol.withdraw(tickId, 100 ether);
        require(joined.exitSharesMinted > 0, "late provider joined live Exit");
        YieldOrders.CollectPreview memory late = protocol.previewCollect(tickId, OTHER_PROVIDER);
        require(late.exitAsset == 0 && late.exitYieldAsset == 0 && late.exitQuote == 0, "no historical Exit growth");

        vm.prank(TAKER);
        protocol.repay(third, type(uint256).max);
        late = protocol.previewCollect(tickId, OTHER_PROVIDER);
        require(late.exitAsset > 0 && late.exitYieldAsset > 0, "new Exit growth received");
        require(late.exitQuote == 0, "old Exit Quote stays with old provider");
        require(
            protocol.previewCollect(tickId, PROVIDER).exitQuote == historical.exitQuote,
            "old Quote remains claimable"
        );
    }

    function testCursorSkipsOutOfOrderTerminalPositionsOneAtATime() public {
        _supply(1_000 ether);
        uint256 first = _use(100 ether);
        uint256 second = _use(100 ether);
        uint256 third = _use(100 ether);
        asset.mint(TAKER, 10 ether);
        protocol.settle(tickId);
        require(_cursor() == 0, "non-mature cursor does not move");
        vm.prank(TAKER);
        protocol.repay(second, type(uint256).max);
        require(_cursor() == 0, "out-of-order Repay leaves cursor");
        vm.prank(TAKER);
        protocol.repay(first, type(uint256).max);
        require(_cursor() == 1, "cursor Repay advances once");
        protocol.settle(tickId);
        require(_cursor() == 2, "terminal entry skipped once");
        protocol.settle(tickId);
        require(_cursor() == 2, "next ACTIVE entry blocks");
        vm.warp(protocol.getPosition(third).maturity);
        protocol.close(third);
        require(_cursor() == 3, "cursor Close advances once");
        protocol.settle(tickId);
        require(_cursor() == 3, "empty queue does not move");
    }

    function testRepayCloseExactMaturityBoundary() public {
        _supply(1_000 ether);
        uint256 beforeMaturity = _use(100 ether);
        uint256 atMaturity = _use(100 ether);
        asset.mint(TAKER, 10 ether);
        uint256 maturity = protocol.getPosition(beforeMaturity).maturity;
        vm.warp(maturity - 1);
        vm.expectRevert(YieldOrders.InvalidState.selector);
        protocol.close(beforeMaturity);
        vm.prank(TAKER);
        protocol.repay(beforeMaturity, type(uint256).max);
        require(_cursor() == 1, "pre-maturity Repay advances cursor");
        vm.warp(maturity);
        vm.prank(TAKER);
        vm.expectRevert(YieldOrders.InvalidState.selector);
        protocol.repay(atMaturity, type(uint256).max);
        protocol.close(atMaturity);
        require(_cursor() == 2, "at-maturity Close advances cursor");
    }

    function testSettlementCursorAcrossActiveAndExitGenerationRollover() public {
        _supply(1_000 ether);
        uint256 first = _use(1_000 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        vm.warp(protocol.getPosition(first).maturity);
        protocol.close(first);
        (YieldOrders.Tick memory rolled, , ) = protocol.getTick(tickId);
        require(rolled.generation == 1 && rolled.exitGeneration == 1, "both generations rolled");
        require(rolled.settleCursor == 1 && rolled.nextPositionSeq == 1, "cursor survived rollover");

        asset.mint(OTHER_PROVIDER, 100 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 100 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 100 ether, address(0));
        uint256 second = _use(50 ether);
        protocol.settle(tickId);
        require(_cursor() == 1, "new non-mature cursor blocks");
        vm.prank(TAKER);
        protocol.repay(second, type(uint256).max);
        (YieldOrders.Tick memory finished, , ) = protocol.getTick(tickId);
        require(finished.settleCursor == 2 && finished.nextPositionSeq == 2, "new cursor Repay advances once");
    }

    function testActiveGenerationCanExhaustWhileOldExitContinues() public {
        _supply(1_000 ether);
        uint256 positionId = _use(400 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 1_000 ether);
        asset.mint(OTHER_PROVIDER, 100 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 100 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 100 ether, address(0));
        vm.prank(TAKER);
        protocol.swap(tickId, 100 ether, type(uint256).max, block.timestamp, address(0));
        (YieldOrders.Tick memory afterSwap, , ) = protocol.getTick(tickId);
        require(afterSwap.generation == 1, "active generation finalized");
        require(afterSwap.exitGeneration == 0 && afterSwap.exitWorking == 400 ether, "old Exit remains live");
        require(
            afterSwap.workingSupply == 400 ether && afterSwap.totalExitShares == 400 ether,
            "Exit still funded by Working"
        );
        asset.mint(TAKER, 1 ether);
        vm.prank(TAKER);
        protocol.repay(positionId, type(uint256).max);
        (YieldOrders.Tick memory afterRepay, , ) = protocol.getTick(tickId);
        require(afterRepay.generation == 1 && afterRepay.exitGeneration == 1, "independent Exit finalization");
        require(
            protocol.previewCollect(tickId, PROVIDER).exitAsset == 400 ether,
            "old Exit claim survived active rollover"
        );
    }

    function testStaleProviderKeepsOldAssetYieldAcrossTwoActiveAndExitGenerations() public {
        _supply(1_000 ether);
        uint256 first = _use(400 ether);
        _rollPastSupply(PROVIDER);
        vm.prank(PROVIDER);
        protocol.withdraw(tickId, 500 ether);
        asset.mint(TAKER, 1 ether);
        vm.warp(block.timestamp + 100);
        vm.prank(TAKER);
        protocol.repay(first, type(uint256).max);
        vm.prank(TAKER);
        protocol.swap(tickId, 500 ether, type(uint256).max, block.timestamp, address(0));
        (YieldOrders.Tick memory firstRollover, , ) = protocol.getTick(tickId);
        require(firstRollover.generation == 1 && firstRollover.exitGeneration == 1, "first generations finalized");
        YieldOrders.CollectPreview memory oldClaim = protocol.previewCollect(tickId, PROVIDER);
        require(oldClaim.activeYieldAsset > 0 && oldClaim.exitYieldAsset > 0, "old Asset Yield uncollected");

        asset.mint(OTHER_PROVIDER, 200 ether);
        vm.prank(OTHER_PROVIDER);
        asset.approve(address(protocol), 200 ether);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 100 ether, address(0));
        uint256 second = _use(100 ether);
        _rollPastSupply(OTHER_PROVIDER);
        vm.prank(OTHER_PROVIDER);
        protocol.withdraw(tickId, 100 ether);
        asset.mint(TAKER, 1 ether);
        vm.prank(TAKER);
        protocol.repay(second, type(uint256).max);
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickId, 100 ether, address(0));
        vm.prank(TAKER);
        protocol.swap(tickId, 100 ether, type(uint256).max, block.timestamp, address(0));
        (YieldOrders.Tick memory secondRollover, , ) = protocol.getTick(tickId);
        require(secondRollover.generation == 2 && secondRollover.exitGeneration == 2, "two independent rollovers");

        YieldOrders.CollectPreview memory afterRollover = protocol.previewCollect(tickId, PROVIDER);
        require(afterRollover.exitAsset == oldClaim.exitAsset, "old Exit Asset isolated");
        require(afterRollover.activeYieldAsset == oldClaim.activeYieldAsset, "old active Yield isolated");
        require(afterRollover.exitYieldAsset == oldClaim.exitYieldAsset, "old Exit Yield isolated");
        require(afterRollover.swapQuote == oldClaim.swapQuote, "old active Quote isolated");
        vm.prank(PROVIDER);
        YieldOrders.CollectPreview memory received = protocol.collect(tickId);
        require(
            received.totalAssetOut == oldClaim.totalAssetOut && received.totalQuoteOut == oldClaim.totalQuoteOut,
            "stale provider collects only old claims"
        );
    }

    function testMaturityAdditionOverflowReverts() public {
        _supply(1_000 ether);
        vm.warp(type(uint256).max - 1 days + 1);
        vm.prank(TAKER);
        vm.expectRevert(abi.encodeWithSelector(bytes4(0x4e487b71), uint256(0x11)));
        protocol.use(tickId, 100 ether, type(uint256).max, type(uint256).max, address(0));
    }

    function testExtremeDurationMaturityOverflowReverts() public {
        (uint256 pairId, , , ) = protocol.getPair(address(asset), address(quote));
        uint8 direction = address(asset) < address(quote) ? 0 : 1;
        uint64 duration = type(uint64).max;
        uint256 longTick = protocol.createTick(pairId, direction, -887272, duration);
        vm.prank(PROVIDER);
        protocol.supply(longTick, 1, address(0));
        vm.warp(type(uint256).max - uint256(duration) * 1 days + 1);
        vm.prank(TAKER);
        vm.expectRevert(abi.encodeWithSelector(bytes4(0x4e487b71), uint256(0x11)));
        protocol.use(longTick, 1, type(uint256).max, type(uint256).max, address(0));
    }
    function _setupStateMachine() internal {
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        tokenC = new MockERC20("Token C", "C", 18);
        tickAB = _createTick(address(tokenA), address(tokenB), 1);
        tickCA = _createTick(address(tokenC), address(tokenA), 2);
        address[4] memory actors = [PROVIDER, OTHER_PROVIDER, TAKER, OTHER_TAKER];
        for (uint256 i; i < actors.length; ++i) {
            tokenA.mint(actors[i], 10_000 ether);
            tokenB.mint(actors[i], 10_000 ether);
            tokenC.mint(actors[i], 10_000 ether);
            vm.prank(actors[i]);
            tokenA.approve(address(protocol), type(uint256).max);
            vm.prank(actors[i]);
            tokenB.approve(address(protocol), type(uint256).max);
            vm.prank(actors[i]);
            tokenC.approve(address(protocol), type(uint256).max);
        }
    }

    function _createTick(address assetToken, address quoteToken, uint64 days_) internal returns (uint256) {
        uint256 pairId = protocol.createPair(assetToken, quoteToken);
        return protocol.createTick(pairId, assetToken < quoteToken ? 0 : 1, 0, days_);
    }

    function _tick(uint256 choice) internal view returns (uint256) {
        return choice & 1 == 0 ? tickAB : tickCA;
    }

    function _provider(uint256 choice) internal pure returns (address) {
        return choice & 1 == 0 ? PROVIDER : OTHER_PROVIDER;
    }

    function _taker(uint256 choice) internal pure returns (address) {
        return choice & 1 == 0 ? TAKER : OTHER_TAKER;
    }

    function _supply(uint256 id, address provider) internal {
        vm.prank(provider);
        protocol.supply(id, 10 ether, address(0));
    }

    function _use(uint256 id, address taker) internal {
        (YieldOrders.Tick memory t, , ) = protocol.getTick(id);
        uint256 amount = t.availableSupply / 4;
        if (amount > 20 ether) amount = 20 ether;
        if (amount == 0) return;
        try protocol.previewUse(id, amount) returns (YieldOrders.UsePreview memory q) {
            vm.prank(taker);
            protocol.use(id, amount, q.fullTermYieldAsset, block.timestamp, address(0));
        } catch {}
    }

    function _withdraw(uint256 id, address provider) internal {
        YieldOrders.EarnPositionView memory p = protocol.getEarnPosition(provider, id);
        if (p.provider.shares == 0) return;
        uint256 shares = p.provider.shares / 2;
        if (shares == 0) shares = p.provider.shares;
        try protocol.previewWithdraw(id, provider, shares) returns (YieldOrders.WithdrawPreview memory) {
            vm.prank(provider);
            protocol.withdraw(id, shares);
        } catch {}
    }

    function _repayOrClose(address taker, bool repayPosition) internal {
        uint256[] memory active = protocol.getUsePositions(taker, 0, 100);
        if (active.length == 0) return;
        uint256 positionId = active[active.length - 1];
        YieldOrders.Position memory p = protocol.getPosition(positionId);
        if (repayPosition && block.timestamp < p.maturity) {
            vm.prank(taker);
            protocol.repay(positionId, type(uint256).max);
        } else if (!repayPosition && block.timestamp >= p.maturity) {
            protocol.close(positionId);
        }
    }

    function _swap(uint256 id, address taker) internal {
        (YieldOrders.Tick memory t, , ) = protocol.getTick(id);
        uint256 amount = t.availableSupply / 8;
        if (amount > 5 ether) amount = 5 ether;
        if (amount == 0) return;
        try protocol.previewSwap(id, amount) returns (YieldOrders.SwapPreview memory q) {
            vm.prank(taker);
            protocol.swap(id, amount, q.quotePrincipal, block.timestamp, address(0));
        } catch {}
    }

    function _assertTick(uint256 id) internal view {
        (YieldOrders.Tick memory t, , uint256 activePrincipal) = protocol.getTick(id);
        require(t.exitWorking <= t.workingSupply, "Exit exceeds Working");
        require((activePrincipal == 0) == (t.totalShares == 0), "active shares/principal mismatch");
        require((t.exitWorking == 0) == (t.totalExitShares == 0), "Exit shares/Working mismatch");
        require(t.totalExitShares >= t.exitWorking, "Exit share ratio");
        require(t.settleCursor <= t.nextPositionSeq, "cursor exceeds sequence");
    }

    function _assertToken(MockERC20 token, uint256 expected) internal view {
        require(protocol.tokenLiability(address(token)) == expected, "global token liability");
        require(token.balanceOf(address(protocol)) >= expected, "token undercollateralized");
    }

    function _assertState() internal view {
        _assertTick(tickAB);
        _assertTick(tickCA);
        (YieldOrders.Tick memory ab, , ) = protocol.getTick(tickAB);
        (YieldOrders.Tick memory ca, , ) = protocol.getTick(tickCA);
        uint256 abAsset = ab.availableSupply + ab.exitAssetReserve + ab.yieldAssetReserve;
        uint256 abQuote = ab.quoteEscrow + ab.exitQuoteReserve + ab.activeQuoteReserve;
        uint256 caAsset = ca.availableSupply + ca.exitAssetReserve + ca.yieldAssetReserve;
        uint256 caQuote = ca.quoteEscrow + ca.exitQuoteReserve + ca.activeQuoteReserve;
        _assertToken(tokenA, abAsset + caQuote);
        _assertToken(tokenB, abQuote);
        _assertToken(tokenC, caAsset);
    }

    function testFuzz_StatefulActionsPreserveGlobalLiabilities(uint256 seed) public {
        _setupStateMachine();
        vm.prank(PROVIDER);
        protocol.supply(tickAB, 200 ether, address(0));
        vm.prank(OTHER_PROVIDER);
        protocol.supply(tickCA, 200 ether, address(0));
        _assertState();
        _use(tickAB, TAKER);
        _assertState();
        _use(tickCA, OTHER_TAKER);
        _assertState();

        uint64 previousCursorAB;
        uint64 previousCursorCA;
        for (uint256 i; i < 20; ++i) {
            vm.roll(block.number + 1);
            uint256 random = uint256(keccak256(abi.encode(seed, i)));
            uint256 id = _tick(random >> 8);
            address provider = _provider(random >> 9);
            address taker = _taker(random >> 10);
            uint256 action = random % 9;
            if (action == 0) _supply(id, provider);
            else if (action == 1) _use(id, taker);
            else if (action == 2) _withdraw(id, provider);
            else if (action == 3) _repayOrClose(taker, true);
            else if (action == 4) _swap(id, taker);
            else if (action == 5) {
                vm.prank(provider);
                protocol.collect(id);
            } else if (action == 6) protocol.settle(id);
            else if (action == 7) _repayOrClose(taker, false);
            else vm.warp(block.timestamp + 1 days);
            _assertState();
            (YieldOrders.Tick memory ab, , ) = protocol.getTick(tickAB);
            (YieldOrders.Tick memory ca, , ) = protocol.getTick(tickCA);
            require(ab.settleCursor >= previousCursorAB && ca.settleCursor >= previousCursorCA, "cursor decreased");
            previousCursorAB = ab.settleCursor;
            previousCursorCA = ca.settleCursor;
        }
    }
}
