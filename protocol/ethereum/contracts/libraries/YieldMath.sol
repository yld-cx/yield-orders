// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Pure, internal Yield calculations shared by economic execution.
library YieldMath {
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_DAILY_BPS = 1;
    uint256 internal constant MAX_DAILY_BPS = 100;

    function utilization(uint256 working, uint256 principal) internal pure returns (uint256) {
        return (working * Q128) / principal;
    }

    function _pow4(uint256 x) private pure returns (uint256) {
        if (x == Q128) return Q128;
        uint256 squared = (x * x) / Q128;
        return (squared * squared) / Q128;
    }

    function fullTermYield(
        uint256 available,
        uint256 working,
        uint64 durationDays,
        uint256 amount
    ) internal pure returns (uint256) {
        uint256 principal = available + working;
        uint256 beforeX128 = utilization(working, principal);
        uint256 afterX128 = utilization(working + amount, principal);
        uint256 curve = 4 * MIN_DAILY_BPS * (afterX128 - beforeX128) +
            (MAX_DAILY_BPS - MIN_DAILY_BPS) * (_pow4(afterX128) - _pow4(beforeX128));
        return Math.mulDiv(principal, uint256(durationDays) * curve, 4 * BPS * Q128, Math.Rounding.Ceil);
    }

    function accruedRepayYield(uint256 fullTermYieldAsset, uint256 elapsed, uint256 termSeconds)
        internal pure returns (uint256)
    {
        return (fullTermYieldAsset * Math.max(1, elapsed) + termSeconds - 1) / termSeconds;
    }
}
