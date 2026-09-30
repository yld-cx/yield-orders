// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {Uint512} from "./libraries/Uint512.sol";

/// @notice yld.cx v0.2 exact-tick, fixed-term Product-Sum liquidity protocol.
contract YieldOrders is Multicall, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BPS = 10_000;
    uint256 public constant Q128 = 1 << 128;
    uint256 public constant PROTOCOL_FEE_BPS = 100;
    uint256 public constant MAX_ACCOUNTING_AMOUNT = 1e30;
    uint256 public constant PRINCIPAL_PRECISION = 1e36;
    uint256 public constant P_PRECISION = 1e39;
    uint256 public constant SCALE_FACTOR = 1e9;
    uint256 public constant P_MIN = 1e30;
    uint256 public constant MAX_SCALE_SPAN = 8;
    uint256 public constant MAX_SCALE_JUMP = 4;
    uint256 public constant MIN_DAILY_BPS = 1;
    uint256 public constant MAX_DAILY_BPS = 100;
    uint256 public constant CURVE_EXPONENT = 3;
    uint256 public constant MIN_BILLABLE_SECONDS = 1;
    uint256 public constant SECONDS_PER_DAY = 86_400;
    uint256 public constant MAX_TIMESTAMP = 9_223_372_036_854_775_807;
    uint256 public constant MAX_DURATION_DAYS = 106_751_991_167_300;
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
    struct Domain {
        uint256 P;
        uint64 scale;
        uint64 generation;
        uint256 assetSum;
        uint256 yieldSum;
        uint256 quoteSum;
    }
    struct ScaleSums {
        uint256 assetSum;
        uint256 yieldSum;
        uint256 quoteSum;
        bool finalized;
    }
    struct GenerationMeta {
        uint64 finalScale;
        bool finalized;
    }
    enum DomainKind {
        Active,
        Exit
    }
    struct Tick {
        uint256 pairId;
        address asset;
        address quote;
        uint8 direction;
        int32 priceTick;
        uint64 durationDays;
        uint256 priceX128;
        bool exists;
        uint256 availableSupply;
        uint256 workingSupply;
        uint256 exitWorking;
        Domain active;
        Domain exit;
        uint256 exitAssetReserve;
        uint256 yieldAssetReserve;
        uint256 exitQuoteReserve;
        uint256 activeQuoteReserve;
        uint256 quoteEscrow;
        uint64 nextPositionSeq;
        uint64 settleCursor;
    }
    struct Snapshot {
        uint256 initialPrincipalX36;
        uint64 generation;
        uint64 scale;
        uint256 P;
        uint256 assetSum;
        uint256 yieldSum;
        uint256 quoteSum;
    }
    struct ProviderPosition {
        Snapshot active;
        Snapshot exit;
        uint256 owedActiveYieldAsset;
        uint256 owedActiveQuote;
        uint256 owedExitAsset;
        uint256 owedExitYieldAsset;
        uint256 owedExitQuote;
        uint256 lastSupplyBlock;
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
        uint256 assetAmount;
        uint256 quotePrincipal;
        uint256 activeUtilizationBeforeX128;
        uint256 activeUtilizationAfterX128;
        uint256 fullTermYieldAsset;
        uint256 closeFee;
        uint256 dailyRateX128;
        uint256 maturity;
    }
    struct WithdrawPreview {
        uint256 providerPrincipal;
        uint256 principalAmount;
        uint256 availableAssetOut;
        uint256 workingToExit;
        uint256 remainingActivePrincipal;
        uint256 resolvingPrincipal;
    }
    struct RepayPreview {
        uint256 assetPrincipal;
        uint256 grossYieldAsset;
        uint256 yieldFeeAsset;
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
        uint256 swapFee;
        uint256 providerSwapProceeds;
    }
    struct CollectPreview {
        uint256 exitAsset;
        uint256 activeYieldAsset;
        uint256 exitYieldAsset;
        uint256 exitQuote;
        uint256 activeQuote;
        uint256 totalAssetOut;
        uint256 totalQuoteOut;
        uint256 resolvingPrincipal;
    }
    struct EarnPositionView {
        uint256 activePrincipal;
        uint256 activePrincipalX36;
        uint256 activeAvailable;
        uint256 activeWorking;
        uint256 exitPrincipalX36;
        uint256 resolvingPrincipal;
        uint256 claimableActiveYieldAsset;
        uint256 claimableExitAsset;
        uint256 claimableExitYieldAsset;
        uint256 claimableActiveQuote;
        uint256 claimableExitQuote;
    }
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
    struct Projection {
        Tick tick;
        ScaleSums activeOverride;
        ScaleSums exitOverride;
        uint64 activeOldGeneration;
        uint64 activeOldScale;
        uint64 exitOldGeneration;
        uint64 exitOldScale;
        bool activeChanged;
        bool exitChanged;
    }

    mapping(uint256 => Pair) public pairs;
    mapping(uint256 => Position) private _positions;
    mapping(address => uint256) public tokenLiability;
    mapping(uint256 => mapping(uint8 => mapping(uint64 => mapping(uint64 => ScaleSums)))) public scaleSums;
    mapping(uint256 => mapping(uint8 => mapping(uint64 => GenerationMeta))) public generationMeta;
    mapping(uint256 => mapping(uint64 => uint256)) public tickPositionId;
    mapping(uint256 => Tick) private _ticks;
    mapping(uint256 => mapping(address => ProviderPosition)) private _providers;
    mapping(uint256 => uint256) private _tickAssetLiability;
    mapping(uint256 => uint256) private _tickQuoteLiability;
    mapping(address => uint256[]) private _userEarnTicks;
    mapping(address => mapping(uint256 => uint256)) private _earnIndexPlusOne;
    mapping(address => uint256[]) private _userPositions;
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
    event Supplied(uint256 indexed tickId, address indexed supplier, uint256 assetAmount, address referrer);
    event Withdrawn(
        uint256 indexed tickId,
        address indexed supplier,
        uint256 principalAmount,
        uint256 availableAssetOut,
        uint256 workingToExit
    );
    event Collected(
        uint256 indexed tickId,
        address indexed supplier,
        uint256 exitAsset,
        uint256 activeYieldAsset,
        uint256 exitYieldAsset,
        uint256 exitQuote,
        uint256 activeQuote,
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
        uint256 yieldFeeAsset,
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
        uint256 swapFee,
        uint256 providerSwapProceeds,
        address referrer
    );
    event DomainScaleChanged(
        uint256 indexed tickId,
        DomainKind indexed domain,
        uint64 generation,
        uint64 oldScale,
        uint64 newScale,
        uint256 newP
    );
    event DomainGenerationFinalized(
        uint256 indexed tickId,
        DomainKind indexed domain,
        uint64 generation,
        uint64 finalScale
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
        if (
            direction > 1 ||
            priceTick < -887272 ||
            priceTick > 887272 ||
            durationDays == 0 ||
            durationDays > MAX_DURATION_DAYS
        ) revert InvalidInput();
        uint256 durationSeconds = uint256(durationDays) * SECONDS_PER_DAY;
        if (durationSeconds > MAX_TIMESTAMP) revert InvalidInput();
        id = uint256(keccak256(abi.encode(pairId, direction, priceTick, durationDays)));
        if (_ticks[id].exists) revert AlreadyExists();
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(int24(priceTick));
        Tick storage t = _ticks[id];
        t.pairId = pairId;
        t.asset = direction == 0 ? p.token0 : p.token1;
        t.quote = direction == 0 ? p.token1 : p.token0;
        t.direction = direction;
        t.priceTick = priceTick;
        t.durationDays = durationDays;
        t.priceX128 = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
        t.active.P = P_PRECISION;
        t.exit.P = P_PRECISION;
        t.exists = true;
        emit TickCreated(id, pairId, direction, priceTick, durationDays, t.asset, t.quote);
    }
    function _requireTick(uint256 id) internal view returns (Tick storage t) {
        t = _ticks[id];
        if (!t.exists) revert NotFound();
    }
    function getTick(uint256 id) external view returns (TickView memory q) {
        Tick storage t = _requireTick(id);
        q = TickView(
            t.asset,
            t.quote,
            t.durationDays,
            t.priceX128,
            t.availableSupply,
            t.workingSupply,
            t.exitWorking,
            t.workingSupply - t.exitWorking,
            t.availableSupply + t.workingSupply - t.exitWorking,
            t.settleCursor
        );
    }
    function getDomain(uint256 id, DomainKind kind) external view returns (Domain memory) {
        Tick storage t = _requireTick(id);
        return kind == DomainKind.Active ? t.active : t.exit;
    }
    function _bound(uint256 amount) internal pure {
        if (amount > MAX_ACCOUNTING_AMOUNT) revert InvalidInput();
    }
    function _activePrincipal(Tick memory t) internal pure returns (uint256) {
        return t.availableSupply + t.workingSupply - t.exitWorking;
    }
    function _pow4(uint256 u) internal pure returns (uint256) {
        uint256 u2 = Math.mulDiv(u, u, Q128);
        return Math.mulDiv(u2, u2, Q128);
    }
    function _quote(Tick memory t, uint256 x) internal pure returns (uint256 q) {
        q = Math.mulDiv(x, t.priceX128, Q128, Math.Rounding.Ceil);
        if (q == 0) revert InvalidInput();
        _bound(q);
    }
    function _fullTermYield(Tick memory t, uint256 x) internal pure returns (uint256 result) {
        uint256 wa = t.workingSupply - t.exitWorking;
        uint256 ca = t.availableSupply + wa;
        if (x == 0 || x > t.availableSupply || ca == 0) revert InsufficientLiquidity();
        uint256 u0 = Math.mulDiv(wa, Q128, ca);
        uint256 u1 = Math.mulDiv(wa + x, Q128, ca);
        uint256 curve = 4 * MIN_DAILY_BPS * (u1 - u0) + (MAX_DAILY_BPS - MIN_DAILY_BPS) * (_pow4(u1) - _pow4(u0));
        result = Math.mulDiv(ca, uint256(t.durationDays) * curve, 4 * BPS * Q128, Math.Rounding.Ceil);
        if (result == 0) revert InvalidInput();
        _bound(result);
    }
    function _swapPreview(Tick memory t, uint256 x) internal pure returns (SwapPreview memory q) {
        if (x == 0 || x > t.availableSupply) revert InsufficientLiquidity();
        _bound(x);
        q.assetAmount = x;
        q.quotePrincipal = _quote(t, x);
        q.swapFee = Math.mulDiv(q.quotePrincipal, PROTOCOL_FEE_BPS, BPS);
        q.providerSwapProceeds = q.quotePrincipal - q.swapFee;
    }
    function _maturity(Tick memory t) internal view returns (uint256 maturity) {
        if (block.timestamp > MAX_TIMESTAMP) revert InvalidInput();
        uint256 duration = uint256(t.durationDays) * SECONDS_PER_DAY;
        maturity = block.timestamp + duration;
        if (maturity > MAX_TIMESTAMP) revert InvalidInput();
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

    function _persist(uint256 id, DomainKind kind, Domain storage d) internal {
        scaleSums[id][uint8(kind)][d.generation][d.scale] = ScaleSums(d.assetSum, d.yieldSum, d.quoteSum, true);
    }
    function _fund(
        Domain storage d,
        uint256 principal,
        uint256 assetGain,
        uint256 yieldGain,
        uint256 quoteGain
    ) internal {
        if (principal == 0) revert Invariant();
        _bound(assetGain);
        _bound(yieldGain);
        _bound(quoteGain);
        if (assetGain != 0) d.assetSum += Math.mulDiv(assetGain, d.P, principal);
        if (yieldGain != 0) d.yieldSum += Math.mulDiv(yieldGain, d.P, principal);
        if (quoteGain != 0) d.quoteSum += Math.mulDiv(quoteGain, d.P, principal);
    }
    function _fundMemory(
        Domain memory d,
        uint256 principal,
        uint256 assetGain,
        uint256 yieldGain,
        uint256 quoteGain
    ) internal pure {
        if (principal == 0) revert Invariant();
        if (assetGain != 0) d.assetSum += Math.mulDiv(assetGain, d.P, principal);
        if (yieldGain != 0) d.yieldSum += Math.mulDiv(yieldGain, d.P, principal);
        if (quoteGain != 0) d.quoteSum += Math.mulDiv(quoteGain, d.P, principal);
    }
    function _depletionP(
        uint256 oldP,
        uint256 beforePrincipal,
        uint256 afterPrincipal
    ) internal pure returns (uint256 newP, uint64 jump) {
        if (beforePrincipal == 0 || afterPrincipal >= beforePrincipal) revert Invariant();
        if (afterPrincipal == 0) return (0, 0);
        uint256 scaledAfter = afterPrincipal;
        for (uint256 i; i <= MAX_SCALE_JUMP; ++i) {
            newP = Math.mulDiv(oldP, scaledAfter, beforePrincipal);
            if (newP >= P_MIN) return (newP, uint64(i));
            if (i != MAX_SCALE_JUMP) scaledAfter *= SCALE_FACTOR;
        }
        revert Invariant();
    }
    function _deplete(
        uint256 id,
        DomainKind kind,
        Domain storage d,
        uint256 beforePrincipal,
        uint256 afterPrincipal
    ) internal {
        if (afterPrincipal == 0) {
            _persist(id, kind, d);
            generationMeta[id][uint8(kind)][d.generation] = GenerationMeta(d.scale, true);
            emit DomainGenerationFinalized(id, kind, d.generation, d.scale);
            d.generation += 1;
            d.scale = 0;
            d.P = P_PRECISION;
            d.assetSum = 0;
            d.yieldSum = 0;
            d.quoteSum = 0;
            return;
        }
        (uint256 newP, uint64 jump) = _depletionP(d.P, beforePrincipal, afterPrincipal);
        if (jump != 0) {
            uint64 oldScale = d.scale;
            _persist(id, kind, d);
            d.scale += jump;
            d.assetSum = 0;
            d.yieldSum = 0;
            d.quoteSum = 0;
            emit DomainScaleChanged(id, kind, d.generation, oldScale, d.scale, newP);
        }
        d.P = newP;
    }
    function _depleteMemory(
        Domain memory d,
        uint256 beforePrincipal,
        uint256 afterPrincipal
    ) internal pure returns (bool changed, ScaleSums memory oldSums, uint64 oldGeneration, uint64 oldScale) {
        oldGeneration = d.generation;
        oldScale = d.scale;
        if (afterPrincipal == 0) {
            oldSums = ScaleSums(d.assetSum, d.yieldSum, d.quoteSum, true);
            changed = true;
            d.generation += 1;
            d.scale = 0;
            d.P = P_PRECISION;
            d.assetSum = 0;
            d.yieldSum = 0;
            d.quoteSum = 0;
            return (changed, oldSums, oldGeneration, oldScale);
        }
        (uint256 newP, uint64 jump) = _depletionP(d.P, beforePrincipal, afterPrincipal);
        if (jump != 0) {
            oldSums = ScaleSums(d.assetSum, d.yieldSum, d.quoteSum, true);
            changed = true;
            d.scale += jump;
            d.assetSum = 0;
            d.yieldSum = 0;
            d.quoteSum = 0;
        }
        d.P = newP;
    }
    function _scaleValue(
        uint256 id,
        DomainKind kind,
        uint64 generation,
        uint64 scale,
        Projection memory v
    ) internal view returns (ScaleSums memory s) {
        Domain memory d = kind == DomainKind.Active ? v.tick.active : v.tick.exit;
        if (generation == d.generation && scale == d.scale) return ScaleSums(d.assetSum, d.yieldSum, d.quoteSum, false);
        if (
            kind == DomainKind.Active &&
            v.activeChanged &&
            generation == v.activeOldGeneration &&
            scale == v.activeOldScale
        ) return v.activeOverride;
        if (kind == DomainKind.Exit && v.exitChanged && generation == v.exitOldGeneration && scale == v.exitOldScale)
            return v.exitOverride;
        return scaleSums[id][uint8(kind)][generation][scale];
    }
    function _endScale(
        uint256 id,
        DomainKind kind,
        uint64 generation,
        Projection memory v
    ) internal view returns (uint64) {
        Domain memory d = kind == DomainKind.Active ? v.tick.active : v.tick.exit;
        if (generation == d.generation) return d.scale;
        if (
            kind == DomainKind.Active &&
            v.activeChanged &&
            generation == v.activeOldGeneration &&
            v.tick.active.generation != generation
        ) return v.activeOldScale;
        if (
            kind == DomainKind.Exit &&
            v.exitChanged &&
            generation == v.exitOldGeneration &&
            v.tick.exit.generation != generation
        ) return v.exitOldScale;
        GenerationMeta memory m = generationMeta[id][uint8(kind)][generation];
        if (!m.finalized) revert Invariant();
        return m.finalScale;
    }
    function _sumField(ScaleSums memory s, uint8 stream) internal pure returns (uint256) {
        if (stream == 0) return s.assetSum;
        if (stream == 1) return s.yieldSum;
        return s.quoteSum;
    }
    /// @dev Exact §9 recurrence: one floor, with the fractional remainder carried through every scale.
    function _accrued(
        uint256 id,
        DomainKind kind,
        Snapshot memory snap,
        uint8 stream,
        Projection memory v
    ) internal view returns (uint256 gain) {
        uint256 A = snap.initialPrincipalX36;
        if (A == 0) return 0;
        uint256 B = snap.P * PRINCIPAL_PRECISION;
        if (A > B || B == 0) revert Invariant();
        uint64 end = _endScale(id, kind, snap.generation, v);
        if (end < snap.scale) revert Invariant();
        uint256 span = Math.min(MAX_SCALE_SPAN, uint256(end - snap.scale));
        uint256 first = _sumField(_scaleValue(id, kind, snap.generation, snap.scale, v), stream);
        uint256 checkpoint =
            stream == 0
                ? snap.assetSum
                : stream == 1
                    ? snap.yieldSum
                    : snap.quoteSum;
        uint256 dS = first - checkpoint;
        gain = Math.mulDiv(A, dS, B);
        // The exact modular remainder is below B and fits one limb.
        Uint512.Value memory R = Uint512.Value(0, mulmod(A, dS, B));
        uint256 pow = 1;
        for (uint256 i = 1; i <= span; ++i) {
            pow *= SCALE_FACTOR;
            dS = _sumField(_scaleValue(id, kind, snap.generation, snap.scale + uint64(i), v), stream);
            uint256 whole = dS / pow;
            uint256 frac = dS % pow;
            uint256 wholeGain = Math.mulDiv(A, whole, B);
            uint256 wholeRem = mulmod(A, whole, B);
            Uint512.Value memory N = Uint512.add(Uint512.mulSmall(R, SCALE_FACTOR), Uint512.mul(wholeRem, pow));
            N = Uint512.add(N, Uint512.mul(A, frac));
            Uint512.Value memory D = Uint512.mul(B, pow);
            uint256 carry;
            if (Uint512.gte(N, D)) {
                N = Uint512.sub(N, D);
                ++carry;
            }
            if (Uint512.gte(N, D)) {
                N = Uint512.sub(N, D);
                ++carry;
            }
            gain += wholeGain + carry;
            R = N;
        }
    }
    function _principal(Snapshot memory s, Domain memory d) internal pure returns (uint256 amountX36) {
        if (s.initialPrincipalX36 == 0 || s.generation != d.generation) return 0;
        if (d.scale < s.scale || s.P == 0) revert Invariant();
        amountX36 = Math.mulDiv(s.initialPrincipalX36, d.P, s.P);
        uint256 diff = d.scale - s.scale;
        for (uint256 i; i < diff && amountX36 != 0; ++i) amountX36 /= SCALE_FACTOR;
    }
    function _snapshot(Snapshot memory s, Domain memory d, uint256 principalX36) internal pure {
        s.initialPrincipalX36 = principalX36;
        s.generation = d.generation;
        s.scale = d.scale;
        s.P = d.P;
        s.assetSum = d.assetSum;
        s.yieldSum = d.yieldSum;
        s.quoteSum = d.quoteSum;
    }
    function _snapshotStorage(Snapshot storage s, Domain storage d, uint256 principalX36) internal {
        s.initialPrincipalX36 = principalX36;
        s.generation = d.generation;
        s.scale = d.scale;
        s.P = d.P;
        s.assetSum = d.assetSum;
        s.yieldSum = d.yieldSum;
        s.quoteSum = d.quoteSum;
    }
    function _syncProvider(
        uint256 id,
        ProviderPosition memory p,
        Projection memory v
    ) internal view returns (ProviderPosition memory) {
        for (uint8 domain = 0; domain < 2; ++domain) {
            Snapshot memory s = domain == 0 ? p.active : p.exit;
            if (s.initialPrincipalX36 == 0) continue;
            DomainKind kind = DomainKind(domain);
            for (uint8 stream = 0; stream < 3; ++stream) {
                if (domain == 0 && stream == 0) continue;
                uint256 gain = _accrued(id, kind, s, stream, v);
                if (domain == 0) {
                    if (stream == 1) p.owedActiveYieldAsset += gain;
                    else p.owedActiveQuote += gain;
                } else {
                    if (stream == 0) p.owedExitAsset += gain;
                    else if (stream == 1) p.owedExitYieldAsset += gain;
                    else p.owedExitQuote += gain;
                }
            }
            Domain memory d = domain == 0 ? v.tick.active : v.tick.exit;
            _snapshot(s, d, _principal(s, d));
        }
        return p;
    }
    function _sync(uint256 id, address owner) internal returns (ProviderPosition storage ps) {
        Projection memory v;
        v.tick = _ticks[id];
        _providers[id][owner] = _syncProvider(id, _providers[id][owner], v);
        return _providers[id][owner];
    }
    function _addEarn(address owner, uint256 id) internal {
        if (_earnIndexPlusOne[owner][id] != 0) return;
        _userEarnTicks[owner].push(id);
        _earnIndexPlusOne[owner][id] = _userEarnTicks[owner].length;
    }
    function _pruneEarn(address owner, uint256 id) internal {
        ProviderPosition storage p = _providers[id][owner];
        if (
            p.active.initialPrincipalX36 != 0 ||
            p.exit.initialPrincipalX36 != 0 ||
            p.owedActiveYieldAsset != 0 ||
            p.owedActiveQuote != 0 ||
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
    function _page(uint256[] storage list, uint256 offset, uint256 limit) internal view returns (uint256[] memory out) {
        if (offset >= list.length) return new uint256[](0);
        uint256 n = Math.min(limit, list.length - offset);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) out[i] = list[offset + i];
    }
    function getEarnPositions(address owner, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_userEarnTicks[owner], offset, limit);
    }
    function getUsePositions(address owner, uint256 offset, uint256 limit) external view returns (uint256[] memory) {
        return _page(_userPositions[owner], offset, limit);
    }
    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function _settleOne(uint256 id, Tick storage t) internal {
        if (t.settleCursor == t.nextPositionSeq) return;
        uint256 positionId = tickPositionId[id][t.settleCursor];
        Position storage p = _positions[positionId];
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

    function supply(uint256 id, uint256 assetAmount, address referrer) external nonReentrant {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        if (assetAmount == 0) revert InvalidInput();
        _bound(assetAmount);
        uint256 ca = t.availableSupply + t.workingSupply - t.exitWorking;
        _bound(ca + assetAmount);
        ProviderPosition storage p = _sync(id, msg.sender);
        uint256 principalX36 = p.active.initialPrincipalX36 + assetAmount * PRINCIPAL_PRECISION;
        if (principalX36 > MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION) revert InvalidInput();
        _pull(IERC20(t.asset), msg.sender, assetAmount);
        t.availableSupply += assetAmount;
        _snapshotStorage(p.active, t.active, principalX36);
        p.lastSupplyBlock = block.number;
        _addEarn(msg.sender, id);
        _checkAsset(id, t);
        emit Supplied(id, msg.sender, assetAmount, referrer);
    }
    function _withdrawNumbers(
        Tick memory t,
        uint256 principalX36,
        uint256 requested
    ) internal pure returns (WithdrawPreview memory q) {
        if (requested == 0) revert InvalidInput();
        q.providerPrincipal = principalX36 / PRINCIPAL_PRECISION;
        q.principalAmount = Math.min(requested, q.providerPrincipal);
        if (q.principalAmount == 0) revert InvalidInput();
        uint256 ca = _activePrincipal(t);
        if (ca == 0) revert Invariant();
        q.availableAssetOut = Math.mulDiv(q.principalAmount, t.availableSupply, ca);
        q.workingToExit = q.principalAmount - q.availableAssetOut;
        if (q.workingToExit > t.workingSupply - t.exitWorking) revert Invariant();
        _bound(t.exitWorking + q.workingToExit);
        q.remainingActivePrincipal = (principalX36 - q.principalAmount * PRINCIPAL_PRECISION) / PRINCIPAL_PRECISION;
    }
    function withdraw(uint256 id, uint256 principalAmount) external nonReentrant returns (WithdrawPreview memory q) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        ProviderPosition storage p = _sync(id, msg.sender);
        if (block.number <= p.lastSupplyBlock) revert Cooldown();
        Tick memory tm = t;
        q = _withdrawNumbers(tm, p.active.initialPrincipalX36, principalAmount);
        t.availableSupply -= q.availableAssetOut;
        t.exitWorking += q.workingToExit;
        _snapshotStorage(p.active, t.active, p.active.initialPrincipalX36 - q.principalAmount * PRINCIPAL_PRECISION);
        if (q.workingToExit != 0) {
            uint256 exitX36 = p.exit.initialPrincipalX36 + q.workingToExit * PRINCIPAL_PRECISION;
            if (exitX36 > MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION) revert InvalidInput();
            _snapshotStorage(p.exit, t.exit, exitX36);
        }
        if (t.availableSupply + t.workingSupply == t.exitWorking)
            _deplete(id, DomainKind.Active, t.active, _activePrincipal(tm), 0);
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION;
        _push(IERC20(t.asset), msg.sender, q.availableAssetOut);
        _pruneEarn(msg.sender, id);
        _checkAsset(id, t);
        emit Withdrawn(id, msg.sender, q.principalAmount, q.availableAssetOut, q.workingToExit);
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
        Tick memory tm = t;
        SwapPreview memory q = _swapPreview(tm, assetAmount);
        uint256 fullYield = _fullTermYield(tm, assetAmount);
        if (fullYield > maxFullTermYieldAsset) revert Slippage();
        uint256 maturity = _maturity(tm);
        // Full precision mulDiv makes every 1..termSeconds elapsed quote representable.
        if (assetAmount > type(uint256).max - fullYield) revert InvalidInput();
        positionId = nextPositionId++;
        uint64 seq = t.nextPositionSeq++;
        tickPositionId[id][seq] = positionId;
        _positions[positionId] = Position(
            id,
            seq,
            msg.sender,
            assetAmount,
            q.quotePrincipal,
            fullYield,
            q.swapFee,
            block.timestamp,
            maturity,
            Status.ACTIVE
        );
        _userPositions[msg.sender].push(positionId);
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
            fullYield,
            q.swapFee,
            block.timestamp,
            maturity,
            referrer
        );
    }
    function _repayPreview(Position memory p, Tick memory t) internal view returns (RepayPreview memory q) {
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
        _bound(q.grossYieldAsset);
        q.yieldFeeAsset = Math.mulDiv(q.grossYieldAsset, PROTOCOL_FEE_BPS, BPS);
        q.totalAssetIn = q.assetPrincipal + q.grossYieldAsset;
        q.exitFill = Math.min(p.assetAmount, t.exitWorking);
        q.activeReturn = p.assetAmount - q.exitFill;
        uint256 netYield = q.grossYieldAsset - q.yieldFeeAsset;
        q.exitYieldAsset = Math.mulDiv(netYield, q.exitFill, p.assetAmount);
        q.activeYieldAsset = netYield - q.exitYieldAsset;
        q.quotePrincipalUnlocked = p.quotePrincipal;
    }
    function repay(uint256 positionId, uint256 maxYieldAsset) external nonReentrant returns (RepayPreview memory q) {
        Position storage p = _positions[positionId];
        if (p.status != Status.ACTIVE) revert InvalidState();
        Tick storage t = _ticks[p.tickId];
        if (p.tickSeq != t.settleCursor) _settleOne(p.tickId, t);
        if (p.user != msg.sender) revert Unauthorized();
        Tick memory tm = t;
        Position memory pm = p;
        q = _repayPreview(pm, tm);
        if (q.grossYieldAsset > maxYieldAsset) revert Slippage();
        uint256 oldExit = t.exitWorking;
        uint256 oldActive = _activePrincipal(tm);
        _pull(IERC20(t.asset), msg.sender, q.totalAssetIn);
        if (q.exitFill != 0) _fund(t.exit, oldExit, q.exitFill, q.exitYieldAsset, 0);
        if (q.activeYieldAsset != 0) _fund(t.active, oldActive, 0, q.activeYieldAsset, 0);
        t.workingSupply -= p.assetAmount;
        t.exitWorking -= q.exitFill;
        t.availableSupply += q.activeReturn;
        t.exitAssetReserve += q.exitFill;
        t.yieldAssetReserve += q.grossYieldAsset - q.yieldFeeAsset;
        t.quoteEscrow -= p.quotePrincipal;
        if (q.exitFill != 0) _deplete(p.tickId, DomainKind.Exit, t.exit, oldExit, t.exitWorking);
        p.status = Status.REPAID;
        if (p.tickSeq == t.settleCursor) t.settleCursor += 1;
        _push(IERC20(t.asset), FEE_TO, q.yieldFeeAsset);
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
            q.yieldFeeAsset,
            q.exitFill,
            q.activeReturn,
            q.exitYieldAsset,
            q.activeYieldAsset
        );
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
        Tick memory tm = t;
        q = _swapPreview(tm, assetAmount);
        if (q.quotePrincipal > maxQuoteIn) revert Slippage();
        uint256 oldActive = _activePrincipal(tm);
        _pull(IERC20(t.quote), msg.sender, q.quotePrincipal);
        _fund(t.active, oldActive, 0, 0, q.providerSwapProceeds);
        t.availableSupply -= assetAmount;
        t.activeQuoteReserve += q.providerSwapProceeds;
        _deplete(id, DomainKind.Active, t.active, oldActive, oldActive - assetAmount);
        _push(IERC20(t.quote), FEE_TO, q.swapFee);
        _push(IERC20(t.asset), msg.sender, assetAmount);
        _checkAsset(id, t);
        _checkQuote(id, t);
        emit ImmediateSwap(id, msg.sender, assetAmount, q.quotePrincipal, q.swapFee, q.providerSwapProceeds, referrer);
    }
    function _close(uint256 positionId, Position storage p, Tick storage t) internal {
        if (p.status != Status.ACTIVE || block.timestamp < p.maturity) revert InvalidState();
        uint256 proceeds = p.quotePrincipal - p.closeFee;
        uint256 exitFill = Math.min(p.assetAmount, t.exitWorking);
        uint256 activeFill = p.assetAmount - exitFill;
        uint256 exitQuote = Math.mulDiv(proceeds, exitFill, p.assetAmount);
        uint256 activeQuote = proceeds - exitQuote;
        uint256 oldExit = t.exitWorking;
        uint256 oldActive = t.availableSupply + t.workingSupply - oldExit;
        if (exitFill != 0 && exitQuote != 0) _fund(t.exit, oldExit, 0, 0, exitQuote);
        if (activeFill != 0 && activeQuote != 0) _fund(t.active, oldActive, 0, 0, activeQuote);
        t.workingSupply -= p.assetAmount;
        t.exitWorking -= exitFill;
        t.quoteEscrow -= p.quotePrincipal;
        t.exitQuoteReserve += exitQuote;
        t.activeQuoteReserve += activeQuote;
        if (exitFill != 0) _deplete(p.tickId, DomainKind.Exit, t.exit, oldExit, oldExit - exitFill);
        if (activeFill != 0) _deplete(p.tickId, DomainKind.Active, t.active, oldActive, oldActive - activeFill);
        p.status = Status.CLOSED;
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
        Position storage p = _positions[positionId];
        if (p.status != Status.ACTIVE) revert InvalidState();
        Tick storage t = _ticks[p.tickId];
        if (p.tickSeq != t.settleCursor) _settleOne(p.tickId, t);
        _close(positionId, p, t);
        if (p.tickSeq == t.settleCursor) t.settleCursor += 1;
    }
    function _collectPreview(ProviderPosition memory p) internal pure returns (CollectPreview memory q) {
        q.exitAsset = p.owedExitAsset;
        q.activeYieldAsset = p.owedActiveYieldAsset;
        q.exitYieldAsset = p.owedExitYieldAsset;
        q.exitQuote = p.owedExitQuote;
        q.activeQuote = p.owedActiveQuote;
        q.totalAssetOut = q.exitAsset + q.activeYieldAsset + q.exitYieldAsset;
        q.totalQuoteOut = q.exitQuote + q.activeQuote;
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION;
    }
    function collect(uint256 id) external nonReentrant returns (CollectPreview memory q) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        ProviderPosition storage p = _sync(id, msg.sender);
        q = _collectPreview(p);
        t.exitAssetReserve -= q.exitAsset;
        t.yieldAssetReserve -= q.activeYieldAsset + q.exitYieldAsset;
        t.exitQuoteReserve -= q.exitQuote;
        t.activeQuoteReserve -= q.activeQuote;
        p.owedExitAsset = 0;
        p.owedActiveYieldAsset = 0;
        p.owedExitYieldAsset = 0;
        p.owedExitQuote = 0;
        p.owedActiveQuote = 0;
        _pruneEarn(msg.sender, id);
        _push(IERC20(t.asset), msg.sender, q.totalAssetOut);
        _push(IERC20(t.quote), msg.sender, q.totalQuoteOut);
        _checkAsset(id, t);
        _checkQuote(id, t);
        emit Collected(
            id,
            msg.sender,
            q.exitAsset,
            q.activeYieldAsset,
            q.exitYieldAsset,
            q.exitQuote,
            q.activeQuote,
            q.totalAssetOut,
            q.totalQuoteOut
        );
    }

    function _projectTick(uint256 id, bool skipSettle) internal view returns (Projection memory v) {
        v.tick = _ticks[id];
        Tick memory t = v.tick;
        if (skipSettle || t.settleCursor == t.nextPositionSeq) return v;
        Position storage p = _positions[tickPositionId[id][t.settleCursor]];
        if (p.status != Status.ACTIVE) {
            v.tick.settleCursor += 1;
            return v;
        }
        if (block.timestamp < p.maturity) return v;
        uint256 proceeds = p.quotePrincipal - p.closeFee;
        uint256 exitFill = Math.min(p.assetAmount, t.exitWorking);
        uint256 activeFill = p.assetAmount - exitFill;
        uint256 exitQuote = Math.mulDiv(proceeds, exitFill, p.assetAmount);
        uint256 activeQuote = proceeds - exitQuote;
        uint256 oldExit = t.exitWorking;
        uint256 oldActive = _activePrincipal(t);
        if (exitFill != 0 && exitQuote != 0) _fundMemory(v.tick.exit, oldExit, 0, 0, exitQuote);
        if (activeFill != 0 && activeQuote != 0) _fundMemory(v.tick.active, oldActive, 0, 0, activeQuote);
        v.tick.workingSupply -= p.assetAmount;
        v.tick.exitWorking -= exitFill;
        v.tick.quoteEscrow -= p.quotePrincipal;
        v.tick.exitQuoteReserve += exitQuote;
        v.tick.activeQuoteReserve += activeQuote;
        if (exitFill != 0)
            (v.exitChanged, v.exitOverride, v.exitOldGeneration, v.exitOldScale) = _depleteMemory(
                v.tick.exit,
                oldExit,
                oldExit - exitFill
            );
        if (activeFill != 0)
            (v.activeChanged, v.activeOverride, v.activeOldGeneration, v.activeOldScale) = _depleteMemory(
                v.tick.active,
                oldActive,
                oldActive - activeFill
            );
        v.tick.settleCursor += 1;
    }
    function _previewProvider(
        uint256 id,
        address owner,
        Projection memory v
    ) internal view returns (ProviderPosition memory) {
        return _syncProvider(id, _providers[id][owner], v);
    }
    function getEarnPosition(address owner, uint256 id) external view returns (EarnPositionView memory q) {
        _requireTick(id);
        Projection memory v;
        v.tick = _ticks[id];
        ProviderPosition memory p = _previewProvider(id, owner, v);
        return _earnPosition(v.tick, p);
    }
    function _earnPosition(Tick memory t, ProviderPosition memory p) internal pure returns (EarnPositionView memory q) {
        q.activePrincipal = p.active.initialPrincipalX36 / PRINCIPAL_PRECISION;
        q.activePrincipalX36 = p.active.initialPrincipalX36;
        q.exitPrincipalX36 = p.exit.initialPrincipalX36;
        uint256 ca = _activePrincipal(t);
        if (ca != 0) q.activeAvailable = Math.mulDiv(q.activePrincipal, t.availableSupply, ca);
        q.activeWorking = q.activePrincipal - q.activeAvailable;
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION;
        q.claimableActiveYieldAsset = p.owedActiveYieldAsset;
        q.claimableExitAsset = p.owedExitAsset;
        q.claimableExitYieldAsset = p.owedExitYieldAsset;
        q.claimableActiveQuote = p.owedActiveQuote;
        q.claimableExitQuote = p.owedExitQuote;
    }
    struct SupplyPreview {
        uint256 resultingActivePrincipal;
        uint256 marketAvailable;
    }
    function previewSupply(uint256 id, uint256 assetAmount) external view returns (SupplyPreview memory q) {
        _requireTick(id);
        Projection memory v = _projectTick(id, false);
        if (assetAmount == 0) revert InvalidInput();
        _bound(assetAmount);
        _bound(_activePrincipal(v.tick) + assetAmount);
        ProviderPosition memory p = _previewProvider(id, msg.sender, v);
        q.resultingActivePrincipal =
            (p.active.initialPrincipalX36 + assetAmount * PRINCIPAL_PRECISION) / PRINCIPAL_PRECISION;
        q.marketAvailable = v.tick.availableSupply + assetAmount;
    }
    function previewWithdraw(
        uint256 id,
        address owner,
        uint256 principalAmount
    ) external view returns (WithdrawPreview memory q) {
        _requireTick(id);
        Projection memory v = _projectTick(id, false);
        ProviderPosition memory p = _previewProvider(id, owner, v);
        if (block.number <= p.lastSupplyBlock) revert Cooldown();
        q = _withdrawNumbers(v.tick, p.active.initialPrincipalX36, principalAmount);
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION + q.workingToExit;
    }
    function previewUse(uint256 id, uint256 amount) external view returns (UsePreview memory q) {
        _requireTick(id);
        Tick memory t = _projectTick(id, false).tick;
        SwapPreview memory s = _swapPreview(t, amount);
        uint256 wa = t.workingSupply - t.exitWorking;
        uint256 ca = _activePrincipal(t);
        q.assetAmount = amount;
        q.quotePrincipal = s.quotePrincipal;
        q.activeUtilizationBeforeX128 = Math.mulDiv(wa, Q128, ca);
        q.activeUtilizationAfterX128 = Math.mulDiv(wa + amount, Q128, ca);
        q.fullTermYieldAsset = _fullTermYield(t, amount);
        q.closeFee = s.swapFee;
        uint256 u2 = Math.mulDiv(q.activeUtilizationBeforeX128, q.activeUtilizationBeforeX128, Q128);
        uint256 u3 = Math.mulDiv(u2, q.activeUtilizationBeforeX128, Q128);
        q.dailyRateX128 = Math.mulDiv(MIN_DAILY_BPS * Q128 + (MAX_DAILY_BPS - MIN_DAILY_BPS) * u3, 1, BPS);
        q.maturity = _maturity(t);
    }
    function previewRepay(uint256 positionId) external view returns (RepayPreview memory) {
        Position memory p = _positions[positionId];
        if (p.status != Status.ACTIVE) revert InvalidState();
        Tick storage t = _ticks[p.tickId];
        Projection memory v = _projectTick(p.tickId, p.tickSeq == t.settleCursor);
        return _repayPreview(p, v.tick);
    }
    function previewSwap(uint256 id, uint256 amount) external view returns (SwapPreview memory) {
        _requireTick(id);
        return _swapPreview(_projectTick(id, false).tick, amount);
    }
    function previewCollect(uint256 id, address owner) external view returns (CollectPreview memory) {
        _requireTick(id);
        Projection memory v = _projectTick(id, false);
        return _collectPreview(_previewProvider(id, owner, v));
    }
}
