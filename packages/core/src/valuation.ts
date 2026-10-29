import { rewardTokenConfig, type RouterConfig } from "./config.js";
import { stableConfig } from "./stables.js";
import type { Opportunity, TokenProfile, YieldStream } from "./types.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const YEAR_HOURS = 8760;

export interface ValuationContext {
  cfg: RouterConfig;
  nowMs: number;
  tokens: Record<string, TokenProfile>;
}

export interface StreamValue {
  label: string;
  kind: YieldStream["kind"];
  rawApr: number;
  /** Fraction of the raw APR we expect to actually realize in USD. */
  realizable: number;
  /** Fraction of the hold horizon during which the stream is still alive. */
  timeWeight: number;
  valuedApr: number;
}

export interface Valuation {
  equityUsd: number;
  /** Sum of raw APRs of non-speculative streams. */
  rawApr: number;
  /** Sum after haircuts and time weights. */
  realizableApr: number;
  costApr: number;
  netApr: number;
  /** Points & co: shown, never counted in netApr. */
  speculativeApr: number;
  streams: StreamValue[];
}

export interface ValueOptions {
  /** Drop streams that end within this many ms (the "does the edge survive" test). */
  excludeEndingWithinMs?: number;
  /** Position already exists: entry cost is sunk, exit cost is paid either way. */
  holding?: boolean;
  /**
   * With excludeEndingWithinMs: keep the ending streams scaled by this factor
   * instead of dropping them (the renewal probability of a re-posted campaign).
   */
  endingScale?: number;
  /**
   * Value streams at their current rate until they end (no horizon
   * time-weighting). Used for hold decisions: whether a stream that ends
   * soon still carries the edge is rule 6's job, not the spread rule's.
   */
  noTimeWeight?: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Realizable fraction of a reward token stream.
 *
 * loop-farm used a flat 50%. Here it is derived from what we know about the
 * token so that it can be measured instead of guessed:
 *
 *   realizable = 1 - slippage - drift
 *   slippage   = 2% x claimSize / depth2pct           (linear impact model, capped 50%)
 *   drift      = sell_on_claim: max(0,-trend) * t + k * vol * sqrt(t)   t = claim interval in years
 *              = hedge:         hedgeCost * t        (price risk hedged away)
 *              = hold:          same as sell_on_claim but t = hold horizon
 *
 * Unknown token -> default_realizable. Result is clamped to [min, max].
 * The Plasma/XPL lesson is the `trend` and `t` terms: for a token trending
 * -90%/yr with 120% vol, sell-on-claim daily realizes ~0.93; holding for the
 * 3-week horizon realizes ~0.66 (trend ~5% + a 3-week one-sigma penalty).
 */
export function rewardRealizable(
  ctx: ValuationContext,
  token: string,
  claimSizeUsd: number
): number {
  const { cfg } = ctx;
  const p = ctx.tokens[token];
  // A reward paid in a stablecoin from the `stables` table (USDC net-lending
  // top-ups, GHO, RLUSD ...) with no token profile: no price drift to haircut;
  // its depeg risk is a tier-2/3 matter, not a selling one.
  if (!p && stableConfig(cfg, token)) return cfg.rewards.max_realizable;
  // A price alone says nothing about how sellable the token is: without depth
  // AND volatility we fall back to the conservative default.
  if (!p || !(p.depth2pctUsd !== undefined && p.depth2pctUsd > 0) || p.vol === undefined)
    return cfg.rewards.default_realizable;
  const tc = rewardTokenConfig(cfg, token);
  const slip = Math.min(0.5, (0.02 * claimSizeUsd) / p.depth2pctUsd);
  let drift: number;
  if (tc.policy === "hedge" && p.perpAvailable) {
    const t = tc.claim_interval_hours / YEAR_HOURS;
    drift = (p.hedgeCostApr ?? 0.1) * t;
  } else {
    const hours = tc.policy === "hold" ? cfg.hold_horizon_days * 24 : tc.claim_interval_hours;
    const t = hours / YEAR_HOURS;
    drift = Math.max(0, -(p.trendApr ?? 0)) * t + cfg.rewards.vol_penalty_k * (p.vol ?? 0) * Math.sqrt(t);
  }
  return clamp(1 - slip - drift, cfg.rewards.min_realizable, cfg.rewards.max_realizable);
}

/**
 * Share of the hold horizon during which a stream is expected to be alive.
 * With a renewal assumption (rewards.renewal[venue]: campaigns that are
 * re-posted every `period_days` with probability `prob`, e.g. weekly Aave /
 * Merkl top-ups), each further period counts with prob^k.
 */
export function timeWeight(
  ctx: ValuationContext,
  endsAtMs: number | null | undefined,
  noTimeWeight = false,
  renewal?: { prob: number; period_days: number }
): number {
  if (endsAtMs === null || endsAtMs === undefined) return 1;
  const remaining = endsAtMs - ctx.nowMs;
  if (remaining <= 0) return 0;
  if (noTimeWeight) return 1;
  const H = ctx.cfg.hold_horizon_days * DAY;
  if (!renewal || !(renewal.prob > 0) || !(renewal.period_days > 0)) return clamp(remaining / H, 0, 1);
  const T = renewal.period_days * DAY;
  let alive = Math.min(remaining, H);
  let t = remaining;
  for (let k = 1, w = renewal.prob; t < H && w > 1e-6; k++, w *= renewal.prob) {
    alive += w * Math.min(T, H - t);
    t += T;
  }
  return clamp(alive / H, 0, 1);
}

export function valueAt(
  opp: Opportunity,
  equityUsd: number,
  ctx: ValuationContext,
  opts: ValueOptions = {}
): Valuation {
  const { cfg } = ctx;
  const streams: StreamValue[] = [];
  let rawApr = 0;
  let realizableApr = 0;
  let speculativeApr = 0;

  const renewal = cfg.rewards.renewal?.[opp.primaryVenue];
  for (const s of opp.streams) {
    let scale = 1;
    if (
      opts.excludeEndingWithinMs !== undefined &&
      s.endsAtMs !== null &&
      s.endsAtMs !== undefined &&
      s.endsAtMs - ctx.nowMs <= opts.excludeEndingWithinMs
    ) {
      if (!(opts.endingScale !== undefined && opts.endingScale > 0 && s.kind === "reward")) continue;
      scale = opts.endingScale;
    }
    const raw = s.aprAt(Math.max(0, equityUsd)) * scale;
    let realizable = 1;
    let tw = 1;
    switch (s.kind) {
      case "points":
        speculativeApr += raw;
        streams.push({ label: s.label, kind: s.kind, rawApr: raw, realizable: 0, timeWeight: 1, valuedApr: 0 });
        continue;
      case "reward": {
        const tc = rewardTokenConfig(cfg, s.rewardToken ?? "?");
        const claimSize = equityUsd * Math.max(0, raw) * (tc.claim_interval_hours / YEAR_HOURS);
        realizable = rewardRealizable(ctx, s.rewardToken ?? "?", claimSize);
        tw = timeWeight(ctx, s.endsAtMs, opts.noTimeWeight, renewal);
        break;
      }
      case "funding":
        realizable = raw > 0 ? cfg.funding.realizable : 1;
        tw = timeWeight(ctx, s.endsAtMs, opts.noTimeWeight);
        break;
      default:
        tw = timeWeight(ctx, s.endsAtMs, opts.noTimeWeight);
    }
    // Costs (negative streams) are never haircut down: we pay them in full
    // while the stream is alive (a borrow that "ends" is not a thing, but be exact).
    const valued = raw < 0 ? raw * (tw > 0 ? 1 : 0) : raw * realizable * tw;
    rawApr += raw;
    realizableApr += valued;
    streams.push({ label: s.label, kind: s.kind, rawApr: raw, realizable, timeWeight: tw, valuedApr: valued });
  }

  const costApr = costAprAt(opp, equityUsd, ctx, opts.holding ?? false);
  return {
    equityUsd,
    rawApr,
    realizableApr,
    costApr,
    netApr: realizableApr - costApr,
    speculativeApr,
    streams,
  };
}

/** Running costs + one-offs amortized over the expected hold horizon. */
export function costAprAt(opp: Opportunity, equityUsd: number, ctx: ValuationContext, holding: boolean): number {
  const c = opp.costs;
  if (holding) return c.ongoingApr; // entry is sunk; exit cost is paid whether we leave now or later
  const perYear = 365 / ctx.cfg.hold_horizon_days;
  const fixedUsd = c.fixedEntryUsd + c.fixedExitUsd;
  const fixed = fixedUsd <= 0 ? 0 : equityUsd > 0 ? (fixedUsd / equityUsd) * perYear : Infinity;
  return c.ongoingApr + (c.entryFrac + c.exitFrac) * perYear + fixed;
}

/**
 * Net APR earned by the marginal dollars between `fromUsd` and `toUsd`.
 * Because emissions are shared pro-rata and IRMs move with utilization, the
 * marginal APR is below the average APR — the allocator ranks on this.
 */
export function marginalNetApr(opp: Opportunity, fromUsd: number, toUsd: number, ctx: ValuationContext): number {
  if (toUsd <= fromUsd) return -Infinity;
  // Opening a new position: the marginal dollars ARE the position.
  if (fromUsd <= 0) return valueAt(opp, toUsd, ctx).netApr;
  // Topping up: existing dollars' one-offs are sunk; the new dollars pay their
  // own proportional one-offs plus one extra entry transaction.
  const delta = toUsd - fromUsd;
  const perYear = 365 / ctx.cfg.hold_horizon_days;
  const oneOffsPerYear =
    (opp.costs.entryFrac + opp.costs.exitFrac) * perYear * delta + opp.costs.fixedEntryUsd * perYear;
  const after = valueAt(opp, toUsd, ctx, { holding: true }).netApr * toUsd;
  const before = valueAt(opp, fromUsd, ctx, { holding: true }).netApr * fromUsd;
  return (after - before - oneOffsPerYear) / delta;
}

/**
 * Net APR earned by money ALREADY held between `fromUsd` and `toUsd` (no
 * one-offs: they are sunk for held money). Used by the "oversized" exit rule.
 */
export function marginalHoldApr(opp: Opportunity, fromUsd: number, toUsd: number, ctx: ValuationContext): number {
  if (toUsd <= fromUsd) return -Infinity;
  const o: ValueOptions = { holding: true, noTimeWeight: true };
  const after = valueAt(opp, toUsd, ctx, o).netApr * toUsd;
  const before = valueAt(opp, fromUsd, ctx, o).netApr * fromUsd;
  return (after - before) / (toUsd - fromUsd);
}

// ---------------------------------------------------------------------------
// Stream builders shared by the sources
// ---------------------------------------------------------------------------

export function constantStream(label: string, kind: YieldStream["kind"], apr: number, extra: Partial<YieldStream> = {}): YieldStream {
  return { label, kind, aprAt: () => apr, ...extra };
}

/**
 * A fixed emission shared pro-rata over a pool.
 *  aprNow           APR currently shown for the pool (on the pool's own unit)
 *  poolUsd          pool size the APR is computed on, INCLUDING my current contribution
 *  grossPerEquity   how many pool-dollars one USD of my equity adds (L for loop supply, ...)
 *  myEquityNowUsd   my equity currently inside poolUsd
 *  aprMultiplier    converts pool-unit APR into APR on my equity (usually = grossPerEquity)
 */
export function proRataStream(args: {
  label: string;
  kind: YieldStream["kind"];
  aprNow: number;
  poolUsd: number;
  grossPerEquity: number;
  myEquityNowUsd: number;
  aprMultiplier: number;
  rewardToken?: string;
  endsAtMs?: number | null;
}): YieldStream {
  const emissionPerYear = args.aprNow * args.poolUsd;
  const exMe = Math.max(0, args.poolUsd - args.grossPerEquity * args.myEquityNowUsd);
  return {
    label: args.label,
    kind: args.kind,
    rewardToken: args.rewardToken,
    endsAtMs: args.endsAtMs,
    aprAt: (e: number) => {
      const denom = exMe + args.grossPerEquity * Math.max(0, e);
      if (denom <= 0) return 0;
      return (emissionPerYear / denom) * args.aprMultiplier;
    },
  };
}
