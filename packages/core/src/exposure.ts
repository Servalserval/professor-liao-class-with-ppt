import { chainCap, type RouterConfig } from "./config.js";
import { stableConfig } from "./stables.js";
import { venueTier } from "./tiers.js";
import type { Kind, Leg, Opportunity, Position } from "./types.js";

export interface Exposure {
  totalDeployedUsd: number;
  byVenue: Record<string, number>;
  byChain: Record<string, number>;
  byToken: Record<string, number>;
  byKind: Record<string, number>;
  byOpp: Record<string, number>;
  /** Unclaimed + held - hedged reward tokens. */
  byRewardToken: Record<string, number>;
  speculativeUsd: number;
  positions: number;
}

const add = (m: Record<string, number>, k: string, v: number) => {
  m[k] = (m[k] ?? 0) + v;
};

function addLegs(e: Exposure, legs: Leg[], equityUsd: number) {
  const sum = legs.reduce((a, l) => a + l.equityFrac, 0) || 1;
  for (const l of legs) {
    const usd = (equityUsd * l.equityFrac) / sum;
    add(e.byVenue, l.venue, usd);
    add(e.byChain, l.chain, usd);
    add(e.byToken, l.token, usd);
  }
}

export function computeExposure(positions: Position[]): Exposure {
  const e: Exposure = {
    totalDeployedUsd: 0,
    byVenue: {},
    byChain: {},
    byToken: {},
    byKind: {},
    byOpp: {},
    byRewardToken: {},
    speculativeUsd: 0,
    positions: 0,
  };
  for (const p of positions) {
    if (p.equityUsd <= 0) continue;
    e.positions += 1;
    e.totalDeployedUsd += p.equityUsd;
    addLegs(e, p.legs, p.equityUsd);
    add(e.byKind, p.kind, p.equityUsd);
    add(e.byOpp, p.oppId, p.equityUsd);
    if (p.speculative) e.speculativeUsd += p.equityUsd;
    for (const [tok, r] of Object.entries(p.rewards)) {
      add(e.byRewardToken, tok, Math.max(0, r.unclaimedUsd + r.heldUsd - r.hedgedUsd));
    }
  }
  return e;
}

/** Exposure as it would be after adding `deltaUsd` to `opp`. */
export function withAddition(e: Exposure, opp: Opportunity, deltaUsd: number): Exposure {
  const out: Exposure = {
    totalDeployedUsd: e.totalDeployedUsd + deltaUsd,
    byVenue: { ...e.byVenue },
    byChain: { ...e.byChain },
    byToken: { ...e.byToken },
    byKind: { ...e.byKind },
    byOpp: { ...e.byOpp },
    byRewardToken: { ...e.byRewardToken },
    speculativeUsd: e.speculativeUsd + (opp.speculative ? deltaUsd : 0),
    positions: e.positions + ((e.byOpp[opp.id] ?? 0) > 0 ? 0 : 1),
  };
  addLegs(out, opp.legs, deltaUsd);
  add(out.byKind, opp.kind, deltaUsd);
  add(out.byOpp, opp.id, deltaUsd);
  return out;
}

/**
 * Hard caps, all as fractions of TOTAL equity (deployed + idle) — the same
 * convention as loop-farm's per_protocol_frac / per_token_frac.
 * Returns human-readable violations (empty = OK).
 */
export function capViolations(cfg: RouterConfig, after: Exposure, opp: Opportunity, totalEquityUsd: number): string[] {
  const r: string[] = [];
  if (totalEquityUsd <= 0) return ["total equity is zero"];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const c = cfg.caps;

  for (const leg of opp.legs) {
    const cap = c.per_venue_frac_by_tier[venueTier(cfg, leg.venue)];
    const f = (after.byVenue[leg.venue] ?? 0) / totalEquityUsd;
    if (f > cap + 1e-9) r.push(`venue ${leg.venue} would be ${pct(f)} > cap ${pct(cap)}`);
    const cc = chainCap(cfg, leg.chain);
    const fc = (after.byChain[leg.chain] ?? 0) / totalEquityUsd;
    if (fc > cc + 1e-9) r.push(`chain ${leg.chain} would be ${pct(fc)} > cap ${pct(cc)}`);
    const ft = (after.byToken[leg.token] ?? 0) / totalEquityUsd;
    if (ft > c.per_token_frac + 1e-9) r.push(`token ${leg.token} would be ${pct(ft)} > cap ${pct(c.per_token_frac)}`);
    // per-stable cap (depeg concentration) across every position holding the asset
    const sm = stableConfig(cfg, leg.token)?.max_frac;
    if (sm !== undefined && ft > sm + 1e-9) r.push(`stable ${leg.token} would be ${pct(ft)} > stables.${leg.token}.max_frac ${pct(sm)}`);
  }
  const kindCap = c.per_kind_frac[opp.kind as Kind] ?? 1;
  const fk = (after.byKind[opp.kind] ?? 0) / totalEquityUsd;
  if (fk > kindCap + 1e-9) r.push(`kind ${opp.kind} would be ${pct(fk)} > cap ${pct(kindCap)}`);
  const fo = (after.byOpp[opp.id] ?? 0) / totalEquityUsd;
  if (fo > c.per_opportunity_frac + 1e-9) r.push(`opportunity would be ${pct(fo)} > cap ${pct(c.per_opportunity_frac)}`);
  if (after.positions > c.max_concurrent_positions) r.push(`max_concurrent_positions ${c.max_concurrent_positions} reached`);
  if (opp.speculative && after.speculativeUsd / totalEquityUsd > cfg.points.budget_frac + 1e-9)
    r.push(`speculative budget ${pct(cfg.points.budget_frac)} exceeded`);
  if (after.totalDeployedUsd / totalEquityUsd > 1 - c.min_idle_frac + 1e-9)
    r.push(`would leave less than ${pct(c.min_idle_frac)} idle`);
  if (c.max_total_deployed_usd !== undefined && after.totalDeployedUsd > c.max_total_deployed_usd + 1e-6)
    r.push(`total deployed $${Math.round(after.totalDeployedUsd)} > max_total_deployed_usd $${Math.round(c.max_total_deployed_usd)}`);
  return r;
}
