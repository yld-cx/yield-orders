// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _tokenDecimals;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }
    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 18) {}
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 0) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

contract BalanceReducingToken is MockERC20 {
    constructor() MockERC20("Balance Reducing Token", "BRT", 18) {}
    function reduceBalance(address holder, uint256 amount) external {
        _burn(holder, amount);
    }
}

contract BlockingRecipientToken is MockERC20 {
    address public blockedRecipient;
    bool public blocking = true;
    constructor(address blockedRecipient_) MockERC20("Blocked Recipient Token", "BRT", 18) {
        blockedRecipient = blockedRecipient_;
    }
    function setBlocking(bool value) external {
        blocking = value;
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (blocking && from != address(0) && to == blockedRecipient && amount != 0) revert("BLOCKED_RECIPIENT");
        super._update(from, to, amount);
    }
}

contract ReentrantToken is MockERC20 {
    address public target;
    bytes public callback;
    bool public attempted;
    bool public succeeded;
    constructor() MockERC20("Reentrant Token", "RENT", 18) {}
    function arm(address target_, bytes calldata callback_) external {
        target = target_;
        callback = callback_;
        attempted = false;
        succeeded = false;
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (target != address(0) && !attempted && from != address(0) && to != address(0)) {
            attempted = true;
            (succeeded, ) = target.call(callback);
        }
        super._update(from, to, amount);
    }
}
