/**
 * Pure Morpho Blue math used by the adapter (no RPC). Everything in base
 * units (bigint); fractions as JS numbers at the edges and WAD inside.
 *
 * Conventions (Morpho Blue, also Lista Moolah):
 *  - oracle price is scaled by ORACLE_PRICE_SCALE (1e36) and already includes
 *    the decimals difference: loanUnits = collateralUnits * price / 1e36.
 *  - LTV = borrowAssets / (collateral * price / 1e36); liquidation at LTV > LLTV.
 *  - shares <-> assets use the virtual-shares math of SharesMathLib
 *    (SDK `SharesMath`, VIRTUAL_SHARES = 1e6, VIRTUAL_ASSETS = 1).
 *  - IRM rates are per-second, WAD-scaled; Morpho compounds them
 *    continuously (wTaylorCompounded), so rate * SECONDS_PER_YEAR is the
 *    nominal APR and exp(APR) - 1 the APY (SDK `MarketUtils.rateToApy`).
 */
import { AdaptiveCurveIrmLib, MathLib, ORACLE_PRICE_SCALE, SECONDS_PER_YEAR, SharesMath } from "@morpho-org/blue-sdk";
import type { IrmModel } from "@incentive-router/core";

export const WAD = MathLib.WAD;
export { ORACLE_PRICE_SCALE, SECONDS_PER_YEAR };

// ---------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------

/** number fraction -> WAD (1e-12 resolution). */
export function toWad(x: number): bigint {
  if (!Number.isFinite(x)) throw new Error(`toWad: not finite: ${x}`);
  return BigInt(Math.round(x * 1e12)) * 1_000_000n;
}

/** WAD -> number fraction. */
export function fromWad(x: bigint): number {
  return Number(x) / 1e18;
}

// ---------------------------------------------------------------------------
// Shares <-> assets (SDK SharesMath, identical to SharesMathLib.sol)
// ---------------------------------------------------------------------------

export interface MarketTotals {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  /** Protocol fee on interest, WAD. */
  fee: bigint;
}

/** What the borrower owes for `shares` (rounded up, as Morpho's repay-by-shares charges). */
export function borrowSharesToAssetsUp(shares: bigint, m: Pick<MarketTotals, "totalBorrowAssets" | "totalBorrowShares">): bigint {
  return SharesMath.toAssets(shares, m.totalBorrowAssets, m.totalBorrowShares, "Up");
}

/** Shares minted for borrowing `assets` (rounded up, as Morpho's borrow does). */
export function borrowAssetsToSharesUp(assets: bigint, m: Pick<MarketTotals, "totalBorrowAssets" | "totalBorrowShares">): bigint {
  return SharesMath.toShares(assets, m.totalBorrowAssets, m.totalBorrowShares, "Up");
}

/** Shares burned when repaying `assets` (rounded down, as Morpho's repay-by-assets does). */
export function borrowAssetsToSharesDown(assets: bigint, m: Pick<MarketTotals, "totalBorrowAssets" | "totalBorrowShares">): bigint {
  return SharesMath.toShares(assets, m.totalBorrowAssets, m.totalBorrowShares, "Down");
}

export function supplySharesToAssetsDown(shares: bigint, m: Pick<MarketTotals, "totalSupplyAssets" | "totalSupplyShares">): bigint {
  return SharesMath.toAssets(shares, m.totalSupplyAssets, m.totalSupplyShares, "Down");
}

/**
 * Accrue interest from `lastUpdate` to `nowTs` with the IRM's per-second
 * `ratePerSec` (what `borrowRateView` returns), like Morpho's _accrueInterest
 * (fee shares are not needed for borrower-side math and are omitted).
 */
export function accrueInterest(m: MarketTotals, ratePerSec: bigint, nowTs: bigint): MarketTotals {
  const elapsed = nowTs > m.lastUpdate ? nowTs - m.lastUpdate : 0n;
  if (elapsed === 0n || ratePerSec === 0n || m.totalBorrowAssets === 0n) return { ...m };
  const interest = MathLib.wMulDown(m.totalBorrowAssets, MathLib.wTaylorCompounded(ratePerSec, elapsed));
  return { ...m, totalBorrowAssets: m.totalBorrowAssets + interest, totalSupplyAssets: m.totalSupplyAssets + interest, lastUpdate: nowTs };
}

export function utilization(m: Pick<MarketTotals, "totalSupplyAssets" | "totalBorrowAssets">): number {
  if (m.totalSupplyAssets === 0n) return 0;
  return fromWad(MathLib.wDivDown(m.totalBorrowAssets, m.totalSupplyAssets));
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Per-second WAD rate -> nominal yearly APR (continuous compounding basis). */
export function ratePerSecondToApr(ratePerSec: bigint): number {
  return Number(ratePerSec * SECONDS_PER_YEAR) / 1e18;
}

/** Continuous-compounding APR -> APY (same as SDK MarketUtils.rateToApy on the per-second rate). */
export function aprToApyContinuous(apr: number): number {
  return Math.expm1(apr);
}

/** APY reported by an external source -> APR with `periodsPerYear` compounding (brief: daily). */
export function apyToApr(apy: number, periodsPerYear = 365): number {
  if (!(apy > -1)) throw new Error(`apyToApr: invalid apy ${apy}`);
  return periodsPerYear * (Math.pow(1 + apy, 1 / periodsPerYear) - 1);
}

/** Morpho supply APR from the borrow APR: borrow * utilization * (1 - fee). */
export function supplyAprFromBorrow(borrowApr: number, util: number, feeFrac: number): number {
  return borrowApr * util * (1 - feeFrac);
}

/**
 * The AdaptiveCurveIrm curve multiplier at utilization u (rate = rateAtTarget * factor):
 * linear from 1/4 at u=0 to 1 at u=0.9 (target) and to 4 at u=1 (CURVE_STEEPNESS = 4).
 */
export function adaptiveCurveFactor(u: number): number {
  const target = fromWad(AdaptiveCurveIrmLib.TARGET_UTILIZATION);
  const C = fromWad(AdaptiveCurveIrmLib.CURVE_STEEPNESS);
  const uc = Math.min(1, Math.max(0, u));
  if (uc <= target) {
    const err = (uc - target) / target; // in [-1, 0]
    return (1 - 1 / C) * err + 1;
  }
  const err = (uc - target) / (1 - target); // in (0, 1]
  return (C - 1) * err + 1;
}

/**
 * IrmModel for the core: the adaptive curve frozen at the CURRENT rate at
 * target r (APR): points [0, r/4], [0.9, r], [1, 4r]. The curve is exactly
 * piecewise linear in u for a fixed r, so the only approximation is that r
 * itself is frozen: on-chain r drifts exponentially (up to ~50x/yr speed)
 * while utilization stays away from 90% — above target the real borrow rate
 * keeps rising over time, below it keeps falling. `reserveFactor` = market fee.
 */
export function adaptiveCurveIrmModel(rateAtTargetApr: number, feeFrac: number): IrmModel {
  const r = Math.max(0, rateAtTargetApr);
  return { points: [[0, r / 4], [fromWad(AdaptiveCurveIrmLib.TARGET_UTILIZATION), r], [1, 4 * r]], reserveFactor: feeFrac };
}

// ---------------------------------------------------------------------------
// Oracle value / LTV
// ---------------------------------------------------------------------------

export function collateralValue(collateral: bigint, price: bigint, rounding: "Up" | "Down" = "Down"): bigint {
  return MathLib.mulDiv(collateral, price, ORACLE_PRICE_SCALE, rounding);
}

export function loanToCollateral(loan: bigint, price: bigint, rounding: "Up" | "Down" = "Down"): bigint {
  if (price <= 0n) throw new Error("loanToCollateral: oracle price is 0");
  return MathLib.mulDiv(loan, ORACLE_PRICE_SCALE, price, rounding);
}

/** debt / oracle value of collateral. 0 without debt, Infinity without collateral value. */
export function oracleLtv(collateral: bigint, debt: bigint, price: bigint): number {
  if (debt === 0n) return 0;
  const v = collateralValue(collateral, price);
  if (v === 0n) return Number.POSITIVE_INFINITY;
  return fromWad(MathLib.wDivUp(debt, v));
}

/** Morpho health factor = collateral value * LLTV / debt. undefined without debt. */
export function healthFactor(collateral: bigint, debt: bigint, price: bigint, lltv: bigint): number | undefined {
  if (debt === 0n) return undefined;
  return fromWad(MathLib.wDivDown(MathLib.wMulDown(collateralValue(collateral, price), lltv), debt));
}

// ---------------------------------------------------------------------------
// Loop planners (no flash loan: borrow -> swap -> re-supply iterations)
// ---------------------------------------------------------------------------

export interface LoopState {
  /** Collateral in the position, collateral-token units. */
  collateral: bigint;
  /** Debt in loan-token units (accrued, rounded up). */
  debt: bigint;
}

export type LoopStep =
  | { kind: "supplyCollateral"; assets: bigint }
  | { kind: "borrow"; assets: bigint }
  | { kind: "swapToCollateral"; loanIn: bigint; expectedCollateralOut: bigint }
  | { kind: "withdrawCollateral"; assets: bigint }
  | { kind: "swapToLoan"; collateralIn: bigint; expectedLoanOut: bigint }
  /** `all` = the step repays the whole debt (execute as repay-by-shares). */
  | { kind: "repay"; assets: bigint; all: boolean };

export interface PlanParams {
  /** Oracle price, ORACLE_PRICE_SCALE (see top of file). */
  price: bigint;
  /** Max LTV allowed at ANY intermediate point (right after a borrow / a withdraw). */
  stepLtvCap: number;
  /** Expected cost of each swap vs the oracle price, fraction (fees + impact). */
  swapCostFrac: number;
  maxIterations: number;
  /** Fork minimum (Lista minLoan): a non-zero debt must stay >= this. */
  minDebt?: bigint;
  /** Skip borrow / sell steps worth less than this, loan-token units (ignored for a full repay). */
  dust?: bigint;
  /** Max additional debt (market liquidity), loan-token units. */
  borrowLiquidity?: bigint;
  /** Oversell on a full repay so the swap output covers debt + slippage + accrual, bps. */
  sellBufferBps?: number;
  /** planLoopSteps: stop once LTV >= target - this (borrows never exceed the target, so it is approached geometrically). */
  ltvTolerance?: number;
}

export interface LoopPlan {
  steps: LoopStep[];
  /** Borrow (or sell) iterations in the plan. */
  iterations: number;
  final: LoopState;
  finalLtv: number;
  reachedTarget: boolean;
  /** Open: debt the target LTV needs. Unwind: debt to repay (D for "all"). */
  targetDebt: bigint;
  /** Unwind: loan tokens expected to stay in the wallet (oversell buffer). */
  leftoverLoan: bigint;
}

function checkParams(p: PlanParams): { s: bigint; c: bigint } {
  if (!(p.price > 0n)) throw new Error("plan: oracle price must be > 0");
  if (!(p.stepLtvCap > 0 && p.stepLtvCap < 1)) throw new Error(`plan: stepLtvCap ${p.stepLtvCap} not in (0,1)`);
  if (!(p.swapCostFrac >= 0 && p.swapCostFrac < 1)) throw new Error(`plan: swapCostFrac ${p.swapCostFrac} not in [0,1)`);
  if (!(Number.isInteger(p.maxIterations) && p.maxIterations >= 0)) throw new Error(`plan: maxIterations ${p.maxIterations}`);
  return { s: toWad(p.stepLtvCap), c: toWad(p.swapCostFrac) };
}

const minB = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));

/**
 * Lever up: optionally add `addCollateral`, then iterate borrow -> swap ->
 * supplyCollateral until LTV reaches `targetLtv` (or `maxIterations`).
 *
 * Final debt Dt solving Dt / (V + (Dt - D)(1-c)) = t:   Dt = (tV - t(1-c)D) / (1 - t(1-c)).
 * Each iteration borrows min(Dt - D, min(t, stepCap)*V - D, liquidity), so the
 * LTV right after ANY borrow (before the swap output is re-supplied) never
 * exceeds the target: a failed swap leaves the position at <= targetLtv.
 * The price is slower convergence: the remaining debt shrinks by t(1-c) per
 * iteration (t=0.80: ~12 iterations to get within 1pp, ~16 within 0.5pp),
 * hence `ltvTolerance` and the maxIterations cap.
 */
export function planLoopSteps(state: LoopState, addCollateral: bigint, targetLtv: number, p: PlanParams): LoopPlan {
  const { s, c } = checkParams(p);
  if (!(targetLtv >= 0 && targetLtv < 1)) throw new Error(`planLoopSteps: targetLtv ${targetLtv} not in [0,1)`);
  if (addCollateral < 0n) throw new Error("planLoopSteps: negative collateral");
  const t = toWad(targetLtv);
  const dust = p.dust ?? 0n;
  let C = state.collateral + addCollateral;
  let D = state.debt;
  const steps: LoopStep[] = [];
  if (addCollateral > 0n) steps.push({ kind: "supplyCollateral", assets: addCollateral });

  const k = MathLib.wMulDown(t, WAD - c);
  const tV = MathLib.wMulDown(t, collateralValue(C, p.price));
  const kD = MathLib.wMulDown(k, D);
  const target = tV > kD ? MathLib.mulDivDown(tV - kD, WAD, WAD - k) : 0n;
  let liquidity = p.borrowLiquidity ?? MathLib.MAX_UINT_256;

  let it = 0;
  // A remainder below `dust` (or within ltvTolerance) counts as reached only
  // once there is some debt (a position that could not borrow has not).
  const tol = p.ltvTolerance ?? 0;
  const done = () => D >= target || (D > 0n && (target - D <= dust || oracleLtv(C, D, p.price) >= targetLtv - tol));
  let reached = done();
  const capW = t < s ? t : s;
  while (!reached && it < p.maxIterations) {
    const capDebt = MathLib.wMulDown(capW, collateralValue(C, p.price));
    if (capDebt <= D) break;
    const b = minB(target - D, capDebt - D, liquidity);
    if (b === 0n || b <= dust) break;
    if (p.minDebt !== undefined && D + b < p.minDebt) break;
    const out = MathLib.wMulDown(loanToCollateral(b, p.price, "Down"), WAD - c);
    steps.push({ kind: "borrow", assets: b }, { kind: "swapToCollateral", loanIn: b, expectedCollateralOut: out });
    if (out > 0n) steps.push({ kind: "supplyCollateral", assets: out });
    D += b;
    C += out;
    liquidity -= b;
    it++;
    reached = done();
  }
  return { steps, iterations: it, final: { collateral: C, debt: D }, finalLtv: oracleLtv(C, D, p.price), reachedTarget: reached, targetDebt: target, leftoverLoan: 0n };
}

export type UnwindTarget =
  /** Deleverage to this LTV (sell collateral, repay). */
  | { kind: "ltv"; ltv: number }
  /** Close this fraction (0,1] of the position: repay f*D, remove f*C. 1 = fully closed. */
  | { kind: "fraction"; fraction: number }
  /**
   * Low level (what the live executor re-plans with): repay this much debt,
   * then remove collateral until `withdrawTotal` (INCLUDING what was sold) has
   * left the position. Omit `withdrawTotal` to only remove what is sold.
   */
  | { kind: "repay"; repay: bigint | "all"; withdrawTotal?: bigint | "all" };

export interface ResolvedUnwind {
  repay: bigint | "all";
  withdrawTotal?: bigint | "all";
}

function fractionOf(x: bigint, f: number): bigint {
  const ppm = BigInt(Math.round(f * 1_000_000));
  return (x * ppm) / 1_000_000n;
}

/** Map an UnwindTarget to absolute repay / withdraw amounts for `state`. */
export function resolveUnwindTarget(state: LoopState, target: UnwindTarget, p: PlanParams): ResolvedUnwind {
  const { c } = checkParams(p);
  const D = state.debt;
  const lowDebt = (left: bigint) => p.minDebt !== undefined && left > 0n && left < p.minDebt;
  if (target.kind === "repay") return { repay: target.repay, withdrawTotal: target.withdrawTotal };
  if (target.kind === "fraction") {
    const f = target.fraction;
    if (!(f > 0 && f <= 1)) throw new Error(`unwind: fraction ${f} not in (0,1]`);
    if (f >= 1) return { repay: "all", withdrawTotal: "all" };
    const r = fractionOf(D, f);
    return { repay: lowDebt(D - r) ? "all" : r, withdrawTotal: fractionOf(state.collateral, f) };
  }
  const t = toWad(target.ltv);
  if (!(target.ltv >= 0 && target.ltv < 1)) throw new Error(`unwind: ltv ${target.ltv} not in [0,1)`);
  const tV = MathLib.wMulDown(t, collateralValue(state.collateral, p.price));
  if (D <= tV) return { repay: 0n };
  if (target.ltv === 0) return { repay: "all" };
  // Sell s collateral (value x) -> x(1-c) loan, repay it:  (D - R) / (V - R/(1-c)) = t
  //   R = (D - tV) / (1 - t/(1-c))
  const q = MathLib.wDivUp(t, WAD - c);
  if (q >= WAD) return { repay: "all" };
  const r = MathLib.mulDivUp(D - tV, WAD, WAD - q);
  if (r >= D || lowDebt(D - r)) return { repay: "all" };
  return { repay: r };
}

/**
 * Unwind without a flash loan: iterate withdrawCollateral -> swap to loan ->
 * repay, each withdrawal keeping LTV <= stepLtvCap, then remove the rest of
 * `withdrawTotal`. Withdraw capacity grows by (1-c)/s per iteration.
 */
export function planUnwindSteps(state: LoopState, target: UnwindTarget, p: PlanParams): LoopPlan {
  const { s, c } = checkParams(p);
  const r = resolveUnwindTarget(state, target, p);
  const dust = p.dust ?? 0n;
  const buffer = BigInt(Math.max(0, Math.round(p.sellBufferBps ?? 0)));
  const repayAll = r.repay === "all";
  let C = state.collateral;
  let D = state.debt;
  const W = r.withdrawTotal;
  let remaining = repayAll ? D : minB(r.repay as bigint, D);
  const targetDebt = remaining;
  const steps: LoopStep[] = [];
  let it = 0;
  let withdrawn = 0n;
  let outSum = 0n;
  let repaidSum = 0n;
  const capWithdraw = () => {
    if (D === 0n) return C;
    const minColl = loanToCollateral(MathLib.mulDivUp(D, WAD, s), p.price, "Up");
    return C > minColl ? C - minColl : 0n;
  };
  if (!repayAll && remaining <= dust) remaining = 0n;

  while (remaining > 0n && it < p.maxIterations) {
    let need = loanToCollateral(MathLib.mulDivUp(remaining, WAD, WAD - c), p.price, "Up");
    if (repayAll) need = (need * (10_000n + buffer) + 9_999n) / 10_000n;
    let w = minB(need, capWithdraw(), C);
    if (typeof W === "bigint") w = minB(w, W > withdrawn ? W - withdrawn : 0n);
    if (w === 0n) break;
    const out = MathLib.wMulDown(collateralValue(w, p.price, "Down"), WAD - c);
    if (!repayAll && out <= dust) break;
    let rep = out >= D ? D : out;
    if (!repayAll && rep > remaining) rep = remaining;
    if (p.minDebt !== undefined) {
      const left = D - rep;
      if (left > 0n && left < p.minDebt) rep = out >= D ? D : D > p.minDebt ? D - p.minDebt : 0n;
    }
    if (rep === 0n) break;
    steps.push(
      { kind: "withdrawCollateral", assets: w },
      { kind: "swapToLoan", collateralIn: w, expectedLoanOut: out },
      { kind: "repay", assets: rep, all: rep === D }
    );
    C -= w;
    D -= rep;
    withdrawn += w;
    outSum += out;
    repaidSum += rep;
    remaining = repayAll ? D : remaining - rep;
    if (!repayAll && remaining <= dust) remaining = 0n;
    it++;
  }
  const reached = remaining === 0n;
  if (reached && W !== undefined) {
    let extra = W === "all" ? C : W > withdrawn ? W - withdrawn : 0n;
    extra = minB(extra, capWithdraw());
    if (extra > 0n) {
      steps.push({ kind: "withdrawCollateral", assets: extra });
      C -= extra;
    }
  }
  return {
    steps,
    iterations: it,
    final: { collateral: C, debt: D },
    finalLtv: oracleLtv(C, D, p.price),
    reachedTarget: reached,
    targetDebt,
    leftoverLoan: outSum - repaidSum,
  };
}

/** Sum of a step kind's amounts (collateral sold, loan borrowed ...). */
export function sumSteps(plan: LoopPlan, kind: LoopStep["kind"]): bigint {
  let s = 0n;
  for (const st of plan.steps) {
    if (st.kind !== kind) continue;
    if (st.kind === "swapToCollateral") s += st.loanIn;
    else if (st.kind === "swapToLoan") s += st.collateralIn;
    else s += st.assets;
  }
  return s;
}
