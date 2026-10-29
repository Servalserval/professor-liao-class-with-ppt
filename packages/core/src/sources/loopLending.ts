import type { Opportunity } from "../types.js";
// Circular with loopPair.ts (it imports interpIrm). Safe: only hoisted function
// declarations cross the cycle and nothing is called at module-evaluation time.
import { loopPairOpportunity, type LoopLeg, type LoopPair } from "./loopPair.js";
import type { Source, SourceContext } from "./types.js";

/** Piecewise-linear IRM: borrow APR as a function of utilization. */
export interface IrmModel {
  /** [utilization, borrowApr] sorted by utilization. */
  points: [number, number][];
  /** Share of borrow interest not passed to suppliers (supply = borrow * u * (1 - rf)). */
  reserveFactor: number;
}

export interface RewardRate {
  token: string;
  /** APR on the pool side it is paid on (supply or borrow), yearly fraction. */
  apr: number;
  endsAtMs?: number | null;
  /**
   * The campaign pays on a NET basis (e.g. Aave / Merkl AAVE_NET_LENDING,
   * AAVE_NET_BORROWING), which is how most stablecoin campaigns deliberately
   * kill loops:
   *  - supply reward: basis = my supply - my borrows of these symbols
   *  - borrow reward: basis = my borrow - my supply of these symbols
   * "*" = any stablecoin; inside a loop it is treated as matching the other
   * leg (a loop pair is same-asset or a stable pair; erring toward "net" only
   * ever lowers the reward).
   */
  netOf?: string[];
  /** Reward accrues only on the first X USD of the (net or gross) basis per user. */
  perUserCapUsd?: number;
  /**
   * Reward requires the position's health factor <= this (Ethena "Liquid
   * Leverage": HF <= 2, i.e. you must loop). For a loop HF = liqLtv / ltv.
   */
  maxHealthFactor?: number;
}

/** Protocol-agnostic view of ONE same-asset lending market. */
export interface LoopMarket {
  protocol: string;
  chain: string;
  symbol: string;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  supplyAprBase: number;
  borrowAprBase: number;
  supplyRewards: RewardRate[];
  borrowRewards: RewardRate[];
  openLtv: number;
  closeLtv: number;
  borrowFeeFrac?: number;
  flashloanFeeFrac?: number;
  supplyCapRemainingUsd?: number | null;
  borrowCapRemainingUsd?: number | null;
  irm?: IrmModel;
  paused?: boolean;
  /** Current LTV of MY position (only when one is open). */
  myLtv?: number;
}

export function interpIrm(irm: IrmModel, u: number): number {
  const pts = irm.points;
  if (!pts.length) return 0;
  if (u <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [u1, r1] = pts[i]!;
    const [u0, r0] = pts[i - 1]!;
    if (u <= u1) return r0 + ((r1 - r0) * (u - u0)) / Math.max(1e-12, u1 - u0);
  }
  // extrapolate the last segment (the jump region keeps getting steeper in reality)
  const [ua, ra] = pts[pts.length - 2] ?? pts[0]!;
  const [ub, rb] = pts[pts.length - 1]!;
  return rb + ((rb - ra) / Math.max(1e-12, ub - ua)) * (u - ub);
}

export function loopLeverage(ltv: number): number {
  return 1 / (1 - ltv);
}

/**
 * Same-asset loop (supply X, borrow X, re-supply) at the configured target LTV.
 *
 * With leverage L = 1/(1-ltv) and equity E:
 *   gross supply = L*E, debt = (L-1)*E
 *   APR on equity = L*supplyApr - (L-1)*borrowApr + L*supplyReward - ... (+ (L-1)*borrowReward)
 *
 * Rates are evaluated AFTER my position is in: utilization
 *   u(E) = (B_exMe + (L-1)E) / (S_exMe + L E)
 * goes through the IRM when we have it; without an IRM the borrow APR is
 * ramped up to `rate_uncertainty_mult` as my added footprint approaches the
 * 10% liquidity limit (loop-farm used a flat multiplier for the same purpose).
 * Rewards are pro-rata: emission / (pool + my gross contribution).
 *
 * Implemented by `loopPairOpportunity` (loopPair.ts) on the same-asset pair
 * from `loopMarketToPair`; the numbers are identical to the original
 * single-market implementation (see test/loopPair.test.ts).
 */
export function loopOpportunity(
  m: LoopMarket,
  ctx: SourceContext,
  sourceId: string,
  opts: { estimated?: boolean } = {}
): Opportunity | null {
  return loopPairOpportunity(loopMarketToPair(m), ctx, sourceId, opts);
}

/**
 * The same-asset `LoopPair` equivalent of a `LoopMarket` (collateral and debt
 * are the same leg object, pairId = symbol so opportunity ids stay
 * `${sourceId}:${protocol}:${symbol}`).
 */
export function loopMarketToPair(m: LoopMarket): LoopPair {
  const leg: LoopLeg = {
    symbol: m.symbol,
    priceUsd: 1,
    totalSupplyUsd: m.totalSupplyUsd,
    totalBorrowUsd: m.totalBorrowUsd,
    supplyAprBase: m.supplyAprBase,
    borrowAprBase: m.borrowAprBase,
    supplyRewards: m.supplyRewards,
    borrowRewards: m.borrowRewards,
    irm: m.irm,
    supplyCapRemainingUsd: m.supplyCapRemainingUsd,
    borrowCapRemainingUsd: m.borrowCapRemainingUsd,
    borrowFeeFrac: m.borrowFeeFrac,
  };
  return {
    protocol: m.protocol,
    chain: m.chain,
    pairId: m.symbol,
    collateral: leg,
    debt: leg,
    maxLtv: m.openLtv,
    liqLtv: m.closeLtv,
    swapCostFrac: 0,
    swapDepthUsd: Infinity,
    flashloanFeeFrac: m.flashloanFeeFrac,
    paused: m.paused,
    myLtv: m.myLtv,
  };
}

/** Wrap any async market provider (e.g. the loop-farm Navi / Suilend adapters). */
export class LoopLendingSource implements Source {
  constructor(
    readonly id: string,
    private readonly provider: () => Promise<LoopMarket[]>
  ) {}
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const markets = await this.provider();
    return markets.map((m) => loopOpportunity(m, ctx, this.id)).filter((o): o is Opportunity => o !== null);
  }
}

/**
 * Bridge from the loop-farm `MarketState` (base units as bigint). Field names
 * follow loop-farm's core/types.ts; `irm.points` is accepted either as
 * [u, apr] tuples or {u, apr}-like objects — adjust `pointOf` if your IrmPoint
 * uses different names.
 */
export interface LoopFarmMarketStateLike {
  protocol: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
  totalSupply: bigint;
  totalBorrow: bigint;
  supplyAprBase: number;
  borrowAprBase: number;
  supplyAprReward: number;
  borrowAprReward: number;
  openLtv: number;
  closeLtv: number;
  borrowFee: number;
  supplyCapRemaining: bigint | null;
  borrowCapRemaining: bigint | null;
  irm?: { points: unknown[]; supplySpreadFee: number };
  supplyRewardEndsAtMs?: number | null;
}

/**
 * `myLtv`: pass the LTV of your open position (loop-farm's position health)
 * so the router's health rule can deleverage / exit. Without it a held loop
 * triggers the `health_missing` warning every cycle.
 */
export function fromLoopFarmMarket(
  ms: LoopFarmMarketStateLike,
  chain: string,
  rewardToken: string,
  myLtv?: number
): LoopMarket {
  const usd = (x: bigint) => (Number(x) / 10 ** ms.decimals) * ms.priceUsd;
  const pointOf = (p: unknown): [number, number] | null => {
    if (Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const u = o.u ?? o.utilization;
      const r = o.apr ?? o.borrowApr ?? o.rate;
      if (u !== undefined && r !== undefined) return [Number(u), Number(r)];
    }
    return null;
  };
  const pts = (ms.irm?.points ?? []).map(pointOf).filter((x): x is [number, number] => x !== null);
  return {
    protocol: ms.protocol,
    chain,
    symbol: ms.symbol,
    totalSupplyUsd: usd(ms.totalSupply),
    totalBorrowUsd: usd(ms.totalBorrow),
    supplyAprBase: ms.supplyAprBase,
    borrowAprBase: ms.borrowAprBase,
    supplyRewards: ms.supplyAprReward > 0 ? [{ token: rewardToken, apr: ms.supplyAprReward, endsAtMs: ms.supplyRewardEndsAtMs ?? null }] : [],
    borrowRewards: ms.borrowAprReward > 0 ? [{ token: rewardToken, apr: ms.borrowAprReward }] : [],
    openLtv: ms.openLtv,
    closeLtv: ms.closeLtv,
    borrowFeeFrac: ms.borrowFee,
    supplyCapRemainingUsd: ms.supplyCapRemaining === null ? null : usd(ms.supplyCapRemaining),
    borrowCapRemainingUsd: ms.borrowCapRemaining === null ? null : usd(ms.borrowCapRemaining),
    irm: pts.length >= 2 ? { points: pts.sort((a, b) => a[0] - b[0]), reserveFactor: ms.irm?.supplySpreadFee ?? 0.15 } : undefined,
    myLtv,
  };
}
