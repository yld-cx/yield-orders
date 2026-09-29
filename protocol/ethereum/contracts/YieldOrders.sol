// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./libraries/TickMath.sol";

/// @notice yld.cx v0.1 exact-tick, fixed-term liquidity protocol.
contract YieldOrders is Multicall, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant Q128 = 1 << 128;
    uint256 public constant FEE_BPS = 1_000;
    uint256 public constant MIN_DAILY_BPS = 1;
    uint256 public constant MAX_DAILY_BPS = 100;
    uint256 public constant CURVE_EXPONENT = 3;
    uint256 public constant MIN_BILLABLE_SECONDS = 1;
    address public immutable FEE_TO;

    error InvalidInput();
    error AlreadyExists();
    error NotFound();
    error InsufficientLiquidity();
    error Slippage();
    error Expired();
    error Unauthorized();
    error InvalidState();
    error Cooldown();
    error UnsupportedToken();
    error Invariant();

    struct Pair {
        address token0;
        address token1;
        bool exists;
    }
    struct Tick {
        uint256 pairId;
        address asset;
        address quote;
        uint256 priceX128;
        uint8 direction;
        int32 priceTick;
        uint64 durationDays;
        bool exists;
        uint256 availableSupply;
        uint256 workingSupply;
        uint256 exitWorking;
        uint256 totalShares;
        uint256 yieldAssetGrowthX128;
        uint256 swapQuoteGrowthX128;
        uint64 generation;
        uint256 totalExitShares;
        uint256 exitAssetGrowthX128;
        uint256 exitYieldAssetGrowthX128;
        uint256 exitQuoteGrowthX128;
        uint64 exitGeneration;
        uint256 exitAssetReserve;
        uint256 yieldAssetReserve;
        uint256 exitQuoteReserve;
        uint256 activeQuoteReserve;
        uint256 quoteEscrow;
        uint64 nextPositionSeq;
        uint64 settleCursor;
    }
    struct Provider {
        uint256 shares;
        uint64 generation;
        uint256 yieldAssetGrowthLastX128;
        uint256 swapQuoteGrowthLastX128;
        uint256 owedYieldAsset;
        uint256 owedSwapQuote;
        uint256 yieldFeeCarry;
        uint256 lastSupplyBlock;
        uint256 exitShares;
        uint64 exitGeneration;
        uint256 exitAssetGrowthLastX128;
        uint256 exitYieldAssetGrowthLastX128;
        uint256 exitQuoteGrowthLastX128;
        uint256 owedExitAsset;
        uint256 owedExitYieldAsset;
        uint256 owedExitQuote;
    }
    struct FinalActive {
        uint256 yieldGrowth;
        uint256 quoteGrowth;
    }
    struct FinalExit {
        uint256 assetGrowth;
        uint256 yieldGrowth;
        uint256 quoteGrowth;
    }
    struct ProjectedTick {
        Tick tick;
        FinalActive activeFinal;
        FinalExit exitFinal;
        bool activeFinalized;
        bool exitFinalized;
    }
    enum Status {
        INVALID,
        ACTIVE,
        REPAID,
        CLOSED
    }
    struct Position {
        uint256 tickId;
        uint64 tickSeq;
        address user;
        uint256 assetAmount;
        uint256 quotePrincipal;
        uint256 fullTermYieldAsset;
        uint256 closeFee;
        uint256 openedAt;
        uint256 maturity;
        Status status;
    }
    struct UsePreview {
        uint256 matchAmount;
        uint256 quotePrincipal;
        uint256 activeWorkingShareBefore;
        uint256 activeWorkingShareAfter;
        uint256 fullTermYieldAsset;
        uint256 referenceYieldQuote;
        uint256 closeFee;
        uint256 dailyRateX128;
        uint256 termRateX128;
        uint256 maturity;
    }
    struct WithdrawPreview {
        uint256 sharesToWithdraw;
        uint256 principalClaim;
        uint256 availableAssetOut;
        uint256 workingToExit;
        uint256 exitSharesMinted;
        uint256 remainingActiveShares;
        uint256 remainingExitShares;
    }
    struct RepayPreview {
        uint256 assetPrincipal;
        uint256 grossYieldAsset;
        uint256 totalAssetIn;
        uint256 exitFill;
        uint256 activeReturn;
        uint256 exitYieldAsset;
        uint256 activeYieldAsset;
        uint256 quotePrincipalUnlocked;
    }
    struct SwapPreview {
        uint256 assetAmount;
        uint256 quotePrincipal;
        uint256 referenceFullTermYieldAsset;
        uint256 referenceYieldQuote;
        uint256 swapFee;
        uint256 providerSwapProceeds;
    }
    struct CollectPreview {
        uint256 exitAsset;
        uint256 activeYieldAsset;
        uint256 exitYieldAsset;
        uint256 grossYieldAsset;
        uint256 yieldFeeAsset;
        uint256 netYieldAsset;
        uint256 exitQuote;
        uint256 swapQuote;
        uint256 totalAssetOut;
        uint256 totalQuoteOut;
    }
    struct EarnPositionView {
        Provider provider;
        uint256 claimableActiveYieldAsset;
        uint256 claimableExitAsset;
        uint256 claimableExitYieldAsset;
        uint256 claimableSwapQuote;
        uint256 claimableExitQuote;
    }

    mapping(uint256 => Pair) public pairs;
    mapping(uint256 => Position) public positions;
    mapping(address => uint256) public tokenLiability;
    mapping(uint256 => mapping(uint64 => FinalActive)) public finalActive;
    mapping(uint256 => mapping(uint64 => FinalExit)) public finalExit;
    mapping(uint256 => mapping(uint64 => uint256)) public tickPositionId;
    mapping(uint256 => Tick) private _ticks;
    mapping(uint256 => mapping(address => Provider)) private _providers;
    mapping(uint256 => uint256) private _tickAssetLiability;
    mapping(uint256 => uint256) private _tickQuoteLiability;
    mapping(address => uint256[]) private _userEarnTicks;
    mapping(address => mapping(uint256 => uint256)) private _earnIndexPlusOne;
    mapping(address => uint256[]) private _userActivePositions;
    mapping(uint256 => uint256) private _activeIndexPlusOne;

    uint256 public nextPositionId = 1;

    event PairCreated(uint256 indexed pairId, address indexed token0, address indexed token1);
    event TickCreated(
        uint256 indexed tickId,
        uint256 indexed pairId,
        uint8 direction,
        int32 priceTick,
        uint64 durationDays,
        address asset,
        address quote
    );
    event Supplied(
        uint256 indexed tickId,
        address indexed supplier,
        uint256 assetAmount,
        uint256 sharesMinted,
        address referrer
    );
    event Withdrawn(
        uint256 indexed tickId,
        address indexed supplier,
        uint256 sharesBurned,
        uint256 principalClaim,
        uint256 availableAssetOut,
        uint256 workingToExit,
        uint256 exitSharesMinted
    );
    event Collected(
        uint256 indexed tickId,
        address indexed supplier,
        uint256 exitAsset,
        uint256 grossYieldAsset,
        uint256 yieldFeeAsset,
        uint256 netYieldAsset,
        uint256 exitQuote,
        uint256 swapQuote,
        uint256 totalAssetOut,
        uint256 totalQuoteOut
    );
    event UseOpened(
        uint256 indexed positionId,
        uint256 indexed tickId,
        uint64 tickSeq,
        address indexed user,
        uint256 assetAmount,
        uint256 quotePrincipal,
        uint256 fullTermYieldAsset,
        uint256 closeFee,
        uint256 openedAt,
        uint256 maturity,
        address referrer
    );
    event TermRepaid(
        uint256 indexed positionId,
        uint256 indexed tickId,
        uint64 tickSeq,
        address indexed user,
        uint256 assetAmount,
        uint256 quotePrincipal,
        uint256 grossYieldAsset,
        uint256 exitFill,
        uint256 activeReturn,
        uint256 exitYieldAsset,
        uint256 activeYieldAsset
    );
    event TermClosed(
        uint256 indexed positionId,
        uint256 indexed tickId,
        uint64 tickSeq,
        address user,
        address caller,
        uint256 assetAmount,
        uint256 quotePrincipal,
        uint256 closeFee,
        uint256 providerSwapProceeds,
        uint256 exitFill,
        uint256 exitQuote,
        uint256 activeQuote
    );
    event ImmediateSwap(
        uint256 indexed tickId,
        address indexed taker,
        uint256 assetAmount,
        uint256 quotePrincipal,
        uint256 referenceFullTermYieldAsset,
        uint256 referenceYieldQuote,
        uint256 swapFee,
        uint256 providerSwapProceeds,
        address referrer
    );
    event GenerationFinalized(
        uint256 indexed tickId,
        uint64 generationId,
        uint256 finalYieldAssetGrowthX128,
        uint256 finalSwapQuoteGrowthX128
    );
    event ExitGenerationFinalized(
        uint256 indexed tickId,
        uint64 exitGenerationId,
        uint256 finalExitAssetGrowthX128,
        uint256 finalExitYieldAssetGrowthX128,
        uint256 finalExitQuoteGrowthX128
    );

    constructor(address feeTo) {
        if (feeTo == address(0)) revert InvalidInput();
        FEE_TO = feeTo;
    }

    function _pair(address a, address b) internal pure returns (uint256 id, address token0, address token1) {
        if (a == address(0) || b == address(0) || a == b) revert InvalidInput();
        (token0, token1) = a < b ? (a, b) : (b, a);
        id = uint256(keccak256(abi.encode(token0, token1)));
    }

    function getPair(
        address a,
        address b
    ) external view returns (uint256 pairId, address token0, address token1, bool exists) {
        (pairId, token0, token1) = _pair(a, b);
        exists = pairs[pairId].exists;
    }

    function createPair(address a, address b) external returns (uint256 id) {
        address token0;
        address token1;
        (id, token0, token1) = _pair(a, b);
        if (pairs[id].exists) revert AlreadyExists();
        pairs[id] = Pair(token0, token1, true);
        emit PairCreated(id, token0, token1);
    }

    function createTick(
        uint256 pairId,
        uint8 direction,
        int32 priceTick,
        uint64 durationDays
    ) external returns (uint256 id) {
        Pair storage p = pairs[pairId];
        if (!p.exists) revert NotFound();
        if (direction > 1 || priceTick < -887272 || priceTick > 887272 || durationDays == 0) revert InvalidInput();
        id = uint256(keccak256(abi.encode(pairId, direction, priceTick, durationDays)));
        if (_ticks[id].exists) revert AlreadyExists();
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(int24(priceTick));
        Tick storage t = _ticks[id];
        t.pairId = pairId;
        t.asset = direction == 0 ? p.token0 : p.token1;
        t.quote = direction == 0 ? p.token1 : p.token0;
        t.priceX128 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
        t.direction = direction;
        t.priceTick = priceTick;
        t.durationDays = durationDays;
        t.exists = true;
        emit TickCreated(id, pairId, direction, priceTick, durationDays, t.asset, t.quote);
    }

    function getTick(
        uint256 id
    ) external view returns (Tick memory tick, uint256 activeWorking, uint256 activePrincipal) {
        tick = _requireTick(id);
        activeWorking = tick.workingSupply - tick.exitWorking;
        activePrincipal = tick.availableSupply + activeWorking;
    }

    function _requireTick(uint256 id) internal view returns (Tick storage t) {
        t = _ticks[id];
        if (!t.exists) revert NotFound();
    }

    function _pow4(uint256 u) internal pure returns (uint256) {
        uint256 u2 = Math.mulDiv(u, u, Q128);
        return Math.mulDiv(u2, u2, Q128);
    }

    function _quote(Tick memory t, uint256 x) internal pure returns (uint256) {
        return Math.mulDiv(x, t.priceX128, Q128, Math.Rounding.Ceil);
    }

    function _fullTermYield(Tick memory t, uint256 x) internal pure returns (uint256) {
        uint256 wa = t.workingSupply - t.exitWorking;
        uint256 ca = t.availableSupply + wa;
        if (x == 0 || x > t.availableSupply || ca == 0 || t.totalShares == 0) revert InsufficientLiquidity();
        uint256 u0 = Math.mulDiv(wa, Q128, ca);
        uint256 u1 = Math.mulDiv(wa + x, Q128, ca);
        uint256 curve = 4 * MIN_DAILY_BPS * (u1 - u0) + (MAX_DAILY_BPS - MIN_DAILY_BPS) * (_pow4(u1) - _pow4(u0));
        uint256 durationCurve = uint256(t.durationDays) * curve;
        uint256 result = Math.mulDiv(ca, durationCurve, 4 * BPS * Q128, Math.Rounding.Ceil);
        if (result == 0) revert InvalidInput();
        return result;
    }

    function _swapPreview(Tick memory t, uint256 x) internal pure returns (SwapPreview memory q) {
        q.assetAmount = x;
        q.quotePrincipal = _quote(t, x);
        if (q.quotePrincipal == 0) revert InvalidInput();
        q.referenceFullTermYieldAsset = _fullTermYield(t, x);
        q.referenceYieldQuote = _quote(t, q.referenceFullTermYieldAsset);
        q.swapFee = Math.mulDiv(q.referenceYieldQuote, FEE_BPS, BPS);
        if (q.swapFee > q.quotePrincipal) revert InvalidInput();
        q.providerSwapProceeds = q.quotePrincipal - q.swapFee;
    }

    function _reconcileLiability(address token, uint256 previous, uint256 current) internal {
        uint256 total = tokenLiability[token];
        total = current >= previous ? total + (current - previous) : total - (previous - current);
        tokenLiability[token] = total;
        if (IERC20(token).balanceOf(address(this)) < total) revert Invariant();
    }

    function _checkAsset(uint256 id, Tick storage t) internal {
        uint256 current = t.availableSupply + t.exitAssetReserve + t.yieldAssetReserve;
        _reconcileLiability(t.asset, _tickAssetLiability[id], current);
        _tickAssetLiability[id] = current;
    }

    function _checkQuote(uint256 id, Tick storage t) internal {
        uint256 current = t.quoteEscrow + t.exitQuoteReserve + t.activeQuoteReserve;
        _reconcileLiability(t.quote, _tickQuoteLiability[id], current);
        _tickQuoteLiability[id] = current;
    }

    function _pull(IERC20 token, address from, uint256 amount) internal {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
    }

    function _push(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) return;
        uint256 beforeFrom = token.balanceOf(address(this));
        uint256 beforeTo = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforeFrom - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeTo != amount)
            revert UnsupportedToken();
    }

    function _activePrincipal(Tick storage t) internal view returns (uint256) {
        return t.availableSupply + t.workingSupply - t.exitWorking;
    }

    function _finalizeActive(uint256 id, Tick storage t) internal {
        if (_activePrincipal(t) != 0 || t.totalShares == 0) return;
        uint64 g = t.generation;
        finalActive[id][g] = FinalActive(t.yieldAssetGrowthX128, t.swapQuoteGrowthX128);
        emit GenerationFinalized(id, g, t.yieldAssetGrowthX128, t.swapQuoteGrowthX128);
        t.totalShares = 0;
        t.generation = g + 1;
        t.yieldAssetGrowthX128 = 0;
        t.swapQuoteGrowthX128 = 0;
    }

    function _finalizeExit(uint256 id, Tick storage t) internal {
        if (t.exitWorking != 0 || t.totalExitShares == 0) return;
        uint64 g = t.exitGeneration;
        finalExit[id][g] = FinalExit(t.exitAssetGrowthX128, t.exitYieldAssetGrowthX128, t.exitQuoteGrowthX128);
        emit ExitGenerationFinalized(id, g, t.exitAssetGrowthX128, t.exitYieldAssetGrowthX128, t.exitQuoteGrowthX128);
        t.totalExitShares = 0;
        t.exitGeneration = g + 1;
        t.exitAssetGrowthX128 = 0;
        t.exitYieldAssetGrowthX128 = 0;
        t.exitQuoteGrowthX128 = 0;
    }

    function _sync(uint256 id, address owner) internal {
        Tick storage t = _ticks[id];
        Provider storage p = _providers[id][owner];
        if (p.generation != t.generation) {
            FinalActive storage f = finalActive[id][p.generation];
            p.owedYieldAsset += Math.mulDiv(p.shares, f.yieldGrowth - p.yieldAssetGrowthLastX128, Q128);
            p.owedSwapQuote += Math.mulDiv(p.shares, f.quoteGrowth - p.swapQuoteGrowthLastX128, Q128);
            p.shares = 0;
            p.generation = t.generation;
            p.yieldAssetGrowthLastX128 = 0;
            p.swapQuoteGrowthLastX128 = 0;
        }
        p.owedYieldAsset += Math.mulDiv(p.shares, t.yieldAssetGrowthX128 - p.yieldAssetGrowthLastX128, Q128);
        p.owedSwapQuote += Math.mulDiv(p.shares, t.swapQuoteGrowthX128 - p.swapQuoteGrowthLastX128, Q128);
        p.yieldAssetGrowthLastX128 = t.yieldAssetGrowthX128;
        p.swapQuoteGrowthLastX128 = t.swapQuoteGrowthX128;
        if (p.exitGeneration != t.exitGeneration) {
            FinalExit storage f = finalExit[id][p.exitGeneration];
            p.owedExitAsset += Math.mulDiv(p.exitShares, f.assetGrowth - p.exitAssetGrowthLastX128, Q128);
            p.owedExitYieldAsset += Math.mulDiv(p.exitShares, f.yieldGrowth - p.exitYieldAssetGrowthLastX128, Q128);
            p.owedExitQuote += Math.mulDiv(p.exitShares, f.quoteGrowth - p.exitQuoteGrowthLastX128, Q128);
            p.exitShares = 0;
            p.exitGeneration = t.exitGeneration;
            p.exitAssetGrowthLastX128 = 0;
            p.exitYieldAssetGrowthLastX128 = 0;
            p.exitQuoteGrowthLastX128 = 0;
        }
        p.owedExitAsset += Math.mulDiv(p.exitShares, t.exitAssetGrowthX128 - p.exitAssetGrowthLastX128, Q128);
        p.owedExitYieldAsset += Math.mulDiv(
            p.exitShares,
            t.exitYieldAssetGrowthX128 - p.exitYieldAssetGrowthLastX128,
            Q128
        );
        p.owedExitQuote += Math.mulDiv(p.exitShares, t.exitQuoteGrowthX128 - p.exitQuoteGrowthLastX128, Q128);
        p.exitAssetGrowthLastX128 = t.exitAssetGrowthX128;
        p.exitYieldAssetGrowthLastX128 = t.exitYieldAssetGrowthX128;
        p.exitQuoteGrowthLastX128 = t.exitQuoteGrowthX128;
    }

    function _addEarn(address owner, uint256 id) internal {
        if (_earnIndexPlusOne[owner][id] != 0) return;
        _userEarnTicks[owner].push(id);
        _earnIndexPlusOne[owner][id] = _userEarnTicks[owner].length;
    }

    function _pruneEarn(address owner, uint256 id) internal {
        Provider storage p = _providers[id][owner];
        if (
            p.shares != 0 ||
            p.exitShares != 0 ||
            p.owedYieldAsset != 0 ||
            p.owedSwapQuote != 0 ||
            p.owedExitAsset != 0 ||
            p.owedExitYieldAsset != 0 ||
            p.owedExitQuote != 0
        ) return;
        uint256 slot = _earnIndexPlusOne[owner][id];
        if (slot == 0) return;
        uint256[] storage list = _userEarnTicks[owner];
        uint256 last = list[list.length - 1];
        list[slot - 1] = last;
        _earnIndexPlusOne[owner][last] = slot;
        list.pop();
        delete _earnIndexPlusOne[owner][id];
    }

    function _removeActive(uint256 positionId, address owner) internal {
        uint256 slot = _activeIndexPlusOne[positionId];
        uint256[] storage list = _userActivePositions[owner];
        uint256 last = list[list.length - 1];
        list[slot - 1] = last;
        _activeIndexPlusOne[last] = slot;
        list.pop();
        delete _activeIndexPlusOne[positionId];
    }

    function _page(uint256[] storage list, uint256 offset, uint256 limit) internal view returns (uint256[] memory out) {
        if (offset >= list.length) return new uint256[](0);
        uint256 n = Math.min(limit, list.length - offset);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = list[offset + i];
    }

    function getEarnPositions(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_userEarnTicks[user], offset, limit);
    }
    function getUsePositions(address user, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_userActivePositions[user], offset, limit);
    }
    function getPosition(uint256 id) external view returns (Position memory) {
        return positions[id];
    }

    function _settleOne(uint256 id, Tick storage t) internal {
        if (t.settleCursor == t.nextPositionSeq) return;
        uint256 positionId = tickPositionId[id][t.settleCursor];
        Position storage p = positions[positionId];
        if (p.status == Status.ACTIVE) {
            if (block.timestamp < p.maturity) return;
            _close(positionId, p, t);
        }
        t.settleCursor += 1;
    }

    function settle(uint256 id) external nonReentrant {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
    }

    function supply(uint256 id, uint256 assetAmount, address referrer) external nonReentrant returns (uint256 minted) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        if (assetAmount == 0) revert InvalidInput();
        _sync(id, msg.sender);
        Provider storage p = _providers[id][msg.sender];
        uint256 ca = _activePrincipal(t);
        if ((ca == 0) != (t.totalShares == 0)) revert Invariant();
        minted = ca == 0 ? assetAmount : Math.mulDiv(assetAmount, t.totalShares, ca);
        if (minted == 0) revert InvalidInput();
        _pull(IERC20(t.asset), msg.sender, assetAmount);
        t.availableSupply += assetAmount;
        t.totalShares += minted;
        p.shares += minted;
        p.lastSupplyBlock = block.number;
        _addEarn(msg.sender, id);
        _checkAsset(id, t);
        emit Supplied(id, msg.sender, assetAmount, minted, referrer);
    }

    function withdraw(uint256 id, uint256 sharesToWithdraw) external nonReentrant returns (WithdrawPreview memory q) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        _sync(id, msg.sender);
        Provider storage p = _providers[id][msg.sender];
        if (sharesToWithdraw == 0 || sharesToWithdraw > p.shares) revert InvalidInput();
        if (block.number <= p.lastSupplyBlock) revert Cooldown();
        uint256 ca = _activePrincipal(t);
        uint256 s = t.totalShares;
        if (ca == 0 || s == 0) revert Invariant();
        q.sharesToWithdraw = sharesToWithdraw;
        q.principalClaim = Math.mulDiv(sharesToWithdraw, ca, s);
        if (q.principalClaim == 0 && sharesToWithdraw != p.shares) revert InvalidInput();
        q.availableAssetOut = Math.mulDiv(sharesToWithdraw, t.availableSupply, s);
        q.workingToExit = q.principalClaim - q.availableAssetOut;
        if (q.workingToExit > t.workingSupply - t.exitWorking) revert Invariant();
        if (q.workingToExit != 0) {
            q.exitSharesMinted =
                t.exitWorking == 0 ? q.workingToExit : Math.mulDiv(q.workingToExit, t.totalExitShares, t.exitWorking);
            if (q.exitSharesMinted == 0) revert Invariant();
            t.exitWorking += q.workingToExit;
            t.totalExitShares += q.exitSharesMinted;
            p.exitShares += q.exitSharesMinted;
        }
        t.availableSupply -= q.availableAssetOut;
        t.totalShares -= sharesToWithdraw;
        p.shares -= sharesToWithdraw;
        q.remainingActiveShares = p.shares;
        q.remainingExitShares = p.exitShares;
        if ((_activePrincipal(t) == 0) != (t.totalShares == 0)) revert Invariant();
        _push(IERC20(t.asset), msg.sender, q.availableAssetOut);
        _pruneEarn(msg.sender, id);
        _checkAsset(id, t);
        emit Withdrawn(
            id,
            msg.sender,
            sharesToWithdraw,
            q.principalClaim,
            q.availableAssetOut,
            q.workingToExit,
            q.exitSharesMinted
        );
    }

    function use(
        uint256 id,
        uint256 assetAmount,
        uint256 maxFullTermYieldAsset,
        uint256 deadline,
        address referrer
    ) external nonReentrant returns (uint256 positionId) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        if (block.timestamp > deadline) revert Expired();
        SwapPreview memory q = _swapPreview(t, assetAmount);
        if (q.referenceFullTermYieldAsset > maxFullTermYieldAsset) revert Slippage();
        uint256 maturity = block.timestamp + uint256(t.durationDays) * 1 days;
        positionId = nextPositionId;
        nextPositionId = positionId + 1;
        uint64 seq = t.nextPositionSeq;
        t.nextPositionSeq = seq + 1;
        tickPositionId[id][seq] = positionId;
        positions[positionId] = Position(
            id,
            seq,
            msg.sender,
            assetAmount,
            q.quotePrincipal,
            q.referenceFullTermYieldAsset,
            q.swapFee,
            block.timestamp,
            maturity,
            Status.ACTIVE
        );
        _userActivePositions[msg.sender].push(positionId);
        _activeIndexPlusOne[positionId] = _userActivePositions[msg.sender].length;
        t.availableSupply -= assetAmount;
        t.workingSupply += assetAmount;
        t.quoteEscrow += q.quotePrincipal;
        _pull(IERC20(t.quote), msg.sender, q.quotePrincipal);
        _push(IERC20(t.asset), msg.sender, assetAmount);
        _checkAsset(id, t);
        _checkQuote(id, t);
        emit UseOpened(
            positionId,
            id,
            seq,
            msg.sender,
            assetAmount,
            q.quotePrincipal,
            q.referenceFullTermYieldAsset,
            q.swapFee,
            block.timestamp,
            maturity,
            referrer
        );
    }

    function _repayPreview(Position storage p, Tick memory t) internal view returns (RepayPreview memory q) {
        if (p.status != Status.ACTIVE || block.timestamp >= p.maturity) revert InvalidState();
        q.assetPrincipal = p.assetAmount;
        uint256 elapsed = block.timestamp - p.openedAt;
        q.grossYieldAsset = Math.mulDiv(
            p.fullTermYieldAsset,
            Math.max(MIN_BILLABLE_SECONDS, elapsed),
            p.maturity - p.openedAt,
            Math.Rounding.Ceil
        );
        if (q.grossYieldAsset == 0 || q.grossYieldAsset > p.fullTermYieldAsset) revert Invariant();
        q.totalAssetIn = q.assetPrincipal + q.grossYieldAsset;
        q.exitFill = Math.min(p.assetAmount, t.exitWorking);
        q.activeReturn = p.assetAmount - q.exitFill;
        q.exitYieldAsset = Math.mulDiv(q.grossYieldAsset, q.exitFill, p.assetAmount);
        q.activeYieldAsset = q.grossYieldAsset - q.exitYieldAsset;
        q.quotePrincipalUnlocked = p.quotePrincipal;
    }

    function repay(uint256 positionId, uint256 maxYieldAsset) external nonReentrant returns (RepayPreview memory q) {
        Position storage p = positions[positionId];
        if (p.status != Status.ACTIVE) revert InvalidState();
        Tick storage t = _ticks[p.tickId];
        if (p.tickSeq != t.settleCursor) _settleOne(p.tickId, t);
        if (p.user != msg.sender) revert Unauthorized();
        q = _repayPreview(p, t);
        if (q.grossYieldAsset > maxYieldAsset) revert Slippage();
        _pull(IERC20(t.asset), msg.sender, q.totalAssetIn);
        t.workingSupply -= p.assetAmount;
        t.exitWorking -= q.exitFill;
        t.availableSupply += q.activeReturn;
        t.exitAssetReserve += q.exitFill;
        t.yieldAssetReserve += q.grossYieldAsset;
        t.quoteEscrow -= p.quotePrincipal;
        if (q.exitFill != 0) {
            if (t.totalExitShares == 0) revert Invariant();
            t.exitAssetGrowthX128 += Math.mulDiv(q.exitFill, Q128, t.totalExitShares);
        }
        if (q.exitYieldAsset != 0) t.exitYieldAssetGrowthX128 += Math.mulDiv(q.exitYieldAsset, Q128, t.totalExitShares);
        if (q.activeYieldAsset != 0) {
            if (t.totalShares == 0) revert Invariant();
            t.yieldAssetGrowthX128 += Math.mulDiv(q.activeYieldAsset, Q128, t.totalShares);
        }
        p.status = Status.REPAID;
        _removeActive(positionId, p.user);
        if (p.tickSeq == t.settleCursor) t.settleCursor += 1;
        _finalizeExit(p.tickId, t);
        _finalizeActive(p.tickId, t);
        _push(IERC20(t.quote), msg.sender, p.quotePrincipal);
        _checkAsset(p.tickId, t);
        _checkQuote(p.tickId, t);
        emit TermRepaid(
            positionId,
            p.tickId,
            p.tickSeq,
            p.user,
            p.assetAmount,
            p.quotePrincipal,
            q.grossYieldAsset,
            q.exitFill,
            q.activeReturn,
            q.exitYieldAsset,
            q.activeYieldAsset
        );
    }

    function _close(uint256 positionId, Position storage p, Tick storage t) internal {
        if (p.status != Status.ACTIVE || block.timestamp < p.maturity) revert InvalidState();
        uint256 proceeds = p.quotePrincipal - p.closeFee;
        uint256 exitFill = Math.min(p.assetAmount, t.exitWorking);
        uint256 exitQuote = Math.mulDiv(proceeds, exitFill, p.assetAmount);
        uint256 activeQuote = proceeds - exitQuote;
        t.workingSupply -= p.assetAmount;
        t.exitWorking -= exitFill;
        t.quoteEscrow -= p.quotePrincipal;
        t.exitQuoteReserve += exitQuote;
        t.activeQuoteReserve += activeQuote;
        if (exitQuote != 0) {
            if (t.totalExitShares == 0) revert Invariant();
            t.exitQuoteGrowthX128 += Math.mulDiv(exitQuote, Q128, t.totalExitShares);
        }
        if (activeQuote != 0) {
            if (t.totalShares == 0) revert Invariant();
            t.swapQuoteGrowthX128 += Math.mulDiv(activeQuote, Q128, t.totalShares);
        }
        p.status = Status.CLOSED;
        _removeActive(positionId, p.user);
        _finalizeExit(p.tickId, t);
        _finalizeActive(p.tickId, t);
        _push(IERC20(t.quote), FEE_TO, p.closeFee);
        _checkAsset(p.tickId, t);
        _checkQuote(p.tickId, t);
        emit TermClosed(
            positionId,
            p.tickId,
            p.tickSeq,
            p.user,
            msg.sender,
            p.assetAmount,
            p.quotePrincipal,
            p.closeFee,
            proceeds,
            exitFill,
            exitQuote,
            activeQuote
        );
    }

    function close(uint256 positionId) external nonReentrant {
        Position storage p = positions[positionId];
        if (p.status != Status.ACTIVE) revert InvalidState();
        Tick storage t = _ticks[p.tickId];
        if (p.tickSeq != t.settleCursor) _settleOne(p.tickId, t);
        _close(positionId, p, t);
        if (p.tickSeq == t.settleCursor) t.settleCursor += 1;
    }

    function swap(
        uint256 id,
        uint256 assetAmount,
        uint256 maxQuoteIn,
        uint256 deadline,
        address referrer
    ) external nonReentrant returns (SwapPreview memory q) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        if (block.timestamp > deadline) revert Expired();
        q = _swapPreview(t, assetAmount);
        if (q.quotePrincipal > maxQuoteIn) revert Slippage();
        _pull(IERC20(t.quote), msg.sender, q.quotePrincipal);
        t.availableSupply -= assetAmount;
        t.activeQuoteReserve += q.providerSwapProceeds;
        t.swapQuoteGrowthX128 += Math.mulDiv(q.providerSwapProceeds, Q128, t.totalShares);
        _finalizeActive(id, t);
        _push(IERC20(t.asset), msg.sender, assetAmount);
        _push(IERC20(t.quote), FEE_TO, q.swapFee);
        _checkAsset(id, t);
        _checkQuote(id, t);
        emit ImmediateSwap(
            id,
            msg.sender,
            assetAmount,
            q.quotePrincipal,
            q.referenceFullTermYieldAsset,
            q.referenceYieldQuote,
            q.swapFee,
            q.providerSwapProceeds,
            referrer
        );
    }

    function _yieldFee(uint256 gross, uint256 carry) internal pure returns (uint256 fee, uint256 nextCarry) {
        uint256 remainderWithCarry = mulmod(gross, FEE_BPS, BPS) + carry;
        fee = Math.mulDiv(gross, FEE_BPS, BPS) + remainderWithCarry / BPS;
        nextCarry = remainderWithCarry % BPS;
    }

    function _collectPreview(Provider memory p) internal pure returns (CollectPreview memory q) {
        q.exitAsset = p.owedExitAsset;
        q.activeYieldAsset = p.owedYieldAsset;
        q.exitYieldAsset = p.owedExitYieldAsset;
        q.grossYieldAsset = q.activeYieldAsset + q.exitYieldAsset;
        (q.yieldFeeAsset, ) = _yieldFee(q.grossYieldAsset, p.yieldFeeCarry);
        q.netYieldAsset = q.grossYieldAsset - q.yieldFeeAsset;
        q.exitQuote = p.owedExitQuote;
        q.swapQuote = p.owedSwapQuote;
        q.totalAssetOut = q.exitAsset + q.netYieldAsset;
        q.totalQuoteOut = q.exitQuote + q.swapQuote;
    }

    function collect(uint256 id) external nonReentrant returns (CollectPreview memory q) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        _sync(id, msg.sender);
        Provider storage p = _providers[id][msg.sender];
        q = _collectPreview(p);
        (, p.yieldFeeCarry) = _yieldFee(q.grossYieldAsset, p.yieldFeeCarry);
        t.exitAssetReserve -= q.exitAsset;
        t.yieldAssetReserve -= q.grossYieldAsset;
        t.exitQuoteReserve -= q.exitQuote;
        t.activeQuoteReserve -= q.swapQuote;
        p.owedExitAsset = 0;
        p.owedYieldAsset = 0;
        p.owedExitYieldAsset = 0;
        p.owedExitQuote = 0;
        p.owedSwapQuote = 0;
        _pruneEarn(msg.sender, id);
        _push(IERC20(t.asset), msg.sender, q.totalAssetOut);
        _push(IERC20(t.asset), FEE_TO, q.yieldFeeAsset);
        _push(IERC20(t.quote), msg.sender, q.totalQuoteOut);
        _checkAsset(id, t);
        _checkQuote(id, t);
        emit Collected(
            id,
            msg.sender,
            q.exitAsset,
            q.grossYieldAsset,
            q.yieldFeeAsset,
            q.netYieldAsset,
            q.exitQuote,
            q.swapQuote,
            q.totalAssetOut,
            q.totalQuoteOut
        );
    }

    function _projectTick(uint256 id, bool skipSettle) internal view returns (ProjectedTick memory v) {
        v.tick = _ticks[id];
        Tick memory t = v.tick;
        if (skipSettle || t.settleCursor == t.nextPositionSeq) return v;
        Position storage p = positions[tickPositionId[id][t.settleCursor]];
        if (p.status != Status.ACTIVE) {
            t.settleCursor += 1;
            v.tick = t;
            return v;
        }
        if (block.timestamp < p.maturity) return v;
        uint256 proceeds = p.quotePrincipal - p.closeFee;
        uint256 exitFill = Math.min(p.assetAmount, t.exitWorking);
        uint256 exitQuote = Math.mulDiv(proceeds, exitFill, p.assetAmount);
        uint256 activeQuote = proceeds - exitQuote;
        t.workingSupply -= p.assetAmount;
        t.exitWorking -= exitFill;
        t.quoteEscrow -= p.quotePrincipal;
        t.exitQuoteReserve += exitQuote;
        t.activeQuoteReserve += activeQuote;
        if (exitQuote != 0) t.exitQuoteGrowthX128 += Math.mulDiv(exitQuote, Q128, t.totalExitShares);
        if (activeQuote != 0) t.swapQuoteGrowthX128 += Math.mulDiv(activeQuote, Q128, t.totalShares);
        if (t.exitWorking == 0 && t.totalExitShares != 0) {
            v.exitFinal = FinalExit(t.exitAssetGrowthX128, t.exitYieldAssetGrowthX128, t.exitQuoteGrowthX128);
            v.exitFinalized = true;
            t.totalExitShares = 0;
            t.exitGeneration += 1;
            t.exitAssetGrowthX128 = 0;
            t.exitYieldAssetGrowthX128 = 0;
            t.exitQuoteGrowthX128 = 0;
        }
        if (t.availableSupply + t.workingSupply - t.exitWorking == 0 && t.totalShares != 0) {
            v.activeFinal = FinalActive(t.yieldAssetGrowthX128, t.swapQuoteGrowthX128);
            v.activeFinalized = true;
            t.totalShares = 0;
            t.generation += 1;
            t.yieldAssetGrowthX128 = 0;
            t.swapQuoteGrowthX128 = 0;
        }
        t.settleCursor += 1;
        v.tick = t;
    }

    function _previewProvider(
        uint256 id,
        address owner,
        ProjectedTick memory v
    ) internal view returns (Provider memory p) {
        Tick memory t = v.tick;
        p = _providers[id][owner];
        if (p.generation != t.generation) {
            FinalActive memory f =
                v.activeFinalized && p.generation + 1 == t.generation ? v.activeFinal : finalActive[id][p.generation];
            p.owedYieldAsset += Math.mulDiv(p.shares, f.yieldGrowth - p.yieldAssetGrowthLastX128, Q128);
            p.owedSwapQuote += Math.mulDiv(p.shares, f.quoteGrowth - p.swapQuoteGrowthLastX128, Q128);
            p.shares = 0;
            p.generation = t.generation;
            p.yieldAssetGrowthLastX128 = 0;
            p.swapQuoteGrowthLastX128 = 0;
        }
        p.owedYieldAsset += Math.mulDiv(p.shares, t.yieldAssetGrowthX128 - p.yieldAssetGrowthLastX128, Q128);
        p.owedSwapQuote += Math.mulDiv(p.shares, t.swapQuoteGrowthX128 - p.swapQuoteGrowthLastX128, Q128);
        p.yieldAssetGrowthLastX128 = t.yieldAssetGrowthX128;
        p.swapQuoteGrowthLastX128 = t.swapQuoteGrowthX128;
        if (p.exitGeneration != t.exitGeneration) {
            FinalExit memory f =
                v.exitFinalized && p.exitGeneration + 1 == t.exitGeneration
                    ? v.exitFinal
                    : finalExit[id][p.exitGeneration];
            p.owedExitAsset += Math.mulDiv(p.exitShares, f.assetGrowth - p.exitAssetGrowthLastX128, Q128);
            p.owedExitYieldAsset += Math.mulDiv(p.exitShares, f.yieldGrowth - p.exitYieldAssetGrowthLastX128, Q128);
            p.owedExitQuote += Math.mulDiv(p.exitShares, f.quoteGrowth - p.exitQuoteGrowthLastX128, Q128);
            p.exitShares = 0;
            p.exitGeneration = t.exitGeneration;
            p.exitAssetGrowthLastX128 = 0;
            p.exitYieldAssetGrowthLastX128 = 0;
            p.exitQuoteGrowthLastX128 = 0;
        }
        p.owedExitAsset += Math.mulDiv(p.exitShares, t.exitAssetGrowthX128 - p.exitAssetGrowthLastX128, Q128);
        p.owedExitYieldAsset += Math.mulDiv(
            p.exitShares,
            t.exitYieldAssetGrowthX128 - p.exitYieldAssetGrowthLastX128,
            Q128
        );
        p.owedExitQuote += Math.mulDiv(p.exitShares, t.exitQuoteGrowthX128 - p.exitQuoteGrowthLastX128, Q128);
    }

    function _previewProvider(uint256 id, address owner) internal view returns (Provider memory) {
        ProjectedTick memory v;
        v.tick = _ticks[id];
        return _previewProvider(id, owner, v);
    }

    function getEarnPosition(address owner, uint256 id) external view returns (EarnPositionView memory v) {
        _requireTick(id);
        v.provider = _previewProvider(id, owner);
        v.claimableActiveYieldAsset = v.provider.owedYieldAsset;
        v.claimableExitAsset = v.provider.owedExitAsset;
        v.claimableExitYieldAsset = v.provider.owedExitYieldAsset;
        v.claimableSwapQuote = v.provider.owedSwapQuote;
        v.claimableExitQuote = v.provider.owedExitQuote;
    }

    function previewSupply(uint256 id, uint256 assetAmount) external view returns (uint256 sharesMinted) {
        _requireTick(id);
        Tick memory t = _projectTick(id, false).tick;
        if (assetAmount == 0) revert InvalidInput();
        uint256 ca = t.availableSupply + t.workingSupply - t.exitWorking;
        sharesMinted = ca == 0 ? assetAmount : Math.mulDiv(assetAmount, t.totalShares, ca);
        if (sharesMinted == 0) revert InvalidInput();
    }

    function previewWithdraw(
        uint256 id,
        address supplier,
        uint256 sharesToWithdraw
    ) external view returns (WithdrawPreview memory q) {
        _requireTick(id);
        ProjectedTick memory v = _projectTick(id, false);
        Tick memory t = v.tick;
        Provider memory p = _previewProvider(id, supplier, v);
        uint256 ca = t.availableSupply + t.workingSupply - t.exitWorking;
        if (sharesToWithdraw == 0 || sharesToWithdraw > p.shares || ca == 0) revert InvalidInput();
        if (block.number <= p.lastSupplyBlock) revert Cooldown();
        q.sharesToWithdraw = sharesToWithdraw;
        q.principalClaim = Math.mulDiv(sharesToWithdraw, ca, t.totalShares);
        if (q.principalClaim == 0 && sharesToWithdraw != p.shares) revert InvalidInput();
        q.availableAssetOut = Math.mulDiv(sharesToWithdraw, t.availableSupply, t.totalShares);
        q.workingToExit = q.principalClaim - q.availableAssetOut;
        q.exitSharesMinted =
            q.workingToExit == 0
                ? 0
                : t.exitWorking == 0
                    ? q.workingToExit
                    : Math.mulDiv(q.workingToExit, t.totalExitShares, t.exitWorking);
        q.remainingActiveShares = p.shares - sharesToWithdraw;
        q.remainingExitShares = p.exitShares + q.exitSharesMinted;
    }

    function previewUse(uint256 id, uint256 amount) external view returns (UsePreview memory q) {
        _requireTick(id);
        Tick memory t = _projectTick(id, false).tick;
        SwapPreview memory s = _swapPreview(t, amount);
        uint256 wa = t.workingSupply - t.exitWorking;
        uint256 ca = t.availableSupply + wa;
        q.matchAmount = amount;
        q.quotePrincipal = s.quotePrincipal;
        q.activeWorkingShareBefore = Math.mulDiv(wa, Q128, ca);
        q.activeWorkingShareAfter = Math.mulDiv(wa + amount, Q128, ca);
        q.fullTermYieldAsset = s.referenceFullTermYieldAsset;
        q.referenceYieldQuote = s.referenceYieldQuote;
        q.closeFee = s.swapFee;
        uint256 u2 = Math.mulDiv(q.activeWorkingShareBefore, q.activeWorkingShareBefore, Q128);
        uint256 u3 = Math.mulDiv(u2, q.activeWorkingShareBefore, Q128);
        q.dailyRateX128 = Math.mulDiv(MIN_DAILY_BPS * Q128 + (MAX_DAILY_BPS - MIN_DAILY_BPS) * u3, 1, BPS);
        q.termRateX128 = q.dailyRateX128 * t.durationDays;
        q.maturity = block.timestamp + uint256(t.durationDays) * 1 days;
    }

    function previewRepay(uint256 positionId) external view returns (RepayPreview memory) {
        Position storage p = positions[positionId];
        if (p.status != Status.ACTIVE) revert InvalidState();
        return _repayPreview(p, _projectTick(p.tickId, p.tickSeq == _ticks[p.tickId].settleCursor).tick);
    }

    function previewSwap(uint256 id, uint256 amount) external view returns (SwapPreview memory) {
        _requireTick(id);
        return _swapPreview(_projectTick(id, false).tick, amount);
    }

    function previewCollect(uint256 id, address supplier) external view returns (CollectPreview memory) {
        _requireTick(id);
        ProjectedTick memory v = _projectTick(id, false);
        return _collectPreview(_previewProvider(id, supplier, v));
    }
}
