/**
 * Pure Suilend math: no SDK, no RPC. Everything here is unit-tested offline
 * (packages/live-sui/test/suilend.test.ts).
 *
 * Suilend health model (mirrors suilend::obligation, verified against
 * github.com/solendprotocol/suilend contracts/suilend/sources/obligation.move):
 *   allowed   = Σ deposit_value_lower_bound · openLtv          (borrow / withdraw limit)
 *   unhealthy = Σ deposit_value · closeLtv                      (liquidation threshold)
 *   weighted  = Σ borrow_value · borrowWeight                   (compared with unhealthy)
 *   weightedUpper = Σ borrow_value_upper_bound · borrowWeight   (compared with allowed)
 * A borrow / withdraw succeeds iff weightedUpper <= allowed afterwards.
 *
 * Borrow weight bw therefore scales the DEBT side: for a single pair the
 * unweighted LTV limits are   maxLtv = openLtv_c / bw_d,  liqLtv = closeLtv_c / bw_d.
 */
import { normalizeStructTag } from "@mysten/sui/utils";
import type { IrmModel, LoopLeg, LoopPair, RewardRate } from "@incentive-router/core";
import type { AssetRef } from "@incentive-router/live-common";
import { fromUnits, toUnits } from "@incentive-router/live-common";
import type { PtbSwapper } from "../common.js";
import type {
  ClaimableReward,
  ObligationSnapshot,
  PoolRewardSnapshot,
  RawObligation,
  RawPoolRewardManager,
  RawRateLimiter,
  RawReserve,
  ReserveSnapshot,
  RewardSide,
  SuilendPairConfig,
} from "./types.js";

export const WAD = 10n ** 18n;
/** SOURCE: @suilend/sdk lib/constants.d.ts `msPerYear` (also @suilend/sui-core MS_PER_YEAR). */
export const MS_PER_YEAR = 31_556_952_000;
/** SOURCE: suilend reserve.move `MIN_AVAILABLE_AMOUNT` — a borrow/redeem must leave this many base units. */
export const MIN_AVAILABLE_AMOUNT = 100n;
/** SOURCE: https://docs.suilend.fi/faq/why-am-i-not-receiving-rewards */
export const REWARD_RULE_DOCS = "https://docs.suilend.fi/faq/why-am-i-not-receiving-rewards";

export const normType = (t: string): string => normalizeStructTag(t);

export function wadToNumber(v: bigint): number {
  // keep 12 fractional digits exactly before the float conversion
  return Number(v / 1_000_000n) / 1e12;
}

// ---------------------------------------------------------------------------
// Reserve-level helpers
// ---------------------------------------------------------------------------

/** IRM curve -> core IrmModel. Utils are percent, APRs are bps (parseReserveConfig divides aprs by 100 to get percent). */
export function irmFromConfig(utilsPct: number[], aprsBps: (bigint | number)[], spreadFeeBps: number): IrmModel | undefined {
  const pts: [number, number][] = [];
  for (let i = 0; i < Math.min(utilsPct.length, aprsBps.length); i++) {
    pts.push([Number(utilsPct[i]) / 100, Number(aprsBps[i]) / 10_000]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts.length >= 2 ? { points: pts, reserveFactor: spreadFeeBps / 10_000 } : undefined;
}

/** Remaining room under the reserve's deposit caps (token cap AND USD cap at the upper-bound price), USD at spot. */
export function depositCapRemainingUsd(s: ReserveSnapshot): number {
  const byTokens = s.depositLimitTokens - s.depositedTokens;
  const byUsd = s.priceHigh > 0 ? s.depositLimitUsd / s.priceHigh - s.depositedTokens : 0;
  return Math.max(0, Math.min(byTokens, byUsd)) * s.price;
}

/**
 * Remaining borrowable USD (spot) for ONE transaction: reserve borrow caps
 * (tokens and USD at the upper-bound price), available liquidity minus the
 * protocol minimum, and the lending market's outflow rate limiter (USD,
 * valued at the upper-bound price on-chain). Borrow fee is included in the
 * amount the caps see.
 */
export function borrowCapRemainingUsd(s: ReserveSnapshot, rateLimiterRemainingUsd: number): number {
  const fee = 1 + s.borrowFeeFrac;
  const byTokens = s.borrowLimitTokens - s.borrowedTokens;
  const byUsd = s.priceHigh > 0 ? s.borrowLimitUsd / s.priceHigh - s.borrowedTokens : 0;
  const byLiquidity = fromUnits(s.availableAmount > MIN_AVAILABLE_AMOUNT ? s.availableAmount - MIN_AVAILABLE_AMOUNT : 0n, s.decimals);
  const byRate = s.priceHigh > 0 ? rateLimiterRemainingUsd / s.priceHigh : 0;
  const tokens = Math.max(0, Math.min(byTokens, byUsd, byLiquidity, byRate)) / fee;
  return tokens * s.price;
}

/**
 * Mirror of suilend rate_limiter.move remaining_outflow (update_internal +
 * current_outflow). Quantities are USD (WAD decimals), max_outflow whole USD.
 */
export function rateLimiterRemainingUsd(rl: RawRateLimiter, nowS: number): number {
  const wd = Number(rl.config.windowDuration);
  const maxOut = Number(rl.config.maxOutflow);
  if (!(wd > 0)) return maxOut;
  let ws = Number(rl.windowStart);
  let prev = wadToNumber(rl.prevQty.value);
  let cur = wadToNumber(rl.curQty.value);
  const now = Math.max(nowS, ws);
  if (now < ws + wd) {
    // same window
  } else if (now < ws + 2 * wd) {
    prev = cur;
    ws = ws + wd;
    cur = 0;
  } else {
    prev = 0;
    cur = 0;
    ws = now;
  }
  const prevWeight = Math.max(0, (wd - (now - ws + 1)) / wd);
  const outflow = prev * prevWeight + cur;
  return Math.max(0, maxOut - outflow);
}

/** Pair LTV limits in UNWEIGHTED spot terms (debtUsd / collateralUsd), borrow weight and Suilend's price bounds folded in. */
export function pairLtvLimits(coll: ReserveSnapshot, debt: ReserveSnapshot): { maxLtv: number; liqLtv: number } {
  const bw = debt.borrowWeight > 0 ? debt.borrowWeight : 1;
  // open check: D·pD_high·bw <= C·pC_low·openLtv  <=>  (D·pD)/(C·pC) <= openLtv/bw · (pC_low/pC) · (pD/pD_high)
  const band = (coll.price > 0 ? coll.priceLow / coll.price : 1) * (debt.priceHigh > 0 ? debt.price / debt.priceHigh : 1);
  const maxLtv = (coll.openLtv / bw) * Math.min(1, band);
  // liquidation: D·pD·bw > C·pC·closeLtv (spot values on both sides)
  const liqLtv = coll.closeLtv / bw;
  return { maxLtv, liqLtv };
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export interface RewardCoinInfo {
  symbol: string;
  decimals: number;
  priceUsd?: number;
}

/**
 * APR (yearly fraction) of one pool reward on the side it is paid on. Same
 * formula as @suilend/sdk lib/liquidityMining formatRewards:
 *   emissionUsd/yr = totalRewards · price · MS_PER_YEAR / (end - start)
 *   shareUsd       = totalShares / 10^dec · (cTokenRatio | cumulativeBorrowRate) · price
 * Returns null when the reward is inactive or unpriceable.
 */
export function poolRewardApr(
  s: ReserveSnapshot,
  side: RewardSide,
  r: PoolRewardSnapshot,
  coin: RewardCoinInfo | undefined,
  nowMs: number
): number | null {
  if (!(nowMs >= r.startMs && nowMs < r.endMs)) return null;
  if (!coin || coin.priceUsd === undefined || !(coin.priceUsd >= 0)) return null;
  const durMs = r.endMs - r.startMs;
  if (!(durMs > 0)) return null;
  const shares = side === "deposit" ? s.depositTotalShares : s.borrowTotalShares;
  if (shares === 0n) return null;
  const perShare = side === "deposit" ? s.ctokenRatio : s.cumulativeBorrowRate;
  const shareUsd = fromUnits(shares, s.decimals) * perShare * s.price;
  if (!(shareUsd > 0)) return null;
  const emissionUsd = fromUnits(r.totalRewards, coin.decimals) * coin.priceUsd * (MS_PER_YEAR / durMs);
  return emissionUsd / shareUsd;
}

/** Active rewards of one side, merged per token (endsAtMs = earliest end, conservative). */
export function sideRewardRates(
  s: ReserveSnapshot,
  side: RewardSide,
  coinInfo: (coinType: string) => RewardCoinInfo | undefined,
  nowMs: number
): { rates: RewardRate[]; unpriced: string[] } {
  const list = side === "deposit" ? s.depositRewards : s.borrowRewards;
  const byToken = new Map<string, RewardRate>();
  const unpriced: string[] = [];
  for (const r of list) {
    if (!(nowMs >= r.startMs && nowMs < r.endMs)) continue;
    const info = coinInfo(r.coinType);
    const apr = poolRewardApr(s, side, r, info, nowMs);
    if (apr === null) {
      unpriced.push(r.coinType);
      continue;
    }
    const token = info!.symbol;
    const prev = byToken.get(token);
    if (prev) {
      prev.apr += apr;
      prev.endsAtMs = Math.min(prev.endsAtMs ?? Infinity, r.endMs);
    } else byToken.set(token, { token, apr, endsAtMs: r.endMs });
  }
  return { rates: [...byToken.values()], unpriced };
}

// ---------------------------------------------------------------------------
// Reward eligibility (looping rule)
// ---------------------------------------------------------------------------

/**
 * Why an obligation holding these deposits/borrows earns no Suilend
 * liquidity-mining rewards, or null when eligible.
 *
 *  1. ON-CHAIN (suilend obligation.move `is_looped`, v7 source): a deposit
 *     and a borrow of the SAME reserve. `zero_out_rewards_if_looped` runs at
 *     the end of every borrow / withdraw / repay / liquidate and sets the
 *     reward share of EVERY deposit and borrow of the obligation to 0.
 *  2. DOCS (REWARD_RULE_DOCS): stablecoin deposit + stablecoin borrow
 *     (same or different stablecoins). Not in the public v7 source; the SDK
 *     targets market v8 whose source is not public, so it is applied
 *     conservatively unless the caller opts out (assumeRewardsEligible).
 *
 * Shares only come back when each position is touched again after the
 * obligation stops being looped (Suilend UI "Restore Eligibility").
 */
export function rewardIneligibility(
  depositTypes: readonly string[],
  borrowTypes: readonly string[],
  stablecoins: ReadonlySet<string>
): string | null {
  const deps = new Set(depositTypes.map(normType));
  const bors = borrowTypes.map(normType);
  const same = bors.find((b) => deps.has(b));
  if (same) return `same-asset loop: ${same} deposited and borrowed in one obligation (on-chain is_looped zeroes all reward shares)`;
  const stableDep = [...deps].find((d) => stablecoins.has(d));
  const stableBor = bors.find((b) => stablecoins.has(b));
  if (stableDep && stableBor) {
    return `stablecoin deposit (${stableDep}) + stablecoin borrow (${stableBor}): ineligible per Suilend docs (${REWARD_RULE_DOCS})`;
  }
  return null;
}

/** Positions whose liquidity-mining share is 0 although the position is non-zero = rewards already zeroed on-chain. */
export function zeroedRewardPositions(o: Pick<ObligationSnapshot, "deposits" | "borrows">): string[] {
  const out: string[] = [];
  for (const d of o.deposits) if (d.ctokens > 0n && d.rewardShare === 0n) out.push(`deposit:${d.coinType}`);
  for (const b of o.borrows) if (b.tokens > 0 && b.rewardShare === 0n) out.push(`borrow:${b.coinType}`);
  return out;
}

export interface RewardEligibility {
  eligible: boolean;
  /** Rule-based reason (null = eligible by rule). */
  reason: string | null;
  /** Observed on-chain: positions whose reward share is already 0. */
  zeroedOnChain: string[];
}

export function rewardsEligible(
  o: Pick<ObligationSnapshot, "deposits" | "borrows">,
  stablecoins: ReadonlySet<string>
): RewardEligibility {
  const reason = rewardIneligibility(
    o.deposits.map((d) => d.coinType),
    o.borrows.map((b) => b.coinType),
    stablecoins
  );
  const zeroedOnChain = zeroedRewardPositions(o);
  return { eligible: reason === null && zeroedOnChain.length === 0, reason, zeroedOnChain };
}

/** Would opening `pair` (on top of the obligation's current holdings) leave the obligation ineligible? */
export function pairRewardIneligibility(
  pair: { collateral: string; debt: string },
  holdings: { deposits: readonly string[]; borrows: readonly string[] } | undefined,
  stablecoins: ReadonlySet<string>
): string | null {
  return rewardIneligibility([...(holdings?.deposits ?? []), pair.collateral], [...(holdings?.borrows ?? []), pair.debt], stablecoins);
}

/**
 * Claimable rewards from a REFRESHED obligation (reward managers already
 * brought to now, e.g. by @suilend/sdk computeObligationRefresh).
 */
export function claimableRewards(o: RawObligation, reserves: readonly RawReserve[]): ClaimableReward[] {
  const out: ClaimableReward[] = [];
  const byType = new Map(reserves.map((r) => [normType(r.coinType), r]));
  const visit = (coinType: string, urmIndex: bigint, side: RewardSide) => {
    const reserve = byType.get(normType(coinType));
    const urm = o.userRewardManagers[Number(urmIndex)];
    if (!reserve || !urm) return;
    const prm: RawPoolRewardManager = side === "deposit" ? reserve.depositsPoolRewardManager : reserve.borrowsPoolRewardManager;
    prm.poolRewards.forEach((pr, i) => {
      if (!pr) return;
      const ur = urm.rewards[i];
      if (!ur) return;
      const amount = ur.earnedRewards.value / WAD;
      if (amount > 0n) out.push({ coinType: normType(pr.coinType), reserveArrayIndex: reserve.arrayIndex, rewardIndex: i, side, amount });
    });
  };
  for (const d of o.deposits) visit(d.coinType, d.userRewardManagerIndex, "deposit");
  for (const b of o.borrows) visit(b.coinType, b.userRewardManagerIndex, "borrow");
  return out;
}

// ---------------------------------------------------------------------------
// LoopPair construction
// ---------------------------------------------------------------------------

export interface BuildPairArgs {
  pair: SuilendPairConfig;
  coll: ReserveSnapshot;
  debt: ReserveSnapshot;
  /** Protocol (+ extra) reward rates per reserve side. */
  rewards: {
    collSupply: RewardRate[];
    collBorrow: RewardRate[];
    debtSupply: RewardRate[];
    debtBorrow: RewardRate[];
  };
  /** null = eligible. When non-null and !assumeEligible every reward array is emptied. */
  ineligibleReason: string | null;
  assumeEligible: boolean;
  swapCostFrac: number;
  swapDepthUsd: number;
  rateLimiterRemainingUsd: number;
  dataAsOfMs: number;
  myLtv?: number;
}

function legOf(asset: AssetRef, s: ReserveSnapshot, supplyRewards: RewardRate[], borrowRewards: RewardRate[], rateLimiterUsd: number): LoopLeg {
  return {
    symbol: asset.symbol,
    assetId: s.coinType,
    priceUsd: s.price,
    totalSupplyUsd: s.depositedTokens * s.price,
    totalBorrowUsd: s.borrowedTokens * s.price,
    supplyAprBase: s.supplyApr,
    borrowAprBase: s.borrowApr,
    supplyRewards,
    borrowRewards,
    irm: s.irmPoints.length >= 2 ? { points: s.irmPoints.map((p) => [p[0], p[1]] as [number, number]), reserveFactor: s.spreadFeeFrac } : undefined,
    supplyCapRemainingUsd: depositCapRemainingUsd(s),
    borrowCapRemainingUsd: borrowCapRemainingUsd(s, rateLimiterUsd),
    borrowFeeFrac: s.borrowFeeFrac,
  };
}

/**
 * swapDepthUsd for a two-asset pair.
 *  - depth unknown (probe failed / no swapper) => NaN ("missing data": the core
 *    keeps the last known value instead of reading 0 = no exit capacity, which
 *    would force an urgent exit). The outflow limit still reaches the core via
 *    borrowCapRemainingUsd.
 *  - depth known (probes succeeded, 0 = nothing within budget) => capped by the
 *    lending market's remaining outflow (it gates the collateral withdrawals
 *    of an unwind; the core derives exit capacity from swapDepthUsd).
 */
export function pairSwapDepthUsd(depthUsd: number, rateLimiterRemainingUsd: number): number {
  if (Number.isNaN(depthUsd)) return NaN;
  const depth = Math.max(0, depthUsd);
  return rateLimiterRemainingUsd >= 0 ? Math.min(depth, rateLimiterRemainingUsd) : depth;
}

export function buildLoopPair(a: BuildPairArgs): LoopPair {
  const same = a.coll.coinType === a.debt.coinType;
  const drop = a.ineligibleReason !== null && !a.assumeEligible;
  const z = (r: RewardRate[]) => (drop ? [] : r);
  const { maxLtv, liqLtv } = pairLtvLimits(a.coll, a.debt);
  const collateral = legOf(a.pair.collateral, a.coll, z(a.rewards.collSupply), z(a.rewards.collBorrow), a.rateLimiterRemainingUsd);
  const debt = same ? collateral : legOf(a.pair.debt, a.debt, z(a.rewards.debtSupply), z(a.rewards.debtBorrow), a.rateLimiterRemainingUsd);
  const p: LoopPair = {
    protocol: "suilend",
    chain: "sui",
    pairId: a.pair.pairId,
    collateral,
    debt,
    maxLtv,
    liqLtv,
    swapCostFrac: same ? 0 : a.swapCostFrac,
    swapDepthUsd: same ? Infinity : pairSwapDepthUsd(a.swapDepthUsd, a.rateLimiterRemainingUsd),
    dataAsOfMs: a.dataAsOfMs,
  };
  if (a.myLtv !== undefined) p.myLtv = a.myLtv;
  return p;
}

// ---------------------------------------------------------------------------
// Position view
// ---------------------------------------------------------------------------

export interface PairPositionNumbers {
  collateralTokens: number;
  debtTokens: number;
  collateralUsd: number;
  debtUsd: number;
  /** Suilend weighted LTV (Σ borrow·bw / Σ deposits) divided by the pair debt's bw => comparable with LoopPair.maxLtv/liqLtv. */
  ltv: number;
  /** Raw Suilend weighted LTV Σ borrow·bw / Σ deposits. */
  weightedLtv: number;
  /** unhealthy / weighted (>1 safe); undefined without debt. */
  healthFactor?: number;
  /** weightedUpper / allowed: >= 1 means borrows AND withdrawals are blocked. */
  borrowLimitUsage: number;
}

export function pairPositionNumbers(o: ObligationSnapshot, collType: string, debtType: string, debtBorrowWeight: number): PairPositionNumbers | null {
  const c = o.deposits.find((d) => d.coinType === collType);
  const d = o.borrows.find((b) => b.coinType === debtType);
  if (!c && !d) return null;
  const weightedLtv = o.depositedUsd > 0 ? o.weightedBorrowUsd / o.depositedUsd : o.weightedBorrowUsd > 0 ? Infinity : 0;
  const bw = debtBorrowWeight > 0 ? debtBorrowWeight : 1;
  return {
    collateralTokens: c?.tokens ?? 0,
    debtTokens: d?.tokens ?? 0,
    collateralUsd: c?.usd ?? 0,
    debtUsd: d?.usd ?? 0,
    ltv: weightedLtv / bw,
    weightedLtv,
    healthFactor: o.weightedBorrowUsd > 0 ? o.unhealthyBorrowUsd / o.weightedBorrowUsd : undefined,
    borrowLimitUsage: o.allowedBorrowUsd > 0 ? o.weightedBorrowUpperUsd / o.allowedBorrowUsd : o.weightedBorrowUpperUsd > 0 ? Infinity : 0,
  };
}

// ---------------------------------------------------------------------------
// Planners (no flash loan on Suilend: iterate inside one PTB)
// ---------------------------------------------------------------------------

export interface PlanPrices {
  /** Spot prices (protocol LTV is measured at spot). */
  collPrice: number;
  debtPrice: number;
  /** Bounds used by the open-LTV check: collateral lower bound, debt upper bound. */
  collPriceLow: number;
  debtPriceHigh: number;
}

export interface LoopPlanInput extends PlanPrices {
  /** Collateral tokens in the obligation for this reserve AFTER the equity deposit (human units). */
  collateralTokens: number;
  debtTokens: number;
  openLtv: number;
  borrowWeight: number;
  borrowFeeFrac: number;
  /** Contribution of the obligation's other deposits to `allowed` and other borrows to `weightedUpper` (USD). */
  otherAllowedUsd?: number;
  otherWeightedBorrowUsd?: number;
  /** Worst-case collateral tokens obtained per debt token (minOut basis). Exactly 1 for same asset. */
  conversionRate: number;
  /** Unweighted spot LTV (debtUsd / collUsd) never to be exceeded. */
  targetLtv: number;
  maxIterations: number;
  /** Fraction of `allowed` the plan may consume (0..1]. */
  stepSafety: number;
  /** Total borrow cap for this tx incl. fee (debt tokens). */
  maxTotalBorrowTokens?: number;
  /** Max collateral added by the loop (collateral tokens). */
  maxTotalDepositTokens?: number;
  /** Smallest borrow worth a step (debt tokens). */
  minStepTokens?: number;
  collDecimals: number;
  debtDecimals: number;
}

export interface LoopStep {
  /** Debt base units borrowed (fee is added to the debt on top). */
  borrow: bigint;
  /** Collateral base units the step must deposit at least (swap minOut; = borrow for same asset). */
  minCollateralOut: bigint;
}

export interface LoopPlan {
  steps: LoopStep[];
  totalBorrow: bigint;
  finalCollateralTokens: number;
  finalDebtTokens: number;
  /** Planned (worst-case) final spot LTV. */
  finalLtv: number;
  reachedTarget: boolean;
  limitedBy: "target" | "iterations" | "health" | "borrowCap" | "depositCap" | "dust" | null;
}

const ltvOf = (cTok: number, dTok: number, pC: number, pD: number) => (cTok > 0 ? (dTok * pD) / (cTok * pC) : dTok > 0 ? Infinity : 0);

/**
 * Lever up: borrow -> (swap) -> deposit, repeated. Every step respects the
 * open-LTV check WITH borrow weight and price bounds at the moment of the
 * borrow (before that step's deposit lands) using only `stepSafety` of the
 * limit, and never lets the worst-case spot LTV exceed `targetLtv`.
 */
export function planLoopSteps(i: LoopPlanInput): LoopPlan {
  if (!(i.targetLtv >= 0 && i.targetLtv < 1)) throw new Error(`planLoopSteps: targetLtv ${i.targetLtv} out of [0,1)`);
  if (!(i.conversionRate > 0)) throw new Error("planLoopSteps: conversionRate must be > 0");
  const dScale = 10 ** i.debtDecimals;
  const cScale = 10 ** i.collDecimals;
  const minStep = Math.max(i.minStepTokens ?? 0, 1 / dScale);
  let C = i.collateralTokens;
  let D = i.debtTokens;
  let borrowedTotal = 0; // incl. fee
  let deposited = 0;
  const steps: LoopStep[] = [];
  let stop: LoopPlan["limitedBy"] = null;
  let reached = ltvOf(C, D, i.collPrice, i.debtPrice) >= i.targetLtv;
  if (reached) stop = "target";
  const f = i.borrowFeeFrac;
  const bw = i.borrowWeight > 0 ? i.borrowWeight : 1;

  for (let k = 0; k < i.maxIterations && !reached; k++) {
    // target: (D + a(1+f))·pD <= t·(C + a·r)·pC
    const num = i.targetLtv * C * i.collPrice - D * i.debtPrice;
    const den = (1 + f) * i.debtPrice - i.targetLtv * i.conversionRate * i.collPrice;
    const aTarget = num <= 0 ? 0 : den > 0 ? num / den : Infinity;
    // health at borrow time: (D + a(1+f))·pD_hi·bw + otherW <= safety·(C·pC_lo·o + otherA)
    const allowed = (C * i.collPriceLow * i.openLtv + (i.otherAllowedUsd ?? 0)) * i.stepSafety;
    const weighted = D * i.debtPriceHigh * bw + (i.otherWeightedBorrowUsd ?? 0);
    const aHealth = allowed > weighted ? (allowed - weighted) / (i.debtPriceHigh * bw * (1 + f)) : 0;
    const aBorrowCap = i.maxTotalBorrowTokens === undefined ? Infinity : (i.maxTotalBorrowTokens - borrowedTotal) / (1 + f);
    const aDepositCap = i.maxTotalDepositTokens === undefined ? Infinity : (i.maxTotalDepositTokens - deposited) / i.conversionRate;

    let a = Math.min(aTarget, aHealth, aBorrowCap, aDepositCap);
    const bind: LoopPlan["limitedBy"] =
      a === aTarget ? "target" : a === aHealth ? "health" : a === aBorrowCap ? "borrowCap" : "depositCap";
    if (aTarget < minStep) {
      reached = true;
      stop = "target";
      break;
    }
    if (!(a >= minStep)) {
      stop = bind;
      break;
    }
    // floor to base units, a hair under to keep float error on the safe side,
    // then re-check the exact post-step state (fee is ceil'ed on-chain) and
    // shave base units until neither the target nor the health limit is crossed
    let borrowBase = BigInt(Math.floor(a * dScale * (1 - 1e-9)));
    const exceeds = (b: bigint): boolean => {
      const dAfter = D + Number(b + BigInt(Math.ceil(Number(b) * f))) / dScale;
      const cAfter = C + Math.floor((Number(b) / dScale) * i.conversionRate * cScale) / cScale;
      return dAfter * i.debtPrice > i.targetLtv * cAfter * i.collPrice || dAfter * i.debtPriceHigh * bw + (i.otherWeightedBorrowUsd ?? 0) > allowed;
    };
    for (let n = 0; n < 8 && borrowBase > 0n && exceeds(borrowBase); n++) {
      borrowBase -= borrowBase / 1_000_000n + 2n;
    }
    if (borrowBase > 0n && exceeds(borrowBase)) borrowBase = 0n;
    a = Number(borrowBase) / dScale;
    const outBase = BigInt(Math.floor(a * i.conversionRate * cScale));
    if (borrowBase <= 0n || outBase <= 0n) {
      stop = bind === "target" ? "target" : "dust";
      if (bind === "target") reached = true;
      break;
    }
    const feeBase = BigInt(Math.ceil(Number(borrowBase) * f));
    steps.push({ borrow: borrowBase, minCollateralOut: outBase });
    const debtAdded = Number(borrowBase + feeBase) / dScale;
    D += debtAdded;
    borrowedTotal += debtAdded;
    const out = Number(outBase) / cScale;
    C += out;
    deposited += out;
    if (bind === "target") {
      reached = true;
      stop = "target";
      break;
    }
  }
  if (stop === null) stop = reached ? "target" : "iterations";
  const limitedBy = stop;
  const finalLtv = ltvOf(C, D, i.collPrice, i.debtPrice);
  return {
    steps,
    totalBorrow: steps.reduce((s, x) => s + x.borrow, 0n),
    finalCollateralTokens: C,
    finalDebtTokens: D,
    finalLtv,
    reachedTarget: reached || finalLtv >= i.targetLtv * (1 - 1e-6),
    limitedBy,
  };
}

export type UnwindGoal = { kind: "debt"; targetDebtTokens: number } | { kind: "ltv"; targetLtv: number };

export interface UnwindPlanInput extends PlanPrices {
  collateralTokens: number;
  debtTokens: number;
  openLtv: number;
  borrowWeight: number;
  otherAllowedUsd?: number;
  otherWeightedBorrowUsd?: number;
  /** Worst-case debt tokens obtained per collateral token (minOut basis). Exactly 1 for same asset. */
  conversionRate: number;
  goal: UnwindGoal;
  /** Extra repay coin when the goal is zero debt (interest accrued until execution). */
  interestBufferFrac: number;
  maxIterations: number;
  stepSafety: number;
  minStepTokens?: number;
  /** Outflow rate limiter budget for all withdrawals of the tx (USD at the collateral's upper-bound price). */
  maxTotalWithdrawUsd?: number;
  /** Collateral upper-bound price (rate limiter valuation); defaults to collPrice. */
  collPriceHigh?: number;
  collDecimals: number;
  debtDecimals: number;
}

export interface UnwindStep {
  /** Collateral base units withdrawn (and swapped / repaid). */
  withdraw: bigint;
  /** Debt base units the swap must return at least (= withdraw for same asset). */
  minDebtOut: bigint;
}

export interface UnwindPlan {
  steps: UnwindStep[];
  feasible: boolean;
  reason?: string;
  finalCollateralTokens: number;
  finalDebtTokens: number;
  finalLtv: number;
  totalWithdrawUsd: number;
}

/**
 * De-lever: withdraw collateral -> (swap) -> repay, repeated. Each withdraw
 * must keep the obligation within `stepSafety` of its open-LTV limit at the
 * moment of the withdraw (Suilend checks health right after withdraw, before
 * the repay). Goal "debt" stops at targetDebtTokens (0 => repays with
 * interestBufferFrac extra; repay takes min(coin, debt) on-chain), goal "ltv"
 * stops once the worst-case spot LTV <= targetLtv.
 */
export function planUnwindSteps(i: UnwindPlanInput): UnwindPlan {
  if (!(i.conversionRate > 0)) throw new Error("planUnwindSteps: conversionRate must be > 0");
  const cScale = 10 ** i.collDecimals;
  const dScale = 10 ** i.debtDecimals;
  const minStep = Math.max(i.minStepTokens ?? 0, 1 / cScale);
  const bw = i.borrowWeight > 0 ? i.borrowWeight : 1;
  const pHighC = i.collPriceHigh ?? i.collPrice;
  let C = i.collateralTokens;
  let D = i.debtTokens;
  let repaid = 0;
  let withdrawUsd = 0;
  const steps: UnwindStep[] = [];
  // Debt goal: total repay coins needed. Full repay adds a buffer on the WHOLE
  // initial debt (interest accrues on all of it until execution; earlier coins
  // are consumed entirely, so the last coin must carry the buffer).
  const owed =
    i.goal.kind === "debt"
      ? Math.max(0, i.debtTokens - i.goal.targetDebtTokens) + (i.goal.targetDebtTokens <= 0 ? i.debtTokens * i.interestBufferFrac : 0)
      : 0;
  const wNeedOf = (): number => {
    if (i.goal.kind === "debt") return (owed - repaid) / i.conversionRate;
    // (D - w·r)·pD <= t·(C - w)·pC  =>  w >= (D·pD - t·C·pC) / (r·pD - t·pC)
    const t = i.goal.targetLtv;
    const den = i.conversionRate * i.debtPrice - t * i.collPrice;
    return den > 0 ? (D * i.debtPrice - t * C * i.collPrice) / den : Infinity;
  };
  // "done" once what is left to do is below one base unit of collateral
  const done = () => wNeedOf() * cScale < 1;
  const result = (feasible: boolean, reason?: string): UnwindPlan => ({
    steps,
    feasible,
    reason,
    finalCollateralTokens: C,
    finalDebtTokens: D,
    finalLtv: ltvOf(C, D, i.collPrice, i.debtPrice),
    totalWithdrawUsd: withdrawUsd,
  });
  if (i.goal.kind === "ltv" && !(i.conversionRate * i.debtPrice - i.goal.targetLtv * i.collPrice > 0)) {
    return result(false, `target LTV ${i.goal.targetLtv} unreachable with conversion rate ${i.conversionRate}`);
  }

  for (let k = 0; k < i.maxIterations && !done(); k++) {
    const wNeed = wNeedOf();
    const hasBorrows = D > 0 || (i.otherWeightedBorrowUsd ?? 0) > 0;
    const allowed = (C * i.collPriceLow * i.openLtv + (i.otherAllowedUsd ?? 0)) * i.stepSafety;
    const weighted = D * i.debtPriceHigh * bw + (i.otherWeightedBorrowUsd ?? 0);
    const wHealth = !hasBorrows || i.openLtv === 0 ? C : allowed > weighted ? (allowed - weighted) / (i.collPriceLow * i.openLtv * i.stepSafety) : 0;
    const wMax = Math.min(wHealth, C);
    if (!(Math.min(wNeed, wMax) >= minStep) && !(wNeed <= wMax)) {
      return result(false, wHealth < minStep ? "no withdraw headroom under the open-LTV limit (needs a flash loan or wallet funds to repay)" : "remaining step below dust");
    }
    // goal-binding steps round UP (so the goal is really reached), limit-binding ones round down
    const maxBase = BigInt(Math.floor(wMax * cScale * (1 - 1e-9)));
    const wBase = wNeed <= wMax ? (() => {
      const up = BigInt(Math.ceil(wNeed * cScale)) + 1n;
      return up <= maxBase ? up : maxBase;
    })() : maxBase;
    if (wBase <= 0n) return result(false, "remaining step below dust");
    const w = Number(wBase) / cScale;
    const outBase = BigInt(Math.floor(w * i.conversionRate * dScale));
    steps.push({ withdraw: wBase, minDebtOut: outBase });
    withdrawUsd += w * pHighC;
    if (i.maxTotalWithdrawUsd !== undefined && withdrawUsd > i.maxTotalWithdrawUsd) {
      return result(false, `withdrawals $${withdrawUsd.toFixed(0)} exceed the market outflow limit remaining $${i.maxTotalWithdrawUsd.toFixed(0)}`);
    }
    const out = Number(outBase) / dScale;
    C -= w;
    repaid += out;
    D = Math.max(0, D - out);
  }
  return done() ? result(true) : result(false, `goal not reached within ${i.maxIterations} iterations (raise limits.maxLoopIterations or deleverage first)`);
}

// ---------------------------------------------------------------------------
// Swap probing
// ---------------------------------------------------------------------------

export interface SwapProbe {
  /** costBps at the probe size. */
  costBpsAtProbe: number;
  /** Largest probed USD size with costBps <= budget (0 if even the probe exceeds it). */
  depthUsd: number;
}

/** Quote geometric sizes probeUsd, probeUsd·factor, … up to maxUsd and report the depth within `budgetBps`. */
export async function probeSwap(
  swapper: Pick<PtbSwapper, "quote">,
  from: AssetRef,
  to: AssetRef,
  fromPriceUsd: number,
  opts: { probeUsd: number; maxUsd: number; budgetBps: number; factor?: number }
): Promise<SwapProbe> {
  if (!(fromPriceUsd > 0)) throw new Error(`probeSwap: bad price for ${from.symbol}`);
  const factor = opts.factor ?? 4;
  let usd = opts.probeUsd;
  let costAtProbe: number | undefined;
  let depth = 0;
  // always quote the probe size at least once, then grow up to maxUsd
  for (;;) {
    const amountIn = toUnits(usd / fromPriceUsd, from.decimals);
    const q = await swapper.quote(from.address, to.address, amountIn);
    if (costAtProbe === undefined) costAtProbe = q.costBps;
    if (!(q.costBps <= opts.budgetBps) || q.amountOut <= 0n) break;
    depth = usd;
    usd *= factor;
    if (usd > opts.maxUsd * (1 + 1e-9)) break;
  }
  return { costBpsAtProbe: costAtProbe!, depthUsd: depth };
}

/** cTokens to withdraw so that redeeming yields at least `tokensBase` (ratio only grows with interest). */
export function ctokensFor(tokensBase: bigint, ctokenRatio: number, maxCtokens?: bigint): bigint {
  if (!(ctokenRatio > 0)) throw new Error("ctokensFor: bad ratio");
  const c = BigInt(Math.ceil(Number(tokensBase) / ctokenRatio)) + 1n;
  return maxCtokens !== undefined && c > maxCtokens ? maxCtokens : c;
}
