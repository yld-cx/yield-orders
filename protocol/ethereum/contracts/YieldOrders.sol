// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./libraries/TickMath.sol";
import {ProductSumMath, Invariant} from "./libraries/ProductSumMath.sol";
import {YieldMath} from "./libraries/YieldMath.sol";

/// @notice yld.cx v0.3 exact-tick, fixed-term Product-Sum liquidity protocol.
contract YieldOrders is Multicall, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BPS = 10_000;
    uint256 public constant Q128 = 1 << 128;
    uint256 public constant PROTOCOL_FEE_BPS = 100;
    uint256 public constant MAX_ACCOUNTING_AMOUNT = 1e30;
    uint256 public constant PRINCIPAL_PRECISION = ProductSumMath.PRINCIPAL_PRECISION;
    uint256 public constant P_PRECISION = ProductSumMath.P_PRECISION;
    uint256 public constant SCALE_FACTOR = ProductSumMath.SCALE_FACTOR;
    uint256 public constant P_MIN = ProductSumMath.P_MIN;
    uint256 public constant MAX_SCALE_SPAN = ProductSumMath.MAX_SCALE_SPAN;
    uint256 public constant MAX_SCALE_JUMP = ProductSumMath.MAX_SCALE_JUMP;
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
        // Independent X36 sub-raw-unit entitlements for Active Yield/Quote and Exit Asset/Yield/Quote.
        uint256[5] fractionalGainX36;
        uint256 timestamp;
    }
    enum Status {
        INVALID,
        ACTIVE
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
    struct WithdrawPreview {
        uint256 providerPrincipal;
        uint256 principalAmount;
        uint256 availableAssetOut;
        uint256 workingToExit;
        uint256 remainingActivePrincipal;
        uint256 resolvingPrincipal;
        uint256 yieldAssetOut;
        uint256 unvestedYield;
    }
    struct RepayResult {
        uint256 positionId;
        uint256 tickId;
        uint64 tickSeq;
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
    struct CloseAmounts {
        uint256 quoteProceeds;
        uint256 exitFill;
        uint256 activeFill;
        uint256 exitQuote;
        uint256 activeQuote;
    }
    struct CloseResult {
        uint256 positionId;
        uint256 tickId;
        uint64 tickSeq;
        uint256 closeFee;
        uint256 providerSwapProceeds;
        uint256 exitFill;
        uint256 activeFill;
        uint256 exitQuote;
        uint256 activeQuote;
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
        uint256 outstandingActiveYieldAsset;
        uint256 outstandingExitYieldAsset;
        uint256 vestingRemainingSeconds;
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
        uint256 timestamp;
        uint256 vestingElapsedSeconds;
        uint256 vestingDurationSeconds;
        uint256 outstandingActiveYieldAsset;
        uint256 outstandingExitYieldAsset;
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
    mapping(uint256 => Pair) public pairs;
    mapping(uint256 => Position) private _positions;
    mapping(address => uint256) public tokenLiability;
    mapping(address => uint256) public accruedProtocolFees;
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
    mapping(uint256 => uint256) private _userPositionIndexPlusOne;
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
        uint256 workingToExit,
        uint256 yieldAssetOut,
        uint256 unvestedYield
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
        uint256 activeFill,
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
    event ProtocolFeesAccrued(address indexed token, uint256 amount);
    event ProtocolFeesCollected(address indexed token, uint256 amount);

    constructor(address feeTo) {
        if (feeTo == address(0) || feeTo == address(this)) {
            revert InvalidInput();
        }
        FEE_TO = feeTo;
    }

    // Pair identity, Tick configuration, pricing, and custody.
    function _pair(address a, address b) internal pure returns (uint256 id, address token0, address token1) {
        if (a == address(0) || b == address(0) || a == b) {
            revert InvalidInput();
        }
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
        if (pairs[id].exists) {
            revert AlreadyExists();
        }
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
        if (!p.exists) {
            revert NotFound();
        }
        if (
            direction > 1 ||
            priceTick < -887272 ||
            priceTick > 887272 ||
            durationDays == 0 ||
            durationDays > MAX_DURATION_DAYS
        ) revert InvalidInput();
        uint256 durationSeconds = uint256(durationDays) * SECONDS_PER_DAY;
        if (durationSeconds > MAX_TIMESTAMP) {
            revert InvalidInput();
        }
        id = uint256(keccak256(abi.encode(pairId, direction, priceTick, durationDays)));
        if (_ticks[id].exists) {
            revert AlreadyExists();
        }
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
        if (!t.exists) {
            revert NotFound();
        }
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
        if (amount > MAX_ACCOUNTING_AMOUNT) {
            revert InvalidInput();
        }
    }
    function _activePrincipal(Tick memory t) internal pure returns (uint256) {
        return t.availableSupply + t.workingSupply - t.exitWorking;
    }
    function _quote(Tick memory t, uint256 x) internal pure returns (uint256 q) {
        q = Math.mulDiv(x, t.priceX128, Q128, Math.Rounding.Ceil);
        if (q == 0) {
            revert InvalidInput();
        }
        _bound(q);
    }
    function _fullTermYield(Tick memory t, uint256 assetAmount) internal pure returns (uint256 result) {
        if (assetAmount == 0 || assetAmount > t.availableSupply) {
            revert InsufficientLiquidity();
        }
        result = YieldMath.fullTermYield(
            t.availableSupply,
            t.workingSupply - t.exitWorking,
            t.durationDays,
            assetAmount
        );
        if (result == 0) {
            revert InvalidInput();
        }
        _bound(result);
    }
    function _swapAmounts(Tick memory t, uint256 x) internal pure returns (SwapPreview memory q) {
        if (x == 0 || x > t.availableSupply) {
            revert InsufficientLiquidity();
        }
        _bound(x);
        q.assetAmount = x;
        q.quotePrincipal = _quote(t, x);
        q.swapFee = Math.mulDiv(q.quotePrincipal, PROTOCOL_FEE_BPS, BPS);
        // The fixed fee is at most the quoted principal.
        {
            q.providerSwapProceeds = q.quotePrincipal - q.swapFee;
        }
    }
    function _maturity(Tick memory t) internal view returns (uint256 maturity) {
        if (block.timestamp > MAX_TIMESTAMP) {
            revert InvalidInput();
        }
        uint256 duration = uint256(t.durationDays) * SECONDS_PER_DAY;
        maturity = block.timestamp + duration;
        if (maturity > MAX_TIMESTAMP) {
            revert InvalidInput();
        }
    }
    function _reconcileLiability(address token, uint256 previous, uint256 current) internal {
        uint256 total = tokenLiability[token];
        total = current >= previous ? total + (current - previous) : total - (previous - current);
        tokenLiability[token] = total;
        if (IERC20(token).balanceOf(address(this)) < total) {
            revert Invariant();
        }
    }
    function _accrueFee(address token, uint256 amount) internal {
        accruedProtocolFees[token] += amount;
        tokenLiability[token] += amount;
        emit ProtocolFeesAccrued(token, amount);
    }
    function collectProtocolFees(address token) external nonReentrant returns (uint256 amount) {
        amount = accruedProtocolFees[token];
        accruedProtocolFees[token] = 0;
        tokenLiability[token] -= amount;
        _push(IERC20(token), FEE_TO, amount);
        _reconcileLiability(token, 0, 0);
        emit ProtocolFeesCollected(token, amount);
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
        if (token.balanceOf(address(this)) - beforeBalance != amount) {
            revert UnsupportedToken();
        }
    }
    function _push(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0) {
            return;
        }
        uint256 beforeFrom = token.balanceOf(address(this));
        uint256 beforeTo = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforeFrom - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeTo != amount) {
            revert UnsupportedToken();
        }
    }

    // Product-Sum storage and historical-scale access. Pure arithmetic lives in ProductSumMath.
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
        if (principal == 0) {
            revert Invariant();
        }
        _bound(assetGain);
        _bound(yieldGain);
        _bound(quoteGain);
        if (assetGain != 0) {
            d.assetSum += ProductSumMath.fundingDelta(assetGain, d.P, principal);
        }
        if (yieldGain != 0) {
            d.yieldSum += ProductSumMath.fundingDelta(yieldGain, d.P, principal);
        }
        if (quoteGain != 0) {
            d.quoteSum += ProductSumMath.fundingDelta(quoteGain, d.P, principal);
        }
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
        (uint256 newP, uint64 jump) = ProductSumMath.depletedProduct(d.P, beforePrincipal, afterPrincipal);
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
    function _scaleValue(
        uint256 id,
        DomainKind kind,
        uint64 generation,
        uint64 scale
    ) internal view returns (ScaleSums memory) {
        Domain storage d = kind == DomainKind.Active ? _ticks[id].active : _ticks[id].exit;
        if (generation == d.generation && scale == d.scale) {
            return ScaleSums(d.assetSum, d.yieldSum, d.quoteSum, false);
        }
        return scaleSums[id][uint8(kind)][generation][scale];
    }
    function _endScale(uint256 id, DomainKind kind, uint64 generation) internal view returns (uint64) {
        Domain storage d = kind == DomainKind.Active ? _ticks[id].active : _ticks[id].exit;
        if (generation == d.generation) return d.scale;
        GenerationMeta memory m = generationMeta[id][uint8(kind)][generation];
        if (!m.finalized) revert Invariant();
        return m.finalScale;
    }
    function _sumField(ScaleSums memory s, uint8 stream) internal pure returns (uint256) {
        if (stream == 0) {
            return s.assetSum;
        }
        if (stream == 1) {
            return s.yieldSum;
        }
        return s.quoteSum;
    }
    /// @dev Reads current and persisted historical scale sums.
    function _accrued(
        uint256 id,
        DomainKind kind,
        Snapshot memory snap,
        uint8 stream
    ) internal view returns (uint256 gain) {
        if (snap.initialPrincipalX36 == 0) {
            return 0;
        }
        uint64 finalScale = _endScale(id, kind, snap.generation);
        if (finalScale < snap.scale) {
            revert Invariant();
        }
        uint256 span = Math.min(MAX_SCALE_SPAN, uint256(finalScale - snap.scale));
        uint256[9] memory scaleDeltas;
        uint256 currentSum = _sumField(_scaleValue(id, kind, snap.generation, snap.scale), stream);
        uint256 checkpoint =
            stream == 0
                ? snap.assetSum
                : stream == 1
                    ? snap.yieldSum
                    : snap.quoteSum;
        scaleDeltas[0] = currentSum - checkpoint;
        for (uint256 i = 1; i <= span; ++i) {
            scaleDeltas[i] = _sumField(_scaleValue(id, kind, snap.generation, snap.scale + uint64(i)), stream);
        }
        gain = ProductSumMath.accruedGainX36(snap.initialPrincipalX36, snap.P, span, scaleDeltas);
    }
    // Provider checkpoints and realized claims remain under protocol storage control.
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
        uint256 tickId,
        ProviderPosition memory position,
        Tick memory tick
    ) internal view returns (ProviderPosition memory) {
        for (uint8 domainIndex = 0; domainIndex < 2; ++domainIndex) {
            bool isActive = domainIndex == 0;
            Snapshot memory snapshot = isActive ? position.active : position.exit;
            if (snapshot.initialPrincipalX36 == 0) {
                continue;
            }
            DomainKind domainKind = DomainKind(domainIndex);
            for (uint8 streamIndex = 0; streamIndex < 3; ++streamIndex) {
                if (isActive && streamIndex == 0) {
                    continue;
                }
                uint256 fractionIndex = isActive ? streamIndex - 1 : streamIndex + 2;
                uint256 accruedX36 = _accrued(tickId, domainKind, snapshot, streamIndex);
                uint256 combinedX36 = position.fractionalGainX36[fractionIndex] + accruedX36;
                uint256 gain = combinedX36 / PRINCIPAL_PRECISION;
                position.fractionalGainX36[fractionIndex] = combinedX36 % PRINCIPAL_PRECISION;
                if (isActive) {
                    if (streamIndex == 1) {
                        position.owedActiveYieldAsset += gain;
                    } else {
                        position.owedActiveQuote += gain;
                    }
                } else {
                    if (streamIndex == 0) {
                        position.owedExitAsset += gain;
                    } else if (streamIndex == 1) {
                        position.owedExitYieldAsset += gain;
                    } else {
                        position.owedExitQuote += gain;
                    }
                }
            }
            Domain memory currentDomain = isActive ? tick.active : tick.exit;
            _snapshot(
                snapshot,
                currentDomain,
                ProductSumMath.principalX36(
                    snapshot.initialPrincipalX36,
                    snapshot.generation,
                    snapshot.scale,
                    snapshot.P,
                    currentDomain.generation,
                    currentDomain.scale,
                    currentDomain.P
                )
            );
        }
        return position;
    }
    function _sync(uint256 id, address owner) internal returns (ProviderPosition storage ps) {
        _providers[id][owner] = _syncProvider(id, _providers[id][owner], _ticks[id]);
        return _providers[id][owner];
    }
    function _addEarn(address owner, uint256 id) internal {
        if (_earnIndexPlusOne[owner][id] != 0) {
            return;
        }
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
            p.owedExitQuote != 0 ||
            p.fractionalGainX36[0] != 0 ||
            p.fractionalGainX36[1] != 0 ||
            p.fractionalGainX36[2] != 0 ||
            p.fractionalGainX36[3] != 0 ||
            p.fractionalGainX36[4] != 0
        ) {
            return;
        }
        uint256 slot = _earnIndexPlusOne[owner][id];
        if (slot == 0) {
            return;
        }
        uint256[] storage list = _userEarnTicks[owner];
        uint256 last = list[list.length - 1];
        list[slot - 1] = last;
        _earnIndexPlusOne[owner][last] = slot;
        list.pop();
        delete _earnIndexPlusOne[owner][id];
    }
    function _page(uint256[] storage list, uint256 offset, uint256 limit) internal view returns (uint256[] memory out) {
        if (offset >= list.length) {
            return new uint256[](0);
        }
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
        if (_positions[id].status != Status.ACTIVE) revert NotFound();
        return _positions[id];
    }
    function _addUsePosition(address owner, uint256 positionId) internal {
        _userPositions[owner].push(positionId);
        _userPositionIndexPlusOne[positionId] = _userPositions[owner].length;
    }
    function _removeUsePosition(address owner, uint256 positionId) internal {
        uint256 indexPlusOne = _userPositionIndexPlusOne[positionId];
        if (indexPlusOne == 0) revert Invariant();
        uint256[] storage list = _userPositions[owner];
        uint256 last = list[list.length - 1];
        list[indexPlusOne - 1] = last;
        _userPositionIndexPlusOne[last] = indexPlusOne;
        list.pop();
        delete _userPositionIndexPlusOne[positionId];
    }
    function _removePosition(uint256 positionId, Position memory p) internal {
        _removeUsePosition(p.user, positionId);
        delete tickPositionId[p.tickId][p.tickSeq];
        delete _positions[positionId];
    }

    // Economic actions execute at most one settlement-cursor step.
    function _settleOne(uint256 id, Tick storage t) internal {
        if (t.settleCursor == t.nextPositionSeq) {
            return;
        }
        uint256 positionId = tickPositionId[id][t.settleCursor];
        if (positionId == 0) {
            t.settleCursor += 1;
            return;
        }
        Position storage p = _positions[positionId];
        if (p.status != Status.ACTIVE) revert Invariant();
        if (block.timestamp < p.maturity) {
            return;
        }
        _close(positionId, p, t);
        t.settleCursor += 1;
    }
    function settle(uint256 id) external nonReentrant {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
    }

    function supply(uint256 id, uint256 assetAmount, address referrer) external nonReentrant {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        if (assetAmount == 0) {
            revert InvalidInput();
        }
        _bound(assetAmount);
        uint256 activePrincipalBefore = t.availableSupply + t.workingSupply - t.exitWorking;
        _bound(activePrincipalBefore + assetAmount);
        ProviderPosition storage p = _sync(id, msg.sender);
        uint256 principalX36 = p.active.initialPrincipalX36 + assetAmount * PRINCIPAL_PRECISION;
        if (principalX36 > MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION) {
            revert InvalidInput();
        }
        _pull(IERC20(t.asset), msg.sender, assetAmount);
        t.availableSupply += assetAmount;
        _snapshotStorage(p.active, t.active, principalX36);
        p.timestamp = block.timestamp;
        _addEarn(msg.sender, id);
        _checkAsset(id, t);
        emit Supplied(id, msg.sender, assetAmount, referrer);
    }
    // Provider vesting, withdrawal allocation, and collection.
    function _withdrawNumbers(
        Tick memory t,
        uint256 principalX36,
        uint256 requested
    ) internal pure returns (WithdrawPreview memory q) {
        if (requested == 0) {
            revert InvalidInput();
        }
        q.providerPrincipal = principalX36 / PRINCIPAL_PRECISION;
        q.principalAmount = Math.min(requested, q.providerPrincipal);
        if (q.principalAmount == 0 || principalX36 == 0) {
            revert InvalidInput();
        }
        uint256 activePrincipal = _activePrincipal(t);
        if (activePrincipal == 0) {
            revert Invariant();
        }
        // Both raw amounts are bounded by 1e30, so their product fits uint256.
        {
            q.availableAssetOut = (q.principalAmount * t.availableSupply) / activePrincipal;
        }
        // The proportional Available part cannot exceed the withdrawn principal.
        {
            q.workingToExit = q.principalAmount - q.availableAssetOut;
        }
        if (q.workingToExit > t.workingSupply - t.exitWorking) {
            revert Invariant();
        }
        _bound(t.exitWorking + q.workingToExit);
        // principalAmount <= floor(principalX36 / X36), so subtraction cannot underflow.
        {
            q.remainingActivePrincipal = (principalX36 - q.principalAmount * PRINCIPAL_PRECISION) / PRINCIPAL_PRECISION;
        }
    }
    function _vesting(Tick memory t, uint256 timestamp) internal view returns (uint256 elapsed, uint256 duration) {
        // Valid Tick duration is below MAX_TIMESTAMP; EVM block time never precedes a stored provider timestamp.
        {
            duration = uint256(t.durationDays) * SECONDS_PER_DAY;
            elapsed = Math.min(block.timestamp - timestamp, duration);
        }
    }
    function _withdrawYield(Tick memory t, ProviderPosition memory p, WithdrawPreview memory q) internal view {
        uint256 withdrawnX36;
        // The whole-raw withdrawal is bounded by 1e30, so its X36 conversion fits uint256.
        {
            withdrawnX36 = q.principalAmount * PRINCIPAL_PRECISION;
        }
        uint256 yieldForWithdraw = Math.mulDiv(p.owedActiveYieldAsset, withdrawnX36, p.active.initialPrincipalX36);
        (uint256 elapsed, uint256 duration) = _vesting(t, p.timestamp);
        q.yieldAssetOut = Math.mulDiv(yieldForWithdraw, elapsed, duration);
        // elapsed <= duration, hence the vested amount cannot exceed its attributable Yield.
        {
            q.unvestedYield = yieldForWithdraw - q.yieldAssetOut;
        }
    }
    function withdraw(
        uint256 id,
        uint256 principalAmount,
        uint256 minImmediateAssetOut,
        uint256 deadline
    ) external nonReentrant returns (WithdrawPreview memory q) {
        if (block.timestamp > deadline) revert Expired();
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        ProviderPosition storage p = _sync(id, msg.sender);
        if (block.timestamp <= p.timestamp) {
            revert Cooldown();
        }
        Tick memory tm = t;
        q = _withdrawNumbers(tm, p.active.initialPrincipalX36, principalAmount);
        _withdrawYield(tm, p, q);
        if (q.availableAssetOut < minImmediateAssetOut) revert Slippage();
        // These two outputs partition yieldForWithdraw, which is at most the synced owed balance.
        {
            p.owedActiveYieldAsset -= q.yieldAssetOut + q.unvestedYield;
        }
        t.availableSupply -= q.availableAssetOut;
        t.exitWorking += q.workingToExit;
        _snapshotStorage(p.active, t.active, p.active.initialPrincipalX36 - q.principalAmount * PRINCIPAL_PRECISION);
        if (q.workingToExit != 0) {
            uint256 exitX36 = p.exit.initialPrincipalX36 + q.workingToExit * PRINCIPAL_PRECISION;
            if (exitX36 > MAX_ACCOUNTING_AMOUNT * PRINCIPAL_PRECISION) {
                revert InvalidInput();
            }
            _snapshotStorage(p.exit, t.exit, exitX36);
        }
        if (t.availableSupply + t.workingSupply == t.exitWorking) {
            _deplete(id, DomainKind.Active, t.active, _activePrincipal(tm), 0);
        }
        if (q.unvestedYield != 0) {
            t.yieldAssetReserve -= q.unvestedYield;
            _accrueFee(t.asset, q.unvestedYield);
        }
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION;
        t.yieldAssetReserve -= q.yieldAssetOut;
        _push(IERC20(t.asset), msg.sender, q.availableAssetOut + q.yieldAssetOut);
        _pruneEarn(msg.sender, id);
        _checkAsset(id, t);
        emit Withdrawn(
            id,
            msg.sender,
            q.principalAmount,
            q.availableAssetOut,
            q.workingToExit,
            q.yieldAssetOut,
            q.unvestedYield
        );
    }
    function _collectAmounts(Tick memory t, ProviderPosition memory p) internal view returns (CollectPreview memory q) {
        (uint256 elapsed, uint256 duration) = _vesting(t, p.timestamp);
        q.exitAsset = p.owedExitAsset;
        q.activeYieldAsset = Math.mulDiv(p.owedActiveYieldAsset, elapsed, duration);
        q.exitYieldAsset = Math.mulDiv(p.owedExitYieldAsset, elapsed, duration);
        q.exitQuote = p.owedExitQuote;
        q.activeQuote = p.owedActiveQuote;
        q.totalAssetOut = q.exitAsset + q.activeYieldAsset + q.exitYieldAsset;
        q.totalQuoteOut = q.exitQuote + q.activeQuote;
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION;
        // The vesting fraction is at most one for each independent Yield balance.
        {
            q.outstandingActiveYieldAsset = p.owedActiveYieldAsset - q.activeYieldAsset;
            q.outstandingExitYieldAsset = p.owedExitYieldAsset - q.exitYieldAsset;
        }
        q.vestingRemainingSeconds = (q.outstandingActiveYieldAsset | q.outstandingExitYieldAsset) == 0 ? 0 : duration;
    }
    function collect(uint256 id) external nonReentrant returns (CollectPreview memory q) {
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        ProviderPosition storage p = _sync(id, msg.sender);
        q = _collectAmounts(t, p);
        t.exitAssetReserve -= q.exitAsset;
        t.yieldAssetReserve -= q.activeYieldAsset + q.exitYieldAsset;
        t.exitQuoteReserve -= q.exitQuote;
        t.activeQuoteReserve -= q.activeQuote;
        p.owedExitAsset = 0;
        // Collect deducts only the vested portions, each no greater than its owed balance.
        {
            p.owedActiveYieldAsset -= q.activeYieldAsset;
            p.owedExitYieldAsset -= q.exitYieldAsset;
        }
        p.owedExitQuote = 0;
        p.owedActiveQuote = 0;
        p.timestamp = block.timestamp;
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

    // Taker term and immediate-swap actions.
    function use(
        uint256 id,
        uint256 assetAmount,
        uint256 maxFullTermYieldAsset,
        uint256 deadline,
        address referrer
    ) external nonReentrant returns (uint256 positionId) {
        if (assetAmount == 0) revert InvalidInput();
        Tick storage t = _requireTick(id);
        _settleOne(id, t);
        if (block.timestamp > deadline) {
            revert Expired();
        }
        Tick memory tm = t;
        SwapPreview memory q = _swapAmounts(tm, assetAmount);
        uint256 fullYield = _fullTermYield(tm, assetAmount);
        if (fullYield > maxFullTermYieldAsset) {
            revert Slippage();
        }
        uint256 maturity = _maturity(tm);
        // Full precision mulDiv makes every 1..termSeconds elapsed quote representable.
        if (assetAmount > type(uint256).max - fullYield) {
            revert InvalidInput();
        }
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
        _addUsePosition(msg.sender, positionId);
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
    function _repayAmounts(Position memory p, Tick memory t) internal view returns (RepayResult memory q) {
        if (p.status != Status.ACTIVE || block.timestamp >= p.maturity) {
            revert InvalidState();
        }
        q.assetPrincipal = p.assetAmount;
        uint256 elapsed = block.timestamp - p.openedAt;
        uint256 termSeconds = p.maturity - p.openedAt;
        // Full-term Yield is at most 1e30, elapsed <= termSeconds <= MAX_TIMESTAMP,
        // and the rounding numerator is therefore far below uint256.max.
        {
            q.grossYieldAsset = YieldMath.accruedRepayYield(p.fullTermYieldAsset, elapsed, termSeconds);
        }
        if (q.grossYieldAsset == 0 || q.grossYieldAsset > p.fullTermYieldAsset) {
            revert Invariant();
        }
        _bound(q.grossYieldAsset);
        q.yieldFeeAsset = Math.mulDiv(q.grossYieldAsset, PROTOCOL_FEE_BPS, BPS);
        q.totalAssetIn = q.assetPrincipal + q.grossYieldAsset;
        q.exitFill = Math.min(p.assetAmount, t.exitWorking);
        uint256 netYield;
        // exitFill <= assetAmount and the 1% fee <= gross Yield.
        {
            q.activeReturn = p.assetAmount - q.exitFill;
            netYield = q.grossYieldAsset - q.yieldFeeAsset;
        }
        // Both factors are at most 1e30, so their product fits uint256.
        {
            q.exitYieldAsset = (netYield * q.exitFill) / p.assetAmount;
        }
        // The Exit allocation cannot exceed the net funded Yield.
        {
            q.activeYieldAsset = netYield - q.exitYieldAsset;
        }
        q.quotePrincipalUnlocked = p.quotePrincipal;
    }
    function repay(uint256 positionId, uint256 maxYieldAsset) external nonReentrant returns (RepayResult memory q) {
        Position storage p = _positions[positionId];
        if (p.status != Status.ACTIVE) {
            revert InvalidState();
        }
        Tick storage t = _ticks[p.tickId];
        bool cursorTarget = p.tickSeq == t.settleCursor;
        if (!cursorTarget) {
            _settleOne(p.tickId, t);
        }
        if (p.user != msg.sender) {
            revert Unauthorized();
        }
        Tick memory tm = t;
        Position memory pm = p;
        q = _repayAmounts(pm, tm);
        q.positionId = positionId;
        q.tickId = pm.tickId;
        q.tickSeq = pm.tickSeq;
        if (q.grossYieldAsset > maxYieldAsset) {
            revert Slippage();
        }
        uint256 oldExit = t.exitWorking;
        uint256 oldActive = _activePrincipal(tm);
        _pull(IERC20(t.asset), msg.sender, q.totalAssetIn);
        if (q.exitFill != 0) {
            _fund(t.exit, oldExit, q.exitFill, q.exitYieldAsset, 0);
        }
        if (q.activeYieldAsset != 0) {
            _fund(t.active, oldActive, 0, q.activeYieldAsset, 0);
        }
        t.workingSupply -= pm.assetAmount;
        t.exitWorking -= q.exitFill;
        t.availableSupply += q.activeReturn;
        t.exitAssetReserve += q.exitFill;
        t.yieldAssetReserve += q.grossYieldAsset - q.yieldFeeAsset;
        t.quoteEscrow -= pm.quotePrincipal;
        if (q.exitFill != 0) {
            _deplete(pm.tickId, DomainKind.Exit, t.exit, oldExit, t.exitWorking);
        }
        _accrueFee(t.asset, q.yieldFeeAsset);
        _push(IERC20(t.quote), msg.sender, pm.quotePrincipal);
        _checkAsset(pm.tickId, t);
        _checkQuote(pm.tickId, t);
        emit TermRepaid(
            positionId,
            pm.tickId,
            pm.tickSeq,
            pm.user,
            pm.assetAmount,
            pm.quotePrincipal,
            q.grossYieldAsset,
            q.yieldFeeAsset,
            q.exitFill,
            q.activeReturn,
            q.exitYieldAsset,
            q.activeYieldAsset
        );
        _removePosition(positionId, pm);
        if (cursorTarget) t.settleCursor += 1;
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
        if (block.timestamp > deadline) {
            revert Expired();
        }
        Tick memory tm = t;
        q = _swapAmounts(tm, assetAmount);
        if (q.quotePrincipal > maxQuoteIn) {
            revert Slippage();
        }
        uint256 oldActive = _activePrincipal(tm);
        _pull(IERC20(t.quote), msg.sender, q.quotePrincipal);
        _fund(t.active, oldActive, 0, 0, q.providerSwapProceeds);
        t.availableSupply -= assetAmount;
        t.activeQuoteReserve += q.providerSwapProceeds;
        _deplete(id, DomainKind.Active, t.active, oldActive, oldActive - assetAmount);
        _accrueFee(t.quote, q.swapFee);
        _push(IERC20(t.asset), msg.sender, assetAmount);
        _checkAsset(id, t);
        _checkQuote(id, t);
        emit ImmediateSwap(id, msg.sender, assetAmount, q.quotePrincipal, q.swapFee, q.providerSwapProceeds, referrer);
    }
    /// @dev Shared by direct and automatic Close execution.
    function _closeAmounts(
        uint256 assetAmount,
        uint256 quotePrincipal,
        uint256 closeFee,
        uint256 exitWorking
    ) internal pure returns (CloseAmounts memory amounts) {
        amounts.quoteProceeds = quotePrincipal - closeFee;
        amounts.exitFill = Math.min(assetAmount, exitWorking);
        amounts.activeFill = assetAmount - amounts.exitFill;
        // Both factors are at most 1e30, so their product fits uint256.
        {
            amounts.exitQuote = (amounts.quoteProceeds * amounts.exitFill) / assetAmount;
        }
        amounts.activeQuote = amounts.quoteProceeds - amounts.exitQuote;
    }
    function _close(uint256 positionId, Position storage p, Tick storage t) internal returns (CloseResult memory q) {
        if (p.status != Status.ACTIVE || block.timestamp < p.maturity) {
            revert InvalidState();
        }
        Position memory pm = p;
        CloseAmounts memory amounts = _closeAmounts(pm.assetAmount, pm.quotePrincipal, pm.closeFee, t.exitWorking);
        q = CloseResult(
            positionId,
            pm.tickId,
            pm.tickSeq,
            pm.closeFee,
            amounts.quoteProceeds,
            amounts.exitFill,
            amounts.activeFill,
            amounts.exitQuote,
            amounts.activeQuote
        );
        uint256 oldExit = t.exitWorking;
        uint256 oldActive = t.availableSupply + t.workingSupply - oldExit;
        if (amounts.exitFill != 0 && amounts.exitQuote != 0) {
            _fund(t.exit, oldExit, 0, 0, amounts.exitQuote);
        }
        if (amounts.activeFill != 0 && amounts.activeQuote != 0) {
            _fund(t.active, oldActive, 0, 0, amounts.activeQuote);
        }
        t.workingSupply -= pm.assetAmount;
        t.exitWorking -= amounts.exitFill;
        t.quoteEscrow -= pm.quotePrincipal;
        t.exitQuoteReserve += amounts.exitQuote;
        t.activeQuoteReserve += amounts.activeQuote;
        if (amounts.exitFill != 0) {
            _deplete(pm.tickId, DomainKind.Exit, t.exit, oldExit, oldExit - amounts.exitFill);
        }
        if (amounts.activeFill != 0) {
            _deplete(pm.tickId, DomainKind.Active, t.active, oldActive, oldActive - amounts.activeFill);
        }
        _accrueFee(t.quote, pm.closeFee);
        _checkAsset(pm.tickId, t);
        _checkQuote(pm.tickId, t);
        emit TermClosed(
            positionId,
            pm.tickId,
            pm.tickSeq,
            pm.user,
            msg.sender,
            pm.assetAmount,
            pm.quotePrincipal,
            pm.closeFee,
            amounts.quoteProceeds,
            amounts.exitFill,
            amounts.activeFill,
            amounts.exitQuote,
            amounts.activeQuote
        );
        _removePosition(positionId, pm);
    }
    function close(uint256 positionId) external nonReentrant returns (CloseResult memory q) {
        Position storage p = _positions[positionId];
        if (p.status != Status.ACTIVE) {
            revert InvalidState();
        }
        Tick storage t = _ticks[p.tickId];
        bool cursorTarget = p.tickSeq == t.settleCursor;
        if (!cursorTarget) {
            _settleOne(p.tickId, t);
        }
        q = _close(positionId, p, t);
        if (cursorTarget) t.settleCursor += 1;
    }
    function getEarnPosition(address owner, uint256 id) external view returns (EarnPositionView memory q) {
        _requireTick(id);
        Tick memory tick = _ticks[id];
        ProviderPosition memory p = _syncProvider(id, _providers[id][owner], tick);
        return _earnPosition(tick, p);
    }
    function _earnPosition(Tick memory t, ProviderPosition memory p) internal view returns (EarnPositionView memory q) {
        q.activePrincipal = p.active.initialPrincipalX36 / PRINCIPAL_PRECISION;
        q.activePrincipalX36 = p.active.initialPrincipalX36;
        q.exitPrincipalX36 = p.exit.initialPrincipalX36;
        uint256 activePrincipal = _activePrincipal(t);
        if (activePrincipal != 0) {
            // Both raw amounts are bounded by 1e30, so their product fits uint256.
            {
                q.activeAvailable = (q.activePrincipal * t.availableSupply) / activePrincipal;
            }
        }
        // The Available fraction cannot exceed the provider's Active principal.
        {
            q.activeWorking = q.activePrincipal - q.activeAvailable;
        }
        q.resolvingPrincipal = p.exit.initialPrincipalX36 / PRINCIPAL_PRECISION;
        (q.vestingElapsedSeconds, q.vestingDurationSeconds) = _vesting(t, p.timestamp);
        q.timestamp = p.timestamp;
        q.outstandingActiveYieldAsset = p.owedActiveYieldAsset;
        q.outstandingExitYieldAsset = p.owedExitYieldAsset;
        q.claimableActiveYieldAsset = Math.mulDiv(
            p.owedActiveYieldAsset,
            q.vestingElapsedSeconds,
            q.vestingDurationSeconds
        );
        q.claimableExitAsset = p.owedExitAsset;
        q.claimableExitYieldAsset = Math.mulDiv(
            p.owedExitYieldAsset,
            q.vestingElapsedSeconds,
            q.vestingDurationSeconds
        );
        q.claimableActiveQuote = p.owedActiveQuote;
        q.claimableExitQuote = p.owedExitQuote;
    }
    /// @notice A current-state, pre-approval Use quote. Execution can differ after settlement or market changes.
    function quoteUse(
        uint256 id,
        uint256 assetAmount
    ) external view returns (uint256 quotePrincipal, uint256 fullTermYieldAsset) {
        Tick memory t = _requireTick(id);
        quotePrincipal = _quote(t, assetAmount);
        fullTermYieldAsset = _fullTermYield(t, assetAmount);
    }
}
