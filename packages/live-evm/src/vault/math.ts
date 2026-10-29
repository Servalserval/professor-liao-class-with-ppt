/** Pure vault math (no RPC). Rates: yearly APR fractions. */
import type { IrmModel } from "@incentive-router/core";
import { EULER_CONFIG_SCALE, EULER_RAY, EULER_SECONDS_PER_YEAR } from "./abis.js";

/** maxDeposit at or above this is "no cap" (Euler returns ~2^112 - cash, Fluid ~2^127 - supply, OZ 2^256-1). */
export const UNLIMITED_DEPOSIT = 1n << 100n;

/**
 * APR from share-price growth: daily-compounding APR (brief rule 8) of the
 * growth `now/then` over `elapsedSec`:  365 * ((now/then)^(1d/elapsed) - 1).
 * A falling share price gives a negative APR (a realised loss).
 */
export function growthApr(assetsNow: bigint, assetsThen: bigint, elapsedSec: number): number {
  if (!(assetsThen > 0n)) throw new Error("growthApr: past share price is 0");
  if (!(elapsedSec > 0)) throw new Error(`growthApr: elapsed ${elapsedSec}s`);
  const ratio = Number((assetsNow * 10n ** 18n) / assetsThen) / 1e18;
  return 365 * (Math.pow(ratio, 86_400 / elapsedSec) - 1);
}

/** Shares used to read the share price: enough that 1 base unit of rounding is < 1e-9 of it. */
export function priceProbeShares(shareDecimals: number): bigint {
  return 10n ** BigInt(Math.min(60, Math.max(0, shareDecimals) + 9));
}

/** Euler: per-second RAY rate -> APR on Euler's 365.2425-day year. */
export function eulerRateToApr(ratePerSecRay: bigint): number {
  return (Number(ratePerSecRay) / Number(EULER_RAY)) * EULER_SECONDS_PER_YEAR;
}

/**
 * Euler supply APR: interest paid by borrowers, minus the interest fee, spread
 * over all supplied assets (evk-periphery Lens/Utils.sol _computeAPYs uses the
 * same borrows * (1e4 - fee) / totalAssets / 1e4 factor on the APY).
 */
export function eulerSupplyApr(borrowApr: number, cash: bigint, borrows: bigint, interestFee: number): number {
  const total = cash + borrows;
  if (total === 0n) return 0;
  const util = Number((borrows * 10n ** 18n) / total) / 1e18;
  return borrowApr * util * (1 - interestFee / EULER_CONFIG_SCALE);
}

export interface LinearKink {
  baseRate: bigint;
  slope1: bigint;
  slope2: bigint;
  /** In type(uint32).max scale. */
  kink: bigint;
}

const U32 = 2n ** 32n - 1n;

/** IRMLinearKink.computeInterestRateInternal, RAY / second. */
export function linearKinkRate(m: LinearKink, cash: bigint, borrows: bigint): bigint {
  const total = cash + borrows;
  const u = total === 0n ? 0n : (borrows * U32) / total;
  if (u <= m.kink) return m.baseRate + u * m.slope1;
  return m.baseRate + m.kink * m.slope1 + m.slope2 * (u - m.kink);
}

/** Exact IrmModel of an IRMLinearKink (it is piecewise linear in utilization). */
export function linearKinkIrmModel(m: LinearKink, interestFee: number): IrmModel {
  const k = Number(m.kink) / Number(U32);
  const atKink = m.baseRate + m.kink * m.slope1;
  const atOne = atKink + m.slope2 * (U32 - m.kink);
  return {
    points: [
      [0, eulerRateToApr(m.baseRate)],
      [k, eulerRateToApr(atKink)],
      [1, eulerRateToApr(atOne)],
    ],
    reserveFactor: interestFee / EULER_CONFIG_SCALE,
  };
}

/** Continuous-compounding APY (Morpho SDK) -> the nominal per-second rate x year. */
export function apyContinuousToApr(apy: number): number {
  return Math.log1p(apy);
}
