// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {YieldOrders} from "../YieldOrders.sol";
import {MockERC20} from "./MockERC20.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
}

contract YieldOrdersTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    YieldOrders private protocol;
    MockERC20 private asset;
    MockERC20 private quote;
    uint256 private tickId;
    address private constant A = address(0xA11CE);
    address private constant B = address(0xB0B);
    address private constant TAKER = address(0xCAFE);

    function setUp() public {
        protocol = new YieldOrders(address(0xBEEF));
        asset = new MockERC20("Asset", "AST", 18);
        quote = new MockERC20("Quote", "QUO", 18);
        uint256 pairId = protocol.createPair(address(asset), address(quote));
        tickId = protocol.createTick(pairId, address(asset) < address(quote) ? 0 : 1, 0, 1);
        asset.mint(A, 1e24);
        asset.mint(B, 1e24);
        quote.mint(TAKER, 1e24);
        vm.prank(A);
        asset.approve(address(protocol), type(uint256).max);
        vm.prank(B);
        asset.approve(address(protocol), type(uint256).max);
        vm.prank(TAKER);
        quote.approve(address(protocol), type(uint256).max);
    }

    function testFractionalPrincipalSurvives() public {
        vm.prank(A);
        protocol.supply(tickId, 1, address(0));
        vm.prank(B);
        protocol.supply(tickId, 1, address(0));
        vm.prank(TAKER);
        protocol.swap(tickId, 1, 1, block.timestamp + 1, address(0));
        YieldOrders.TickView memory t = protocol.getTick(tickId);
        require(
            t.activePrincipal == 1 && protocol.getDomain(tickId, YieldOrders.DomainKind.Active).P == 5e38,
            "product"
        );
        YieldOrders.EarnPositionView memory a = protocol.getEarnPosition(A, tickId);
        YieldOrders.EarnPositionView memory b = protocol.getEarnPosition(B, tickId);
        require(a.activePrincipal == 0 && b.activePrincipal == 0, "raw floor");
        require(a.activePrincipalX36 > 0 && b.activePrincipalX36 > 0, "fractional discovery");
        require(a.claimableActiveQuote == 0 && b.claimableActiveQuote == 0, "quote floor");
    }

    function testSupplyAndUseKeepProduct() public {
        vm.prank(A);
        protocol.supply(tickId, 1000 ether, address(0));
        vm.prank(TAKER);
        protocol.use(tickId, 100 ether, type(uint256).max, block.timestamp + 1, address(0));
        YieldOrders.TickView memory t = protocol.getTick(tickId);
        require(
            t.activePrincipal == 1000 ether &&
                protocol.getDomain(tickId, YieldOrders.DomainKind.Active).P == protocol.P_PRECISION(),
            "principal and product"
        );
        vm.warp(block.timestamp + 1);
        vm.prank(A);
        YieldOrders.WithdrawPreview memory w = protocol.withdraw(tickId, 500 ether);
        require(w.availableAssetOut == 450 ether && w.workingToExit == 50 ether, "exit split");
        t = protocol.getTick(tickId);
        require(t.activePrincipal == 500 ether && t.exitWorking == 50 ether, "domains");
    }
}
