// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;

import {MockERC20} from "./MockERC20.sol";

/// @dev Independent sender/recipient rounding plus controlled rebases and return values.
contract AdversarialToken is MockERC20 {
    address public protocol;
    int256 public inboundCredit;
    int256 public outboundCredit;
    int256 public outboundDebit;
    uint8 public balanceMode;
    uint8 public nextBalanceMode;
    function setBalanceMode(uint8 mode, uint8 nextMode) external {
        balanceMode = mode;
        nextBalanceMode = nextMode;
    }
    function balanceOf(address holder) public view override returns (uint256) {
        if (balanceMode == 1) revert("BALANCE_UNAVAILABLE");
        if (balanceMode == 2)
            assembly ("memory-safe") {
                mstore(0, 1)
                return(31, 1)
            }
        if (balanceMode == 3) return 0;
        return super.balanceOf(holder);
    }
    uint8 public returnMode; // 0=true, 1=empty, 2=false, 3=malformed
    constructor() MockERC20("Adversarial", "ADV", 18) {}
    function configure(address protocol_, int256 inbound, int256 credit, int256 debit, uint8 mode) external {
        protocol = protocol_;
        inboundCredit = inbound;
        outboundCredit = credit;
        outboundDebit = debit;
        returnMode = mode;
    }
    function rebase(address holder, int256 delta) external {
        if (delta >= 0) _mint(holder, uint256(delta));
        else _burn(holder, uint256(-delta));
    }
    function _adjust(address holder, int256 delta) private {
        if (delta > 0) _mint(holder, uint256(delta));
        else if (delta < 0) _burn(holder, uint256(-delta));
    }
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from == address(0) || to == address(0) || amount == 0) return;
        if (to == protocol) _adjust(to, inboundCredit);
        if (from == protocol) {
            _adjust(to, outboundCredit);
            _adjust(from, -outboundDebit);
        }
        if (nextBalanceMode != 0) balanceMode = nextBalanceMode;
    }
    function _result() private view returns (bool) {
        uint256 mode = returnMode;
        if (mode == 1)
            assembly ("memory-safe") {
                return(0, 0)
            }
        if (mode == 2) return false;
        if (mode == 3)
            assembly ("memory-safe") {
                mstore(0, 1)
                return(31, 1)
            }
        return true;
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        return _result();
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        return _result();
    }
}
