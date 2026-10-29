import type { RouterConfig } from "./config.js";
import type { Opportunity } from "./types.js";

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Ingestion check for everything a source hands us. NaN slips through every
 * comparison (`NaN >= limit` is false), so a single bad field could otherwise
 * pass all entry gates or silence every exit rule. Invalid or stale
 * opportunities are dropped by the router: a held position whose data is
 * invalid is treated exactly like a blind one.
 */
export function validateOpportunity(o: Opportunity, cfg: RouterConfig, nowMs: number): string[] {
  const e: string[] = [];
  if (!fin(o.liquidity?.exitCapacityUsd) || o.liquidity.exitCapacityUsd < 0) e.push("liquidity.exitCapacityUsd not a finite number >= 0");
  if (!fin(o.liquidity?.footprintPerEquity) || o.liquidity.footprintPerEquity <= 0) e.push("liquidity.footprintPerEquity not a finite number > 0");
  if (!o.legs?.length) e.push("no legs");
  else if (o.legs.some((l) => !fin(l.equityFrac) || l.equityFrac < 0) || !(o.legs.reduce((a, l) => a + l.equityFrac, 0) > 0))
    e.push("legs.equityFrac invalid");
  for (const [k, v] of Object.entries(o.costs ?? {})) if (!fin(v)) e.push(`costs.${k} not finite`);
  for (const s of o.signals ?? []) if (!fin(s.value) || !fin(s.warnAt) || !fin(s.exitAt)) e.push(`signal ${s.name} not finite`);
  for (const [k, v] of Object.entries(o.metrics ?? {})) if (!fin(v)) e.push(`metric ${k} not finite`);
  if (o.health && (!fin(o.health.value) || !fin(o.health.rebalanceAt) || !fin(o.health.criticalAt))) e.push("health not finite");
  if (o.maxEquityUsd !== undefined && !(fin(o.maxEquityUsd) && o.maxEquityUsd >= 0)) e.push("maxEquityUsd invalid");
  const probe = Math.max(1, o.myEquityUsd || 0);
  for (const s of o.streams ?? []) {
    let a: number;
    let b: number;
    try {
      a = s.aprAt(0);
      b = s.aprAt(probe);
    } catch (err) {
      e.push(`stream ${s.label} threw: ${(err as Error).message}`);
      continue;
    }
    if (!fin(a) || !fin(b)) e.push(`stream ${s.label} APR not finite`);
  }
  if (o.dataAsOfMs !== undefined) {
    if (!fin(o.dataAsOfMs)) e.push("dataAsOfMs invalid");
    else if (nowMs - o.dataAsOfMs > cfg.portfolio.max_data_age_minutes * 60_000)
      e.push(`stale data (${Math.round((nowMs - o.dataAsOfMs) / 60_000)} min old)`);
  }
  return e;
}
