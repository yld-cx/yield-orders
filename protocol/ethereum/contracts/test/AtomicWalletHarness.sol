// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;

/// @dev Test-only stand-in for an atomic-capable wallet. Never deploy for users.
contract AtomicWalletHarness {
    function execute(address[] calldata targets, bytes[] calldata data) external returns (bytes[] memory results) {
        require(targets.length == data.length);
        results = new bytes[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            (bool ok, bytes memory result) = targets[i].call(data[i]);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(result, 32), mload(result))
                }
            }
            results[i] = result;
        }
    }
}
