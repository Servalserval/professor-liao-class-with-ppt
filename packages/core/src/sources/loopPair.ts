/**
 * Two-asset (or same-asset) lending loop: supply COLLATERAL, borrow DEBT,
 * convert debt -> collateral, re-supply. Same-asset loops are the special
 * case collateral.symbol === debt.symbol (no swap, no depeg risk).
 *
 * This file defines the shared contract between protocol adapters
 * (packages/live-*) and the core. The math lives in `loopPairOpportunity`.
 */
import { gasUsd } from "../config.js";
import { median, recentMetricValues } from "../signals.js";
import { depegLevels, stableRisk } from "../stables.js";
import type { Flag, Opportunity, StressSignal, YieldStream } from "../types.js";
import { proRataStream } from "../valuation.js";
import { interpIrm, type IrmModel, type RewardRate } from "./loopLending.js";
import type { Source, SourceContext } from "./types.js";

export interface LoopLeg {
  /** Canonical symbol used for caps/exposure (e.g. "USDC", "USDT", "USDsui"). */
  symbol: string;
  /** Chain-specific id (EVM address / Sui coinType) — informational for the core. */
  assetId?: string;
  priceUsd: number;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  supplyAprBase: number;
  borrowAprBase: number;
  supplyRewards: RewardRate[];
  borrowRewards: RewardRate[];
  irm?: IrmModel;
  supplyCapRemainingUsd?: number | null;
  borrowCapRemainingUsd?: number | null;
  /** One-off fee charged on borrowing, fraction of borrowed amount. */
  borrowFeeFrac?: number;
}

export interface LoopPair {
  protocol: string;
  chain: string;
  /** Unique within protocol+chain, e.g. "USDC/USDC" or "USDC/USDsui" or a Morpho market id. */
  pairId: string;
  collateral: LoopLeg;
  /** For same-asset loops pass the same object (or an equal one) as `collateral`. */
  debt: LoopLeg;
  /** Max LTV for opening, liquidation LTV — pair-specific (e-mode / Morpho LLTV). */
  maxLtv: number;
  liqLtv: number;
  /**
   * Cost of converting debt -> collateral (and back on exit), fraction of the amount. 0 for same asset.
   * NaN = UNKNOWN (every probe failed): the core reuses the last recent quote or
   * `unknown_swap_cost_frac`, and blocks entries.
   */
  swapCostFrac: number;
  /**
   * USD of debt->collateral (and reverse) that can be swapped within the slippage budget. Infinity for same asset.
   * NaN = UNKNOWN (quote failed). Never report 0 for a failed quote: 0 means "no
   * depth at all" and makes the position exit. Unknown reuses the recent depth
   * (within portfolio.max_data_age_minutes) or, without one, the pair is not
   * reported this cycle (blind; no exit on one cycle alone).
   */
  swapDepthUsd: number;
  flashloanFeeFrac?: number;
  paused?: boolean;
  /** LTV of MY open position, measured by the adapter (relative prices included). */
  myLtv?: number;
  /** Block / API time the data was read at. */
  dataAsOfMs?: number;
  /**
   * Expected debt/collateral price ratio (debt.priceUsd / collateral.priceUsd)
   * when nothing is depegged. Default 1 (two stablecoins). For yield-bearing
   * collateral (sUSDe vs USDC) pass the protocol oracle ratio, so the depeg
   * signal measures the MARKET ratio against it instead of against 1.
   */
  expectedPriceRatio?: number;
}

export function isSameAsset(p: LoopPair): boolean {
  return p.collateral.symbol === p.debt.symbol;
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Utilization of one lending market as a function of my equity, with my current footprint backed out. */
interface MarketView {
  uNow: number;
  /** supply - borrow, as observed (my position included). */
  available: number;
  uAt: (E: number) => number;
}

/**
 * `supplyPerE` / `borrowPerE`: USD I supply / borrow in THIS market per USD
 * of loop equity (same asset: L and L-1; pair collateral: L and 0; pair
 * debt: 0 and L-1).
 */
function marketView(S: number, B: number, supplyPerE: number, borrowPerE: number, myE: number): MarketView {
  const exS = Math.max(0, S - supplyPerE * myE);
  const exB = Math.max(0, B - borrowPerE * myE);
  return {
    uNow: S > 0 ? B / S : 0,
    available: Math.max(0, S - B),
    uAt: (E: number) => {
      const d = exS + supplyPerE * Math.max(0, E);
      return d > 0 ? (exB + borrowPerE * Math.max(0, E)) / d : 0;
    },
  };
}

/**
 * Lending loop at the configured target LTV, same-asset or two-asset.
 *
 * With leverage L = 1/(1-ltv) and equity E (held in the collateral asset):
 *   collateral supplied = L*E, debt = (L-1)*E (USD)
 *   APR on equity = L*supplyApr_c - (L-1)*borrowApr_d + supply rewards (g=L) + borrow rewards (g=L-1)
 *
 * Same asset: ONE market gains both supply and borrow,
 *   u(E) = (B_exMe + (L-1)E) / (S_exMe + L E)            (identical to loopLending.ts)
 * Two assets: the collateral market only gains supply and the debt market only gains borrow,
 *   u_c(E) = B_c / (S_c_exMe + L E),   u_d(E) = (B_d_exMe + (L-1)E) / S_d
 * Rates go through each market's IRM when known; without an IRM the supply
 * APR is the observed one and the borrow APR is ramped up to
 * `rate_uncertainty_mult` as my added borrow approaches
 * `entry_max_frac_of_capacity` of the debt market's available liquidity.
 *
 * Field sourcing: supply-side quotes (supplyAprBase, supplyRewards,
 * supplyCapRemainingUsd) come from `collateral`, borrow-side quotes
 * (borrowAprBase, borrowRewards, borrowCapRemainingUsd, borrowFeeFrac) from
 * `debt`. For a same-asset pair the market totals and IRM come from
 * `collateral`.
 */
export function loopPairOpportunity(
  pair: LoopPair,
  ctx: SourceContext,
  sourceId: string,
  opts: { estimated?: boolean } = {}
): Opportunity | null {
  const ll = ctx.cfg.sources.lending_loop;
  const same = isSameAsset(pair);
  const C = pair.collateral;
  const D = pair.debt;

  const ltv = Math.min(ll.target_ltv, pair.maxLtv * ll.max_ltv_frac_of_open);
  if (!(ltv > 0) || !(ltv < 1)) return null;
  // Reject non-finite inputs here rather than emitting an opportunity whose
  // NaN only surfaces later (e.g. a NaN liqLtv would be invisible until a
  // position is open and health is computed).
  if (!fin(pair.maxLtv) || !fin(pair.liqLtv)) return null;
  // NaN swap numbers mean UNKNOWN (a failed probe), handled below; anything else invalid is rejected.
  const costUnknown = Number.isNaN(pair.swapCostFrac);
  const depthUnknown = Number.isNaN(pair.swapDepthUsd);
  if (!costUnknown && (!fin(pair.swapCostFrac) || pair.swapCostFrac < 0)) return null;
  if (!depthUnknown && !(pair.swapDepthUsd >= 0)) return null; // swapDepthUsd may be Infinity
  const optOk = (x: number | undefined) => x === undefined || fin(x);
  if (!optOk(pair.flashloanFeeFrac) || !optOk(D.borrowFeeFrac)) return null;
  const marketOk = (leg: LoopLeg) => fin(leg.totalSupplyUsd) && leg.totalSupplyUsd > 0 && fin(leg.totalBorrowUsd) && leg.totalBorrowUsd >= 0;
  if (!marketOk(C) || !fin(C.supplyAprBase) || !fin(D.borrowAprBase)) return null;
  const rewardOk = (r: RewardRate) =>
    fin(r.apr) &&
    (r.perUserCapUsd === undefined || (fin(r.perUserCapUsd) && r.perUserCapUsd >= 0)) &&
    optOk(r.maxHealthFactor) &&
    (r.netOf === undefined || Array.isArray(r.netOf)) &&
    (r.ineligibleIfBorrowing === undefined || Array.isArray(r.ineligibleIfBorrowing)) &&
    (r.aprCap === undefined || (fin(r.aprCap) && r.aprCap >= 0));
  if (!C.supplyRewards.every(rewardOk) || !D.borrowRewards.every(rewardOk)) return null;
  if (!same && (!marketOk(D) || !fin(C.priceUsd) || !(C.priceUsd > 0) || !fin(D.priceUsd) || !(D.priceUsd > 0))) return null;

  const L = 1 / (1 - ltv);
  const id = `${sourceId}:${pair.protocol}:${pair.pairId}`;
  const myE = ctx.myEquityByOpp[id] ?? 0;

  // --- swap quote: unknown -> recent history / fallback; depth smoothed -------------
  // History holds the RAW quotes of previous cycles (metrics swap_depth_usd /
  // swap_cost_frac), so a reused value is never re-recorded as a fresh one.
  const since = ctx.nowMs - ctx.cfg.portfolio.max_data_age_minutes * 60_000;
  let swapCostFrac = pair.swapCostFrac;
  let swapDepthUsd = pair.swapDepthUsd;
  let reusedQuote = false;
  const quoteNotes: string[] = [];
  if (same) {
    // no swap in a same-asset loop: the numbers do not matter
    if (costUnknown) swapCostFrac = 0;
    if (depthUnknown) swapDepthUsd = Infinity;
  } else {
    if (costUnknown) {
      const prev = recentMetricValues(ctx.history, id, "swap_cost_frac", since);
      swapCostFrac = prev.length ? prev[prev.length - 1]! : ll.unknown_swap_cost_frac;
      reusedQuote = true;
      quoteNotes.push(prev.length ? "swap cost reused from the last quote" : `swap cost unknown, assumed ${ll.unknown_swap_cost_frac}`);
    }
    const prevDepth = recentMetricValues(ctx.history, id, "swap_depth_usd", since);
    if (depthUnknown) {
      // no recent depth: do not report the pair (blind), never a 0-capacity exit
      if (!prevDepth.length) return null;
      swapDepthUsd = median(prevDepth.slice(-3));
      reusedQuote = true;
      quoteNotes.push("swap depth reused from recent quotes");
    } else if (Number.isFinite(swapDepthUsd) && prevDepth.length) {
      // median of the last 3 observations: one bad quote cannot drain the capacity
      swapDepthUsd = median([...prevDepth.slice(-2), swapDepthUsd]);
    }
  }

  const S_c = C.totalSupplyUsd;
  const B_c = C.totalBorrowUsd;
  const B_d = same ? B_c : D.totalBorrowUsd;
  const cm = same ? marketView(S_c, B_c, L, L - 1, myE) : marketView(S_c, B_c, L, 0, myE);
  const dm = same ? cm : marketView(D.totalSupplyUsd, B_d, 0, L - 1, myE);
  const irmC = same ? C.irm ?? D.irm : C.irm;
  const irmD = same ? irmC : D.irm;
  // Same asset keeps loopLending.ts's gross-footprint ramp; a pair ramps on the added debt only.
  const rampPerE = same ? L : L - 1;

  const borrowAt = (E: number): number => {
    if (irmD) return interpIrm(irmD, dm.uAt(E));
    const added = Math.max(0, E - myE) * rampPerE;
    const denom = Math.max(1, dm.available * ctx.cfg.liquidity.entry_max_frac_of_capacity);
    const k = 1 + (ll.rate_uncertainty_mult - 1) * Math.min(1, added / denom);
    return D.borrowAprBase * k;
  };
  const supplyAt = (E: number): number => {
    if (!irmC) return C.supplyAprBase;
    const u = cm.uAt(E);
    return interpIrm(irmC, u) * u * (1 - irmC.reserveFactor);
  };

  const streams: YieldStream[] = [
    { label: "supply_base", kind: "base", aprAt: (E) => L * supplyAt(E) },
    { label: "borrow_base", kind: "borrow_cost", aprAt: (E) => -(L - 1) * borrowAt(E) },
  ];
  // Reward eligibility / basis (RewardRate.netOf, perUserCapUsd, maxHealthFactor).
  // Plain rewards (none of those fields) are the unmodified proRataStream.
  const hf = pair.liqLtv / ltv;
  const rewardNotes: Record<string, string[]> = {};
  const rewardStream = (r: RewardRate, side: "supply" | "borrow"): YieldStream => {
    const label = `${side}_reward:${r.token}`;
    const other = side === "supply" ? D.symbol : C.symbol;
    const net = Array.isArray(r.netOf) && r.netOf.some((s) => s === other || s === "*");
    // Basis per USD of equity. Supply: gross L, net L*E-(L-1)*E = E.
    // Borrow: gross L-1, net (L-1)*E - L*E < 0 -> nothing accrues.
    // The pool stays the reported gross pool (net pool totals are not in the
    // contract); see the report on the dilution approximation.
    const g = side === "supply" ? (net ? 1 : L) : L - 1;
    const base = proRataStream({
      label,
      kind: "reward",
      aprNow: r.aprCap !== undefined ? Math.min(r.apr, r.aprCap) : r.apr,
      poolUsd: side === "supply" ? S_c : B_d,
      grossPerEquity: g,
      myEquityNowUsd: myE,
      aprMultiplier: g,
      rewardToken: r.token,
      endsAtMs: r.endsAtMs ?? null,
    });
    const notes: string[] = [];
    if (net) notes.push(side === "supply" ? "net_basis" : "net_basis_negative");
    const hfIneligible = r.maxHealthFactor !== undefined && hf > r.maxHealthFactor;
    if (hfIneligible) notes.push(`hf_${hf.toFixed(3)}_above_max_${r.maxHealthFactor}`);
    const cap = r.perUserCapUsd;
    if (cap !== undefined) notes.push(`per_user_cap_usd_${cap}`);
    const debtIds = [D.assetId, D.symbol].filter((x): x is string => !!x).map((x) => x.toLowerCase());
    const borrowIneligible = !!r.ineligibleIfBorrowing?.some((x) => debtIds.includes(x.toLowerCase()));
    if (borrowIneligible) notes.push(`ineligible_borrowing_${D.symbol}`);
    if (r.aprCap !== undefined && r.apr > r.aprCap) notes.push(`apr_capped_${r.aprCap}`);
    if (notes.length) rewardNotes[label] = notes;

    if ((side === "borrow" && net) || hfIneligible || borrowIneligible || cap === 0) return { ...base, aprAt: () => 0 };
    if (cap === undefined) return base;
    return {
      ...base,
      aprAt: (E: number) => {
        const apr = base.aprAt(E);
        const basisUsd = g * Math.max(0, E);
        return basisUsd > cap ? apr * (cap / basisUsd) : apr;
      },
    };
  };
  for (const r of C.supplyRewards) streams.push(rewardStream(r, "supply"));
  for (const r of D.borrowRewards) streams.push(rewardStream(r, "borrow"));

  const gas = gasUsd(ctx.cfg, pair.chain);
  const footprintPerEquity = ll.footprint === "gross" ? L : 1;
  const sig = (name: string, value: number, warnAt: number, exitAt: number): StressSignal => ({
    name,
    value,
    warnAt,
    exitAt,
    direction: "above",
  });
  const expRatio = pair.expectedPriceRatio !== undefined && fin(pair.expectedPriceRatio) && pair.expectedPriceRatio > 0 ? pair.expectedPriceRatio : 1;
  const depeg = same ? 0 : Math.abs(D.priceUsd / C.priceUsd / expRatio - 1);
  // Strictest of the per-stable levels of both legs AND the lending_loop levels: a
  // leveraged position loses L x the depeg at exit, so loops never get looser
  // levels than sources.lending_loop.depeg_* (the per-stable levels are sized for 1x).
  const dlS = depegLevels(ctx.cfg, [C.symbol, D.symbol]);
  const dl = { warn: Math.min(dlS.warn, ll.depeg_warn), exit: Math.min(dlS.exit, ll.depeg_exit) };
  // Expected depeg loss as a running cost: a same-asset loop is exposed 1x
  // (both legs move together); a pair conservatively L x on the collateral.
  const risk = stableRisk(ctx.cfg, C.symbol);
  const depegLossApr = (same ? 1 : L) * risk.lossApr;
  const signalsAt = (uc: number, ud: number): StressSignal[] =>
    same
      ? [sig("utilization", uc, ll.utilization_warn, ll.utilization_exit)]
      : [
          sig("utilization:collateral", uc, ll.utilization_warn, ll.utilization_exit),
          sig("utilization:debt", ud, ll.utilization_warn, ll.utilization_exit),
          sig("depeg", depeg, dl.warn, dl.exit),
        ];

  // Two assets: unwinding withdraws L*E collateral from the collateral market
  // (even with a flashloan, which comes from the debt side) and swaps (L-1)*E
  // back to the debt asset. Both limits are converted into the same units as
  // `footprintPerEquity` so the router's E*footprint/capacity check binds on
  // whichever is tighter. With the default gross footprint this is
  // min(S_c - B_c, swapDepth * L/(L-1)).
  const poolCapacity = same ? cm.available : ll.footprint === "gross" ? cm.available : cm.available / L;
  const swapCapacity = same ? Infinity : ll.footprint === "gross" ? (swapDepthUsd * L) / (L - 1) : swapDepthUsd / (L - 1);
  const exitCapacityUsd = Math.min(poolCapacity, swapCapacity);
  const binding: "pool" | "swap" = swapCapacity < poolCapacity ? "swap" : "pool";

  const caps: number[] = [];
  if (C.supplyCapRemainingUsd !== undefined && C.supplyCapRemainingUsd !== null) caps.push(myE + C.supplyCapRemainingUsd / L);
  if (D.borrowCapRemainingUsd !== undefined && D.borrowCapRemainingUsd !== null) caps.push(myE + D.borrowCapRemainingUsd / (L - 1));

  const metrics: Record<string, number> = same
    ? { borrow_apr: D.borrowAprBase, supply_apr: C.supplyAprBase, utilization: cm.uNow, tvl_usd: S_c }
    : {
        borrow_apr: D.borrowAprBase,
        supply_apr: C.supplyAprBase,
        utilization_c: cm.uNow,
        utilization_d: dm.uNow,
        tvl_usd: S_c,
        depeg,
      };
  // raw fresh quotes only (the fallback above reads these back)
  if (!same && !depthUnknown && Number.isFinite(pair.swapDepthUsd)) metrics.swap_depth_usd = pair.swapDepthUsd;
  if (!same && !costUnknown) metrics.swap_cost_frac = pair.swapCostFrac;
  const flags: Flag[] = pair.paused ? [{ name: "market_paused", severity: "exit" }] : [];
  // warn severity: blocks entries and top-ups, never exits a held position
  if (reusedQuote) flags.push({ name: "swap_quote_unknown", severity: "warn", detail: quoteNotes.join("; ") });

  const o: Opportunity = {
    id,
    sourceId,
    kind: "lending_loop",
    name: `${pair.protocol} ${same ? C.symbol : `${C.symbol}/${D.symbol}`} loop @${(ltv * 100).toFixed(0)}% LTV`,
    primaryVenue: pair.protocol,
    chain: pair.chain,
    legs: [{ venue: pair.protocol, chain: pair.chain, token: C.symbol, equityFrac: 1, grossFrac: L }],
    streams,
    costs: {
      entryFrac: (L - 1) * ((D.borrowFeeFrac ?? 0) + swapCostFrac),
      exitFrac: (L - 1) * swapCostFrac + (ll.footprint === "net" ? (L - 1) * (pair.flashloanFeeFrac ?? 0) : 0),
      fixedEntryUsd: gas * ll.txs_per_entry,
      fixedExitUsd: gas * ll.txs_per_exit,
      ongoingApr: depegLossApr,
    },
    liquidity: {
      exitCapacityUsd,
      footprintPerEquity,
      estimated: opts.estimated || reusedQuote || undefined,
      // same asset: pool liquidity is the only limit (undefined = pool-driven)
      ...(same ? {} : { binding }),
      ...(reusedQuote ? { reusedQuote: true } : {}),
    },
    signals: signalsAt(cm.uNow, dm.uNow),
    projectedSignals: (E) => signalsAt(cm.uAt(E), dm.uAt(E)),
    flags,
    metrics,
    health:
      myE > 0 && pair.myLtv !== undefined
        ? {
            metric: "ltv",
            value: pair.myLtv,
            // Pairs: never let the deleverage level sit within 3% of liquidation
            // (Morpho-style LLTVs can be low). Same asset keeps loopLending.ts's
            // exact behaviour.
            rebalanceAt: same ? ll.deleverage_at_ltv : Math.min(ll.deleverage_at_ltv, pair.liqLtv * 0.97),
            criticalAt: pair.liqLtv * ll.critical_ltv_frac_of_close,
            direction: "above",
          }
        : undefined,
    maxEquityUsd: caps.length ? Math.min(...caps) : undefined,
    funding: { chain: pair.chain, asset: C.symbol },
    myEquityUsd: myE,
    observedAtMs: ctx.nowMs,
    meta: {
      leverage: L,
      ltv,
      pairId: pair.pairId,
      debtSymbol: D.symbol,
      depegLossApr,
      stableRisk: { symbol: C.symbol, tier: risk.tier, lossApr: risk.lossApr, known: risk.known },
    },
  };
  if (pair.dataAsOfMs !== undefined) o.dataAsOfMs = pair.dataAsOfMs;
  if (Object.keys(rewardNotes).length) o.meta = { ...o.meta, rewardNotes };
  return o;
}

/** Wrap any async pair provider (live adapters in packages/live-*). */
export class LoopPairSource implements Source {
  constructor(
    readonly id: string,
    private readonly provider: () => Promise<LoopPair[]>
  ) {}
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const pairs = await this.provider();
    return pairs.map((p) => loopPairOpportunity(p, ctx, this.id)).filter((o): o is Opportunity => o !== null);
  }
}
