import { gasUsd } from "../config.js";
import type { Opportunity, StressSignal, YieldStream } from "../types.js";
import { proRataStream } from "../valuation.js";
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
 */
export function loopOpportunity(
  m: LoopMarket,
  ctx: SourceContext,
  sourceId: string,
  opts: { estimated?: boolean } = {}
): Opportunity | null {
  const ll = ctx.cfg.sources.lending_loop;
  const ltv = Math.min(ll.target_ltv, m.openLtv * ll.max_ltv_frac_of_open);
  if (!(ltv > 0) || !(m.totalSupplyUsd > 0) || !(m.totalBorrowUsd >= 0)) return null;
  const L = loopLeverage(ltv);
  const id = `${sourceId}:${m.protocol}:${m.symbol}`;
  const myE = ctx.myEquityByOpp[id] ?? 0;

  const S = m.totalSupplyUsd;
  const B = m.totalBorrowUsd;
  const exS = Math.max(0, S - L * myE);
  const exB = Math.max(0, B - (L - 1) * myE);
  const uAt = (E: number) => {
    const d = exS + L * Math.max(0, E);
    return d > 0 ? (exB + (L - 1) * Math.max(0, E)) / d : 0;
  };
  const uNow = S > 0 ? B / S : 0;
  const available = Math.max(0, S - B);

  const borrowAt = (E: number): number => {
    if (m.irm) return interpIrm(m.irm, uAt(E));
    const added = Math.max(0, E - myE) * L;
    const denom = Math.max(1, available * ctx.cfg.liquidity.entry_max_frac_of_capacity);
    const k = 1 + (ll.rate_uncertainty_mult - 1) * Math.min(1, added / denom);
    return m.borrowAprBase * k;
  };
  const supplyAt = (E: number): number => {
    if (!m.irm) return m.supplyAprBase;
    const u = uAt(E);
    return interpIrm(m.irm, u) * u * (1 - m.irm.reserveFactor);
  };

  const streams: YieldStream[] = [
    { label: "supply_base", kind: "base", aprAt: (E) => L * supplyAt(E) },
    { label: "borrow_base", kind: "borrow_cost", aprAt: (E) => -(L - 1) * borrowAt(E) },
  ];
  for (const r of m.supplyRewards) {
    streams.push(
      proRataStream({
        label: `supply_reward:${r.token}`,
        kind: "reward",
        aprNow: r.apr,
        poolUsd: S,
        grossPerEquity: L,
        myEquityNowUsd: myE,
        aprMultiplier: L,
        rewardToken: r.token,
        endsAtMs: r.endsAtMs ?? null,
      })
    );
  }
  for (const r of m.borrowRewards) {
    streams.push(
      proRataStream({
        label: `borrow_reward:${r.token}`,
        kind: "reward",
        aprNow: r.apr,
        poolUsd: B,
        grossPerEquity: L - 1,
        myEquityNowUsd: myE,
        aprMultiplier: L - 1,
        rewardToken: r.token,
        endsAtMs: r.endsAtMs ?? null,
      })
    );
  }

  const gas = gasUsd(ctx.cfg, m.chain);
  const utilSignal = (u: number): StressSignal => ({
    name: "utilization",
    value: u,
    warnAt: ll.utilization_warn,
    exitAt: ll.utilization_exit,
    direction: "above",
  });

  const caps: number[] = [];
  if (m.supplyCapRemainingUsd !== undefined && m.supplyCapRemainingUsd !== null) caps.push(myE + m.supplyCapRemainingUsd / L);
  if (m.borrowCapRemainingUsd !== undefined && m.borrowCapRemainingUsd !== null) caps.push(myE + m.borrowCapRemainingUsd / (L - 1));

  return {
    id,
    sourceId,
    kind: "lending_loop",
    name: `${m.protocol} ${m.symbol} loop @${(ltv * 100).toFixed(0)}% LTV`,
    primaryVenue: m.protocol,
    chain: m.chain,
    legs: [{ venue: m.protocol, chain: m.chain, token: m.symbol, equityFrac: 1 }],
    streams,
    costs: {
      entryFrac: (L - 1) * (m.borrowFeeFrac ?? 0),
      exitFrac: ll.footprint === "net" ? (L - 1) * (m.flashloanFeeFrac ?? 0) : 0,
      fixedEntryUsd: gas * ll.txs_per_entry,
      fixedExitUsd: gas * ll.txs_per_exit,
      ongoingApr: 0,
    },
    liquidity: {
      exitCapacityUsd: available,
      footprintPerEquity: ll.footprint === "gross" ? L : 1,
      estimated: opts.estimated,
    },
    signals: [utilSignal(uNow)],
    projectedSignals: (E) => [utilSignal(uAt(E))],
    flags: m.paused ? [{ name: "market_paused", severity: "exit" }] : [],
    metrics: { borrow_apr: m.borrowAprBase, supply_apr: m.supplyAprBase, utilization: uNow, tvl_usd: S },
    health:
      myE > 0 && m.myLtv !== undefined
        ? {
            metric: "ltv",
            value: m.myLtv,
            rebalanceAt: ll.deleverage_at_ltv,
            criticalAt: m.closeLtv * ll.critical_ltv_frac_of_close,
            direction: "above",
          }
        : undefined,
    maxEquityUsd: caps.length ? Math.min(...caps) : undefined,
    myEquityUsd: myE,
    observedAtMs: ctx.nowMs,
    meta: { leverage: L, ltv },
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
