/**
 * Pure (SDK-free, I/O-free) Scallop helpers: amount planning for the flash-loan
 * loop PTBs, IRM / reward / LoopPair mapping, and position mapping. Everything
 * here is unit-tested offline (test/scallop.test.ts).
 *
 * Units: token amounts are base-unit bigint; prices USD per whole token;
 * APRs yearly fractions.
 *
 * Protocol facts encoded here (Scallop protocol Move sources, see report):
 *  - Obligation collateral is SEGREGATED: it sits in the obligation's balance
 *    bag, is never lent out and earns NO supply APR (only lending-pool
 *    deposits, i.e. sCoins, accrue interest). sCoins are not accepted as
 *    collateral (no risk model; SDK 5.4.3 has no sCoin-collateral path).
 *  - deposit_collateral aborts if the obligation already has that coin as
 *    debt, and borrow aborts if it has that coin as collateral, so SAME-ASSET
 *    LOOPS ARE IMPOSSIBLE; every Scallop loop is a two-asset pair with a swap.
 *  - Borrow check: sum(coll * price * collateralFactor) > sum(debt * price *
 *    borrowWeight) => max unweighted LTV = CF / borrowWeight; liquidation at
 *    LF / borrowWeight.
 *  - Borrow fee: fixed_point32::multiply_u64(amount, rate) (floor) split from
 *    the borrowed balance. Flash fee: mul_div(amount, rate, scale) + 1 when the
 *    rate is non-zero.
 */
import type { IrmModel, LoopLeg, LoopPair, RewardRate, SupplyMarket } from "@incentive-router/core";
import type { AssetRef, LoopPositionView } from "@incentive-router/live-common";

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

const SCALE = 1_000_000_000n; // 1e9 fixed point for fractions

export function fracToScaled(f: number): bigint {
  if (!Number.isFinite(f) || f < 0) throw new Error(`scallop: invalid fraction ${f}`);
  return BigInt(Math.round(f * 1e9));
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: non-positive divisor");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/** ceil(amount * frac) with frac as a float (rounded to 1e-9). */
export function mulFracCeil(amount: bigint, frac: number): bigint {
  return ceilDiv(amount * fracToScaled(frac), SCALE);
}

/** floor(amount * frac). */
export function mulFracFloor(amount: bigint, frac: number): bigint {
  return (amount * fracToScaled(frac)) / SCALE;
}

/** Float base units (SDK numbers) -> bigint, rounding as requested. */
export function unitsFromNumber(x: number, mode: "floor" | "ceil" = "floor"): bigint {
  if (!Number.isFinite(x) || x < 0) throw new Error(`scallop: invalid amount ${x}`);
  return BigInt(mode === "ceil" ? Math.ceil(x) : Math.floor(x));
}

/** The Scallop SDK takes u64 amounts as JS numbers in borrow/takeCollateral. Refuse anything not exactly representable. */
export function toSafeNumber(x: bigint, what: string): number {
  if (x < 0n || x > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`scallop: ${what} ${x} not representable as a safe JS number`);
  return Number(x);
}

const usdPerUnit = (priceUsd: number, decimals: number) => priceUsd / 10 ** decimals;

export function unitsUsd(units: bigint, priceUsd: number, decimals: number): number {
  return Number(units) * usdPerUnit(priceUsd, decimals);
}

/** The exact fee the protocol adds to a flash loan of `amount` (rate as a float). */
export function flashFee(amount: bigint, flashFeeFrac: number): bigint {
  if (amount <= 0n || !(flashFeeFrac > 0)) return 0n;
  return mulFracCeil(amount, flashFeeFrac) + 1n; // contract: floor(a*r/scale) + 1; we round up (never under-repay)
}

/** Smallest gross borrow B with B - floor(B*fee) >= need. +1 unit for float rounding of the fee. */
export function grossBorrowFor(need: bigint, borrowFeeFrac: number): bigint {
  if (need <= 0n) return 0n;
  const bf = fracToScaled(borrowFeeFrac);
  if (bf >= SCALE) throw new Error(`scallop: borrow fee ${borrowFeeFrac} >= 100%`);
  return ceilDiv(need * SCALE, SCALE - bf) + 1n;
}

export function ltvOf(collateral: bigint, debt: bigint, p: PlanPrices): number {
  const c = unitsUsd(collateral, p.collPriceUsd, p.collDecimals);
  const d = unitsUsd(debt, p.debtPriceUsd, p.debtDecimals);
  if (d <= 0) return 0;
  return c > 0 ? d / c : Infinity;
}

export interface PlanPrices {
  collPriceUsd: number;
  debtPriceUsd: number;
  collDecimals: number;
  debtDecimals: number;
}

function checkPrices(p: PlanPrices): void {
  if (!(p.collPriceUsd > 0) || !(p.debtPriceUsd > 0) || !Number.isFinite(p.collPriceUsd) || !Number.isFinite(p.debtPriceUsd)) {
    throw new Error(`scallop: invalid prices coll=${p.collPriceUsd} debt=${p.debtPriceUsd}`);
  }
}

/** Oracle-implied units of `to` per unit of `from` (no costs). */
export function oracleRate(fromPriceUsd: number, fromDecimals: number, toPriceUsd: number, toDecimals: number): number {
  return usdPerUnit(fromPriceUsd, fromDecimals) / usdPerUnit(toPriceUsd, toDecimals);
}

// ---------------------------------------------------------------------------
// Open (flash loan the DEBT asset -> swap -> deposit -> borrow -> repay flash)
// ---------------------------------------------------------------------------

export interface OpenPlanInput extends PlanPrices {
  /** Collateral units added from the wallet. */
  equity: bigint;
  collateralNow: bigint;
  debtNow: bigint;
  targetLtv: number;
  borrowFeeFrac: number;
  flashFeeFrac: number;
  /** Worst-case collateral base units out per debt base unit swapped (fees, impact AND slippage tolerance). */
  swapRateMin: number;
}

/**
 * Debt units to flash-borrow and swap into collateral so that, after
 * borrowing enough to repay the flash loan (+fees), LTV == targetLtv (using
 * the worst-case swap output). Returns 0 when the position (incl. the new
 * equity) is already at or above the target -> deposit only.
 *
 * t*(C0+E+F*r)*Cv = (D0 + F*k)*Dv,  k = (1+ff)/(1-bf)
 *   => F = (t*(C0+E)*Cv - D0*Dv) / (k*Dv - t*r*Cv)
 */
export function planOpenFlash(i: OpenPlanInput): bigint {
  checkPrices(i);
  if (!(i.targetLtv > 0 && i.targetLtv < 1)) throw new Error(`scallop: target LTV ${i.targetLtv} out of (0,1)`);
  if (!(i.swapRateMin > 0) || !Number.isFinite(i.swapRateMin)) throw new Error(`scallop: invalid swap rate ${i.swapRateMin}`);
  const Cv = usdPerUnit(i.collPriceUsd, i.collDecimals);
  const Dv = usdPerUnit(i.debtPriceUsd, i.debtDecimals);
  const k = (1 + i.flashFeeFrac) / (1 - i.borrowFeeFrac);
  const num = i.targetLtv * Number(i.collateralNow + i.equity) * Cv - Number(i.debtNow) * Dv;
  const den = k * Dv - i.targetLtv * i.swapRateMin * Cv;
  if (!(den > 0)) throw new Error("scallop: target LTV unreachable with these swap/fee costs");
  if (!(num > 0)) return 0n;
  return BigInt(Math.floor(num / den));
}

export interface OpenAmounts {
  flashAmount: bigint;
  flashRepay: bigint;
  /** Gross amount passed to borrow() (borrow fee is split from it on-chain). */
  borrowAmount: bigint;
  collateralAfterMin: bigint;
  debtAfter: bigint;
  ltvAfterWorst: number;
}

/** Exact amounts for a flash amount F whose swap is protected by `minSwapOut` (collateral units). */
export function openAmounts(i: OpenPlanInput, flashAmount: bigint, minSwapOut: bigint): OpenAmounts {
  checkPrices(i);
  const flashRepay = flashAmount > 0n ? flashAmount + flashFee(flashAmount, i.flashFeeFrac) : 0n;
  const borrowAmount = grossBorrowFor(flashRepay, i.borrowFeeFrac);
  const collateralAfterMin = i.collateralNow + i.equity + (flashAmount > 0n ? minSwapOut : 0n);
  const debtAfter = i.debtNow + borrowAmount;
  return { flashAmount, flashRepay, borrowAmount, collateralAfterMin, debtAfter, ltvAfterWorst: ltvOf(collateralAfterMin, debtAfter, i) };
}

// ---------------------------------------------------------------------------
// Deleverage / close (flash DEBT -> repay -> withdraw collateral -> swap -> repay flash)
// ---------------------------------------------------------------------------

export interface UnwindPlanInput extends PlanPrices {
  collateralNow: bigint;
  debtNow: bigint;
  flashFeeFrac: number;
  /** Worst-case debt base units out per collateral base unit swapped. */
  swapRateMin: number;
}

export interface UnwindPlan {
  /** Debt units flash-borrowed and repaid into the obligation (repay() refunds any excess over the debt). */
  repayAmount: bigint;
  flashRepay: bigint;
  /** Collateral units withdrawn from the obligation. */
  withdrawAmount: bigint;
  /** Part of the withdrawal swapped to the debt asset (minOut must cover flashRepay). */
  swapIn: bigint;
  /** Debt units the swap must deliver at minimum. */
  minSwapOut: bigint;
  /** Collateral units sent back to the wallet. */
  collateralToWallet: bigint;
  collateralAfter: bigint;
  debtAfter: bigint;
  ltvAfterWorst: number;
}

function swapInFor(need: bigint, rate: number): bigint {
  if (need <= 0n) return 0n;
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error(`scallop: invalid swap rate ${rate}`);
  return BigInt(Math.ceil(Number(need) / rate)) + 1n;
}

/**
 * Bring LTV down to `targetLtv`:
 *   t*(C0 - W)*Cv = (D0 - F)*Dv,  W = F*(1+ff)/s
 *   => F = (D0*Dv - t*C0*Cv) / (Dv - t*(1+ff)*Cv/s)
 */
export function planDeleverage(i: UnwindPlanInput & { targetLtv: number }): UnwindPlan {
  checkPrices(i);
  if (!(i.targetLtv >= 0 && i.targetLtv < 1)) throw new Error(`scallop: target LTV ${i.targetLtv} out of [0,1)`);
  const Cv = usdPerUnit(i.collPriceUsd, i.collDecimals);
  const Dv = usdPerUnit(i.debtPriceUsd, i.debtDecimals);
  const num = Number(i.debtNow) * Dv - i.targetLtv * Number(i.collateralNow) * Cv;
  const den = Dv - (i.targetLtv * (1 + i.flashFeeFrac) * Cv) / i.swapRateMin;
  if (!(den > 0)) throw new Error("scallop: target LTV unreachable with these swap/fee costs");
  let repay = num > 0 ? BigInt(Math.ceil(num / den)) : 0n;
  if (repay > i.debtNow) repay = i.debtNow;
  const flashRepay = repay > 0n ? repay + flashFee(repay, i.flashFeeFrac) : 0n;
  const swapIn = swapInFor(flashRepay, i.swapRateMin);
  if (swapIn > i.collateralNow) throw new Error("scallop: not enough collateral to cover the debt repayment (underwater or swap too costly)");
  const collateralAfter = i.collateralNow - swapIn;
  const debtAfter = i.debtNow - repay;
  return {
    repayAmount: repay,
    flashRepay,
    withdrawAmount: swapIn,
    swapIn,
    minSwapOut: flashRepay,
    collateralToWallet: 0n,
    collateralAfter,
    debtAfter,
    ltvAfterWorst: ltvOf(collateralAfter, debtAfter, i),
  };
}

/**
 * Unwind `fraction` of the position. fraction=1: repay the whole debt (plus
 * `debtBufferBps` for interest accrued until execution — repay() refunds the
 * excess to the sender) and withdraw all collateral. Partial: repay f*D,
 * withdraw up to f*C but never more than keeps LTV <= min(now, maxLtv*0.99)
 * (withdraw_collateral is checked against the collateral factor).
 */
export function planClose(i: UnwindPlanInput & { fraction: number; maxLtv: number; debtBufferBps: number }): UnwindPlan {
  checkPrices(i);
  if (!(i.fraction > 0 && i.fraction <= 1)) throw new Error(`scallop: close fraction ${i.fraction} out of (0,1]`);
  const full = i.fraction >= 1;
  let repay: bigint;
  if (i.debtNow <= 0n) repay = 0n;
  else if (full) repay = i.debtNow + mulFracCeil(i.debtNow, i.debtBufferBps / 10_000) + 1n;
  else repay = mulFracFloor(i.debtNow, i.fraction);
  const debtAfter = full ? 0n : i.debtNow - repay;

  let withdraw = full ? i.collateralNow : mulFracFloor(i.collateralNow, i.fraction);
  if (!full && debtAfter > 0n) {
    const cap = Math.min(ltvOf(i.collateralNow, i.debtNow, i), i.maxLtv * 0.99);
    if (!(cap > 0)) throw new Error("scallop: cannot size a partial withdrawal (no LTV headroom)");
    const Cv = usdPerUnit(i.collPriceUsd, i.collDecimals);
    const Dv = usdPerUnit(i.debtPriceUsd, i.debtDecimals);
    const minKeep = BigInt(Math.ceil((Number(debtAfter) * Dv) / (cap * Cv))) + 1n;
    const maxWithdraw = i.collateralNow > minKeep ? i.collateralNow - minKeep : 0n;
    if (withdraw > maxWithdraw) withdraw = maxWithdraw;
  }
  const flashRepay = repay > 0n ? repay + flashFee(repay, i.flashFeeFrac) : 0n;
  const swapIn = swapInFor(flashRepay, i.swapRateMin);
  if (swapIn > withdraw) throw new Error("scallop: withdrawn collateral cannot cover the debt repayment (underwater or swap too costly)");
  const collateralAfter = i.collateralNow - withdraw;
  return {
    repayAmount: repay,
    flashRepay,
    withdrawAmount: withdraw,
    swapIn,
    minSwapOut: flashRepay,
    collateralToWallet: withdraw - swapIn,
    collateralAfter,
    debtAfter,
    ltvAfterWorst: ltvOf(collateralAfter, debtAfter, i),
  };
}

/**
 * Next swap input when a quote's protected output (`quotedMinOut` for
 * `quotedIn`) has to reach `needOut`. Assumes locally linear pricing; a 2 bps
 * cushion absorbs curvature. Returns `quotedIn` when it already suffices.
 */
export function nextSwapIn(needOut: bigint, quotedIn: bigint, quotedMinOut: bigint): bigint {
  if (quotedMinOut >= needOut) return quotedIn;
  if (quotedMinOut <= 0n) throw new Error("scallop: swap quote returned no output");
  return ceilDiv(needOut * quotedIn * 10_002n, quotedMinOut * 10_000n) + 1n;
}

// ---------------------------------------------------------------------------
// Market mapping
// ---------------------------------------------------------------------------

/** Subset of the SDK MarketPool used here (SDK computes these from on-chain state; rates are APR). */
export interface PoolLike {
  coinName: string;
  coinPrice: number;
  coinDecimal: number;
  supplyCoin: number;
  borrowCoin: number;
  supplyAmount: number;
  borrowAmount: number;
  utilizationRate: number;
  supplyApr: number;
  borrowApr: number;
  baseBorrowApr: number;
  borrowAprOnMidKink: number;
  borrowAprOnHighKink: number;
  maxBorrowApr: number;
  midKink: number;
  highKink: number;
  reserveFactor: number;
  borrowWeight: number;
  borrowFee: number;
  minBorrowAmount: number;
  maxSupplyCoin: number;
  maxBorrowCoin: number;
  isIsolated: boolean;
}

export interface CollateralLike {
  coinName: string;
  coinPrice: number;
  coinDecimal: number;
  collateralFactor: number;
  liquidationFactor: number;
  depositCoin: number;
  maxDepositCoin: number;
  isIsolated: boolean;
}

export interface IncentivePointLike {
  symbol: string;
  coinName: string;
  coinType: string;
  /** Remaining undistributed reward points (base units of the reward coin). */
  points: number;
  accumulatedPoints: number;
  distributedPointPerSec: number;
  baseWeight: number;
  rewardApr: number;
}

export interface IncentivePoolLike {
  coinName: string;
  points: Partial<Record<string, IncentivePointLike>>;
}

const finiteOr0 = (x: number) => (Number.isFinite(x) ? x : 0);

/** Scallop's 3-kink interest model as IrmModel points (all APR). */
export function irmFromPool(p: PoolLike): IrmModel | undefined {
  const pts: [number, number][] = [
    [0, p.baseBorrowApr],
    [p.midKink, p.borrowAprOnMidKink],
    [p.highKink, p.borrowAprOnHighKink],
    [1, p.maxBorrowApr],
  ];
  if (!pts.every(([u, r]) => Number.isFinite(u) && Number.isFinite(r) && u >= 0 && u <= 1 && r >= 0)) return undefined;
  if (!(pts[1]![0] > 0 && pts[2]![0] > pts[1]![0] && pts[2]![0] < 1)) return undefined;
  if (!Number.isFinite(p.reserveFactor) || p.reserveFactor < 0 || p.reserveFactor >= 1) return undefined;
  return { points: pts, reserveFactor: p.reserveFactor };
}

/** Max boost of a borrow-incentive point: 1 / (baseWeight / 1e12) (SDK buildBorrowIncentiveRewards). */
export function maxBoostOf(point: IncentivePointLike): number {
  const scale = point.baseWeight / 1e12;
  return scale > 0 && Number.isFinite(scale) ? Math.max(1, 1 / scale) : 1;
}

/**
 * Borrow-incentive reward streams for one debt pool. `rewardApr` from the SDK
 * is the UNBOOSTED rate (veSCA boosts up to `maxBoost`); `boost` (>=1) is
 * applied capped at the point's max. Exhausted programs and the SDK's
 * Infinity sentinel map to nothing.
 */
export function borrowIncentiveRates(
  pool: IncentivePoolLike | undefined,
  nowMs: number,
  boost: number,
  exclude: { has(name: string): boolean } = new Set<string>()
): RewardRate[] {
  if (!pool) return [];
  const out: RewardRate[] = [];
  for (const point of Object.values(pool.points)) {
    if (!point || exclude.has(point.coinName)) continue;
    const remaining = point.points - finiteOr0(point.accumulatedPoints);
    const apr = finiteOr0(point.rewardApr);
    if (!(remaining > 0) || !(apr > 0)) continue;
    const b = Math.min(Math.max(1, Number.isFinite(boost) ? boost : 1), maxBoostOf(point));
    const perSec = finiteOr0(point.distributedPointPerSec);
    out.push({
      token: point.symbol || point.coinName,
      apr: apr * b,
      endsAtMs: perSec > 0 ? nowMs + Math.floor((remaining / perSec) * 1000) : null,
    });
  }
  return out;
}

export interface SwapProbe {
  costFrac: number;
  depthUsd: number;
}

export interface BuildPairInput {
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
  collateralMarket: CollateralLike;
  debtPool: PoolLike;
  incentive?: IncentivePoolLike;
  flashFeeFrac?: number;
  swap: SwapProbe;
  boost: number;
  rewardExclude?: { has(name: string): boolean };
  extra: { collateral: RewardRate[]; borrow: RewardRate[] };
  myLtv?: number;
  nowMs: number;
}

/**
 * Scallop pair -> core LoopPair, modelled truthfully:
 *  - collateral leg: the obligation-collateral "market" (segregated, not lent):
 *    totalSupplyUsd = total collateral deposited, totalBorrowUsd = 0,
 *    supplyAprBase = 0, no IRM, supply rewards = collateral-side incentives
 *    only (extraRewards side "collateral"); cap = max collateral - deposited.
 *  - debt leg: the debt asset's lending pool (supply/borrow totals, APRs, IRM,
 *    borrow fee, borrow cap = min(borrow-limit headroom, cash/2) — the flash
 *    route draws the pool twice), borrow
 *    rewards = borrow-incentive pools (+ extraRewards side "borrow").
 *  - maxLtv/liqLtv include the debt's borrow weight.
 *  - swapDepthUsd = min(swap depth, debt-pool free cash) (NaN = probe failed,
 *    unknown; still 0 when the pool has no cash): every unwind
 *    flash-borrows the debt from that pool's cash (collateral itself is
 *    segregated and always withdrawable), and the core derives pair exit
 *    capacity from swapDepthUsd/(L-1) — so the flash-loan cash limit binds
 *    there, alongside the real swap depth.
 */
export function buildScallopLoopPair(a: BuildPairInput): LoopPair {
  const cm = a.collateralMarket;
  const dp = a.debtPool;
  const cPrice = cm.coinPrice;
  const dPrice = dp.coinPrice;
  if (!(cPrice > 0) || !(dPrice > 0)) throw new Error(`scallop ${a.pairId}: missing oracle price (coll=${cPrice}, debt=${dPrice})`);
  const bw = dp.borrowWeight > 0 ? dp.borrowWeight : 1;

  const collateral: LoopLeg = {
    symbol: a.collateral.symbol,
    assetId: a.collateral.address,
    priceUsd: cPrice,
    totalSupplyUsd: Math.max(0, cm.depositCoin) * cPrice,
    totalBorrowUsd: 0,
    supplyAprBase: 0,
    borrowAprBase: 0,
    supplyRewards: [...a.extra.collateral],
    borrowRewards: [],
    supplyCapRemainingUsd: Math.max(0, cm.maxDepositCoin - cm.depositCoin) * cPrice,
  };

  const cash = Math.max(0, dp.supplyCoin - dp.borrowCoin);
  const borrowHeadroom = Math.max(0, dp.maxBorrowCoin - dp.borrowCoin);
  const debt: LoopLeg = {
    symbol: a.debt.symbol,
    assetId: a.debt.address,
    priceUsd: dPrice,
    totalSupplyUsd: Math.max(0, dp.supplyCoin) * dPrice,
    totalBorrowUsd: Math.max(0, dp.borrowCoin) * dPrice,
    supplyAprBase: finiteOr0(dp.supplyApr),
    borrowAprBase: finiteOr0(dp.borrowApr),
    supplyRewards: [],
    borrowRewards: [...borrowIncentiveRates(a.incentive, a.nowMs, a.boost, a.rewardExclude), ...a.extra.borrow],
    irm: irmFromPool(dp),
    supplyCapRemainingUsd: Math.max(0, dp.maxSupplyCoin - dp.supplyCoin) * dPrice,
    // open() flash-borrows F from this pool and then borrows ~F more before the
    // flash loan is repaid, so it needs ~2x cash: report what we can execute.
    borrowCapRemainingUsd: Math.min(borrowHeadroom, cash / 2) * dPrice,
    borrowFeeFrac: finiteOr0(dp.borrowFee),
  };

  const pair: LoopPair = {
    protocol: "scallop",
    chain: "sui",
    pairId: a.pairId,
    collateral,
    debt,
    maxLtv: cm.collateralFactor / bw,
    liqLtv: cm.liquidationFactor / bw,
    swapCostFrac: a.swap.costFrac,
    // NaN (probe failed = unknown) must stay NaN unless the cash limit is a known 0.
    swapDepthUsd: cash * dPrice <= 0 ? 0 : Number.isNaN(a.swap.depthUsd) ? NaN : Math.min(a.swap.depthUsd, cash * dPrice),
    dataAsOfMs: a.nowMs,
  };
  if (a.flashFeeFrac !== undefined && Number.isFinite(a.flashFeeFrac)) pair.flashloanFeeFrac = a.flashFeeFrac;
  if (a.myLtv !== undefined && Number.isFinite(a.myLtv)) pair.myLtv = a.myLtv;
  return pair;
}

// ---------------------------------------------------------------------------
// Position mapping
// ---------------------------------------------------------------------------

export interface ObligationRewardLike {
  coinName: string;
  symbol: string;
  coinDecimal: number;
  coinPrice: number;
  availableClaimAmount: number;
  availableClaimCoin: number;
  boostValue: number;
}

export interface ObligationAccountLike {
  totalRequiredCollateralValue: number;
  totalBorrowedValueWithWeight: number;
  collaterals: Partial<Record<string, { depositedAmount: number; depositedValue: number }>>;
  debts: Partial<Record<string, { borrowedAmount: number; borrowedValue: number; rewards: ObligationRewardLike[] }>>;
  borrowIncentives: Partial<Record<string, { rewards: ObligationRewardLike[] }>>;
}

export function claimableRewards(acct: ObligationAccountLike): ObligationRewardLike[] {
  const out: ObligationRewardLike[] = [];
  for (const bi of Object.values(acct.borrowIncentives)) {
    for (const r of bi?.rewards ?? []) if (r.availableClaimAmount >= 1) out.push(r);
  }
  return out;
}

/** Measured veSCA boost on the debt pool's incentive (1 = unboosted), undefined when no reward entries. */
export function measuredBoost(acct: ObligationAccountLike, debtName: string): number | undefined {
  const rs = acct.debts[debtName]?.rewards ?? acct.borrowIncentives[debtName]?.rewards ?? [];
  const vals = rs.map((r) => r.boostValue).filter((b) => Number.isFinite(b) && b > 0);
  return vals.length ? Math.max(...vals) : undefined;
}

export function positionFromAccount(acct: ObligationAccountLike, pairId: string, collName: string, debtName: string, asOfMs: number): LoopPositionView | null {
  const c = acct.collaterals[collName];
  const d = acct.debts[debtName];
  const collateralUsd = c?.depositedValue ?? 0;
  const debtUsd = d?.borrowedValue ?? 0;
  if (!((c?.depositedAmount ?? 0) > 0) && !((d?.borrowedAmount ?? 0) > 0)) return null;
  const view: LoopPositionView = {
    pairId,
    collateralUsd,
    debtUsd,
    ltv: collateralUsd > 0 ? debtUsd / collateralUsd : debtUsd > 0 ? Infinity : 0,
    equityUsd: collateralUsd - debtUsd,
    rewardsUnclaimed: claimableRewards(acct).map((r) => ({
      token: r.symbol || r.coinName,
      amount: BigInt(Math.floor(r.availableClaimAmount)),
      decimals: r.coinDecimal,
      usd: finiteOr0(r.availableClaimCoin * r.coinPrice),
    })),
    asOfMs,
  };
  if (acct.totalBorrowedValueWithWeight > 0) view.healthFactor = acct.totalRequiredCollateralValue / acct.totalBorrowedValueWithWeight;
  return view;
}

/**
 * Swap probe summary. Failed quotes (null) are unknowns, not "no depth":
 *  - every probe failed -> { costFrac: NaN, depthUsd: NaN } (core convention:
 *    NaN = unknown, the core keeps its last known value);
 *  - otherwise cost = cost at the smallest successful size and depth = the
 *    largest successful size within maxCostBps before the first successful
 *    size over budget (failed sizes are skipped; cost is monotone in size).
 */
export function summarizeSwapProbe(results: { sizeUsd: number; costBps: number | null }[], maxCostBps: number): SwapProbe {
  const ok = results
    .filter((r): r is { sizeUsd: number; costBps: number } => r.costBps !== null && Number.isFinite(r.costBps))
    .sort((x, y) => x.sizeUsd - y.sizeUsd);
  if (!ok.length) return { costFrac: NaN, depthUsd: NaN };
  let depth = 0;
  for (const r of ok) {
    if (r.costBps > maxCostBps) break;
    depth = r.sizeUsd;
  }
  return { costFrac: Math.max(0, ok[0]!.costBps) / 10_000, depthUsd: depth };
}

// ---------------------------------------------------------------------------
// Supply-only lending (deposit -> MarketCoin/sCoin, optional spool staking)
// ---------------------------------------------------------------------------
//
// Scallop lending: mint::mint(coin) -> MarketCoin<T> (1:1 lockable into the
// sCoin via mintSCoin). The interest accrues in the MarketCoin exchange rate:
// underlying = marketCoinUnits * conversionRate, conversionRate =
// (cash + debt - reserve) / marketCoinSupply (SDK calculateMarketPoolData).
// Spool staking locks the MarketCoin in a stake account to earn spool rewards.

/** Subset of the SDK Spool used here. */
export interface SpoolLike {
  marketCoinName: string;
  coinDecimal: number;
  rewardCoinType: string;
  rewardCoinDecimal: number;
  rewardCoinPrice: number;
  rewardApr: number;
  endDate: Date;
  maxPoint: number;
  distributedPoint: number;
  maxStake: number;
  stakedAmount: number;
  currentPointIndex: number;
  exchangeRateNumerator: number;
  exchangeRateDenominator: number;
}

export interface StakeAccountLike {
  id: string;
  staked: number;
  index: number;
  points: number;
}

/**
 * A spool we would stake into: whitelisted, not deprecated, still emitting
 * (end date in the future, undistributed points left, finite positive APR)
 * and not full.
 */
export function spoolIsLive(spool: SpoolLike | null | undefined, nowMs: number, flags: { whitelisted: boolean; deprecated: boolean }): boolean {
  if (!spool || !flags.whitelisted || flags.deprecated) return false;
  const end = spool.endDate instanceof Date ? spool.endDate.getTime() : NaN;
  return (
    Number.isFinite(end) &&
    end > nowMs &&
    spool.maxPoint > spool.distributedPoint &&
    Number.isFinite(spool.rewardApr) &&
    spool.rewardApr > 0 &&
    spool.stakedAmount < spool.maxStake
  );
}

/** Pending spool reward (reward-coin base units) for stake accounts; SDK buildLending formula. */
export function spoolPendingReward(spool: SpoolLike, accounts: StakeAccountLike[]): bigint {
  let total = 0;
  for (const a of accounts) {
    const rate = spool.currentPointIndex ? Math.max(0, (spool.currentPointIndex - a.index) / 1e9) : 1;
    const pts = a.staked * rate + a.points;
    total += spool.exchangeRateDenominator > 0 ? (pts * spool.exchangeRateNumerator) / spool.exchangeRateDenominator : 0;
  }
  return Number.isFinite(total) && total > 0 ? BigInt(Math.floor(total)) : 0n;
}

/** My lending position: market-coin units held as sCoin / legacy MarketCoin in the wallet and staked in spools. */
export interface SupplyHoldings {
  sCoin: bigint;
  marketCoin: bigint;
  staked: { accountId: string; units: bigint }[];
}

export function holdingUnits(h: SupplyHoldings): bigint {
  return h.sCoin + h.marketCoin + h.staked.reduce((a, s) => a + s.units, 0n);
}

/** Underlying base units for market-coin units at the pool's conversion rate. */
export function underlyingOf(marketUnits: bigint, conversionRate: number): bigint {
  if (!(conversionRate > 0) || !Number.isFinite(conversionRate)) throw new Error(`scallop: invalid conversion rate ${conversionRate}`);
  return mulFracFloor(marketUnits, conversionRate);
}

export interface WithdrawPlan {
  sCoin: bigint;
  marketCoin: bigint;
  unstake: { accountId: string; units: bigint }[];
  /** Total market-coin units redeemed. */
  units: bigint;
}

/** Withdraw `fraction` of every source (1 = everything, no dust). */
export function planWithdraw(h: SupplyHoldings, fraction: number): WithdrawPlan {
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`scallop: withdraw fraction ${fraction} out of (0,1]`);
  const take = (x: bigint) => (fraction >= 1 ? x : mulFracFloor(x, fraction));
  const unstake = h.staked.map((s) => ({ accountId: s.accountId, units: take(s.units) })).filter((s) => s.units > 0n);
  const plan = { sCoin: take(h.sCoin), marketCoin: take(h.marketCoin), unstake, units: 0n };
  plan.units = plan.sCoin + plan.marketCoin + unstake.reduce((a, s) => a + s.units, 0n);
  return plan;
}

export interface BuildSupplyInput {
  marketId: string;
  asset: AssetRef;
  pool: PoolLike & { conversionRate: number };
  /** Spool data when we stake (live spool); undefined = not staking. */
  spool?: SpoolLike;
  spoolRewardToken?: string;
  /**
   * Spool rewards accrue only on what is staked, and a spool has a global
   * stake cap: my rewarded basis is at most (my staked + remaining spool
   * room). Passed through as the reward's perUserCapUsd.
   */
  spoolCapUsd?: number;
  /**
   * USD currently staked in the spool: spool rewards are shared among spool
   * stakers, not the whole lending pool, so the core dilutes them over this
   * (RewardRate.basisUsd) instead of totalSupplyUsd.
   */
  spoolBasisUsd?: number;
  extra: RewardRate[];
  paused: boolean;
  myDepositUsd?: number;
  note?: string;
  nowMs: number;
}

/**
 * Scallop lending pool -> core SupplyMarket. Base APR is the pool's supply APR
 * (SDK: borrowApr * utilization * (1 - reserveFactor), an APR); spool rewards
 * only when this adapter stakes the deposit; withdrawable = pool cash.
 */
export function buildScallopSupplyMarket(a: BuildSupplyInput): SupplyMarket {
  const p = a.pool;
  const price = p.coinPrice;
  if (!(price > 0)) throw new Error(`scallop ${a.marketId}: missing oracle price`);
  const rewards: RewardRate[] = [];
  if (a.spool) {
    const apr = finiteOr0(a.spool.rewardApr);
    if (apr > 0) {
      const r: RewardRate = { token: a.spoolRewardToken ?? a.spool.rewardCoinType, apr, endsAtMs: a.spool.endDate.getTime() };
      if (a.spoolCapUsd !== undefined && Number.isFinite(a.spoolCapUsd)) r.perUserCapUsd = Math.max(0, a.spoolCapUsd);
      if (a.spoolBasisUsd !== undefined && Number.isFinite(a.spoolBasisUsd) && a.spoolBasisUsd > 0) r.basisUsd = a.spoolBasisUsd;
      rewards.push(r);
    }
  }
  rewards.push(...a.extra);
  const m: SupplyMarket = {
    protocol: "scallop",
    chain: "sui",
    marketId: a.marketId,
    asset: { symbol: a.asset.symbol, assetId: a.asset.address, priceUsd: price },
    totalSupplyUsd: Math.max(0, p.supplyCoin) * price,
    totalBorrowUsd: Math.max(0, p.borrowCoin) * price,
    supplyAprBase: finiteOr0(p.supplyApr),
    rewards,
    withdrawableUsd: Math.max(0, p.supplyCoin - p.borrowCoin) * price,
    supplyCapRemainingUsd: Math.max(0, p.maxSupplyCoin - p.supplyCoin) * price,
    paused: a.paused,
    dataAsOfMs: a.nowMs,
    note: a.note ?? (a.spool ? "Scallop lending (MarketCoin staked in spool)" : "Scallop lending (sCoin held in wallet)"),
  };
  const irm = irmFromPool(p);
  if (irm) m.irm = irm;
  if (a.myDepositUsd !== undefined) m.myDepositUsd = a.myDepositUsd;
  return m;
}

export interface SpoolStakePlan {
  /** Market-coin units to stake (0 = do not stake). */
  stakeUnits: bigint;
  /** Burn + restake the sCoin / MarketCoin already held (only when room is left after the new deposit). */
  includeExisting: boolean;
  /** Everything (new + included existing) fits: stake the merged coin whole, no split. */
  stakeAll: boolean;
}

/**
 * How much of a deposit (and of what is already held unstaked) goes into the
 * spool, never beyond 99% of its remaining capacity (the spool aborts above
 * max stake; the 1% absorbs the conversion-rate move until execution).
 * `newUnitsLb` = a LOWER bound of the market-coin units the mint will return.
 */
export function planSpoolStake(i: { newUnitsLb: bigint; existingUnits: bigint; roomUnits: bigint }): SpoolStakePlan {
  const room = mulFracFloor(i.roomUnits > 0n ? i.roomUnits : 0n, 0.99);
  if (room <= 0n || i.newUnitsLb <= 0n) return { stakeUnits: 0n, includeExisting: false, stakeAll: false };
  const includeExisting = i.existingUnits > 0n && room > i.newUnitsLb;
  const total = i.newUnitsLb + (includeExisting ? i.existingUnits : 0n);
  return total <= room ? { stakeUnits: total, includeExisting, stakeAll: true } : { stakeUnits: room, includeExisting, stakeAll: false };
}

/** Lower bound of market-coin units minted for `amount` underlying (0.1% under the read conversion rate). */
export function mintedUnitsLowerBound(amount: bigint, conversionRate: number): bigint {
  if (!(conversionRate > 0) || !Number.isFinite(conversionRate)) throw new Error(`scallop: invalid conversion rate ${conversionRate}`);
  return BigInt(Math.floor((Number(amount) / conversionRate) * 0.999));
}
