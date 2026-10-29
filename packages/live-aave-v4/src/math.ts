/**
 * Pure Aave V4 math — no I/O, fully unit-tested.
 *
 * Protocol facts used here (all from aave/aave-v4 @ a3ef63e, v0.5.11):
 *  - Health factor = sum(collateralValue_i * CF_i) / debtValue (Spoke._processUserAccountData).
 *    There is NO separate liquidation threshold: borrow / withdraw require
 *    HF >= 1.0 (HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18), so the collateral
 *    factor is both the max LTV and the liquidation LTV (also stated by the
 *    AaveKit schema: "Also the liquidation boundary").
 *  - Risk premium (BPS) = debt-weighted collateralRisk of the collaterals that
 *    cover the debt, lowest risk first. With a single collateral that covers
 *    the whole debt it is exactly that reserve's collateralRisk.
 *  - Premium debt = drawnShares * RP grows with the drawn index, so the
 *    position's borrow APR = drawnRate * (1 + RP).
 *  - drawnRate is a per-year RAY rate accrued linearly between updates (an APR).
 *  - IRM (AssetInterestRateStrategy): u = drawn / (liquidity + drawn + swept);
 *    r = base + g1 * u / opt (u <= opt), base + g1 + g2 * (u - opt) / (1 - opt).
 *  - Value units: 1e26 = 1 USD (SpokeUtils.toValue, 8-decimal oracle prices).
 */
import type { IrmModel } from "@incentive-router/core";

export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;
export const MAX_UINT256 = (1n << 256n) - 1n;
/** SOURCE: src/hub/Hub.sol MAX_ALLOWED_SPOKE_CAP = type(uint40).max (= no cap). */
export const MAX_SPOKE_CAP = (1n << 40n) - 1n;
/** SOURCE: src/spoke/libraries/SpokeUtils.sol toValue — 1e26 represents 1 USD. */
export const VALUE_PER_USD = 10n ** 26n;
/** SOURCE: SpokeUtils.ORACLE_DECIMALS. */
export const ORACLE_DECIMALS = 8;
/** open() refuses targets above this fraction of the collateral factor. */
export const MAX_TARGET_FRAC_OF_MAX_LTV = 0.95;

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

/** Exact-ish bigint / 10^d -> number (keeps 18 significant fractional digits). */
export function toHuman(units: bigint, decimals: number): number {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const v = Number(u / base) + Number(u % base) / Number(base);
  return neg ? -v : v;
}

/** floor(human * 10^d); 0 for non-positive / non-finite input. */
export function fromHumanFloor(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human <= 0) return 0n;
  const s = human.toFixed(Math.min(decimals, 18) + 2);
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function rayToNumber(x: bigint): number {
  return toHuman(x, 27);
}

export function bpsToFrac(bps: bigint | number): number {
  return Number(bps) / 10_000;
}

/** WAD health factor -> number; uint256.max (no debt) -> Infinity. */
export function wadToHealthFactor(hf: bigint): number {
  if (hf >= MAX_UINT256 / 2n) return Infinity;
  return toHuman(hf, 18);
}

export function valueToUsd(value: bigint): number {
  return toHuman(value, 26);
}

export function valueRayToUsd(valueRay: bigint): number {
  return toHuman(valueRay, 53);
}

export function oraclePriceToUsd(price: bigint, decimals = ORACLE_DECIMALS): number {
  return toHuman(price, decimals);
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * APY -> APR with `periodsPerYear` compounding (brief rule 8: daily). AaveKit
 * reports per-second-compounded APYs; daily conversion differs from the
 * continuous ln(1+apy) by < 0.01% abs at 10% APY.
 */
export function apyToApr(apy: number, periodsPerYear = 365): number {
  if (!Number.isFinite(apy) || apy <= -1) throw new Error(`apyToApr: invalid apy ${apy}`);
  return periodsPerYear * (Math.pow(1 + apy, 1 / periodsPerYear) - 1);
}

/** Borrow APR paid by a position with risk premium `riskPremiumFrac` (e.g. 0.5 = 50% on top of the drawn rate). */
export function borrowAprWithRiskPremium(drawnApr: number, riskPremiumFrac: number): number {
  if (!(riskPremiumFrac >= 0) || !Number.isFinite(riskPremiumFrac)) throw new Error(`invalid risk premium ${riskPremiumFrac}`);
  return drawnApr * (1 + riskPremiumFrac);
}

/**
 * Hub supply APR: interest on drawn + premium debt (both grow with the drawn
 * index) net of the liquidity fee, spread over all added assets. Premium is
 * the outstanding premium debt (slightly below premiumShares * index), which
 * makes this a lower bound — conservative for the supply leg.
 */
export function hubSupplyApr(p: { drawnRateRay: bigint; drawn: bigint; premium: bigint; addedAssets: bigint; liquidityFeeBps: number }): number {
  if (p.addedAssets <= 0n) return 0;
  const r = rayToNumber(p.drawnRateRay);
  const owed = Number(p.drawn + p.premium);
  const added = Number(p.addedAssets);
  return (r * owed * (1 - bpsToFrac(p.liquidityFeeBps))) / added;
}

/** On-chain InterestRateData (BPS) -> piecewise-linear borrow IRM, borrow rates scaled by `borrowMultiplier` (1 + risk premium). */
export function irmFromRateData(
  d: { optimalUsageRatio: number; baseDrawnRate: number; rateGrowthBeforeOptimal: number; rateGrowthAfterOptimal: number },
  liquidityFeeBps: number,
  borrowMultiplier = 1
): IrmModel | undefined {
  const opt = bpsToFrac(d.optimalUsageRatio);
  if (!(opt > 0 && opt < 1)) return undefined;
  const base = bpsToFrac(d.baseDrawnRate);
  const g1 = bpsToFrac(d.rateGrowthBeforeOptimal);
  const g2 = bpsToFrac(d.rateGrowthAfterOptimal);
  const m = borrowMultiplier;
  return {
    points: [
      [0, base * m],
      [opt, (base + g1) * m],
      [1, (base + g1 + g2) * m],
    ],
    reserveFactor: bpsToFrac(liquidityFeeBps),
  };
}

/** Remaining room under a spoke cap given in WHOLE tokens; null = uncapped (MAX_SPOKE_CAP). */
export function capRemaining(capWholeTokens: bigint, decimals: number, current: bigint): bigint | null {
  if (capWholeTokens >= MAX_SPOKE_CAP) return null;
  const cap = capWholeTokens * 10n ** BigInt(decimals);
  return cap > current ? cap - current : 0n;
}

// ---------------------------------------------------------------------------
// Loop planner (open)
// ---------------------------------------------------------------------------

export interface LoopPlanOptions {
  collateralDecimals: number;
  debtDecimals: number;
  /** Swap cost debt -> collateral as a fraction of the amount (fees + impact vs protocol oracle). */
  swapCostFrac?: number;
  /** Smallest borrow worth an iteration (debt base units). Default 1. */
  minBorrow?: bigint;
  existingCollateral?: bigint;
  existingDebt?: bigint;
  sameAsset?: boolean;
}

export type LoopStep =
  | { kind: "supply"; amount: bigint }
  | { kind: "borrow"; amount: bigint; ltvAfter: number }
  | { kind: "swap"; amountIn: bigint; expectedOut: bigint };

export interface LoopPlan {
  steps: LoopStep[];
  iterations: number;
  totalBorrowed: bigint;
  totalSupplied: bigint;
  finalCollateral: bigint;
  finalDebt: bigint;
  finalLtv: number;
  /** Highest LTV in any intermediate state (always right after a borrow). Never above targetLtv. */
  maxLtvSeen: number;
}

/** Debt (human units) that may be added at collateral Ch, debt Dh so that LTV = t. priceRatio r = collateral price / debt price. */
export function nextLoopBorrow(Ch: number, Dh: number, t: number, r: number): number {
  return Math.max(0, t * Ch * r - Dh);
}

export function validateTargetLtv(targetLtv: number, maxLtv: number): void {
  if (!(targetLtv > 0 && targetLtv < 1)) throw new Error(`targetLtv must be in (0,1), got ${targetLtv}`);
  if (!(maxLtv > 0 && maxLtv < 1)) throw new Error(`maxLtv must be in (0,1), got ${maxLtv}`);
  if (targetLtv > maxLtv * MAX_TARGET_FRAC_OF_MAX_LTV + 1e-12)
    throw new Error(
      `targetLtv ${targetLtv} exceeds ${MAX_TARGET_FRAC_OF_MAX_LTV} x collateral factor ${maxLtv} (= ${(maxLtv * MAX_TARGET_FRAC_OF_MAX_LTV).toFixed(4)})`
    );
}

/**
 * Greedy iterative loop: supply equity, then repeat borrow -> swap -> supply,
 * each borrow taking LTV exactly up to (never above) `targetLtv`. Converges
 * geometrically to D = t*C0*r / (1 - t*(1-s)).
 *
 * `priceRatio` = collateral price / debt price (protocol oracle), so
 * LTV = debt_h / (collateral_h * priceRatio).
 */
export function planLoopSteps(
  equity: bigint,
  targetLtv: number,
  maxLtv: number,
  priceRatio: number,
  maxIterations: number,
  opts: LoopPlanOptions
): LoopPlan {
  validateTargetLtv(targetLtv, maxLtv);
  if (!(priceRatio > 0 && Number.isFinite(priceRatio))) throw new Error(`invalid priceRatio ${priceRatio}`);
  if (equity < 0n) throw new Error("negative equity");
  const same = opts.sameAsset ?? false;
  const s = same ? 0 : (opts.swapCostFrac ?? 0);
  if (!(s >= 0 && s < 0.5)) throw new Error(`invalid swapCostFrac ${s}`);
  if (same && Math.abs(priceRatio - 1) > 1e-12) throw new Error("same-asset loop needs priceRatio 1");
  const dc = opts.collateralDecimals;
  const dd = opts.debtDecimals;
  const minBorrow = opts.minBorrow ?? 1n;
  const r = priceRatio;

  const steps: LoopStep[] = [];
  let Cu = (opts.existingCollateral ?? 0n) + equity;
  let Du = opts.existingDebt ?? 0n;
  if (equity > 0n) steps.push({ kind: "supply", amount: equity });
  let totalBorrowed = 0n;
  let totalSupplied = equity;
  let iterations = 0;
  const ltvOf = (c: bigint, d: bigint) => {
    const cv = toHuman(c, dc) * r;
    return cv > 0 ? toHuman(d, dd) / cv : d > 0n ? Infinity : 0;
  };
  let maxLtvSeen = ltvOf(Cu, Du);

  for (let i = 0; i < Math.max(0, Math.floor(maxIterations)); i++) {
    // 1e-9 relative haircut: float rounding can never push us over the target
    const b = nextLoopBorrow(toHuman(Cu, dc), toHuman(Du, dd), targetLtv, r) * (1 - 1e-9);
    const bu = fromHumanFloor(b, dd);
    if (bu <= 0n || bu < minBorrow) break;
    Du += bu;
    const ltvAfter = ltvOf(Cu, Du);
    maxLtvSeen = Math.max(maxLtvSeen, ltvAfter);
    steps.push({ kind: "borrow", amount: bu, ltvAfter });
    let out: bigint;
    if (same) out = bu;
    else {
      out = fromHumanFloor((toHuman(bu, dd) * (1 - s)) / r, dc);
      steps.push({ kind: "swap", amountIn: bu, expectedOut: out });
    }
    if (out > 0n) steps.push({ kind: "supply", amount: out });
    Cu += out;
    totalBorrowed += bu;
    totalSupplied += out;
    iterations++;
  }
  return {
    steps,
    iterations,
    totalBorrowed,
    totalSupplied,
    finalCollateral: Cu,
    finalDebt: Du,
    finalLtv: ltvOf(Cu, Du),
    maxLtvSeen,
  };
}

// ---------------------------------------------------------------------------
// Unwind planner (close / deleverage)
// ---------------------------------------------------------------------------

export type UnwindGoal =
  | { kind: "close" }
  /** Remove `fraction` of the position measured at the start (debt -> (1-f) D0, collateral -> (1-f) C0). */
  | { kind: "fraction"; fraction: number; startCollateral: bigint; startDebt: bigint }
  | { kind: "ltv"; targetLtv: number };

export interface UnwindParams {
  collateralDecimals: number;
  debtDecimals: number;
  /** collateral price / debt price (protocol oracle). */
  priceRatio: number;
  /** Collateral factor that will apply after the next withdraw (min(pinned, latest)). */
  liqLtv: number;
  /** HF kept right after each withdraw, before the swap + repay. >= 1.01 recommended. */
  minHealthFactor: number;
  /**
   * Lower floor used ONLY when `minHealthFactor` allows no progress (LTV
   * already above CF / minHealthFactor, e.g. after a price move): every step
   * still lowers the LTV afterwards, so refusing to unwind would be worse.
   * Must be >= 1. Omit (or set = minHealthFactor) to disable.
   */
  emergencyMinHealthFactor?: number;
  /** Swap cost collateral -> debt (fraction). */
  swapCostFrac: number;
  /** Extra collateral withdrawn on the repay that should clear the debt (interest accrual + slippage). Default 0.002. */
  repayBufferFrac?: number;
  sameAsset?: boolean;
}

export type UnwindStep =
  | { kind: "withdraw-repay"; withdraw: bigint; expectedRepay: bigint; ltvAfterWithdraw: number; ltvAfterRepay: number; emergency?: boolean }
  /** Final collateral withdrawal; "max" = whole balance (Spoke.withdraw caps amounts above the balance). */
  | { kind: "withdraw"; withdraw: bigint | "max"; ltvAfter: number }
  | { kind: "done" }
  | { kind: "stuck"; reason: string };

/** One step of an unwind from the CURRENT state (the live loop re-reads chain state before each step). */
export function unwindStep(C: bigint, D: bigint, goal: UnwindGoal, p: UnwindParams): UnwindStep {
  const dc = p.collateralDecimals;
  const dd = p.debtDecimals;
  const r = p.priceRatio;
  if (!(r > 0 && Number.isFinite(r))) return { kind: "stuck", reason: `invalid priceRatio ${r}` };
  if (!(p.liqLtv > 0 && p.liqLtv < 1)) return { kind: "stuck", reason: `invalid collateral factor ${p.liqLtv}` };
  if (!(p.minHealthFactor >= 1)) return { kind: "stuck", reason: `minHealthFactor must be >= 1, got ${p.minHealthFactor}` };
  const eff = p.sameAsset ? 1 : 1 - p.swapCostFrac;
  if (!(eff > 0.5 && eff <= 1)) return { kind: "stuck", reason: `invalid swapCostFrac ${p.swapCostFrac}` };
  const buffer = p.repayBufferFrac ?? 0.002;

  const Cv = toHuman(C, dc) * r; // collateral value in debt units
  const Dh = toHuman(D, dd);
  const ltvNow = Cv > 0 ? Dh / Cv : D > 0n ? Infinity : 0;
  const stepCap = p.liqLtv / p.minHealthFactor;

  // How much debt (debt units) still has to go.
  let needRepay: number;
  if (goal.kind === "close") needRepay = Dh;
  else if (goal.kind === "fraction") {
    if (!(goal.fraction > 0 && goal.fraction <= 1)) return { kind: "stuck", reason: `fraction out of range ${goal.fraction}` };
    needRepay = Dh - (1 - goal.fraction) * toHuman(goal.startDebt, dd);
  } else {
    if (!(goal.targetLtv >= 0 && goal.targetLtv < 1)) return { kind: "stuck", reason: `invalid targetLtv ${goal.targetLtv}` };
    if (ltvNow <= goal.targetLtv + 1e-9) return { kind: "done" };
    if (!(eff > goal.targetLtv)) return { kind: "stuck", reason: `swap efficiency ${eff} <= target LTV ${goal.targetLtv}` };
    // (Dh - w*eff) / (Cv - w) = t  =>  w = (Dh - t*Cv) / (eff - t)
    needRepay = ((Dh - goal.targetLtv * Cv) / (eff - goal.targetLtv)) * eff;
  }
  const debtDust = toHuman(1n, dd);

  // A full close only withdraws "max" once the debt is exactly 0 (1 wei of debt would fail the HF check).
  if (D === 0n || (goal.kind !== "close" && needRepay <= debtDust)) {
    if (goal.kind === "close") return C > 0n ? { kind: "withdraw", withdraw: "max", ltvAfter: 0 } : { kind: "done" };
    if (goal.kind === "fraction") {
      const targetC = toHuman(goal.startCollateral, dc) * (1 - goal.fraction) * r;
      const startCv = toHuman(goal.startCollateral, dc) * r;
      const startLtv = startCv > 0 ? toHuman(goal.startDebt, dd) / startCv : 0;
      const ltvKeep = Math.min(stepCap, Math.max(startLtv, 1e-12));
      const floorByLtv = Dh > 0 ? Dh / ltvKeep : 0;
      const w = Cv - Math.max(targetC, floorByLtv);
      const wu = fromHumanFloor(w / r, dc);
      if (wu <= 0n) return { kind: "done" };
      const wuc = wu > C ? C : wu;
      const left = Cv - toHuman(wuc, dc) * r;
      return { kind: "withdraw", withdraw: wuc, ltvAfter: left > 0 ? Dh / left : 0 };
    }
    return { kind: "done" };
  }

  if (!(Cv > 0)) return { kind: "stuck", reason: "debt without collateral" };
  let wMax = Cv - Dh / stepCap;
  let emergency = false;
  const em = p.emergencyMinHealthFactor;
  if (!(wMax > 0) && em !== undefined && em >= 1 && em < p.minHealthFactor && ltvNow < eff) {
    wMax = Cv - Dh / (p.liqLtv / em);
    emergency = wMax > 0;
  }
  if (!(wMax > 0))
    return {
      kind: "stuck",
      reason: `LTV ${ltvNow.toFixed(4)} >= per-step cap ${stepCap.toFixed(4)} (CF ${p.liqLtv} / min HF ${p.minHealthFactor}${em !== undefined ? `, emergency ${em}` : ""}); repay from wallet first`,
    };
  const repayTarget = Math.min(needRepay, Dh);
  const wNeed = goal.kind === "ltv" ? repayTarget / eff : (repayTarget * (1 + buffer)) / eff;
  const w = Math.min(wMax, wNeed, Cv);
  const wu = fromHumanFloor(w / r, dc);
  if (wu <= 0n) return { kind: "stuck", reason: "withdraw amount rounds to 0" };
  const wv = toHuman(wu, dc) * r;
  const rep = Math.min(Dh, wv * eff);
  const left = Cv - wv;
  const step: UnwindStep = {
    kind: "withdraw-repay",
    withdraw: wu,
    expectedRepay: fromHumanFloor(rep, dd),
    ltvAfterWithdraw: left > 0 ? Dh / left : Infinity,
    ltvAfterRepay: left > 0 ? (Dh - rep) / left : 0,
  };
  if (emergency) step.emergency = true;
  return step;
}

export interface UnwindPlan {
  steps: UnwindStep[];
  finalCollateral: bigint;
  finalDebt: bigint;
  feasible: boolean;
  /** Lowest HF in any intermediate state (right after a withdraw). */
  minHealthFactorSeen: number;
  reason?: string;
}

/** Simulate a full unwind with expected swap outputs (used for dry-run plans and tests). */
export function planUnwind(C0: bigint, D0: bigint, goal: UnwindGoal, p: UnwindParams, maxIterations: number): UnwindPlan {
  let C = C0;
  let D = D0;
  const steps: UnwindStep[] = [];
  let minHf = Infinity;
  for (let i = 0; i < maxIterations; i++) {
    const s = unwindStep(C, D, goal, p);
    if (s.kind === "done") return { steps, finalCollateral: C, finalDebt: D, feasible: true, minHealthFactorSeen: minHf };
    if (s.kind === "stuck") return { steps, finalCollateral: C, finalDebt: D, feasible: false, minHealthFactorSeen: minHf, reason: s.reason };
    steps.push(s);
    if (s.kind === "withdraw") {
      const w = s.withdraw === "max" ? C : s.withdraw;
      C -= w;
      if (D > 0n && s.ltvAfter > 0) minHf = Math.min(minHf, p.liqLtv / s.ltvAfter);
      return { steps, finalCollateral: C, finalDebt: D, feasible: true, minHealthFactorSeen: minHf };
    }
    C -= s.withdraw;
    minHf = Math.min(minHf, p.liqLtv / s.ltvAfterWithdraw);
    D = s.expectedRepay >= D ? 0n : D - s.expectedRepay;
  }
  return { steps, finalCollateral: C, finalDebt: D, feasible: false, minHealthFactorSeen: minHf, reason: `not finished after ${maxIterations} iterations` };
}
