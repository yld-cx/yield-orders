// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {YieldMath} from "../libraries/YieldMath.sol";
import {ProductSumMath} from "../libraries/ProductSumMath.sol";
import {Uint512} from "../libraries/Uint512.sol";

contract MathBoundariesTest {
    function testYieldEndpointsAndOneSecondRepay() public pure {
        uint256 full = YieldMath.fullTermYield(1e30, 0, 1, 1e30);
        require(full == 2_575_000_000_000_000_000_000_000_000, "curve endpoint");
        require(YieldMath.accruedRepayYield(full, 0, 86_400) == YieldMath.accruedRepayYield(full, 1, 86_400), "one second");
        require(YieldMath.accruedRepayYield(full, 86_400, 86_400) == full, "full term");
    }

    function testProductScaleBoundaryAndFractionalGain() public pure {
        (uint256 p, uint64 jump) = ProductSumMath.depletedProduct(1e39, 1e30, 1);
        require(p == 1e36 && jump == 3, "scale jump");
        uint256[9] memory deltas;
        deltas[0] = 5e38;
        require(ProductSumMath.accruedGainX36(1e36, 1e39, 0, deltas) == 5e35, "half raw");
        deltas[0] = 0;
        deltas[1] = 5e47;
        require(ProductSumMath.accruedGainX36(1e36, 1e39, 1, deltas) == 5e35, "cross scale half raw");
        deltas[1] = 1e9 - 1;
        require(ProductSumMath.accruedGainX36(1e57, 1e39, 1, deltas) == 999_999_999_000_000_000, "large fractional carry");
        deltas[1] = 0;
        deltas[8] = 1e72 - 1;
        require(ProductSumMath.accruedGainX36(1e57, 1e39, 8, deltas) == 1e18 - 1, "eight-scale fraction");
    }

    function testUint512CarryBorrowAndFullProduct() public pure {
        uint256 max = type(uint256).max;
        Uint512.Value memory product = Uint512.mul(max, max);
        require(product.hi == max - 1 && product.lo == 1, "full product");
        Uint512.Value memory carried = Uint512.add(Uint512.Value(0, max), Uint512.Value(0, 1));
        require(carried.hi == 1 && carried.lo == 0, "carry");
        Uint512.Value memory borrowed = Uint512.sub(carried, Uint512.Value(0, 1));
        require(borrowed.hi == 0 && borrowed.lo == max, "borrow");
        Uint512.Value memory scaled = Uint512.mulSmall(Uint512.Value(1, max), 2);
        require(scaled.hi == 3 && scaled.lo == max - 1, "small multiplier");
    }
}
