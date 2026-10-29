import { capViolations, withAddition } from "../exposure.js";
import { entryThreshold, venueEnabled, venueTier } from "../tiers.js";
import type { Opportunity } from "../types.js";
import { marginalNetApr, valueAt } from "../valuation.js";
import { effectiveCapacity, liquidityUsage, signalLevel, venues, type DecisionContext } from "./common.js";

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/**
 * Size-independent entry gates. If any of these fail there is no point
 * sizing the opportunity at all.
 */
export function entryBlockers(opp: Opportunity, ctx: DecisionContext): string[] {
  const { cfg } = ctx;
  const r: string[] = [];
  if (ctx.paused) r.push("router paused");
  if (opp.discoveryOnly) r.push("discovery only (no executor wired)");
  for (const v of venues(opp)) if (!venueEnabled(cfg, v)) r.push(`venue ${v} disabled`);

  // The wash-trading line: a hedge must sit on two different venues.
  if (opp.kind === "delta_neutral_perp" && venues(opp).length < 2)
    r.push("delta-neutral legs on a single venue = self-matching risk; refused");

  const cd = ctx.cooldownUntil[opp.id];
  if (cd !== undefined && ctx.nowMs < cd) r.push(`re-entry cooldown until ${new Date(cd).toISOString()}`);

  // `opp.flags` already includes the history-derived flags (capacity drain,
  // spikes, emission cut): the router merges them in before planning.
  for (const f of opp.flags) r.push(`flag ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  for (const s of opp.signals) {
    const lvl = signalLevel(s);
    if (lvl !== "ok") r.push(`signal ${s.name}=${s.value.toFixed(4)} at ${lvl} level`);
  }

  // Top-ups of something we already hold: never into a position that is
  // being exited, under exit debounce, or drifting on health.
  const held = ctx.positions.find((p) => p.oppId === opp.id);
  if (held) {
    if (held.forcedExit) r.push(`exit pending (${held.forcedExit.reason})`);
    if (Object.values(held.pending).some((n) => n > 0)) r.push("exit rule under confirmation");
    if (held.exitProbe.consecutiveFailures > 0) r.push("exit simulation failing");
    const h = opp.health;
    if (h && (h.direction === "above" ? h.value >= h.rebalanceAt : h.value <= h.rebalanceAt))
      r.push(`health ${h.metric}=${h.value.toFixed(4)} past rebalance level`);
  }

  // Supply deposits: the stable's depeg-risk tier must be acceptable (loops keep
  // their own rules and only pay the expected-loss haircut).
  const sr = opp.meta?.["stableRisk"] as { symbol: string; tier: number } | undefined;
  if (opp.kind === "deposit" && sr && sr.tier > cfg.sources.supply.max_risk_tier)
    r.push(`depeg risk tier ${sr.tier} > max ${cfg.sources.supply.max_risk_tier} (${sr.symbol})`);

  const cap = effectiveCapacity(cfg, opp);
  if (cap < cfg.liquidity.min_capacity_usd)
    r.push(`exit capacity $${Math.round(cap)} < min $${cfg.liquidity.min_capacity_usd}`);
  return r;
}

export interface SizedCheck {
  ok: boolean;
  reasons: string[];
  avgNetApr: number;
  marginalNetApr: number;
  speculativeApr: number;
}

/** Gates that depend on how much we put in: liquidity share, caps, economics. */
export function checkSizedEntry(opp: Opportunity, fromUsd: number, toUsd: number, ctx: DecisionContext): SizedCheck {
  const { cfg } = ctx;
  const r: string[] = [];
  const tier = venueTier(cfg, opp.primaryVenue);

  if (fromUsd <= 0 && toUsd < cfg.caps.min_position_usd) r.push(`below min_position_usd ${cfg.caps.min_position_usd}`);
  if (toUsd > cfg.caps.max_position_usd) r.push(`above max_position_usd ${cfg.caps.max_position_usd}`);
  if (opp.maxEquityUsd !== undefined && toUsd > opp.maxEquityUsd)
    r.push(`above protocol-side limit $${Math.round(opp.maxEquityUsd)}`);

  // Generalized 1/10 rule: what I need to get out <= 10% of what can get out.
  const usage = liquidityUsage(cfg, opp, toUsd);
  if (usage > cfg.liquidity.entry_max_frac_of_capacity)
    r.push(`would use ${pct(usage)} of exit capacity > ${pct(cfg.liquidity.entry_max_frac_of_capacity)}`);

  // Post-entry signals (e.g. utilization after my loop is in).
  for (const s of opp.projectedSignals?.(toUsd) ?? []) {
    const lvl = signalLevel(s);
    if (lvl !== "ok") r.push(`projected ${s.name}=${s.value.toFixed(4)} at ${lvl} level after entry`);
  }

  r.push(...capViolations(cfg, withAddition(ctx.exposure, opp, toUsd - fromUsd), opp, ctx.totalEquityUsd));

  const v = valueAt(opp, toUsd, ctx);
  const marginal = marginalNetApr(opp, fromUsd, toUsd, ctx);
  if (!Number.isFinite(v.netApr) || !Number.isFinite(marginal)) r.push("valuation not finite (bad source data?)");
  if (opp.speculative) {
    // Points farm: pay at most max_cost_apr for the lottery ticket.
    if (!(v.speculativeApr > 0)) r.push("speculative opportunity without a points stream");
    if (v.netApr < -cfg.points.max_cost_apr) r.push(`points cost ${pct(-v.netApr)}/yr > max ${pct(cfg.points.max_cost_apr)}`);
    if (marginal < -cfg.points.max_cost_apr) r.push(`marginal points cost ${pct(-marginal)}/yr too high`);
  } else {
    const th = entryThreshold(cfg, tier, opp.kind);
    if (v.netApr < th) r.push(`net APR ${pct(v.netApr)} < entry ${pct(th)} (tier ${tier})`);
    if (marginal < th) r.push(`marginal APR ${pct(marginal)} < entry ${pct(th)}`);
  }
  return { ok: r.length === 0, reasons: r, avgNetApr: v.netApr, marginalNetApr: marginal, speculativeApr: v.speculativeApr };
}
