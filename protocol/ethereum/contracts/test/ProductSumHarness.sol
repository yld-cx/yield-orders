// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {ProductSumMath} from "../libraries/ProductSumMath.sol";
import {Uint512} from "../libraries/Uint512.sol";

/// @dev Test-only wrapper; not part of the production ABI or runtime.
contract ProductSumHarness {
    function accruedGainX36(uint256 initialPrincipalX36, uint256 snapshotProduct, uint256 span, uint256[9] memory deltas)
        external pure returns (uint256)
    {
        return ProductSumMath.accruedGainX36(initialPrincipalX36, snapshotProduct, span, deltas);
    }

    function add512(uint256 aHi, uint256 aLo, uint256 bHi, uint256 bLo)
        external pure returns (uint256 hi, uint256 lo)
    {
        Uint512.Value memory value = Uint512.add(Uint512.Value(aHi, aLo), Uint512.Value(bHi, bLo));
        return (value.hi, value.lo);
    }

    function sub512(uint256 aHi, uint256 aLo, uint256 bHi, uint256 bLo)
        external pure returns (uint256 hi, uint256 lo)
    {
        Uint512.Value memory value = Uint512.sub(Uint512.Value(aHi, aLo), Uint512.Value(bHi, bLo));
        return (value.hi, value.lo);
    }
}
