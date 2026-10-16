export const Duration = {
  Weekly: 7,
  Monthly: 30,
} as const;

export type Duration = (typeof Duration)[keyof typeof Duration];
export const DURATIONS = [Duration.Weekly, Duration.Monthly] as const;
export const DEFAULT_DURATION = Duration.Weekly;

export const DISCOVERY_DEFAULTS = {
  baseTick: 0,
  stepTicks: 1000,
  radius: 10,
} as const;
export const MAX_DISCOVERY_RADIUS = 128;
export const DISCOVERY_BATCH_SIZE = 100;
export const YIELD_BOOK_LAYOUT = { visibleRows: 5, rowHeightRem: 2.5 } as const;

export const PORTFOLIO_DEFAULTS = { offset: 0, limit: 24 } as const;
export const MAX_PORTFOLIO_PAGE_SIZE = 100;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const FIXED_POINT_BITS = 128n;
export const SQRT_RATIO_SHIFT = 32n;
export const PRICE_RATIO_SHIFT = 64n;
export const Q128 = 1n << FIXED_POINT_BITS;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_AMOUNT = 10n ** 30n;
export const MAX_DURATION_DAYS = 106751991167300n;
export const MAX_DECIMAL_INPUT_LENGTH = 512;
export const YIELD_CURVE = {
  exponent: 3n,
  weight: 99n,
  divisor: 100n,
} as const;

export const TOKEN_METADATA_LIMITS = {
  symbol: 32,
  name: 100,
  decimals: 255,
  tags: 6,
} as const;

export const MILLISECONDS_PER_SECOND = 1000;
export const QUERY_TIMING = {
  defaultStale: 15000,
  marketRefresh: 30000,
  liveRefresh: 15000,
  tokenMetadataStale: 3600000,
  deploymentStale: 60000,
} as const;
export const QUERY_RETRY_COUNT = 1;
export const RPC_TIMEOUT_MS = 15000;
export const RPC_RETRY_COUNT = 1;
export const SAFE_INFO_TIMEOUT_MS = 10000;
export const NETWORK_COOKIE_MAX_AGE_SECONDS = 31536000;
export const RECEIPT_TIMEOUT_MS = 0;
export const TRANSACTION_CONFIRMATIONS = 1;

export const BASIS_POINTS = 10000n;
export const PERCENT_SCALE = 100;
export const TRANSACTION_DEFAULTS = {
  toleranceBps: 50,
  maxToleranceBps: 1000,
  deadlineSeconds: 300n,
} as const;
export const WITHDRAW_PERCENTAGES = [25, 50, 75, PERCENT_SCALE] as const;

export const FORMAT_PRECISION = {
  ratio: 12,
  humanPrice: 12,
  yieldPercent: 4,
  amount: 6,
  largePrice: 2,
  price: 4,
  smallPrice: 8,
  smallPriceSignificant: 6,
} as const;
export const LARGE_PRICE_THRESHOLD = 1000n;
export const SHORT_ADDRESS = { prefix: 6, suffix: 4 } as const;
