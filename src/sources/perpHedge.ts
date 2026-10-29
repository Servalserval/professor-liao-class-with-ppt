import { gasUsd } from "../config.js";
import { venueTier } from "../tiers.js";
import type { Opportunity, YieldStream } from "../types.js";
import { constantStream } from "../valuation.js";
import type { SourceContext } from "./types.js";

export interface PerpVenueQuote {
  venue: string;
  /** "offchain" for CEX-like venues (no gas). */
  chain: string;
  /** Look-back averaged funding, annualized on notional; + means longs pay shorts. */
  fundingApr: number;
  /** Notional you can trade within your impact budget (USD). */
  depthUsd: number;
  takerFee: number;
  makerFee: number;
  markPrice: number;
  marginToken?: string;
  /** Points per USD of volume / per USD of open interest held for a year. */
  pointsPerUsdVolume?: number;
  pointsPerUsdOiYear?: number;
  paused?: boolean;
}

export interface PerpHedgeInput {
  asset: string;
  long: PerpVenueQuote;
  short: PerpVenueQuote;
  /** Notional / margin on each leg. Equity is split evenly between the two venues. */
  leverage: number;
  /** Extra round-trip volume farmed per year, as multiples of notional (0 = pure funding carry). */
  turnoverPerYear?: number;
  /** Your guess of $ per point. Undefined = points valued at 0 (shown as speculative only). */
  pointValueUsd?: number;
  /** The edge is points: use the speculative budget and rules. */
  farmPoints?: boolean;
  useMaker?: boolean;
  basisWarnBps?: number;
  basisExitBps?: number;
  /** Current smallest distance to liquidation across legs (fraction of price), when open. */
  liqDistance?: number;
}

/**
 * Cross-venue delta-neutral perp position: long where funding is cheap,
 * short where it is rich, optionally farming points with turnover.
 *
 *   n = notional per equity = leverage / 2 (half the equity margins each leg)
 *   funding APR on equity = (fundingShort - fundingLong) * n   (valued at funding.realizable)
 *   fees: entry and exit n*(feeL+feeS) each; turnover adds turnover*n*(feeL+feeS) per year
 *   capacity = min(depthL, depthS); footprint = n
 *
 * Same-venue legs are rejected outright: that is self-matching / wash trading
 * and gets points programs (and accounts) disqualified.
 */
export function perpHedgeOpportunity(input: PerpHedgeInput, ctx: SourceContext, sourceId: string): Opportunity {
  const { long, short } = input;
  if (long.venue === short.venue) throw new Error(`perp hedge ${input.asset}: both legs on ${long.venue} (self-matching refused)`);
  if (!(input.leverage > 0)) throw new Error("leverage must be > 0");
  const n = input.leverage / 2;
  const fee = (q: PerpVenueQuote) => (input.useMaker ? q.makerFee : q.takerFee);
  const roundFee = n * (fee(long) + fee(short));
  const turnover = input.turnoverPerYear ?? 0;
  const fundingDiff = short.fundingApr - long.fundingApr;
  const id = `${sourceId}:${input.asset}:${long.venue}>${short.venue}`;

  const streams: YieldStream[] = [constantStream("funding_diff", "funding", fundingDiff * n)];
  const pointsPerYearPerEquity = [long, short].reduce(
    (a, q) => a + (q.pointsPerUsdVolume ?? 0) * (turnover + 2) * n + (q.pointsPerUsdOiYear ?? 0) * n,
    0
  );
  if (pointsPerYearPerEquity > 0)
    streams.push(constantStream("points", "points", pointsPerYearPerEquity * (input.pointValueUsd ?? 0)));

  const mid = (long.markPrice + short.markPrice) / 2;
  const basisBps = mid > 0 ? (Math.abs(long.markPrice - short.markPrice) / mid) * 1e4 : 0;
  const riskier = venueTier(ctx.cfg, long.venue) >= venueTier(ctx.cfg, short.venue) ? long : short;
  const gas = (q: PerpVenueQuote) => (q.chain === "offchain" ? 0 : gasUsd(ctx.cfg, q.chain));

  return {
    id,
    sourceId,
    kind: "delta_neutral_perp",
    name: `${input.asset} long ${long.venue} / short ${short.venue} x${input.leverage}`,
    primaryVenue: riskier.venue,
    chain: riskier.chain,
    legs: [
      { venue: long.venue, chain: long.chain, token: long.marginToken ?? "USDC", equityFrac: 0.5 },
      { venue: short.venue, chain: short.chain, token: short.marginToken ?? "USDC", equityFrac: 0.5 },
    ],
    streams,
    costs: {
      entryFrac: roundFee,
      exitFrac: roundFee,
      fixedEntryUsd: gas(long) + gas(short),
      fixedExitUsd: gas(long) + gas(short),
      ongoingApr: turnover * roundFee,
    },
    liquidity: { exitCapacityUsd: Math.min(long.depthUsd, short.depthUsd), footprintPerEquity: n },
    signals: [
      {
        name: "venue_basis_bps",
        value: basisBps,
        warnAt: input.basisWarnBps ?? 30,
        exitAt: input.basisExitBps ?? 100,
        direction: "above",
      },
    ],
    flags: [long, short].filter((q) => q.paused).map((q) => ({ name: `venue_paused:${q.venue}`, severity: "exit" as const })),
    metrics: { funding_diff_apr: fundingDiff, funding_flip_apr: -fundingDiff, venue_basis_bps: basisBps },
    health:
      input.liqDistance !== undefined
        ? {
            metric: "liq_distance",
            value: input.liqDistance,
            rebalanceAt: 0.5 / input.leverage,
            criticalAt: 0.2 / input.leverage,
            direction: "below",
          }
        : undefined,
    speculative: input.farmPoints ?? false,
    myEquityUsd: ctx.myEquityByOpp[id] ?? 0,
    observedAtMs: ctx.nowMs,
    meta: { notionalPerEquity: n, pointsPerYearPerEquity },
  };
}
