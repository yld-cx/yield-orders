// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Uint512} from "./Uint512.sol";

error Invariant();

/// @notice Pure fixed-point arithmetic for the Active and Exit Product-Sum domains.
/// @dev The protocol owns storage, historical sums, and provider checkpoints.
library ProductSumMath {
    uint256 internal constant PRINCIPAL_PRECISION = 1e36;
    uint256 internal constant P_PRECISION = 1e39;
    uint256 internal constant SCALE_FACTOR = 1e9;
    uint256 internal constant P_MIN = 1e30;
    uint256 internal constant MAX_SCALE_SPAN = 8;
    uint256 internal constant MAX_SCALE_JUMP = 4;

    /// @dev The caller bounds `gain` to 1e30. A domain P never exceeds 1e39,
    /// so `gain * product` is at most 1e69 and fits uint256.
    function fundingDelta(uint256 gain, uint256 product, uint256 principal) internal pure returns (uint256 delta) {
        unchecked {
            delta = (gain * product) / principal;
        }
    }

    /// @dev Retains the existing Product-Sum scale-jump rule and one-floor product update.
    function depletedProduct(
        uint256 oldProduct,
        uint256 beforePrincipal,
        uint256 afterPrincipal
    ) internal pure returns (uint256 newProduct, uint64 scaleJump) {
        if (beforePrincipal == 0 || afterPrincipal >= beforePrincipal) {
            revert Invariant();
        }
        if (afterPrincipal == 0) {
            return (0, 0);
        }

        uint256 scaledAfter = afterPrincipal;
        for (uint256 i; i <= MAX_SCALE_JUMP; ++i) {
            newProduct = Math.mulDiv(oldProduct, scaledAfter, beforePrincipal);
            if (newProduct >= P_MIN) {
                return (newProduct, uint64(i));
            }
            if (i != MAX_SCALE_JUMP) {
                scaledAfter *= SCALE_FACTOR;
            }
        }
        revert Invariant();
    }

    /// @dev Compounds an X36 snapshot through the current product and scale.
    function principalX36(
        uint256 initialPrincipalX36,
        uint64 snapshotGeneration,
        uint64 snapshotScale,
        uint256 snapshotProduct,
        uint64 currentGeneration,
        uint64 currentScale,
        uint256 currentProduct
    ) internal pure returns (uint256 amountX36) {
        if (initialPrincipalX36 == 0 || snapshotGeneration != currentGeneration) {
            return 0;
        }
        if (currentScale < snapshotScale || snapshotProduct == 0) {
            revert Invariant();
        }
        amountX36 = Math.mulDiv(initialPrincipalX36, currentProduct, snapshotProduct);
        uint256 scaleDistance = currentScale - snapshotScale;
        for (uint256 i; i < scaleDistance && amountX36 != 0; ++i) amountX36 /= SCALE_FACTOR;
    }

    /// @dev Exact historical gain: one rational floor with a remainder carried across scales.
    /// `scaleDeltas[0]` excludes the provider checkpoint; later entries are whole scale sums.
    /// The fixed array has MAX_SCALE_SPAN + 1 entries.
    function accruedGain(
        uint256 initialPrincipalX36,
        uint256 snapshotProduct,
        uint256 span,
        uint256[9] memory scaleDeltas
    ) internal pure returns (uint256 gain) {
        uint256 denominator = snapshotProduct * PRINCIPAL_PRECISION;
        if (initialPrincipalX36 > denominator || denominator == 0) {
            revert Invariant();
        }

        uint256 firstDelta = scaleDeltas[0];
        gain = Math.mulDiv(initialPrincipalX36, firstDelta, denominator);
        // The exact modular remainder is below denominator and fits one limb.
        Uint512.Value memory remainder = Uint512.Value(0, mulmod(initialPrincipalX36, firstDelta, denominator));
        uint256 scalePower = 1;
        for (uint256 i = 1; i <= span; ++i) {
            scalePower *= SCALE_FACTOR;
            uint256 scaleDelta = scaleDeltas[i];
            uint256 whole = scaleDelta / scalePower;
            uint256 fraction = scaleDelta % scalePower;
            uint256 wholeGain = Math.mulDiv(initialPrincipalX36, whole, denominator);
            uint256 wholeRemainder = mulmod(initialPrincipalX36, whole, denominator);
            Uint512.Value memory numerator = Uint512.add(
                Uint512.mulSmall(remainder, SCALE_FACTOR),
                Uint512.mul(wholeRemainder, scalePower)
            );
            numerator = Uint512.add(numerator, Uint512.mul(initialPrincipalX36, fraction));
            Uint512.Value memory scaledDenominator = Uint512.mul(denominator, scalePower);
            uint256 carry;
            if (Uint512.gte(numerator, scaledDenominator)) {
                numerator = Uint512.sub(numerator, scaledDenominator);
                ++carry;
            }
            if (Uint512.gte(numerator, scaledDenominator)) {
                numerator = Uint512.sub(numerator, scaledDenominator);
                ++carry;
            }
            gain += wholeGain + carry;
            remainder = numerator;
        }
    }
}
