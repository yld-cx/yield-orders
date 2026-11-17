// SPDX-License-Identifier: MIT
pragma solidity ^0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IResolverYieldOrders {
    struct TickView {
        address asset;
        address quote;
        uint64 durationDays;
        uint256 priceX128;
        uint256 availableSupply;
        uint256 workingSupply;
        uint256 exitWorking;
        uint256 activeWorking;
        uint256 activePrincipal;
        uint64 settleCursor;
    }
    function getTick(uint256 id) external view returns (TickView memory);
    function swap(uint256 id, uint256 amount, uint256 maxQuoteIn, uint256 deadline, address referrer) external;
}
interface IResolverMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}
interface IResolverPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// @notice Permissionless flash execution periphery; holds no intentional inventory.
contract YieldResolver is IMorphoFlashLoanCallback {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_BATCH = 8;
    uint256 public constant MAX_ORDER_GAS = 2_000_000;
    uint256 public constant MAX_ROUTE_BYTES = 16_384;
    address public immutable YLD;
    address public immutable MORPHO;
    address public immutable UNIVERSAL_ROUTER;
    address public immutable PERMIT2;
    // 0 idle, 1 batch, 2 awaiting callback, 3 callback, 4 awaiting repayment.
    uint256 private phase;
    bytes32 private activeHash;

    struct Execution {
        uint256 tickId;
        uint256 amount;
        address flashToken;
        uint256 flashAmount;
        uint256 deadline;
        bytes preSwapData;
        bytes postSwapData;
    }
    struct Context {
        Execution order;
        address asset;
        address quote;
        uint256 cost;
        uint256[3] baseline;
    }
    error InvalidExecution();
    error Unauthorized();
    error BalanceInvariant();
    error RouterFailed();
    event ExecutionSucceeded(uint256 indexed index, uint256 indexed tickId);
    event ExecutionFailed(uint256 indexed index, uint256 indexed tickId, bytes32 reasonHash);
    event Resolved(
        uint256 indexed tickId,
        address indexed flashToken,
        address indexed to,
        uint256 assetAmount,
        uint256 flashAmount,
        uint8 mode,
        address[3] tokens,
        uint256[3] tokenSurplus
    );

    constructor(address yld, address morpho, address router, address permit2) {
        if (yld.code.length == 0 || morpho.code.length == 0 || router.code.length == 0 || permit2.code.length == 0)
            revert InvalidExecution();
        YLD = yld;
        MORPHO = morpho;
        UNIVERSAL_ROUTER = router;
        PERMIT2 = permit2;
    }

    receive() external payable {
        // SAFE API calldata refunds native dust, including a zero-value call.
        // ERC-20-only execution accepts only the zero-value form.
        if (msg.sender != UNIVERSAL_ROUTER || phase != 3 || msg.value != 0) revert Unauthorized();
    }

    function execute(Execution[] calldata orders, address to) external returns (uint256 successBitmap) {
        if (phase != 0) revert Unauthorized();
        if (to == address(0) || to == address(this) || orders.length == 0 || orders.length > MAX_BATCH)
            revert InvalidExecution();
        phase = 1;
        for (uint256 i; i < orders.length; ++i) {
            if (orders[i].preSwapData.length > MAX_ROUTE_BYTES || orders[i].postSwapData.length > MAX_ROUTE_BYTES) {
                emit ExecutionFailed(i, orders[i].tickId, keccak256("route too large"));
                continue;
            }
            // Keep earlier successes if the next isolated call cannot be funded.
            if (gasleft() < MAX_ORDER_GAS + MAX_ORDER_GAS / 63 + 120_000) {
                for (; i < orders.length; ++i)
                    emit ExecutionFailed(i, orders[i].tickId, keccak256("insufficient batch gas"));
                break;
            }
            bytes memory payload = abi.encodeCall(this.executeOne, (orders[i], to));
            bool success;
            bytes32 fingerprint;
            // Bound copied revert data to 256 bytes, including for a malicious token.
            assembly ("memory-safe") {
                success := call(MAX_ORDER_GAS, address(), 0, add(payload, 32), mload(payload), 0, 0)
                let size := returndatasize()
                if gt(size, 256) {
                    size := 256
                }
                let ptr := mload(0x40)
                returndatacopy(ptr, 0, size)
                fingerprint := keccak256(ptr, size)
                mstore(0x40, add(ptr, 256))
            }
            if (success) {
                successBitmap |= uint256(1) << i;
                emit ExecutionSucceeded(i, orders[i].tickId);
            } else emit ExecutionFailed(i, orders[i].tickId, fingerprint);
        }
        if (successBitmap == 0) revert InvalidExecution();
        phase = 0;
    }

    function executeOne(Execution calldata order, address to) external {
        if (msg.sender != address(this) || phase != 1 || activeHash != bytes32(0)) revert Unauthorized();
        if (
            to == address(0) ||
            to == address(this) ||
            block.timestamp > order.deadline ||
            order.deadline > type(uint48).max ||
            order.flashToken.code.length == 0 ||
            order.flashAmount == 0 ||
            order.flashAmount > type(uint160).max ||
            order.amount == 0 ||
            order.amount > type(uint160).max ||
            order.preSwapData.length > MAX_ROUTE_BYTES ||
            order.postSwapData.length > MAX_ROUTE_BYTES
        ) revert InvalidExecution();
        IResolverYieldOrders.TickView memory tick = IResolverYieldOrders(YLD).getTick(order.tickId);
        if (
            tick.asset == address(0) ||
            tick.quote == address(0) ||
            tick.asset == tick.quote ||
            order.amount > tick.availableSupply
        ) revert InvalidExecution();
        uint256 cost = Math.mulDiv(order.amount, tick.priceX128, 1 << 128, Math.Rounding.Ceil);
        if (cost == 0) revert InvalidExecution();
        uint8 mode =
            order.flashToken == tick.quote
                ? 0
                : order.flashToken == tick.asset
                    ? 1
                    : 2;
        if (
            (mode == 0 &&
                (order.flashAmount != cost || order.preSwapData.length != 0 || order.postSwapData.length == 0)) ||
            (mode == 1 &&
                (order.flashAmount != order.amount ||
                    order.preSwapData.length == 0 ||
                    order.postSwapData.length != 0)) ||
            (mode == 2 && (order.preSwapData.length == 0 || order.postSwapData.length == 0))
        ) revert InvalidExecution();
        uint256 assetBalance = IERC20(tick.asset).balanceOf(address(this));
        uint256 quoteBalance = IERC20(tick.quote).balanceOf(address(this));
        Context memory c = Context(
            order,
            tick.asset,
            tick.quote,
            cost,
            [
                assetBalance,
                quoteBalance,
                mode == 0
                    ? quoteBalance
                    : mode == 1
                        ? assetBalance
                        : IERC20(order.flashToken).balanceOf(address(this))
            ]
        );
        bytes memory data = abi.encode(c);
        activeHash = keccak256(data);
        phase = 2;
        IResolverMorpho(MORPHO).flashLoan(order.flashToken, order.flashAmount, data);
        if (phase != 4) revert Unauthorized();
        IERC20(order.flashToken).forceApprove(MORPHO, 0);
        address[3] memory tokens = [tick.asset, tick.quote, order.flashToken];
        uint256[3] memory surplus;
        for (uint256 i; i < 3; ++i) {
            if (i == 2 && (tokens[2] == tokens[0] || tokens[2] == tokens[1])) continue;
            uint256 balance = IERC20(tokens[i]).balanceOf(address(this));
            if (balance < c.baseline[i]) revert BalanceInvariant();
            surplus[i] = balance - c.baseline[i];
        }
        for (uint256 i; i < 3; ++i) if (surplus[i] != 0) IERC20(tokens[i]).safeTransfer(to, surplus[i]);
        for (uint256 i; i < 3; ++i) {
            if (i == 2 && (tokens[2] == tokens[0] || tokens[2] == tokens[1])) continue;
            if (IERC20(tokens[i]).balanceOf(address(this)) != c.baseline[i]) revert BalanceInvariant();
        }
        activeHash = bytes32(0);
        phase = 1;
        emit Resolved(order.tickId, order.flashToken, to, order.amount, order.flashAmount, mode, tokens, surplus);
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO || phase != 2 || activeHash != keccak256(data)) revert Unauthorized();
        phase = 3;
        Context memory c = abi.decode(data, (Context));
        if (
            assets != c.order.flashAmount ||
            IERC20(c.order.flashToken).balanceOf(address(this)) != c.baseline[2] + assets
        ) revert BalanceInvariant();
        uint8 mode =
            c.order.flashToken == c.quote
                ? 0
                : c.order.flashToken == c.asset
                    ? 1
                    : 2;
        if (mode != 0) {
            _route(c.order.preSwapData, c.order.flashToken, c.quote, assets, c.order.deadline, c.cost);
        }
        uint256 beforeAsset = IERC20(c.asset).balanceOf(address(this));
        uint256 beforeQuote = IERC20(c.quote).balanceOf(address(this));
        if (beforeQuote < c.baseline[1] + c.cost) revert BalanceInvariant();
        IERC20(c.quote).forceApprove(YLD, c.cost);
        IResolverYieldOrders(YLD).swap(c.order.tickId, c.order.amount, c.cost, c.order.deadline, address(0));
        IERC20(c.quote).forceApprove(YLD, 0);
        if (
            IERC20(c.asset).balanceOf(address(this)) != beforeAsset + c.order.amount ||
            IERC20(c.quote).balanceOf(address(this)) != beforeQuote - c.cost
        ) revert BalanceInvariant();
        if (mode != 1)
            _route(c.order.postSwapData, c.asset, c.order.flashToken, c.order.amount, c.order.deadline, assets);
        if (IERC20(c.order.flashToken).balanceOf(address(this)) < c.baseline[2] + assets) revert BalanceInvariant();
        IERC20(c.order.flashToken).forceApprove(MORPHO, assets);
        phase = 4;
    }

    function _route(
        bytes memory data,
        address input,
        address output,
        uint256 amount,
        uint256 deadline,
        uint256 minimum
    ) private {
        uint256 beforeInput = IERC20(input).balanceOf(address(this));
        uint256 beforeOutput = IERC20(output).balanceOf(address(this));
        if (beforeInput < amount) revert BalanceInvariant();
        // The router receives no general authority over the resolver's inventory.
        // Opaque calldata may spend at most this leg's input, through Permit2 only.
        IERC20(input).forceApprove(PERMIT2, amount);
        IResolverPermit2(PERMIT2).approve(input, UNIVERSAL_ROUTER, uint160(amount), uint48(deadline));
        bool success;
        address router = UNIVERSAL_ROUTER;
        assembly ("memory-safe") {
            success := call(gas(), router, 0, add(data, 32), mload(data), 0, 0)
        }
        if (!success) revert RouterFailed();
        IResolverPermit2(PERMIT2).approve(input, UNIVERSAL_ROUTER, 0, 0);
        IERC20(input).forceApprove(PERMIT2, 0);
        if (
            IERC20(output).balanceOf(address(this)) < beforeOutput + minimum ||
            IERC20(input).balanceOf(address(this)) < beforeInput - amount
        ) revert BalanceInvariant();
    }
}
