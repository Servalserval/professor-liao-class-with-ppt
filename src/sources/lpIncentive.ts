import { gasUsd } from "../config.js";
import type { Flag, Opportunity, YieldStream } from "../types.js";
import { proRataStream } from "../valuation.js";
import type { SourceContext } from "./types.js";

export interface LpReward {
  token: string;
  /** USD emitted per day to the pool (or to the in-range liquidity). */
  dailyUsd: number;
  endsAtMs?: number | null;
}

export interface LpIncentiveInput {
  venue: string;
  chain: string;
  pool: string;
  tokenA: string;
  tokenB: string;
  /**
   * Liquidity that shares fees and rewards with me, in full-range-equivalent
   * USD, including my current position (my USD counts `concentration` times).
   */
  tvlUsd: number;
  /** Trailing fees per year / tvlUsd. */
  feeApr: number;
  rewards: LpReward[];
  /** Annualized vol of the A/B price (0 for a stable pair). */
  pairVol: number;
  /**
   * Capital-efficiency multiple of my range vs full range (1 = full range).
   * Scales both my share of fees/rewards and the LVR I pay.
   */
  concentration: number;
  /** USD that can be dumped of the volatile side within the impact budget. */
  exitCapacityUsd: number;
  /** Price of A in B vs reference (oracle / CEX), for depeg detection. */
  priceDeviation?: number;
  depegWarn?: number;
  depegExit?: number;
  /** Delta-hedged with a perp: removes directional exposure, not LVR. */
  hedged?: { venue: string; chain: string; costApr: number; marginFrac: number };
  paused?: boolean;
}

/**
 * Incentivized LP position (Aqua / CL pools with Merkl or gauge rewards).
 *
 * Fees and rewards are shared pro-rata with the in-range TVL, my liquidity
 * counting `concentration` times. The cost side is loss-versus-rebalancing:
 * LVR ~ sigma^2 / 8 per year for a full-range CPMM, scaled by concentration.
 * A hedge does not remove LVR (LVR is exactly what a hedged LP loses); it only
 * removes the directional exposure and adds the hedge's funding cost.
 */
export function lpIncentiveOpportunity(input: LpIncentiveInput, ctx: SourceContext, sourceId: string): Opportunity {
  const id = `${sourceId}:${input.venue}:${input.pool}`;
  const myE = ctx.myEquityByOpp[id] ?? 0;
  const c = Math.max(1, input.concentration);

  const streams: YieldStream[] = [
    proRataStream({
      label: "fees",
      kind: "fee",
      aprNow: input.feeApr, // fees per year / TVL (per pool-dollar); my dollar counts c times
      poolUsd: input.tvlUsd,
      grossPerEquity: c,
      myEquityNowUsd: myE,
      aprMultiplier: c,
    }),
  ];
  for (const r of input.rewards) {
    streams.push(
      proRataStream({
        label: `reward:${r.token}`,
        kind: "reward",
        aprNow: input.tvlUsd > 0 ? (r.dailyUsd * 365) / input.tvlUsd : 0,
        poolUsd: input.tvlUsd,
        grossPerEquity: c,
        myEquityNowUsd: myE,
        aprMultiplier: c,
        rewardToken: r.token,
        endsAtMs: r.endsAtMs ?? null,
      })
    );
  }

  const lvrApr = ((input.pairVol * input.pairVol) / 8) * c;
  const hedgeCost = input.hedged ? input.hedged.costApr * 0.5 : 0; // hedge ~ half of the position is the volatile side
  const flags: Flag[] = input.paused ? [{ name: "pool_paused", severity: "exit" }] : [];

  const legs = input.hedged
    ? [
        { venue: input.venue, chain: input.chain, token: input.tokenA, equityFrac: 0.5 * (1 - input.hedged.marginFrac) },
        { venue: input.venue, chain: input.chain, token: input.tokenB, equityFrac: 0.5 * (1 - input.hedged.marginFrac) },
        { venue: input.hedged.venue, chain: input.hedged.chain, token: "USDC", equityFrac: input.hedged.marginFrac },
      ]
    : [
        { venue: input.venue, chain: input.chain, token: input.tokenA, equityFrac: 0.5 },
        { venue: input.venue, chain: input.chain, token: input.tokenB, equityFrac: 0.5 },
      ];

  const gas = gasUsd(ctx.cfg, input.chain);
  return {
    id,
    sourceId,
    kind: "lp_incentive",
    name: `${input.venue} ${input.tokenA}/${input.tokenB} LP${input.hedged ? " (hedged)" : ""}`,
    primaryVenue: input.venue,
    chain: input.chain,
    legs,
    streams,
    costs: {
      entryFrac: 0.001, // swap to the pool ratio
      exitFrac: 0.001,
      fixedEntryUsd: gas * 2,
      fixedExitUsd: gas * 2,
      ongoingApr: lvrApr + hedgeCost,
    },
    // on the way out half the equity is the volatile side that must be sold
    liquidity: { exitCapacityUsd: input.exitCapacityUsd, footprintPerEquity: input.hedged ? 0.1 : 0.5 },
    signals:
      input.priceDeviation !== undefined
        ? [
            {
              name: "price_deviation",
              value: Math.abs(input.priceDeviation),
              warnAt: input.depegWarn ?? 0.005,
              exitAt: input.depegExit ?? 0.02,
              direction: "above",
            },
          ]
        : [],
    flags,
    metrics: { tvl_usd: input.tvlUsd, fee_apr: input.feeApr },
    myEquityUsd: myE,
    observedAtMs: ctx.nowMs,
    meta: { lvrApr, concentration: c },
  };
}
