// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;

import {YieldOrders} from "../YieldOrders.sol";
import {YieldResolver, IMorphoFlashLoanCallback} from "../periphery/YieldResolver.sol";
import {MockERC20} from "./MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ResolverMorphoMock {
    uint256 public attack;
    function setAttack(uint256 value) external {
        attack = value;
    }
    function flashLoan(address token, uint256 amount, bytes calldata data) external {
        IERC20(token).transfer(msg.sender, amount);
        if (attack == 4) return;
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(
            attack == 1 ? amount + 1 : amount,
            attack == 2 ? bytes("wrong") : data
        );
        if (attack == 3) IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(amount, data);
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}

contract ResolverPermit2Mock {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }
    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(
            amount,
            expiration == 0 ? uint48(block.timestamp) : expiration,
            0
        );
    }
    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage authorized = allowance[from][token][msg.sender];
        require(authorized.amount >= amount && authorized.expiration >= block.timestamp, "permit allowance");
        authorized.amount -= amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}
contract ResolverRouterMock {
    ResolverPermit2Mock private immutable permit2;
    constructor(ResolverPermit2Mock p) {
        permit2 = p;
    }
    uint256 public multiplier = 2;
    uint256 public attack;
    function configure(uint256 rate, uint256 evil) external {
        multiplier = rate;
        attack = evil;
    }
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256) external {
        if (attack == 1) revert("route failed");
        if (attack == 2) {
            assembly {
                revert(0, 65536)
            }
        }
        if (attack == 3) {
            while (true) {}
        }
        if (attack == 4) {
            (bool ok, ) = msg.sender.call(
                abi.encodeWithSignature(
                    "execute((uint256,uint256,address,uint256,uint256,bytes,bytes)[],address)",
                    new bytes(0),
                    address(this)
                )
            );
            require(!ok, "reentry");
        }
        for (uint256 index; index < commands.length; ++index) {
            address from;
            address to;
            address recipient;
            uint256 amount;
            bool payer;
            if (commands[index] == 0x08) {
                address[] memory path;
                (recipient, amount, , path, payer, ) = abi.decode(
                    inputs[index],
                    (address, uint256, uint256, address[], bool, uint256[])
                );
                from = path[0];
                to = path[path.length - 1];
            } else {
                bytes memory path;
                (recipient, amount, , path, payer, ) = abi.decode(
                    inputs[index],
                    (address, uint256, uint256, bytes, bool, uint256[])
                );
                assembly ("memory-safe") {
                    from := shr(96, mload(add(path, 32)))
                    to := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
                }
            }
            if (payer) permit2.transferFrom(msg.sender, address(this), uint160(amount), from);
            IERC20(from).transfer(address(0xdead), amount);
            if (recipient == address(1)) recipient = msg.sender;
            if (recipient == address(2)) recipient = address(this);
            IERC20(to).transfer(recipient, amount * multiplier);
        }
    }
    function steal(address token, uint160 amount) external {
        permit2.transferFrom(msg.sender, address(0xbad), amount, token);
    }
    function directSteal(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(0xbad), amount);
    }
    function noOp() external {}
    function oversizedRevert() external pure {
        assembly {
            revert(0, 65536)
        }
    }
    function exhaustGas() external pure {
        while (true) {}
    }
}

contract ResolverHookToken is MockERC20 {
    address public target;
    bytes private payload;
    constructor() MockERC20("Hook token", "HOOK", 18) {}
    function arm(address resolver, bytes memory data) external {
        target = resolver;
        payload = data;
    }
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (target != address(0)) {
            (bool ok, bytes memory reason) = target.call(payload);
            require(!ok && bytes4(reason) == YieldResolver.Unauthorized.selector, "reentrant entry");
        }
    }
}

contract YieldResolverTest {
    YieldOrders private yld;
    YieldResolver private resolver;
    ResolverMorphoMock private morpho;
    ResolverRouterMock private router;
    ResolverPermit2Mock private permit2;
    MockERC20 private a;
    MockERC20 private q;
    MockERC20 private f;
    uint256 private tick;
    address private constant TO = address(0xbeef);
    function setUp() public {
        yld = new YieldOrders(address(0xf00));
        a = new MockERC20("Asset", "A", 18);
        q = new MockERC20("Quote", "Q", 18);
        f = new MockERC20("Flash", "F", 18);
        morpho = new ResolverMorphoMock();
        permit2 = new ResolverPermit2Mock();
        router = new ResolverRouterMock(permit2);
        resolver = new YieldResolver(address(yld), address(morpho), address(router), address(permit2));
        uint256 pair = yld.createPair(address(a), address(q));
        tick = yld.createTick(pair, address(a) < address(q) ? 0 : 1, 0, 7);
        a.mint(address(this), 10000);
        a.approve(address(yld), 10000);
        yld.supply(tick, 10000, address(0));
        a.mint(address(morpho), 10000);
        q.mint(address(morpho), 10000);
        f.mint(address(morpho), 10000);
        a.mint(address(router), 10000);
        q.mint(address(router), 10000);
        f.mint(address(router), 10000);
        // Router input balances need not start at zero. Use exact funding for this mock.
    }
    function route(
        address input,
        address output,
        uint256 amount,
        address recipient
    ) private view returns (bytes memory) {
        bytes[] memory args = new bytes[](1);
        address[] memory path = new address[](2);
        path[0] = input;
        path[1] = output;
        args[0] = abi.encode(recipient, amount, uint256(1), path, true, new uint256[](0));
        return abi.encodeWithSignature("execute(bytes,bytes[],uint256)", hex"08", args, block.timestamp + 100);
    }
    function order(uint8 mode) private view returns (YieldResolver.Execution memory e) {
        e = YieldResolver.Execution(
            tick,
            100,
            mode == 0
                ? address(q)
                : mode == 1
                    ? address(a)
                    : address(f),
            100,
            block.timestamp + 100,
            "",
            ""
        );
        if (mode != 0) e.preSwapData = route(e.flashToken, address(q), 100, address(resolver));
        if (mode != 1) e.postSwapData = route(address(a), e.flashToken, 100, address(resolver));
    }
    function run(YieldResolver.Execution memory e) private returns (uint256) {
        YieldResolver.Execution[] memory orders = new YieldResolver.Execution[](1);
        orders[0] = e;
        return resolver.execute(orders, TO);
    }
    function fails(YieldResolver.Execution memory e) private {
        YieldResolver.Execution[] memory orders = new YieldResolver.Execution[](1);
        orders[0] = e;
        (bool ok, ) = address(resolver).call(abi.encodeCall(resolver.execute, (orders, TO)));
        require(!ok, "expected failure");
    }
    function clean() private view {
        address[3] memory tokens = [address(a), address(q), address(f)];
        for (uint256 i; i < 3; ++i) {
            require(IERC20(tokens[i]).allowance(address(resolver), address(permit2)) == 0, "ERC20 Permit2 approval");
            (uint160 approved, uint48 expiry, ) = permit2.allowance(address(resolver), tokens[i], address(router));
            require(approved == 0 && expiry <= block.timestamp, "Permit2 router approval");
        }
        require(
            a.balanceOf(address(resolver)) == 0 &&
                q.balanceOf(address(resolver)) == 0 &&
                f.balanceOf(address(resolver)) == 0,
            "custody"
        );
        require(q.allowance(address(resolver), address(yld)) == 0, "YLD approval");
        require(
            a.allowance(address(resolver), address(morpho)) == 0 &&
                q.allowance(address(resolver), address(morpho)) == 0 &&
                f.allowance(address(resolver), address(morpho)) == 0,
            "Morpho approval"
        );
    }
    function testQuoteFirst() public {
        require(run(order(0)) == 1);
        require(q.balanceOf(TO) == 100 && q.balanceOf(address(morpho)) == 10000);
        clean();
    }
    function testAssetFirstSurplusIsQuote() public {
        require(run(order(1)) == 1);
        require(q.balanceOf(TO) == 100 && a.balanceOf(TO) == 0 && a.balanceOf(address(morpho)) == 10000);
        clean();
    }
    function testThirdTokenAndQuoteDust() public {
        require(run(order(2)) == 1);
        require(f.balanceOf(TO) == 100 && q.balanceOf(TO) == 100 && f.balanceOf(address(morpho)) == 10000);
        clean();
    }
    function testDonatedBalancesPreserved() public {
        a.mint(address(resolver), 7);
        q.mint(address(resolver), 13);
        f.mint(address(resolver), 19);
        run(order(2));
        require(
            a.balanceOf(address(resolver)) == 7 &&
                q.balanceOf(address(resolver)) == 13 &&
                f.balanceOf(address(resolver)) == 19,
            "donations"
        );
    }
    function testDonationCannotCoverLoss() public {
        q.mint(address(resolver), 1000);
        router.configure(0, 0);
        fails(order(0));
        require(q.balanceOf(address(resolver)) == 1000, "subsidy");
    }
    function testInvalidAmountsAndDeadline() public {
        YieldResolver.Execution memory e = order(0);
        e.amount = 0;
        fails(e);
        e = order(0);
        e.amount = 10001;
        fails(e);
        e = order(0);
        e.flashAmount = 99;
        fails(e);
        e = order(0);
        e.deadline = 0;
        fails(e);
        e = order(0);
        e.tickId = 1;
        fails(e);
        e = order(0);
        e.preSwapData = hex"ff";
        fails(e);
        e = order(1);
        e.flashAmount = 99;
        fails(e);
    }
    function testInsufficientFlashBalance() public {
        YieldResolver.Execution memory e = order(2);
        e.flashAmount = 10001;
        fails(e);
        clean();
    }
    function testRouterRevertRollsBackPrefunding() public {
        router.configure(2, 1);
        fails(order(2));
        require(f.balanceOf(address(morpho)) == 10000 && f.balanceOf(address(router)) == 10000, "rollback");
        clean();
    }
    function testCallbackAuthenticationAndReplay() public {
        (bool ok, ) = address(resolver).call(abi.encodeCall(resolver.onMorphoFlashLoan, (100, bytes("x"))));
        require(!ok, "callback");
        (ok, ) = address(resolver).call(abi.encodeCall(resolver.executeOne, (order(0), TO)));
        require(!ok, "self only");
        for (uint256 i = 1; i <= 4; ++i) {
            morpho.setAttack(i);
            fails(order(0));
            clean();
        }
    }
    function testUntrustedCalldataCannotSpendProtectedInventory() public {
        q.mint(address(resolver), 1000);
        f.mint(address(resolver), 1000);
        YieldResolver.Execution memory e = order(0);
        e.postSwapData = route(address(a), address(q), 100, address(0xbad));
        fails(e);
        e.postSwapData = route(address(a), address(q), 101, address(resolver));
        fails(e);
        e.postSwapData = abi.encodeCall(router.steal, (address(q), uint160(1)));
        fails(e);
        e.postSwapData = abi.encodeCall(router.steal, (address(f), uint160(1)));
        fails(e);
        e.postSwapData = abi.encodeCall(router.directSteal, (address(a), 1));
        fails(e);
        e.postSwapData = abi.encodeCall(router.noOp, ());
        fails(e);
        require(q.balanceOf(address(resolver)) == 1000 && f.balanceOf(address(resolver)) == 1000, "protected");
        require(a.allowance(address(resolver), address(permit2)) == 0, "rolled back approval");
    }
    function testPartialInputSpendingIsBoundedAndSurplusDistributed() public {
        YieldResolver.Execution memory e = order(0);
        e.postSwapData = route(address(a), address(q), 50, address(resolver));
        require(run(e) == 1);
        require(a.balanceOf(TO) == 50 && q.balanceOf(TO) == 0, "partial input surplus");
        clean();
    }
    function twoLegRoute(bool split, bool mixed) private view returns (bytes memory) {
        bytes[] memory args = new bytes[](2);
        args[0] = abi.encode(
            split ? address(resolver) : address(2),
            split ? uint256(40) : 100,
            uint256(1),
            abi.encodePacked(address(a), uint24(500), split ? address(q) : address(f)),
            true,
            new uint256[](0)
        );
        address input = split ? address(a) : address(f);
        uint256 amount = split ? 60 : 200;
        if (mixed) {
            address[] memory path = new address[](2);
            path[0] = input;
            path[1] = address(q);
            args[1] = abi.encode(address(resolver), amount, uint256(1), path, split, new uint256[](0));
        } else {
            args[1] = abi.encode(
                address(resolver),
                amount,
                uint256(1),
                abi.encodePacked(input, uint24(500), address(q)),
                split,
                new uint256[](0)
            );
        }
        return
            abi.encodeWithSignature(
                "execute(bytes,bytes[],uint256)",
                mixed ? hex"0008" : hex"0000",
                args,
                block.timestamp + 100
            );
    }
    function testMultiHopAndMixedProtocolRoutesAreOpaque() public {
        for (uint256 i; i < 2; ++i) {
            YieldResolver.Execution memory e = order(0);
            e.postSwapData = twoLegRoute(false, i == 1);
            require(run(e) == 1, "multi-hop");
            clean();
        }
        require(q.balanceOf(TO) == 600, "multi-hop profit");
    }
    function testSplitRoutesAreOpaque() public {
        YieldResolver.Execution memory e = order(0);
        e.postSwapData = twoLegRoute(true, true);
        require(run(e) == 1);
        require(q.balanceOf(TO) == 100, "split profit");
        clean();
    }
    function testBatchPartialSuccessAndAllFailed() public {
        YieldResolver.Execution[] memory orders = new YieldResolver.Execution[](2);
        orders[0] = order(0);
        orders[0].amount = 0;
        orders[1] = order(1);
        require(resolver.execute(orders, TO) == 2, "first failure");
        orders[0] = order(0);
        orders[1].amount = 0;
        require(resolver.execute(orders, TO) == 1, "second failure");
        orders[1] = order(2);
        orders[1].amount = 50;
        orders[1].postSwapData = route(address(a), address(f), 50, address(resolver));
        require(resolver.execute(orders, TO) == 3, "two successes");
        clean();
    }

    function testRepeatedTickExecutesIndependently() public {
        YieldResolver.Execution[] memory orders = new YieldResolver.Execution[](2);
        orders[0] = order(0);
        orders[1] = order(1);
        require(resolver.execute(orders, TO) == 3, "both executions");
        require(q.balanceOf(TO) == 200, "both profits");
        clean();
    }
    function testOversizedRevertAndGasExhaustionAreIsolated() public {
        YieldResolver.Execution[] memory orders = new YieldResolver.Execution[](2);
        for (uint256 i; i < 2; ++i) {
            orders[0] = order(0);
            orders[0].postSwapData =
                i == 0 ? abi.encodeCall(router.oversizedRevert, ()) : abi.encodeCall(router.exhaustGas, ());
            orders[1] = order(1);
            require(resolver.execute(orders, TO) == 2, "later success");
            orders[1] = orders[0];
            orders[0] = order(1);
            require(resolver.execute(orders, TO) == 1, "earlier success");
            clean();
        }
    }
    function testInsufficientBatchGasPreservesEarlierSuccess() public {
        YieldResolver.Execution[] memory orders = new YieldResolver.Execution[](2);
        orders[0] = order(0);
        orders[1] = order(1);
        (bool ok, bytes memory result) = address(resolver).call{gas: 2_250_000}(
            abi.encodeCall(resolver.execute, (orders, TO))
        );
        require(ok && abi.decode(result, (uint256)) == 1, "earlier success survives");
        require(q.balanceOf(TO) == 100, "profit preserved");
        clean();
    }
    function testQuoteUsesCeilRounding() public {
        uint256 pair = yld.createPair(address(a), address(f));
        uint256 id = yld.createTick(pair, address(a) < address(f) ? 0 : 1, 1, 7);
        a.mint(address(this), 100);
        a.approve(address(yld), 100);
        yld.supply(id, 100, address(0));
        YieldResolver.Execution memory e = order(0);
        e.tickId = id;
        e.amount = 1;
        e.flashToken = address(f);
        e.flashAmount = 2;
        e.postSwapData = route(address(a), address(f), 1, address(resolver));
        require(run(e) == 1);
        clean();
    }

    function testTokenHookCannotReenterDuringFlashRouteOrPayout() public {
        ResolverHookToken hook = new ResolverHookToken();
        uint256 pair = yld.createPair(address(hook), address(q));
        uint256 id = yld.createTick(pair, address(hook) < address(q) ? 0 : 1, 0, 7);
        hook.mint(address(this), 100);
        hook.approve(address(yld), 100);
        yld.supply(id, 100, address(0));
        hook.mint(address(morpho), 100);
        YieldResolver.Execution memory e = order(1);
        e.tickId = id;
        e.flashToken = address(hook);
        e.preSwapData = route(address(hook), address(q), 100, address(resolver));
        YieldResolver.Execution[] memory nested = new YieldResolver.Execution[](1);
        nested[0] = e;
        hook.arm(address(resolver), abi.encodeCall(resolver.execute, (nested, TO)));
        require(run(e) == 1, "hook-compatible transfer");
        require(hook.balanceOf(address(morpho)) == 100, "repayment");
        clean();
    }
}
