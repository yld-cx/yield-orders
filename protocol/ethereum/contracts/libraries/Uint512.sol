// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @dev Checked two-limb unsigned arithmetic for the bounded Product-Sum recurrence.
library Uint512 {
    error Arithmetic512();
    struct Value {
        uint256 hi;
        uint256 lo;
    }

    function mul(uint256 a, uint256 b) internal pure returns (Value memory z) {
        uint256 mm = mulmod(a, b, type(uint256).max);
        unchecked {
            z.lo = a * b;
            z.hi = mm - z.lo - (mm < z.lo ? 1 : 0);
        }
    }

    function mulSmall(Value memory a, uint256 b) internal pure returns (Value memory z) {
        Value memory low = mul(a.lo, b);
        Value memory high = mul(a.hi, b);
        if (high.hi != 0) revert Arithmetic512();
        z.lo = low.lo;
        z.hi = low.hi + high.lo;
    }

    function add(Value memory a, Value memory b) internal pure returns (Value memory z) {
        unchecked {
            z.lo = a.lo + b.lo;
            uint256 carry = z.lo < a.lo ? 1 : 0;
            z.hi = a.hi + b.hi + carry;
            if (z.hi < a.hi || (carry != 0 && z.hi == a.hi)) revert Arithmetic512();
        }
    }

    function gte(Value memory a, Value memory b) internal pure returns (bool) {
        return a.hi > b.hi || (a.hi == b.hi && a.lo >= b.lo);
    }

    function sub(Value memory a, Value memory b) internal pure returns (Value memory z) {
        if (!gte(a, b)) revert Arithmetic512();
        unchecked {
            z.lo = a.lo - b.lo;
            z.hi = a.hi - b.hi - (a.lo < b.lo ? 1 : 0);
        }
    }
}
