/**
 * Plain-data types for the Suilend adapter.
 *
 * Why structural "Raw*" types: @suilend/sdk 14's .d.ts files use extensionless
 * relative imports, which do not resolve under this repo's NodeNext module
 * resolution, so most SDK struct types (LendingMarket, Reserve, Obligation)
 * degrade to `any`. The shapes below mirror the generated BCS structs
 * (node_modules/@suilend/sdk/_generated/suilend/{reserve,obligation,
 * liquidity-mining,rate-limiter}/structs.d.ts: u64 -> bigint, u8 -> number,
 * TypeName/ID/UID -> string, Option<T> -> T | null, Decimal -> { value: WAD
 * bigint }) for exactly the fields this adapter reads. The real SDK objects
 * satisfy them at runtime.
 */
import type { AssetRef, Logger } from "@incentive-router/live-common";
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";

// ---------------------------------------------------------------------------
// Raw on-chain shapes (subset)
// ---------------------------------------------------------------------------

export interface RawDecimal {
  /** WAD (1e18) scaled. */
  value: bigint;
}

export interface RawReserveConfig {
  openLtvPct: number;
  closeLtvPct: number;
  maxCloseLtvPct: number;
  borrowWeightBps: bigint;
  depositLimit: bigint;
  borrowLimit: bigint;
  depositLimitUsd: bigint;
  borrowLimitUsd: bigint;
  /** Utilization points, percent (u8). */
  interestRateUtils: number[];
  /** Borrow APR at each point, in bps (u64). */
  interestRateAprs: bigint[];
  borrowFeeBps: bigint;
  spreadFeeBps: bigint;
  isolated: boolean;
  additionalFields: { id: string; size: bigint };
}

export interface RawPoolReward {
  id: string;
  poolRewardManagerId: string;
  coinType: string;
  startTimeMs: bigint;
  endTimeMs: bigint;
  /** Base units of the reward coin. */
  totalRewards: bigint;
  allocatedRewards: RawDecimal;
  cumulativeRewardsPerShare: RawDecimal;
  numUserRewardManagers: bigint;
}

export interface RawPoolRewardManager {
  id: string;
  totalShares: bigint;
  poolRewards: (RawPoolReward | null)[];
  lastUpdateTimeMs: bigint;
}

export interface RawReserve {
  id: string;
  arrayIndex: bigint;
  /** On-chain TypeName string (no 0x prefix) — always normalize before comparing. */
  coinType: string;
  config: { element: RawReserveConfig | null };
  mintDecimals: number;
  priceIdentifier: { bytes: number[] };
  price: RawDecimal;
  smoothedPrice: RawDecimal;
  priceLastUpdateTimestampS: bigint;
  availableAmount: bigint;
  ctokenSupply: bigint;
  borrowedAmount: RawDecimal;
  cumulativeBorrowRate: RawDecimal;
  interestLastUpdateTimestampS: bigint;
  unclaimedSpreadFees: RawDecimal;
  depositsPoolRewardManager: RawPoolRewardManager;
  borrowsPoolRewardManager: RawPoolRewardManager;
}

export interface RawRateLimiter {
  config: { windowDuration: bigint; maxOutflow: bigint };
  prevQty: RawDecimal;
  windowStart: bigint;
  curQty: RawDecimal;
}

export interface RawLendingMarket {
  id: string;
  version: bigint;
  reserves: RawReserve[];
  rateLimiter: RawRateLimiter;
  $typeArgs: string[];
}

export interface RawUserReward {
  poolRewardId: string;
  earnedRewards: RawDecimal;
  cumulativeRewardsPerShare: RawDecimal;
}

export interface RawUserRewardManager {
  poolRewardManagerId: string;
  share: bigint;
  rewards: (RawUserReward | null)[];
  lastUpdateTimeMs: bigint;
}

export interface RawDeposit {
  coinType: string;
  reserveArrayIndex: bigint;
  depositedCtokenAmount: bigint;
  userRewardManagerIndex: bigint;
}

export interface RawBorrow {
  coinType: string;
  reserveArrayIndex: bigint;
  borrowedAmount: RawDecimal;
  cumulativeBorrowRate: RawDecimal;
  userRewardManagerIndex: bigint;
}

export interface RawObligation {
  id: string;
  lendingMarketId: string;
  deposits: RawDeposit[];
  borrows: RawBorrow[];
  userRewardManagers: RawUserRewardManager[];
}

// ---------------------------------------------------------------------------
// Derived, protocol-normalised snapshots (pure data, what the pure helpers use)
// ---------------------------------------------------------------------------

export interface PoolRewardSnapshot {
  /** Normalized reward coin type. */
  coinType: string;
  /** Index in the pool reward manager's vector (needed to claim). */
  rewardIndex: number;
  startMs: number;
  endMs: number;
  /** Base units of the reward coin over [startMs, endMs). */
  totalRewards: bigint;
}

export interface ReserveSnapshot {
  /** Normalized coin type (0x… long form). */
  coinType: string;
  arrayIndex: bigint;
  decimals: number;
  /** Spot oracle price (USD) stored on-chain (or refreshed from a feed). */
  price: number;
  /** Lower / upper price bounds Suilend uses for borrow limits (min/max of spot & EMA, widened by the confidence margin when known). */
  priceLow: number;
  priceHigh: number;
  priceUpdatedMs: number;
  availableAmount: bigint;
  /** Human units, interest compounded to `nowMs`. */
  borrowedTokens: number;
  /** available + borrowed (what Suilend shows as "deposits"), human units. */
  depositedTokens: number;
  /** Underlying base units per cToken base unit. */
  ctokenRatio: number;
  cumulativeBorrowRate: number;
  /** 0..1 */
  utilization: number;
  /** Yearly fractions. Suilend's curve is an APR (compounded per second on-chain), no APY conversion needed. */
  borrowApr: number;
  supplyApr: number;
  openLtv: number;
  closeLtv: number;
  /** e.g. 1.0, 1.5 (from borrowWeightBps / 1e4). */
  borrowWeight: number;
  borrowFeeFrac: number;
  spreadFeeFrac: number;
  depositLimitTokens: number;
  borrowLimitTokens: number;
  depositLimitUsd: number;
  borrowLimitUsd: number;
  isolated: boolean;
  /** [utilization 0..1, borrow APR fraction] */
  irmPoints: [number, number][];
  depositRewards: PoolRewardSnapshot[];
  borrowRewards: PoolRewardSnapshot[];
  depositTotalShares: bigint;
  borrowTotalShares: bigint;
  depositsPoolRewardManagerId: string;
  borrowsPoolRewardManagerId: string;
}

export type RewardSide = "deposit" | "borrow";

export interface ClaimableReward {
  /** Normalized reward coin type. */
  coinType: string;
  /** Array index of the reserve whose pool pays the reward. */
  reserveArrayIndex: bigint;
  rewardIndex: number;
  side: RewardSide;
  /** Base units (floor). */
  amount: bigint;
}

export interface ObligationPositionSnapshot {
  coinType: string;
  reserveArrayIndex: bigint;
  /** Human units (deposits: ctokens * ratio; borrows: compounded debt). */
  tokens: number;
  usd: number;
  /** Raw cTokens for deposits, 0n for borrows. */
  ctokens: bigint;
  /** Liquidity-mining share in the user reward manager (0 => rewards zeroed). */
  rewardShare: bigint;
}

export interface ObligationSnapshot {
  id: string;
  lendingMarketId: string;
  deposits: ObligationPositionSnapshot[];
  borrows: ObligationPositionSnapshot[];
  /** Suilend aggregates (same math as obligation::refresh). */
  depositedUsd: number;
  /** sum(deposit lower-bound value * openLtv) */
  allowedBorrowUsd: number;
  /** sum(deposit value * closeLtv) */
  unhealthyBorrowUsd: number;
  borrowedUsd: number;
  /** sum(borrow value * borrowWeight) — liquidation compares this with unhealthyBorrowUsd. */
  weightedBorrowUsd: number;
  /** sum(borrow upper-bound value * borrowWeight) — borrow/withdraw limits compare this with allowedBorrowUsd. */
  weightedBorrowUpperUsd: number;
  rewards: ClaimableReward[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SuilendPairConfig {
  /** Unique id, e.g. "USDC/USDsui". */
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
}

/** Same shape as @suilend/sdk lib/pyth `PriceUpdateDataSource` (signed Pyth VAAs for the pro-compatible deployment). */
export interface PriceUpdateDataSourceLike {
  getPriceFeedsUpdateData(priceIds: string[]): Promise<Buffer[]>;
}

/** Same shape as @suilend/sdk utils/simulate `PriceFeedSource` (off-chain latest prices). */
export interface PriceFeedSourceLike {
  getLatestPriceFeeds(
    ids: string[]
  ): Promise<{ id: string; price: number; emaPrice: number; publishTimeS: number; conf?: number }[] | undefined>;
}

/** Subset of SuilendClient used by the adapter (real client satisfies it; tests inject fakes). */
export interface SuilendClientLike {
  lendingMarket: RawLendingMarket;
  pythConnection: unknown;
  findReserveArrayIndex(coinType: string): bigint;
  createObligation(tx: Transaction): TransactionObjectArgument | unknown;
  refreshAll(tx: Transaction, obligation?: RawObligation, coinTypes?: string[]): Promise<void>;
  deposit(coin: TransactionObjectArgument, coinType: string, cap: unknown, tx: Transaction): void;
  depositIntoObligation(owner: string, coinType: string, value: string, tx: Transaction, cap: unknown): Promise<void>;
  borrow(cap: unknown, obligationId: string, coinType: string, value: string, tx: Transaction, addRefreshCalls?: boolean): Promise<unknown>;
  withdraw(cap: unknown, obligationId: string, coinType: string, value: string, tx: Transaction, addRefreshCalls?: boolean): Promise<unknown>;
  repay(obligationId: string, coinType: string, coin: TransactionObjectArgument, tx: Transaction): unknown;
  claimRewardsAndSendToUser(
    owner: string,
    cap: unknown,
    rewards: { reserveArrayIndex: bigint; rewardIndex: bigint; rewardCoinType: string; side: unknown }[],
    tx: Transaction
  ): unknown;
  getObligation(obligationId: string): Promise<RawObligation>;
}

export interface SuilendAdapterConfig {
  env: import("../common.js").SuiEnv;
  /** "main" (default; SDK constant LENDING_MARKET_ID/TYPE) or a lending market object id (type is read on-chain). */
  lendingMarket?: "main" | string;
  /** Lending market type arg when `lendingMarket` is an id (optional; read from chain when absent and cross-checked by verifyConfig). */
  lendingMarketType?: string;
  pairs: SuilendPairConfig[];
  /** Required for pairs whose collateral != debt (stable pairs). */
  swapper?: import("../common.js").PtbSwapper;
  extraRewards?: import("@incentive-router/live-common").RewardRateProvider;
  /** Obligation to use. Absent: the single ObligationOwnerCap the wallet holds for this market (created on first open). */
  obligationId?: string;
  /**
   * Liquidity-mining eligibility. Suilend zeroes ALL reward shares of an
   * obligation that is "looped". On-chain (suilend v7 source) looped = a
   * deposit and a borrow of the same reserve; Suilend docs additionally treat
   * stablecoin-deposit + stablecoin-borrow obligations as ineligible. Unless
   * this is set to true, pairs that would make the obligation ineligible by
   * either rule are reported with EMPTY reward arrays.
   */
  assumeRewardsEligible?: boolean;
  /** Coin types treated as stablecoins for the eligibility rule. Default: @suilend/sui-core NORMALIZED_STABLECOIN_COINTYPES. */
  stablecoinCoinTypes?: string[];
  /** Signed Pyth update source for on-chain refreshes. Without it any write fails once a feed is >20 s stale. */
  priceUpdateSource?: PriceUpdateDataSourceLike;
  /** Off-chain latest prices (e.g. @suilend/sdk createHermesPriceFeedSource) used to reprice reserves before planning / markets(). */
  priceFeed?: PriceFeedSourceLike;
  /** USD price of a reward coin that is not a reserve of the market (reserve rewards use the reserve price). */
  rewardPriceUsd?: (coinType: string) => Promise<number | undefined>;
  log?: Logger;
  /** Swap probe size for swapCostFrac (default 10_000 USD). */
  probeUsd?: number;
  /** Largest probe for swapDepthUsd (default 2_560_000 USD, x4 steps). */
  depthProbeMaxUsd?: number;
  /** Cost budget defining swapDepthUsd (default 50 bps). */
  depthBudgetBps?: number;
  /** swapCostFrac used when no swapper / quote fails (default 100 bps; swapDepthUsd is then NaN = unknown). */
  fallbackSwapCostBps?: number;
  /** Fraction of the open-LTV borrow limit planners may use (default 0.97). */
  stepSafety?: number;
  /** Extra debt repaid on full close to cover interest accrued between build and execution (default 10 bps). */
  interestBufferBps?: number;
  /** Max age of on-chain oracle prices before dataAsOfMs is pulled back to the price time (default 10 min). */
  onChainPriceMaxAgeMs?: number;
  /** Reward coin types never claimed (default: SEND / STEAMM points, same as the SDK's getRewardsMap). */
  skipRewardCoinTypes?: string[];
  /** Test seam: replaces SDK / RPC access. */
  deps?: Partial<import("./sdk.js").SuilendDeps>;
}
