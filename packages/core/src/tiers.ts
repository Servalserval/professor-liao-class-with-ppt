import type { RouterConfig, VenueConfig } from "./config.js";
import type { Tier } from "./types.js";

/**
 * Protocol tiering. The loop-farm config had a hand-set tier per protocol;
 * here the tier can also be scored from public facts so that new venues
 * discovered by the scanners start conservative (tier 3) until you either
 * fill in `meta` or set the tier explicitly.
 *
 * Score (max 8):
 *   audits      >=2: +2, 1: +1
 *   age         >=365d: +2, >=90d: +1
 *   TVL         >=$500M: +2, >=$50M: +1
 *   admin       multisig: +1, timelock >=24h: +1
 *   upgradeable proxy without a >=24h timelock: -1
 *   any past exploit / bad-debt incident: -2
 */
export function scoreVenue(meta: VenueConfig["meta"]): number {
  if (!meta) return 0;
  let s = 0;
  const audits = meta.audits ?? 0;
  s += audits >= 2 ? 2 : audits >= 1 ? 1 : 0;
  const age = meta.age_days ?? 0;
  s += age >= 365 ? 2 : age >= 90 ? 1 : 0;
  const tvl = meta.tvl_usd ?? 0;
  s += tvl >= 500e6 ? 2 : tvl >= 50e6 ? 1 : 0;
  if (meta.admin_multisig) s += 1;
  const timelockOk = (meta.timelock_hours ?? 0) >= 24;
  if (timelockOk) s += 1;
  if (meta.upgradeable && !timelockOk) s -= 1;
  if ((meta.incidents ?? 0) > 0) s -= 2;
  return s;
}

export function venueTier(cfg: RouterConfig, venue: string): Tier {
  const v = cfg.venues[venue];
  if (v?.tier) return v.tier;
  if (!v?.meta) return 3;
  const s = scoreVenue(v.meta);
  if (s >= cfg.tiers.tier1_min_score) return 1;
  if (s >= cfg.tiers.tier2_min_score) return 2;
  return 3;
}

export function venueEnabled(cfg: RouterConfig, venue: string): boolean {
  // Unknown venues are allowed into discovery reports but capped by tier 3.
  return cfg.venues[venue]?.enabled ?? true;
}

/** Entry threshold = baseline + tier premium; exit threshold is lower (hysteresis). */
export function entryThreshold(cfg: RouterConfig, tier: Tier): number {
  return cfg.baseline_apr + cfg.thresholds.entry_premium_by_tier[tier];
}

export function exitThreshold(cfg: RouterConfig, tier: Tier): number {
  return cfg.baseline_apr + cfg.thresholds.exit_premium_by_tier[tier];
}
