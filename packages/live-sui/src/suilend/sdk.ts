/**
 * Everything that touches @suilend/sdk / @suilend/sui-core or RPC lives here
 * (the adapter only calls these through `SuilendDeps`, so tests can swap them).
 *
 * SDK entry points used (node_modules/@suilend/sdk 14.0.0):
 *  - client.d.ts            SuilendClient.initialize / getObligationOwnerCaps /
 *                           getReserveConfidenceMultiplierBps / getReserveConfidenceShare,
 *                           LENDING_MARKET_ID / LENDING_MARKET_TYPE (MAIN market constants)
 *  - utils/simulate.d.ts    compoundReserveInterest, priceRange, applyConfidenceMargin,
 *                           cTokenRatio, calculate*Percent, computeObligationRefresh,
 *                           refreshReservePrice, decimalToBigNumber
 *  - lib/transactions.d.ts  createObligationIfNoneExists, sendObligationToUser
 *  - lib/types.d.ts         Side
 *  - _generated/suilend     PACKAGE_ID (original package; LendingMarket type origin)
 *  - @suilend/sui-core      NORMALIZED_STABLECOIN_COINTYPES, isSendPoints, isSteammPoints, MAX_U64
 */
import { SuilendClient, LENDING_MARKET_ID, LENDING_MARKET_TYPE } from "@suilend/sdk/client";
import { PACKAGE_ID } from "@suilend/sdk/_generated/suilend";
import * as simulate from "@suilend/sdk/utils/simulate";
import { createObligationIfNoneExists, sendObligationToUser } from "@suilend/sdk/lib/transactions";
import { Side } from "@suilend/sdk/lib/types";
import { NORMALIZED_STABLECOIN_COINTYPES, isSendPoints, isSteammPoints } from "@suilend/sui-core/lib/coinType";
import { MAX_U64 } from "@suilend/sui-core/lib/constants";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import type { Transaction } from "@mysten/sui/transactions";
import { fromUnits } from "@incentive-router/live-common";
import type { SuiEnv } from "../common.js";
import { claimableRewards, irmFromConfig, normType } from "./pure.js";
import type {
  ObligationSnapshot,
  PoolRewardSnapshot,
  PriceFeedSourceLike,
  RawObligation,
  RawPoolRewardManager,
  RawReserve,
  ReserveSnapshot,
  SuilendClientLike,
} from "./types.js";

/** SOURCE: @suilend/sdk client.d.ts LENDING_MARKET_ID / LENDING_MARKET_TYPE (checked on-chain by SuilendClient.initialize + verifyConfig). */
export const MAIN_LENDING_MARKET = { id: LENDING_MARKET_ID as string, type: LENDING_MARKET_TYPE as string };
/** SOURCE: @suilend/sdk _generated/suilend PACKAGE_ID (original suilend package = type origin of LendingMarket / ObligationOwnerCap). */
export const SUILEND_PACKAGE_ID = PACKAGE_ID as string;
/** SOURCE: @suilend/sui-core lib/coinType NORMALIZED_STABLECOIN_COINTYPES. */
export const DEFAULT_STABLECOIN_COINTYPES: readonly string[] = (NORMALIZED_STABLECOIN_COINTYPES as string[]).map((t) => normalizeStructTag(t));
/** SOURCE: @suilend/sui-core lib/constants MAX_U64 (withdraw_ctokens: U64_MAX = withdraw the maximum possible). */
export const U64_MAX_STRING: string = (MAX_U64 as { toFixed(): string }).toFixed();

export function isDefaultSkippedReward(coinType: string): boolean {
  return Boolean(isSendPoints(coinType) || isSteammPoints(coinType));
}

export function toSdkSide(side: "deposit" | "borrow"): unknown {
  return side === "deposit" ? Side.DEPOSIT : Side.BORROW;
}

export { createObligationIfNoneExists, sendObligationToUser };

/** Opaque SDK confidence pair (BigNumber share + kBps) as used by simulate.applyConfidenceMargin. */
export type ReserveConfidence = { share: unknown; kBps: unknown };

export interface SuilendDeps {
  loadClient(env: SuiEnv, marketId: string, marketType: string): Promise<SuilendClientLike>;
  resolveMarketType(env: SuiEnv, marketId: string): Promise<string>;
  listObligationCaps(env: SuiEnv, owner: string, marketType: string): Promise<{ id: string; obligationId: string }[]>;
  coinMetadata(env: SuiEnv, coinType: string): Promise<{ decimals: number; symbol: string } | null>;
  reserveConfidence(env: SuiEnv, reserve: RawReserve): Promise<ReserveConfidence | undefined>;
  nowMs(): number;
}

export const defaultDeps: SuilendDeps = {
  async loadClient(env, marketId, marketType) {
    const c = await SuilendClient.initialize(marketId, marketType, env.grpc);
    return c as unknown as SuilendClientLike;
  },
  async resolveMarketType(env, marketId) {
    if (normalizeSuiAddress(marketId) === normalizeSuiAddress(MAIN_LENDING_MARKET.id)) return MAIN_LENDING_MARKET.type;
    const { object } = await env.grpc.getObject({ objectId: marketId });
    const tag = parseStructTag(object.type);
    if (tag.module !== "lending_market" || tag.name !== "LendingMarket" || normalizeSuiAddress(tag.address) !== normalizeSuiAddress(SUILEND_PACKAGE_ID)) {
      throw new Error(`object ${marketId} is not a suilend LendingMarket (type ${object.type})`);
    }
    const p = tag.typeParams[0];
    if (p === undefined) throw new Error(`LendingMarket ${marketId} has no type parameter`);
    return typeof p === "string" ? normalizeStructTag(p) : normalizeStructTag(p);
  },
  async listObligationCaps(env, owner, marketType) {
    const caps = (await SuilendClient.getObligationOwnerCaps(owner, [marketType], env.grpc)) as unknown as { id: string; obligationId: string }[];
    return caps.map((c) => ({ id: c.id, obligationId: c.obligationId }));
  },
  async coinMetadata(env, coinType) {
    const r = await env.grpc.getCoinMetadata({ coinType: normalizeStructTag(coinType) });
    return r.coinMetadata ? { decimals: r.coinMetadata.decimals, symbol: r.coinMetadata.symbol } : null;
  },
  async reserveConfidence(env, reserve) {
    // Same logic as @suilend/sdk lib/initialize reserveConfidenceMultipliers / reserveConfidenceByCoinType.
    const bag = reserve.config.element?.additionalFields;
    if (!bag || BigInt(bag.size) === 0n) return undefined;
    const kBps = (await SuilendClient.getReserveConfidenceMultiplierBps(env.grpc, bag.id)) as unknown as { isZero(): boolean };
    if (kBps.isZero()) return undefined;
    if (simulate.isRefreshedFromFeed(reserve)) return { share: undefined, kBps };
    const share = await SuilendClient.getReserveConfidenceShare(env.grpc, reserve.id);
    return { share, kBps };
  },
  nowMs: () => Date.now(),
};

type BN = { toNumber(): number };
const bn = (x: unknown): number => (x as BN).toNumber();

/** Bring reserve interest + pool reward accumulators to `nowMs` (SDK compoundReserveInterest). */
export function compoundReserves(reserves: readonly RawReserve[], nowMs: number): RawReserve[] {
  const nowS = Math.floor(nowMs / 1000);
  return reserves.map((r) => simulate.compoundReserveInterest(r, nowS) as RawReserve);
}

/** Reprice reserves from an off-chain feed (SDK refreshReservePrice); throws when a feed is missing. */
export async function repriceReserves(reserves: RawReserve[], feed: PriceFeedSourceLike): Promise<RawReserve[]> {
  return (await simulate.refreshReservePrice(reserves, feed as never)) as RawReserve[];
}

function rewardsOf(prm: RawPoolRewardManager): PoolRewardSnapshot[] {
  const out: PoolRewardSnapshot[] = [];
  prm.poolRewards.forEach((pr, i) => {
    if (!pr) return;
    out.push({
      coinType: normType(pr.coinType),
      rewardIndex: i,
      startMs: Number(pr.startTimeMs),
      endMs: Number(pr.endTimeMs),
      totalRewards: BigInt(pr.totalRewards),
    });
  });
  return out;
}

/** Protocol-normalised snapshot of a (compounded) reserve, using the SDK's own formulas. */
export function reserveSnapshot(r: RawReserve, conf?: ReserveConfidence): ReserveSnapshot {
  const cfg = r.config.element;
  if (!cfg) throw new Error(`suilend reserve ${r.coinType} has no config`);
  const dec = r.mintDecimals;
  const { low, high } = simulate.priceRange(r) as { low: unknown; high: unknown };
  let lo = bn(low);
  let hi = bn(high);
  if (conf && conf.share !== undefined) {
    const m = simulate.applyConfidenceMargin(low as never, high as never, conf.share as never, conf.kBps as never) as {
      lowerBound: unknown;
      upperBound: unknown;
    };
    lo = bn(m.lowerBound);
    hi = bn(m.upperBound);
  }
  const borrowedTokens = bn(simulate.decimalToBigNumber(r.borrowedAmount as never)) / 10 ** dec;
  const availableTokens = fromUnits(BigInt(r.availableAmount), dec);
  const spreadFeeBps = Number(cfg.spreadFeeBps);
  return {
    coinType: normType(r.coinType),
    arrayIndex: BigInt(r.arrayIndex),
    decimals: dec,
    price: bn(simulate.decimalToBigNumber(r.price as never)),
    priceLow: lo,
    priceHigh: hi,
    priceUpdatedMs: Number(r.priceLastUpdateTimestampS) * 1000,
    availableAmount: BigInt(r.availableAmount),
    borrowedTokens,
    depositedTokens: borrowedTokens + availableTokens,
    ctokenRatio: bn(simulate.cTokenRatio(r)),
    cumulativeBorrowRate: bn(simulate.decimalToBigNumber(r.cumulativeBorrowRate as never)),
    utilization: bn(simulate.calculateUtilizationPercent(r)) / 100,
    borrowApr: bn(simulate.calculateBorrowAprPercent(r)) / 100,
    supplyApr: bn(simulate.calculateDepositAprPercent(r)) / 100,
    openLtv: cfg.openLtvPct / 100,
    closeLtv: cfg.closeLtvPct / 100,
    borrowWeight: Number(cfg.borrowWeightBps) / 10_000,
    borrowFeeFrac: Number(cfg.borrowFeeBps) / 10_000,
    spreadFeeFrac: spreadFeeBps / 10_000,
    depositLimitTokens: fromUnits(BigInt(cfg.depositLimit), dec),
    borrowLimitTokens: fromUnits(BigInt(cfg.borrowLimit), dec),
    depositLimitUsd: Number(cfg.depositLimitUsd),
    borrowLimitUsd: Number(cfg.borrowLimitUsd),
    isolated: Boolean(cfg.isolated),
    irmPoints: irmFromConfig(cfg.interestRateUtils.map(Number), cfg.interestRateAprs, spreadFeeBps)?.points ?? [],
    depositRewards: rewardsOf(r.depositsPoolRewardManager),
    borrowRewards: rewardsOf(r.borrowsPoolRewardManager),
    depositTotalShares: BigInt(r.depositsPoolRewardManager.totalShares),
    borrowTotalShares: BigInt(r.borrowsPoolRewardManager.totalShares),
    depositsPoolRewardManagerId: r.depositsPoolRewardManager.id,
    borrowsPoolRewardManagerId: r.borrowsPoolRewardManager.id,
  };
}

/**
 * Obligation snapshot via the SDK's computeObligationRefresh (same math as
 * obligation::refresh: compounded debt, price bounds, reward managers brought
 * to now). `reserves` must be compounded to `nowMs`.
 */
export function obligationSnapshot(
  raw: RawObligation,
  reserves: readonly RawReserve[],
  nowMs: number,
  confidence?: Map<string, ReserveConfidence>
): ObligationSnapshot {
  const ref = simulate.computeObligationRefresh(raw, reserves as RawReserve[], nowMs, confidence as never) as {
    deposits: (RawObligation["deposits"][number] & { marketValue: { value: bigint } })[];
    borrows: (RawObligation["borrows"][number] & { marketValue: { value: bigint } })[];
    userRewardManagers: RawObligation["userRewardManagers"];
    depositedValueUsd: unknown;
    allowedBorrowValueUsd: unknown;
    unhealthyBorrowValueUsd: unknown;
    unweightedBorrowedValueUsd: unknown;
    weightedBorrowedValueUsd: unknown;
    weightedBorrowedValueUpperBoundUsd: unknown;
  };
  const byType = new Map(reserves.map((r) => [normType(r.coinType), r]));
  const urmShare = (i: bigint) => BigInt(ref.userRewardManagers[Number(i)]?.share ?? 0n);
  const deposits = ref.deposits.map((d) => {
    const r = byType.get(normType(d.coinType));
    const ratio = r ? bn(simulate.cTokenRatio(r)) : 1;
    const dec = r?.mintDecimals ?? 0;
    return {
      coinType: normType(d.coinType),
      reserveArrayIndex: BigInt(d.reserveArrayIndex),
      tokens: (Number(d.depositedCtokenAmount) * ratio) / 10 ** dec,
      usd: bn(simulate.decimalToBigNumber(d.marketValue as never)),
      ctokens: BigInt(d.depositedCtokenAmount),
      rewardShare: urmShare(d.userRewardManagerIndex),
    };
  });
  const borrows = ref.borrows.map((b) => {
    const r = byType.get(normType(b.coinType));
    const dec = r?.mintDecimals ?? 0;
    return {
      coinType: normType(b.coinType),
      reserveArrayIndex: BigInt(b.reserveArrayIndex),
      tokens: bn(simulate.decimalToBigNumber(b.borrowedAmount as never)) / 10 ** dec,
      usd: bn(simulate.decimalToBigNumber(b.marketValue as never)),
      ctokens: 0n,
      rewardShare: urmShare(b.userRewardManagerIndex),
    };
  });
  const refreshed: RawObligation = { ...raw, deposits: ref.deposits, borrows: ref.borrows, userRewardManagers: ref.userRewardManagers };
  return {
    id: raw.id,
    lendingMarketId: raw.lendingMarketId,
    deposits,
    borrows,
    depositedUsd: bn(ref.depositedValueUsd),
    allowedBorrowUsd: bn(ref.allowedBorrowValueUsd),
    unhealthyBorrowUsd: bn(ref.unhealthyBorrowValueUsd),
    borrowedUsd: bn(ref.unweightedBorrowedValueUsd),
    weightedBorrowUsd: bn(ref.weightedBorrowedValueUsd),
    weightedBorrowUpperUsd: bn(ref.weightedBorrowedValueUpperBoundUsd),
    rewards: claimableRewards(refreshed, reserves),
  };
}

/** Real SuilendClient type check (kept here so a SuilendClient API drift shows up at typecheck). */
export function asClientLike(c: SuilendClient): SuilendClientLike {
  return c as unknown as SuilendClientLike;
}

export type { Transaction };
