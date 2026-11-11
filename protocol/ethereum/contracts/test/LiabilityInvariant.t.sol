// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;

import {YieldOrders} from "../YieldOrders.sol";
import {AdversarialToken} from "./AdversarialToken.sol";

interface LiabilityVm {
    function warp(uint256) external;
}

contract LiabilityInvariantTest {
    LiabilityVm private constant vm = LiabilityVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant TREASURY = address(0xBEEF);

    function _market() private returns (YieldOrders p, AdversarialToken a, AdversarialToken q, uint256 pair) {
        p = new YieldOrders(TREASURY);
        a = new AdversarialToken();
        q = new AdversarialToken();
        pair = p.createPair(address(a), address(q));
        a.mint(address(this), 1e25);
        q.mint(address(this), 1e25);
        a.approve(address(p), type(uint256).max);
        q.approve(address(p), type(uint256).max);
    }

    function testFuzzOutgoingRoundingCannotSpendOtherTickReserves(
        uint96 principalSeed,
        uint96 withdrawalSeed,
        uint8 giftSeed,
        uint8 debitSeed,
        uint8 creditSeed
    ) public {
        (YieldOrders p, AdversarialToken a, AdversarialToken q, uint256 pair) = _market();
        uint8 direction = address(a) < address(q) ? 0 : 1;
        uint256 tick = p.createTick(pair, direction, 0, 1);
        uint256 otherTick = p.createTick(pair, direction, 0, 2);
        uint256 principal = 1 + (uint256(principalSeed) % 1e24);
        uint256 withdrawal = 1 + (uint256(withdrawalSeed) % principal);
        uint256 gift = uint256(giftSeed) % 10;
        uint256 debit = uint256(debitSeed) % 4;
        uint256 credit = uint256(creditSeed) % 4;
        p.supply(tick, principal, address(0));
        p.supply(otherTick, 12345, address(0));
        a.mint(address(p), gift);
        a.configure(address(p), 0, int256(credit), int256(debit), 0);
        vm.warp(block.timestamp + 1);
        uint256 beforeRecipient = a.balanceOf(address(this));
        (bool ok, ) = address(p).call(abi.encodeCall(p.withdraw, (tick, withdrawal, 0, type(uint256).max)));
        require(ok == (gift >= debit), "accept iff surplus covers extra debit");
        uint256 liability = principal + 12345 - (ok ? withdrawal : 0);
        require(p.tokenLiability(address(a)) == liability, "aggregate user claims");
        require(a.balanceOf(address(p)) == liability + gift - (ok ? debit : 0), "independent balance conservation");
        require(
            a.balanceOf(address(this)) == beforeRecipient + (ok ? withdrawal + credit : 0),
            "entitlement or rollback"
        );
        require(p.getTick(otherTick).availableSupply == 12345, "other Tick unchanged");
    }

    function testFuzzSharedAssetQuoteRolesNeverEnterSurplus(uint64 aSeed, uint64 qSeed, uint64 xSeed) public {
        (YieldOrders p, AdversarialToken a, AdversarialToken q, uint256 pair) = _market();
        uint8 direction = address(a) < address(q) ? 0 : 1;
        uint256 forward = p.createTick(pair, direction, 0, 1);
        uint256 reverse = p.createTick(pair, 1 - direction, 0, 1);
        uint256 aDeposit = 3 + uint256(aSeed);
        uint256 qDeposit = 1 + uint256(qSeed);
        uint256 x = 1 + (uint256(xSeed) % qDeposit);
        uint256 y = aDeposit / 3;
        p.supply(forward, aDeposit, address(0));
        p.supply(reverse, qDeposit, address(0));
        p.swap(reverse, x, type(uint256).max, type(uint256).max, address(0));
        p.use(forward, y, type(uint256).max, type(uint256).max, address(0));
        uint256 expectedA = aDeposit - y + x - x / 100;
        uint256 expectedQ = qDeposit - x + y;
        require(p.tokenLiability(address(a)) == expectedA, "A available plus reverse proceeds");
        require(p.tokenLiability(address(q)) == expectedQ, "Q available plus forward escrow");
        if (x / 100 != 0) p.collectProtocolFees(address(a), x / 100);
        (bool zeroAccepted, ) = address(p).call(abi.encodeCall(p.collectProtocolFees, (address(q), 0)));
        require(!zeroAccepted, "zero collection rejected");
        require(a.balanceOf(TREASURY) == x / 100, "only swap fee collected");
        require(q.balanceOf(TREASURY) == 0, "no escrow collected");
        require(a.balanceOf(address(p)) == expectedA && q.balanceOf(address(p)) == expectedQ, "all roles backed");
    }
    function testFuzzCollectionChecksRequestedAmountAndFinalDebit(
        uint96 principalSeed,
        uint32 giftSeed,
        uint8 mode,
        uint8 debitSeed
    ) public {
        (YieldOrders p, AdversarialToken a, AdversarialToken q, uint256 pair) = _market();
        uint8 direction = address(a) < address(q) ? 0 : 1;
        uint256 tick = p.createTick(pair, direction, 0, 1);
        uint256 principal = 1 + (uint256(principalSeed) % 1e24);
        uint256 gift = uint256(giftSeed) % 1e6;
        int256 debit = int256(uint256(debitSeed) % 4) - 1;
        uint256 request =
            mode % 4 == 0
                ? 0
                : mode % 4 == 1
                    ? gift
                    : mode % 4 == 2
                        ? gift + 1
                        : gift / 2;
        p.supply(tick, principal, address(0));
        a.mint(address(p), gift);
        a.configure(address(p), 0, 0, int256(debit), 0);
        (bool ok, ) = address(p).call(abi.encodeCall(p.collectProtocolFees, (address(a), request)));
        uint256 actualDebit = request == 0 ? 0 : uint256(int256(request) + debit);
        require(ok == (request != 0 && actualDebit <= gift), "nonzero request and final backing checked");
        require(p.tokenLiability(address(a)) == principal, "user liability unchanged");
        require(p.getTick(tick).availableSupply == principal, "provider reserve unchanged");
        require(a.balanceOf(address(p)) == principal + gift - (ok ? actualDebit : 0), "balance or rollback");
        require(a.balanceOf(TREASURY) == (ok ? request : 0), "treasury entitlement or rollback");
    }
}
