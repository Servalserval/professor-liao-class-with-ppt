import { withAddition, type Exposure } from "./exposure.js";
import type { DecisionContext } from "./gates/common.js";
import { checkSizedEntry, entryBlockers } from "./gates/entry.js";
import type { Action, Opportunity } from "./types.js";
import { valueAt } from "./valuation.js";

export type EnterAction = Extract<Action, { type: "enter" }>;

export interface AllocationPlan {
  entries: EnterAction[];
  /** Why each opportunity did not get (more) money. */
  rejected: Record<string, string[]>;
  deployableUsd: number;
}

/**
 * Greedy water-filling in chunks.
 *
 * loop-farm sized one position per market as min(wallet, cap headroom,
 * liquidity max) and ranked by projected APR. With many heterogeneous farms
 * that is not enough, because rewards are diluted by our own size: the 5th
 * chunk into a pool earns less than the 1st. So we hand out capital one chunk
 * at a time to whichever opportunity has the highest MARGINAL net APR that
 * still passes every gate. For concave returns this greedy is optimal, and it
 * automatically stops adding to a farm when our own size has diluted it below
 * the entry threshold.
 *
 * Non-speculative opportunities are always served before points farms.
 */
export function planAllocation(opps: Opportunity[], ctx: DecisionContext): AllocationPlan {
  const { cfg } = ctx;
  const rejected: Record<string, string[]> = {};
  const deployable = Math.max(
    0,
    ctx.totalEquityUsd * (1 - cfg.caps.min_idle_frac) - ctx.exposure.totalDeployedUsd
  );
  const chunk = Math.max(cfg.allocator.min_chunk_usd, ctx.totalEquityUsd * cfg.allocator.chunk_frac);

  const current: Record<string, number> = {};
  for (const p of ctx.positions) current[p.oppId] = (current[p.oppId] ?? 0) + p.equityUsd;

  const candidates: Opportunity[] = [];
  for (const o of opps) {
    const b = entryBlockers(o, ctx);
    if (b.length) rejected[o.id] = b;
    else candidates.push(o);
  }

  const planned: Record<string, number> = {};
  const lastMarginal: Record<string, number> = {};
  let exposure: Exposure = ctx.exposure;
  let left = deployable;
  let newPositions = 0;
  const maxIter = 10_000;

  for (let iter = 0; iter < maxIter && left > 0; iter++) {
    let best: { opp: Opportunity; from: number; to: number; marginal: number } | null = null;
    let bestKey: [number, number] | null = null;

    for (const o of candidates) {
      const from = (current[o.id] ?? 0) + (planned[o.id] ?? 0);
      const isNew = from <= 0;
      if (isNew && newPositions >= cfg.allocator.max_new_positions_per_cycle) {
        rejected[o.id] = [`max_new_positions_per_cycle ${cfg.allocator.max_new_positions_per_cycle} reached`];
        continue;
      }
      const step = Math.min(left, isNew ? Math.max(chunk, cfg.caps.min_position_usd) : chunk);
      if (step <= 0) continue;
      const to = from + step;
      const chk = checkSizedEntry(o, from, to, { ...ctx, exposure });
      if (!chk.ok) {
        // keep the first reason set we saw for reporting (usually the binding one)
        if (!planned[o.id]) rejected[o.id] = chk.reasons;
        continue;
      }
      // rank: non-speculative first, then by marginal APR
      const key: [number, number] = [o.speculative ? 0 : 1, chk.marginalNetApr];
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = { opp: o, from, to, marginal: chk.marginalNetApr };
        bestKey = key;
      }
    }
    if (!best) break;
    const step = best.to - best.from;
    if (best.from <= 0) newPositions += 1;
    planned[best.opp.id] = (planned[best.opp.id] ?? 0) + step;
    lastMarginal[best.opp.id] = best.marginal;
    exposure = withAddition(exposure, best.opp, step);
    left -= step;
    delete rejected[best.opp.id];
  }

  const entries: EnterAction[] = [];
  for (const o of candidates) {
    const add = planned[o.id] ?? 0;
    if (add <= 0) continue;
    const existing = current[o.id] ?? 0;
    if (existing > 0 && add < cfg.allocator.min_rebalance_usd) {
      rejected[o.id] = [`top-up $${Math.round(add)} < min_rebalance_usd`];
      continue;
    }
    const v = valueAt(o, existing + add, ctx);
    entries.push({
      type: "enter",
      oppId: o.id,
      deltaUsd: add,
      netApr: v.netApr,
      marginalApr: lastMarginal[o.id] ?? v.netApr,
    });
  }
  entries.sort((a, b) => b.marginalApr - a.marginalApr);
  return { entries, rejected, deployableUsd: deployable };
}
