/**
 * Pure Aave v3 math: unit conversions, IRM, e-mode selection, loop / unwind
 * planners. No I/O — everything here is unit-tested offline.
 *
 * Conventions: amounts are base-unit bigints; "human" numbers are
 * amount / 10^decimals; priceRatio = priceUsd(collateral) / priceUsd(debt)
 * (human units, ~1 for a stable pair, exactly 1 for a same-asset loop).
 */
import type { IrmModel } from "@incentive-router/core";

export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000;
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Aave reports currentLiquidityRate / currentVariableBorrowRate as APR in ray. */
export function rayToApr(ray: bigint): number {
  return Number(ray / 10n ** 9n) / 1e18;
}

export function rayToFrac(ray: bigint): number {
  return rayToApr(ray);
}

export function bpsToFrac(bps: number): number {
  return bps / 10_000;
}

/** Health factor (wad) -> number; type(uint256).max (no debt) -> Infinity. */
export function wadToHealthFactor(hf: bigint): number {
  if (hf >= MAX_UINT256 / 2n) return Infinity;
  return Number(hf / 10n ** 6n) / 1e12;
}

export function toHuman(units: bigint, decimals: number): number {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const v = Number(u / base) + Number(u % base) / Number(base);
  return neg ? -v : v;
}

/** floor(human * 10^decimals), never negative. */
export function fromHumanFloor(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human <= 0) return 0n;
  // split integer / fraction so large 18-decimal amounts keep their integer part exactly
  const i = Math.floor(human);
  const f = human - i;
  const scale = 10n ** BigInt(decimals);
  const frac = decimals <= 15 ? BigInt(Math.floor(f * 10 ** decimals)) : BigInt(Math.floor(f * 1e15)) * 10n ** BigInt(decimals - 15);
  return BigInt(i) * scale + frac;
}

/** x * f rounded down, f in [0,1], 1e-12 resolution. */
export function mulFrac(x: bigint, f: number): bigint {
  if (!(f >= 0 && f <= 1)) throw new Error(`mulFrac: fraction out of range: ${f}`);
  const p = BigInt(Math.floor(f * 1e12));
  return (x * p) / 10n ** 12n;
}

// ---------------------------------------------------------------------------
// IRM (DefaultReserveInterestRateStrategy V1/V2: two-slope kinked model)
// ---------------------------------------------------------------------------

export interface IrmParamsRay {
  baseVariableBorrowRate: bigint;
  variableRateSlope1: bigint;
  variableRateSlope2: bigint;
  optimalUsageRatio: bigint;
}

/**
 * [0, base], [optimal, base+slope1], [1, base+slope1+slope2]. Undefined when
 * the data provider could not read the strategy (all zero) or the kink is
 * outside (0,1).
 */
export function irmFromRay(p: IrmParamsRay, reserveFactorBps: number): IrmModel | undefined {
  const optimal = rayToFrac(p.optimalUsageRatio);
  if (!(optimal > 0 && optimal < 1)) return undefined;
  const base = rayToFrac(p.baseVariableBorrowRate);
  const s1 = rayToFrac(p.variableRateSlope1);
  const s2 = rayToFrac(p.variableRateSlope2);
  return {
    points: [
      [0, base],
      [optimal, base + s1],
      [1, base + s1 + s2],
    ],
    reserveFactor: bpsToFrac(reserveFactorBps),
  };
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * UiPoolDataProvider price -> USD. For USD-based oracles the provider reports
 * marketReferenceCurrencyPriceInUsd == marketReferenceCurrencyUnit (that is
 * what the contract writes when the oracle has BASE_CURRENCY_UNIT); otherwise
 * the reference currency (e.g. ETH) is priced by a Chainlink feed with 8
 * decimals.
 */
export function refPriceToUsd(priceInRef: bigint, unit: bigint, refPriceInUsd: bigint): number {
  if (!(unit > 0n)) return NaN;
  const inRef = toHumanRatio(priceInRef, unit);
  if (refPriceInUsd === unit) return inRef;
  return inRef * (Number(refPriceInUsd) / 1e8);
}

function toHumanRatio(a: bigint, b: bigint): number {
  return Number(a / b) + Number(a % b) / Number(b);
}

// ---------------------------------------------------------------------------
// Bitmaps / user configuration
// ---------------------------------------------------------------------------

export function isBitSet(bitmap: bigint, id: number): boolean {
  return ((bitmap >> BigInt(id)) & 1n) === 1n;
}

/** UserConfigurationMap: bit 2*id = borrowing, bit 2*id+1 = using as collateral. */
export function userConfigFlags(data: bigint, reserveId: number): { borrowing: boolean; collateral: boolean } {
  return { borrowing: isBitSet(data, reserveId * 2), collateral: isBitSet(data, reserveId * 2 + 1) };
}

// ---------------------------------------------------------------------------
// E-mode selection
// ---------------------------------------------------------------------------

export interface EModeCategoryInfo {
  id: number;
  /** bps */
  ltv: number;
  liquidationThreshold: number;
  label: string;
  /** v3.2+ */
  collateralBitmap?: bigint;
  borrowableBitmap?: bigint;
  /** v3.6+ */
  ltvzeroBitmap?: bigint;
  /** v3.7+: collateral outside the bitmap counts 0 */
  isolated?: boolean;
}

export interface ReserveModeInfo {
  /** Reserve id (bit position in e-mode bitmaps / user configuration). */
  id: number;
  /** Normal-mode params, bps. */
  baseLtv: number;
  liquidationThreshold: number;
  /** v3.0/3.1: the reserve's single e-mode category (0 = none). */
  legacyEModeCategory?: number;
}

export interface ModeChoice {
  /** 0 = no e-mode */
  categoryId: number;
  /** fractions */
  ltv: number;
  liqLtv: number;
  label: string;
  isolated?: boolean;
}

/**
 * Effective (ltv, liqLtv) of `collateral` when borrowing `debt` with the user
 * in `categoryId`; null when `debt` cannot be borrowed in that e-mode.
 * `legacy` = Aave 3.0/3.1 (one category per reserve, both assets must share it).
 */
export function pairModeIn(
  categoryId: number,
  collateral: ReserveModeInfo,
  debt: ReserveModeInfo,
  categories: readonly EModeCategoryInfo[],
  legacy: boolean
): ModeChoice | null {
  const normal: ModeChoice = {
    categoryId: 0,
    ltv: bpsToFrac(collateral.baseLtv),
    liqLtv: bpsToFrac(collateral.liquidationThreshold),
    label: "normal",
  };
  if (categoryId === 0) return normal;
  const cat = categories.find((c) => c.id === categoryId);
  if (!cat || !(cat.liquidationThreshold > 0)) return null;
  if (legacy) {
    if (debt.legacyEModeCategory !== categoryId) return null;
    if (collateral.legacyEModeCategory === categoryId)
      return { categoryId, ltv: bpsToFrac(cat.ltv), liqLtv: bpsToFrac(cat.liquidationThreshold), label: cat.label };
    return { ...normal, categoryId, label: cat.label };
  }
  if (cat.borrowableBitmap === undefined || !isBitSet(cat.borrowableBitmap, debt.id)) return null;
  if (cat.collateralBitmap !== undefined && isBitSet(cat.collateralBitmap, collateral.id)) {
    const ltvZero = cat.ltvzeroBitmap !== undefined && isBitSet(cat.ltvzeroBitmap, collateral.id);
    return {
      categoryId,
      ltv: ltvZero ? 0 : bpsToFrac(cat.ltv),
      liqLtv: bpsToFrac(cat.liquidationThreshold),
      label: cat.label,
      isolated: cat.isolated,
    };
  }
  if (cat.isolated) return { categoryId, ltv: 0, liqLtv: 0, label: cat.label, isolated: true };
  return { ...normal, categoryId, label: cat.label, isolated: cat.isolated };
}

export type EModePreference = "auto" | "none" | number;

/**
 * Best mode for the pair: highest LTV, then highest liquidation LTV, then
 * prefer normal mode (fewer borrow restrictions), then the lowest id.
 * `pref`: "auto" (default) | "none" (normal mode only) | a category id (must be valid for the pair).
 */
export function selectEMode(
  collateral: ReserveModeInfo,
  debt: ReserveModeInfo,
  categories: readonly EModeCategoryInfo[],
  legacy: boolean,
  pref: EModePreference = "auto"
): { chosen: ModeChoice; candidates: ModeChoice[] } {
  const ids = [0, ...categories.map((c) => c.id)];
  const candidates = ids.map((id) => pairModeIn(id, collateral, debt, categories, legacy)).filter((m): m is ModeChoice => m !== null);
  if (pref === "none") return { chosen: candidates.find((c) => c.categoryId === 0)!, candidates };
  if (typeof pref === "number") {
    const hit = candidates.find((c) => c.categoryId === pref);
    if (!hit) throw new Error(`e-mode ${pref} does not allow borrowing this debt asset against this collateral`);
    return { chosen: hit, candidates };
  }
  const sorted = [...candidates].sort(
    (a, b) => b.ltv - a.ltv || b.liqLtv - a.liqLtv || (a.categoryId === 0 ? -1 : b.categoryId === 0 ? 1 : a.categoryId - b.categoryId)
  );
  return { chosen: sorted[0]!, candidates };
}

// ---------------------------------------------------------------------------
// Loop planner (open)
// ---------------------------------------------------------------------------

export const MAX_TARGET_FRAC_OF_LTV = 0.95;

export type LoopStep =
  | { kind: "supply"; amount: bigint }
  | { kind: "borrow"; amount: bigint }
  | { kind: "swap"; amount: bigint; expectedOut: bigint };

export interface LoopPlanOptions {
  collateralDecimals: number;
  debtDecimals: number;
  /** true = collateral and debt are the same token (no swap; priceRatio must be 1). */
  sameAsset?: boolean;
  /** Fraction lost converting debt -> collateral (fees + impact). 0 for same asset. */
  swapCostFrac?: number;
  /** Already in the position (aToken balance of collateral / variable debt of debt asset). */
  existingCollateral?: bigint;
  existingDebt?: bigint;
  /** Stop when the next borrow is below this many debt base units. */
  minBorrow?: bigint;
}

export interface LoopPlan {
  steps: LoopStep[];
  /** Debt the position should end with if every iteration ran (debt units). */
  targetDebt: bigint;
  totalSupplied: bigint;
  totalBorrowed: bigint;
  finalCollateral: bigint;
  finalDebt: bigint;
  finalLtv: number;
  iterations: number;
  reachedTarget: boolean;
}

/**
 * Debt that puts the whole position exactly at `targetLtv` after re-supplying
 * the borrowed funds (net of swap cost s):
 *   D_f = t (r S - (1-s) D0) / (1 - t (1-s))       (human units, S incl. new equity)
 */
export function targetLoopDebt(S: number, D0: number, t: number, r: number, s: number): number {
  return (t * (r * S - (1 - s) * D0)) / (1 - t * (1 - s));
}

/**
 * Largest borrow (human debt units) that keeps LTV <= t immediately after the
 * borrow (i.e. before the re-supply): t*S*r - D, capped by what is still
 * needed to reach the target.
 */
export function nextLoopBorrow(S: number, D: number, t: number, r: number, remaining: number): number {
  return Math.max(0, Math.min(remaining, t * S * r - D));
}

/**
 * Iterative supply -> borrow -> (swap) -> supply plan. Every intermediate
 * state has LTV <= targetLtv (borrow capacity is capped at the TARGET, not the
 * protocol max), so the plan never exceeds targetLtv even if it stops early;
 * with few iterations it may end below target (`reachedTarget` = false).
 * Throws if targetLtv > maxLtv * 0.95.
 */
export function planLoopSteps(
  equity: bigint,
  targetLtv: number,
  maxLtv: number,
  priceRatio: number,
  maxIterations: number,
  opts: LoopPlanOptions
): LoopPlan {
  if (!(targetLtv > 0 && targetLtv < 1)) throw new Error(`targetLtv must be in (0,1), got ${targetLtv}`);
  if (!(maxLtv > 0 && maxLtv < 1)) throw new Error(`maxLtv must be in (0,1), got ${maxLtv}`);
  if (targetLtv > maxLtv * MAX_TARGET_FRAC_OF_LTV + 1e-12)
    throw new Error(`targetLtv ${targetLtv} exceeds ${MAX_TARGET_FRAC_OF_LTV} x max LTV ${maxLtv} (= ${(maxLtv * MAX_TARGET_FRAC_OF_LTV).toFixed(4)})`);
  if (!(priceRatio > 0 && Number.isFinite(priceRatio))) throw new Error(`invalid priceRatio ${priceRatio}`);
  if (equity < 0n) throw new Error("negative equity");
  const same = opts.sameAsset ?? false;
  const s = same ? 0 : (opts.swapCostFrac ?? 0);
  if (!(s >= 0 && s < 0.5)) throw new Error(`invalid swapCostFrac ${s}`);
  if (same && Math.abs(priceRatio - 1) > 1e-12) throw new Error("same-asset loop needs priceRatio 1");
  const r = priceRatio;
  const dc = opts.collateralDecimals;
  const dd = opts.debtDecimals;
  const minBorrow = opts.minBorrow ?? 1n;

  const steps: LoopStep[] = [];
  let Su = (opts.existingCollateral ?? 0n) + equity;
  let Du = opts.existingDebt ?? 0n;
  if (equity > 0n) steps.push({ kind: "supply", amount: equity });
  const S0 = toHuman(Su, dc);
  const D0 = toHuman(Du, dd);
  const Dt = targetLoopDebt(S0, D0, targetLtv, r, s);
  const targetDebt = fromHumanFloor(Dt, dd);
  let totalBorrowed = 0n;
  let totalSupplied = equity;
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    const S = toHuman(Su, dc);
    const D = toHuman(Du, dd);
    // 1e-9 relative haircut so float rounding can never push us over the target
    const b = nextLoopBorrow(S, D, targetLtv, r, Dt - D) * (1 - 1e-9);
    const bu = fromHumanFloor(b, dd);
    if (bu < minBorrow || bu <= 0n) break;
    steps.push({ kind: "borrow", amount: bu });
    let out: bigint;
    if (same) out = bu;
    else {
      out = fromHumanFloor((toHuman(bu, dd) * (1 - s)) / r, dc);
      steps.push({ kind: "swap", amount: bu, expectedOut: out });
    }
    steps.push({ kind: "supply", amount: out });
    Su += out;
    Du += bu;
    totalBorrowed += bu;
    totalSupplied += out;
    iterations++;
  }
  const Sf = toHuman(Su, dc);
  const Df = toHuman(Du, dd);
  const finalLtv = Sf > 0 ? Df / (Sf * r) : 0;
  const tol = Math.max(toHuman(minBorrow, dd), Dt * 1e-6);
  return {
    steps,
    targetDebt,
    totalSupplied,
    totalBorrowed,
    finalCollateral: Su,
    finalDebt: Du,
    finalLtv,
    iterations,
    reachedTarget: Dt - Df <= tol,
  };
}

// ---------------------------------------------------------------------------
// Close / deleverage planners
// ---------------------------------------------------------------------------

export interface SameAssetClosePlan {
  /** Amount for repayWithATokens (MAX_UINT256 = whole debt); 0n = skip. */
  repayWithATokens: bigint;
  /** Amount for withdraw (MAX_UINT256 = whole aToken balance). */
  withdraw: bigint;
  full: boolean;
}

/**
 * Same-asset unwind without a flash loan: repayWithATokens burns collateral
 * against debt (always lowers LTV), then withdraw returns equity. Partial
 * closes keep the LTV unchanged: repay f*D, withdraw f*(S-D).
 */
export function planSameAssetClose(collateral: bigint, debt: bigint, fraction: number): SameAssetClosePlan {
  if (!(fraction > 0 && fraction <= 1)) throw new Error(`fraction must be in (0,1], got ${fraction}`);
  if (collateral < debt) throw new Error("position is underwater (debt > collateral); cannot unwind with aTokens alone");
  if (fraction >= 1 - 1e-9) return { repayWithATokens: debt > 0n ? MAX_UINT256 : 0n, withdraw: MAX_UINT256, full: true };
  return { repayWithATokens: mulFrac(debt, fraction), withdraw: mulFrac(collateral - debt, fraction), full: false };
}

/** repayWithATokens amount x so that (D-x)/(S-x) <= t (same asset). 0 when already there. */
export function planSameAssetDeleverage(collateral: bigint, debt: bigint, targetLtv: number): bigint {
  if (!(targetLtv >= 0 && targetLtv < 1)) throw new Error(`targetLtv must be in [0,1), got ${targetLtv}`);
  const t = BigInt(Math.floor(targetLtv * 1e12));
  const one = 10n ** 12n;
  const num = debt * one - t * collateral;
  if (num <= 0n) return 0n;
  const x = num / (one - t) + 1n; // round up -> lands at or below target
  return x > debt ? debt : x;
}

export interface UnwindParams {
  priceRatio: number;
  collateralDecimals: number;
  debtDecimals: number;
  swapCostFrac: number;
  /** Max LTV allowed right after a withdrawal while the swap is in flight. */
  ceilingLtv: number;
  /** Extra debt bought on the final full-repay swap (interest / slippage), fraction. */
  debtBufferFrac?: number;
  /** Ignore withdrawals below this many collateral base units. */
  minWithdraw?: bigint;
}

export type UnwindGoal = { targetDebt: bigint } | { targetLtv: number };

export interface UnwindStep {
  withdraw: bigint;
  expectedOut: bigint;
  done: boolean;
  /** No safe withdrawal possible (LTV already at / above the ceiling). */
  stuck: boolean;
  /** This step's output should cover the entire remaining debt (repay with MAX). */
  finalRepay: boolean;
}

/**
 * One withdraw -> swap -> repay iteration for a two-asset unwind.
 * Withdraw w (collateral) is bounded so that LTV after the withdrawal stays
 * <= ceilingLtv:  w_max = S - D / (ceiling * r).
 */
export function unwindStep(S: bigint, D: bigint, goal: UnwindGoal, p: UnwindParams): UnwindStep {
  const r = p.priceRatio;
  const s = p.swapCostFrac;
  const Sh = toHuman(S, p.collateralDecimals);
  const Dh = toHuman(D, p.debtDecimals);
  const none: UnwindStep = { withdraw: 0n, expectedOut: 0n, done: false, stuck: false, finalRepay: false };
  let wNeed: number;
  let finalRepay = false;
  if ("targetDebt" in goal) {
    if (D <= goal.targetDebt) return { ...none, done: true };
    const need = Dh - toHuman(goal.targetDebt, p.debtDecimals);
    finalRepay = goal.targetDebt === 0n;
    wNeed = (need / (r * (1 - s))) * (finalRepay ? 1 + (p.debtBufferFrac ?? 0.0005) : 1);
  } else {
    const t = goal.targetLtv;
    const ltv = Sh > 0 ? Dh / (Sh * r) : Infinity;
    if (ltv <= t) return { ...none, done: true };
    if (!(1 - s > t)) throw new Error(`cannot deleverage to ${t}: swap cost ${s} makes each step raise LTV`);
    wNeed = ((Dh - t * Sh * r) / (r * (1 - s - t))) * (1 + 1e-6);
  }
  const wMax = p.ceilingLtv > 0 ? Sh - Dh / (p.ceilingLtv * r) : 0;
  if (!(wMax > 0)) return { ...none, stuck: true };
  const wMaxU = fromHumanFloor(wMax * (1 - 1e-9), p.collateralDecimals);
  let wu = fromHumanFloor(Math.min(wMax * (1 - 1e-9), wNeed), p.collateralDecimals);
  if (wu > S) wu = S;
  const minW = p.minWithdraw ?? 1n;
  if (wu < minW) {
    // dust left: within rounding of the LTV target, or withdraw the minimum step to clear a debt remainder
    if (!("targetDebt" in goal)) return { ...none, done: true };
    wu = minW < wMaxU ? minW : wMaxU;
    if (wu > S) wu = S;
    if (wu <= 0n) return { ...none, stuck: true };
  }
  const out = fromHumanFloor(toHuman(wu, p.collateralDecimals) * r * (1 - s), p.debtDecimals);
  return { withdraw: wu, expectedOut: out, done: false, stuck: false, finalRepay: finalRepay && wNeed <= wMax * (1 - 1e-9) };
}

export type UnwindPlanStep =
  | { kind: "withdraw"; amount: bigint }
  | { kind: "swap"; amount: bigint; expectedOut: bigint }
  | { kind: "repay"; amount: bigint };

export interface UnwindPlan {
  steps: UnwindPlanStep[];
  finalCollateral: bigint;
  finalDebt: bigint;
  finalLtv: number;
  iterations: number;
  complete: boolean;
}

/**
 * Simulate the whole two-asset unwind with expected swap outputs.
 * close: goal targetDebt = (1-f) * D0, then (partial) withdraw the excess
 * collateral back to the original LTV, or (full) withdraw everything (MAX).
 */
export function planPairUnwind(
  collateral: bigint,
  debt: bigint,
  goal: { fraction: number } | { targetLtv: number },
  p: UnwindParams,
  maxIterations: number
): UnwindPlan {
  const r = p.priceRatio;
  let S = collateral;
  let D = debt;
  const steps: UnwindPlanStep[] = [];
  const ltvOf = (s: bigint, d: bigint) => {
    const sh = toHuman(s, p.collateralDecimals);
    return sh > 0 ? toHuman(d, p.debtDecimals) / (sh * r) : d > 0n ? Infinity : 0;
  };
  const ltv0 = ltvOf(S, D);
  let g: UnwindGoal;
  let full = false;
  if ("fraction" in goal) {
    if (!(goal.fraction > 0 && goal.fraction <= 1)) throw new Error(`fraction must be in (0,1], got ${goal.fraction}`);
    full = goal.fraction >= 1 - 1e-9;
    g = { targetDebt: full ? 0n : D - mulFrac(D, goal.fraction) };
  } else g = { targetLtv: goal.targetLtv };

  let iterations = 0;
  let complete = false;
  for (let i = 0; i < maxIterations; i++) {
    const st = unwindStep(S, D, g, p);
    if (st.done) {
      complete = true;
      break;
    }
    if (st.stuck || st.withdraw === 0n) break;
    steps.push({ kind: "withdraw", amount: st.withdraw });
    steps.push({ kind: "swap", amount: st.withdraw, expectedOut: st.expectedOut });
    const repay = st.finalRepay && st.expectedOut >= D ? MAX_UINT256 : st.expectedOut < D ? st.expectedOut : D;
    steps.push({ kind: "repay", amount: repay });
    S -= st.withdraw;
    D -= repay === MAX_UINT256 ? D : repay;
    iterations++;
  }
  if (!complete) complete = unwindStep(S, D, g, p).done;
  if (complete && "fraction" in goal) {
    if (full && D === 0n) {
      steps.push({ kind: "withdraw", amount: MAX_UINT256 });
      S = 0n;
    } else if (!full) {
      // restore the original LTV: keep S_t = D / (ltv0 * r)
      const keep = ltv0 > 0 && D > 0n ? fromHumanFloor(toHuman(D, p.debtDecimals) / (ltv0 * r), p.collateralDecimals) + 1n : S - mulFrac(collateral, goal.fraction);
      const extra = S > keep ? S - keep : 0n;
      if (extra > 0n) {
        steps.push({ kind: "withdraw", amount: extra });
        S -= extra;
      }
    }
  }
  return { steps, finalCollateral: S, finalDebt: D, finalLtv: ltvOf(S, D), iterations, complete };
}

// ---------------------------------------------------------------------------
// Rewards / caps
// ---------------------------------------------------------------------------

/** APR of an Aave RewardsController stream on a pool side. */
export function rewardAprFromEmission(emissionPerSecond: bigint, rewardDecimals: number, rewardPriceUsd: number, poolUsd: number): number {
  if (!(poolUsd > 0) || !(rewardPriceUsd > 0)) return 0;
  return (toHuman(emissionPerSecond, rewardDecimals) * SECONDS_PER_YEAR * rewardPriceUsd) / poolUsd;
}

/** Remaining room under a whole-token cap (0 = uncapped -> null). */
export function capRemaining(capWholeTokens: bigint, decimals: number, current: bigint): bigint | null {
  if (capWholeTokens === 0n) return null;
  const cap = capWholeTokens * 10n ** BigInt(decimals);
  return cap > current ? cap - current : 0n;
}

/** Current value of a scaled amount: scaled * index / RAY (rounded down). */
export function rayMul(scaled: bigint, index: bigint): bigint {
  return (scaled * index + RAY / 2n) / RAY;
}
