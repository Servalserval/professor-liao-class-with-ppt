/**
 * Pure Navi math: unit conversions, rate conversions, IRM points, loop /
 * unwind planning. No SDK or RPC imports so everything here is unit-tested
 * offline (test/navi.test.ts).
 *
 * Units used throughout:
 *  - token amounts: bigint base units of the token (USDC 6 dec, SUI 9 dec ...)
 *  - Navi "normal" amounts: Navi stores every balance with 9 decimals
 *    (lending_core::pool::normal_amount) -> see naviNormalToBase
 *  - priceRatio: DEBT base units per 1 COLLATERAL base unit, at Navi oracle prices
 *      priceRatio = (Pcoll / Pdebt) * 10^(debtDecimals - collDecimals)
 *    so a collateral amount c is worth c * priceRatio debt base units.
 *  - LTV = debt value / collateral value (both at Navi oracle prices).
 *
 * Facts below were checked against Navi's Move sources
 * (SOURCE: https://github.com/naviprotocol/navi-smart-contracts lending_core/sources):
 *  - calculator.move: borrow_rate = base + u*multiplier            (u <  optimal)
 *                     borrow_rate = base + opt*multiplier + (u-opt)*jump (u >= optimal)
 *                     supply_rate = borrow_rate * u * (1 - reserve_factor); all ray (1e27), per YEAR
 *  - logic.move update_state: supply index accrues LINEARLY at supply_rate, borrow index compounds
 *    per second at borrow_rate/SECONDS_PER_YEAR -> the ray rates are nominal APRs.
 *  - incentive_v3.move borrow*: user receives exactly `amount`, debt grows by amount + fee
 *    (fee = amount * rate_bps / 10000, floor).
 *  - flash_loan.move: repay must be >= amount + floor(amount*rs/1e4) + floor(amount*rt/1e4);
 *    any excess repay balance is returned.
 *  - logic.move execute_withdraw: withdraws min(amount, balance); post-withdraw needs HF >= 1
 *    (liquidation-threshold based). execute_borrow: debt <= sum(collateral * ltv).
 *  - logic.move execute_repay: excess over current debt is returned to the caller.
 */
import type { IrmModel, RewardRate } from "@incentive-router/core";

export const RAY = 1e27;
export const SECONDS_PER_YEAR = 31_536_000;
export const NAVI_INTERNAL_DECIMALS = 9;
/** open() refuses targetLtv above this fraction of the pair's max LTV. */
export const MAX_TARGET_LTV_FRAC = 0.95;

// ---------------------------------------------------------------------------
// Number / unit conversions
// ---------------------------------------------------------------------------

/** Ray-scaled (1e27) number or numeric string -> plain fraction. Accepts "5.5e+34". */
export function rayToFrac(v: string | number | bigint | null | undefined): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) throw new Error(`rayToFrac: bad value ${String(v)}`);
  return n / RAY;
}

/** Percent number/string (Navi open-api: "3.428" = 3.428%) -> fraction. Bad input -> 0. */
export function pctToFrac(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n / 100 : 0;
}

/** APY -> APR with `periodsPerYear` compounding (default daily, per repo rule 8). */
export function apyToApr(apy: number, periodsPerYear = 365): number {
  if (!(apy > -1)) throw new Error(`apyToApr: invalid apy ${apy}`);
  if (apy === 0) return 0;
  return periodsPerYear * (Math.pow(1 + apy, 1 / periodsPerYear) - 1);
}

/**
 * Decimal string (may use exponent notation, e.g. BigNumber's "1e-9") -> base
 * units, rounded DOWN. Negative values throw.
 */
export function decimalStringToUnits(s: string, decimals: number): bigint {
  const m = /^\s*\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(String(s));
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`decimalStringToUnits: cannot parse "${s}"`);
  const intPart = m[1] || "0";
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? 0);
  const digits = BigInt(intPart + frac);
  const shift = decimals + exp - frac.length;
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

/**
 * Navi internal 9-decimal amount (string from getLendingState / bigint) -> token base units.
 * Floor by default (balances we can withdraw); "ceil" for debts, so a dust debt never reads as 0.
 */
export function naviNormalToBase(amount: string | bigint, decimals: number, rounding: "floor" | "ceil" = "floor"): bigint {
  const a = typeof amount === "bigint" ? amount : decimalStringToUnits(amount, 0);
  if (decimals === NAVI_INTERNAL_DECIMALS) return a;
  if (decimals < NAVI_INTERNAL_DECIMALS) {
    const d = 10n ** BigInt(NAVI_INTERNAL_DECIMALS - decimals);
    return rounding === "ceil" ? (a + d - 1n) / d : a / d;
  }
  return a * 10n ** BigInt(decimals - NAVI_INTERNAL_DECIMALS);
}

/** Raw (9-decimal) amount > 0? Independent of prices, so a missing oracle price never hides a debt. */
export function rawPositive(amount: string | bigint | undefined | null): boolean {
  if (amount === undefined || amount === null) return false;
  try {
    return (typeof amount === "bigint" ? amount : decimalStringToUnits(String(amount), 0)) > 0n;
  } catch {
    // unparseable -> assume a balance exists (conservative)
    return true;
  }
}

export function unitsToNumber(units: bigint, decimals: number): number {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const v = Number(u / base) + Number(u % base) / Number(base);
  return neg ? -v : v;
}

const FRAC_SCALE = 1_000_000_000n;
function fracScaled(f: number): bigint {
  if (!Number.isFinite(f) || f < 0) throw new Error(`invalid fraction ${f}`);
  return BigInt(Math.round(f * 1e9));
}
/** floor(a * f) for a small fraction-like multiplier f (1e-9 resolution). */
export function mulFracFloor(a: bigint, f: number): bigint {
  return (a * fracScaled(f)) / FRAC_SCALE;
}
/** ceil(a * f) for a small fraction-like multiplier f (1e-9 resolution). */
export function mulFracCeil(a: bigint, f: number): bigint {
  const s = fracScaled(f);
  return (a * s + FRAC_SCALE - 1n) / FRAC_SCALE;
}
/** floor(a * r) for an arbitrary positive ratio (float; fine for planning, ~1e-16 relative error). */
export function convFloor(a: bigint, r: number): bigint {
  if (!(r >= 0) || !Number.isFinite(r)) throw new Error(`convFloor: bad ratio ${r}`);
  return BigInt(Math.floor(Number(a) * r));
}
export function convCeil(a: bigint, r: number): bigint {
  if (!(r >= 0) || !Number.isFinite(r)) throw new Error(`convCeil: bad ratio ${r}`);
  return BigInt(Math.ceil(Number(a) * r));
}
export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Debt base units per 1 collateral base unit (see file header). */
export function priceRatioOf(collPriceUsd: number, collDecimals: number, debtPriceUsd: number, debtDecimals: number): number {
  if (!(collPriceUsd > 0) || !(debtPriceUsd > 0)) throw new Error(`priceRatioOf: invalid prices ${collPriceUsd} / ${debtPriceUsd}`);
  return (collPriceUsd / debtPriceUsd) * Math.pow(10, debtDecimals - collDecimals);
}

/** LTV of (collateral, debt) base-unit amounts at a price ratio. */
export function ltvOf(collateral: bigint, debt: bigint, priceRatio: number): number {
  if (debt <= 0n) return 0;
  if (collateral <= 0n) return Infinity;
  return Number(debt) / priceRatio / Number(collateral);
}

// ---------------------------------------------------------------------------
// Pool data (Navi open-api Pool, as returned by @naviprotocol/lending getPools)
// ---------------------------------------------------------------------------

export interface NaviBorrowRateFactors {
  baseRate: string;
  multiplier: string;
  jumpRateMultiplier: string;
  optimalUtilization: string;
  reserveFactor: string;
}

/** Exact Navi borrow rate at utilization u (calculator.move). */
export function naviBorrowRateAt(f: NaviBorrowRateFactors, u: number): number {
  const base = rayToFrac(f.baseRate);
  const mult = rayToFrac(f.multiplier);
  const jump = rayToFrac(f.jumpRateMultiplier);
  const opt = rayToFrac(f.optimalUtilization);
  return u < opt ? base + u * mult : base + opt * mult + (u - opt) * jump;
}

/** Navi kinked IRM -> core piecewise-linear IrmModel (exact: Navi's curve is piecewise linear). */
export function buildIrmModel(f: NaviBorrowRateFactors | undefined | null): IrmModel | undefined {
  if (!f) return undefined;
  const base = rayToFrac(f.baseRate);
  const mult = rayToFrac(f.multiplier);
  const jump = rayToFrac(f.jumpRateMultiplier);
  const opt = rayToFrac(f.optimalUtilization);
  const rf = rayToFrac(f.reserveFactor);
  if (!(opt > 0 && opt <= 1) || ![base, mult, jump, rf].every(Number.isFinite)) return undefined;
  const atOpt = base + opt * mult;
  const points: [number, number][] = [
    [0, base],
    [opt, atOpt],
  ];
  if (opt < 1) points.push([1, atOpt + (1 - opt) * jump]);
  return { points, reserveFactor: rf };
}

export interface PoolAmountsLike {
  totalSupplyAmount?: string;
  borrowedAmount?: string;
  validBorrowAmount?: string;
  supplyCapCeiling?: string;
  poolSupplyAmount?: string;
  poolBorrowAmount?: string;
  poolSupplyCapAmount?: string;
  poolBorrowCapAmount?: string;
}

/**
 * Human-unit pool totals. Prefers the fields the SDK derives in getPools
 * (poolSupplyAmount = totalSupplyAmount/1e9, poolSupplyCapAmount =
 * supplyCapCeiling/1e27, poolBorrowCapAmount = max(borrowed, validBorrow)/1e9)
 * and recomputes them the same way when absent. On-chain the borrow cap is a
 * RATIO of supply (validate_borrow), validBorrowAmount = ratio * supply.
 */
export function poolAmounts(p: PoolAmountsLike): { supply: number; borrow: number; supplyCap: number; borrowCap: number } {
  const num = (v: string | undefined, div: number) => (v === undefined || v === null ? NaN : Number(v) / div);
  const pick = (a: string | undefined, fallback: number) => {
    const x = a === undefined || a === null ? NaN : Number(a);
    return Number.isFinite(x) ? x : fallback;
  };
  const supply = pick(p.poolSupplyAmount, num(p.totalSupplyAmount, 1e9));
  const borrow = pick(p.poolBorrowAmount, num(p.borrowedAmount, 1e9));
  const supplyCap = pick(p.poolSupplyCapAmount, num(p.supplyCapCeiling, RAY));
  const borrowCap = pick(p.poolBorrowCapAmount, Math.max(num(p.borrowedAmount, 1e9), num(p.validBorrowAmount, 1e9)));
  return { supply, borrow, supplyCap, borrowCap };
}

/** Remaining supply / borrow cap in human units (null when unknown). */
export function capsRemaining(p: PoolAmountsLike): { supply: number | null; borrow: number | null } {
  const a = poolAmounts(p);
  return {
    supply: Number.isFinite(a.supplyCap) && Number.isFinite(a.supply) ? Math.max(0, a.supplyCap - a.supply) : null,
    borrow: Number.isFinite(a.borrowCap) && Number.isFinite(a.borrow) ? Math.max(0, a.borrowCap - a.borrow) : null,
  };
}

/**
 * Navi pools carry ONE incentive APR per side (supply/borrowIncentiveApyInfo.boostedApr)
 * plus a list of reward coins. The split per coin is not exposed by the SDK;
 * we split evenly (exact when there is a single reward coin, the common case).
 */
export function splitRewardApr(apr: number, tokens: string[], endsAtMs: number | null = null): RewardRate[] {
  if (!(apr > 0)) return [];
  const uniq = [...new Set(tokens.filter(Boolean))];
  if (!uniq.length) return [{ token: "navi:reward", apr, endsAtMs }];
  return uniq.map((token) => ({ token, apr: apr / uniq.length, endsAtMs }));
}

// ---------------------------------------------------------------------------
// E-Mode selection
// ---------------------------------------------------------------------------

export interface EModeAssetLike {
  assetId: number;
  ltv: number;
  lt: number;
  isCollateral: boolean;
  isDebt: boolean;
}
export interface EModeLike {
  emodeId: number;
  marketId: number;
  isActive: boolean;
  assets: EModeAssetLike[];
}
export interface ChosenEmode {
  emodeId: number;
  ltv: number;
  lt: number;
}

/**
 * Pick the e-mode for a collateral -> debt loop. `mode`:
 *  - "off": never
 *  - number: that e-mode, if active and covering collateral (isCollateral, ltv>0) and debt (isDebt)
 *  - "auto": the covering active e-mode with the highest collateral LTV, only if it beats poolLtv
 */
export function chooseEmode(
  emodes: EModeLike[],
  collAssetId: number,
  debtAssetId: number,
  mode: "auto" | "off" | number,
  poolLtv: number
): ChosenEmode | null {
  if (mode === "off") return null;
  const covering: ChosenEmode[] = [];
  for (const e of emodes) {
    if (!e.isActive) continue;
    const c = e.assets.find((a) => a.assetId === collAssetId && a.isCollateral && a.ltv > 0);
    const d = e.assets.find((a) => a.assetId === debtAssetId && a.isDebt);
    if (c && d) covering.push({ emodeId: e.emodeId, ltv: c.ltv, lt: c.lt });
  }
  if (typeof mode === "number") return covering.find((c) => c.emodeId === mode) ?? null;
  covering.sort((a, b) => b.ltv - a.ltv);
  const best = covering[0];
  return best && best.ltv > poolLtv ? best : null;
}

// ---------------------------------------------------------------------------
// Health factor
// ---------------------------------------------------------------------------

/** Navi HF = sum(collateralUsd * liquidationThreshold) / sum(debtUsd) (logic.move user_health_factor). */
export function healthFactor(entries: { collateralUsd: number; liqThreshold: number; debtUsd: number }[]): number {
  let c = 0;
  let d = 0;
  for (const e of entries) {
    c += e.collateralUsd * e.liqThreshold;
    d += e.debtUsd;
  }
  return d > 0 ? c / d : Infinity;
}

// ---------------------------------------------------------------------------
// Buffers
// ---------------------------------------------------------------------------

/**
 * Debt to repay so a full close leaves zero debt: Navi accrues interest up to
 * the execution second, our read is older. Over-repaying is free (excess is
 * returned by execute_repay).
 */
export function debtWithBuffer(
  debt: bigint,
  borrowApr: number,
  secondsSinceRead: number,
  opts: { minBufferFrac?: number; extraSeconds?: number } = {}
): bigint {
  if (debt <= 0n) return 0n;
  const secs = Math.max(0, secondsSinceRead) + (opts.extraSeconds ?? 1800);
  const accrual = Math.max(0, borrowApr) * (secs / SECONDS_PER_YEAR) * 1.5;
  const frac = Math.max(opts.minBufferFrac ?? 0.0002, accrual);
  return debt + mulFracCeil(debt, frac) + 1n;
}

/** Same idea for a withdraw-all request (withdraw is capped at the balance on-chain). */
export function withdrawAllRequest(collateral: bigint, supplyApr: number, secondsSinceRead: number): bigint {
  if (collateral <= 0n) return 0n;
  const secs = Math.max(0, secondsSinceRead) + 1800;
  const frac = Math.max(0.0001, Math.max(0, supplyApr) * (secs / SECONDS_PER_YEAR) * 1.5);
  return collateral + mulFracCeil(collateral, frac) + 1n;
}

/** Flash-loan repay amount: amount + ceil(amount * fee). Covers Navi's two floor-rounded fee parts. */
export function flashRepayAmount(amount: bigint, flashFeeFrac: number): bigint {
  return amount + mulFracCeil(amount, flashFeeFrac);
}

// ---------------------------------------------------------------------------
// Flash-loan open (one-shot leverage)
// ---------------------------------------------------------------------------

export interface FlashOpenPlan {
  /** Collateral base units to flash-borrow (and deposit with the equity). */
  flash: bigint;
  /** Flash repayment required (collateral base units). */
  flashRepay: bigint;
  /** Debt base units to borrow (received exactly; debt grows by borrow * (1 + borrowFee)). */
  borrow: bigint;
  /** Expected LTV after the trade (existing position included). */
  expectedLtv: number;
  collateralAfter: bigint;
  debtAfter: bigint;
}

/**
 * Solve the one-shot flash loop. With existing collateral C0 / debt value Dv0
 * (collateral units), equity E, flash x, borrow value b:
 *   swap:   b (1 - c) >= x (1 + ff)        -> b = x (1 + ff) / (1 - c)
 *   target: Dv0 + (1 + bf) b = t (C0 + E + x)
 *   =>      x = (t (C0 + E) - Dv0) / ((1 + bf)(1 + ff) / (1 - c) - t)
 * swapCostFrac c must include the slippage allowance (min-out). Same asset: c = 0, priceRatio = 1.
 */
export function solveFlashOpen(a: {
  equity: bigint;
  targetLtv: number;
  flashFeeFrac: number;
  borrowFeeFrac: number;
  swapCostFrac: number;
  priceRatio: number;
  existingCollateral?: bigint;
  existingDebt?: bigint;
}): FlashOpenPlan {
  const { equity, targetLtv: t, flashFeeFrac: ff, borrowFeeFrac: bf, swapCostFrac: c, priceRatio: pr } = a;
  if (!(t >= 0 && t < 1)) throw new Error(`solveFlashOpen: targetLtv ${t} out of range`);
  if (!(c >= 0 && c < 1)) throw new Error(`solveFlashOpen: swapCostFrac ${c} out of range`);
  const C0 = a.existingCollateral ?? 0n;
  const D0 = a.existingDebt ?? 0n;
  const dv0 = Number(D0) / pr;
  const denom = ((1 + bf) * (1 + ff)) / (1 - c) - t;
  if (!(denom > 0)) throw new Error("solveFlashOpen: costs make the target LTV unreachable");
  const xNum = (t * Number(C0 + equity) - dv0) / denom;
  const flash = xNum > 0 ? BigInt(Math.floor(xNum)) : 0n;
  if (flash === 0n) {
    const collateralAfter = C0 + equity;
    return { flash: 0n, flashRepay: 0n, borrow: 0n, expectedLtv: ltvOf(collateralAfter, D0, pr), collateralAfter, debtAfter: D0 };
  }
  const flashRepay = flashRepayAmount(flash, ff);
  // borrow value (collateral units) so that b (1 - c) >= flashRepay, then to debt units (ceil)
  const borrow = convCeil(flashRepay, pr / (1 - c));
  const debtAfter = D0 + borrow + mulFracCeil(borrow, bf);
  const collateralAfter = C0 + equity + flash;
  return { flash, flashRepay, borrow, expectedLtv: ltvOf(collateralAfter, debtAfter, pr), collateralAfter, debtAfter };
}

// ---------------------------------------------------------------------------
// Iterative loop (no flash loan): deposit / borrow (/swap) / deposit ... in one PTB
// ---------------------------------------------------------------------------

export interface LoopStep {
  /** Debt base units to borrow in this step. */
  borrow: bigint;
  /** Collateral base units expected to be re-deposited (after swap cost); swap min-out for different assets. */
  expectedDeposit: bigint;
}
export interface LoopPlan {
  steps: LoopStep[];
  collateralAfter: bigint;
  /** Debt base units after the plan, including the borrow fee. */
  debtAfter: bigint;
  achievedLtv: number;
  targetReached: boolean;
}

/**
 * Plan the deposit/borrow loop. Each step borrows the most it can without
 * breaching maxLtv * safety on the CURRENT collateral (Navi checks every
 * borrow), until the target LTV is reached or maxIterations is used up.
 *
 * @param equity     collateral base units deposited first
 * @param targetLtv  final debt/collateral value
 * @param maxLtv     protocol borrow limit for the collateral (pool or e-mode LTV)
 * @param priceRatio debt base units per collateral base unit
 */
export function planLoopSteps(
  equity: bigint,
  targetLtv: number,
  maxLtv: number,
  priceRatio: number,
  maxIterations: number,
  opts: {
    swapCostFrac?: number;
    borrowFeeFrac?: number;
    safety?: number;
    existingCollateral?: bigint;
    existingDebt?: bigint;
    /** Stop when a step would borrow less than this many debt base units. */
    minStep?: bigint;
  } = {}
): LoopPlan {
  if (!(targetLtv >= 0 && targetLtv < 1)) throw new Error(`planLoopSteps: targetLtv ${targetLtv} out of range`);
  if (!(maxLtv > 0 && maxLtv < 1)) throw new Error(`planLoopSteps: maxLtv ${maxLtv} out of range`);
  if (!(priceRatio > 0)) throw new Error(`planLoopSteps: priceRatio ${priceRatio} invalid`);
  const c = opts.swapCostFrac ?? 0;
  const bf = opts.borrowFeeFrac ?? 0;
  const safety = opts.safety ?? 0.99;
  const minStep = opts.minStep ?? 1n;
  const C0 = (opts.existingCollateral ?? 0n) + equity;
  const D0 = opts.existingDebt ?? 0n;

  // value bookkeeping in collateral units (float), amounts emitted as bigint
  let C = Number(C0);
  let Dv = Number(D0) / priceRatio;
  const totalB = (targetLtv * C - Dv) / (1 + bf - targetLtv * (1 - c));
  let remaining = totalB > 0 ? totalB : 0;
  const steps: LoopStep[] = [];
  let debtAfter = D0;
  let collAfter = C0;
  for (let i = 0; i < Math.max(0, Math.floor(maxIterations)) && remaining > 0; i++) {
    const limit = (maxLtv * safety * C - Dv) / (1 + bf);
    const b = Math.min(remaining, limit);
    if (!(b > 0)) break;
    const borrow = BigInt(Math.floor(b * priceRatio));
    if (borrow < minStep) break;
    const bVal = Number(borrow) / priceRatio;
    const expectedDeposit = BigInt(Math.floor(bVal * (1 - c)));
    steps.push({ borrow, expectedDeposit });
    Dv += bVal * (1 + bf);
    C += Number(expectedDeposit);
    remaining -= bVal;
    debtAfter += borrow + mulFracCeil(borrow, bf);
    collAfter += expectedDeposit;
  }
  const achievedLtv = ltvOf(collAfter, debtAfter, priceRatio);
  return {
    steps,
    collateralAfter: collAfter,
    debtAfter,
    achievedLtv,
    targetReached: achievedLtv >= targetLtv * 0.995 || totalB <= 0,
  };
}

// ---------------------------------------------------------------------------
// Unwind (deleverage / close)
// ---------------------------------------------------------------------------

/**
 * Flash deleverage to target t: flash y debt, repay y, withdraw w collateral,
 * swap w -> debt (>= y (1 + ff)), repay flash.
 *   y = w (1 - c) pr / (1 + ff);  Dv - w (1 - c)/(1 + ff) = t (C - w)
 *   => w = (Dv - t C) / ((1 - c)/(1 + ff) - t)
 * Returns null when the target is unreachable with these costs.
 */
export function solveDeleverage(a: {
  collateral: bigint;
  debt: bigint;
  targetLtv: number;
  priceRatio: number;
  swapCostFrac: number;
  flashFeeFrac: number;
}): { repay: bigint; withdraw: bigint } | null {
  const { collateral: C, debt: D, targetLtv: t, priceRatio: pr, swapCostFrac: c, flashFeeFrac: ff } = a;
  if (!(t >= 0 && t < 1)) throw new Error(`solveDeleverage: targetLtv ${t} out of range`);
  const dv = Number(D) / pr;
  const need = dv - t * Number(C);
  if (!(need > 0)) return { repay: 0n, withdraw: 0n };
  const denom = (1 - c) / (1 + ff) - t;
  if (!(denom > 0)) return null;
  const w = need / denom;
  if (w > Number(C)) return null;
  const withdraw = BigInt(Math.ceil(w));
  const repay = BigInt(Math.floor((w * (1 - c) * pr) / (1 + ff)));
  return { repay: repay > D ? D : repay, withdraw };
}

export interface UnwindStep {
  /** Collateral base units to withdraw. */
  withdraw: bigint;
  /** Debt base units the withdrawn collateral must repay (swap min-out for different assets). */
  minRepay: bigint;
}

/**
 * Iterative unwind without a flash loan: withdraw -> (swap) -> repay, repeated.
 * Each withdraw keeps HF >= 1/safety on the remaining collateral (Navi checks
 * HF >= 1 against the liquidation threshold after a withdraw).
 *
 * @param repayTarget debt base units to repay in total (buffered debt for a full close)
 */
export function planUnwindSteps(a: {
  collateral: bigint;
  debt: bigint;
  repayTarget: bigint;
  liqLtv: number;
  priceRatio: number;
  maxIterations: number;
  swapCostFrac?: number;
  safety?: number;
}): { steps: UnwindStep[]; repaid: bigint; withdrawn: bigint; reached: boolean } {
  const c = a.swapCostFrac ?? 0;
  const safety = a.safety ?? 0.97;
  const pr = a.priceRatio;
  if (!(pr > 0)) throw new Error("planUnwindSteps: invalid priceRatio");
  if (!(a.liqLtv > 0 && a.liqLtv < 1)) throw new Error("planUnwindSteps: invalid liqLtv");
  let C = a.collateral;
  let D = a.debt;
  let remaining = a.repayTarget;
  const steps: UnwindStep[] = [];
  let repaid = 0n;
  let withdrawn = 0n;
  for (let i = 0; i < Math.max(0, Math.floor(a.maxIterations)) && remaining > 0n; i++) {
    const dv = Number(D) / pr;
    const wMax = Number(C) - dv / (a.liqLtv * safety);
    const needW = Number(remaining) / (pr * (1 - c));
    const last = needW <= wMax;
    let withdraw = last ? BigInt(Math.ceil(needW)) : BigInt(Math.floor(Math.max(0, wMax)));
    let covers = last;
    if (withdraw > C) {
      withdraw = C;
      covers = false; // not enough collateral to cover the rest (insolvent at these prices)
    }
    if (withdraw <= 0n) break;
    const minRepay = covers ? remaining : BigInt(Math.floor(Number(withdraw) * (1 - c) * pr));
    if (minRepay <= 0n) break;
    steps.push({ withdraw, minRepay });
    C -= withdraw;
    D = D > minRepay ? D - minRepay : 0n;
    remaining -= minRepay;
    repaid += minRepay;
    withdrawn += withdraw;
  }
  return { steps, repaid, withdrawn, reached: remaining <= 0n };
}

/** Largest probe size (USD) whose quoted cost stays within the slippage budget (0 if none). */
export function swapDepthFromProbes(probes: { usd: number; costBps: number }[], budgetBps: number): number {
  let depth = 0;
  for (const p of [...probes].sort((x, y) => x.usd - y.usd)) {
    if (p.costBps <= budgetBps) depth = p.usd;
    else break;
  }
  return depth;
}
