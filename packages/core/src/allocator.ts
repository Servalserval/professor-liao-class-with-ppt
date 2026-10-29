import { withAddition, type Exposure } from "./exposure.js";
import type { DecisionContext } from "./gates/common.js";
import { checkSizedEntry, entryBlockers } from "./gates/entry.js";
import { entryThreshold, venueTier } from "./tiers.js";
import type { Action, Opportunity } from "./types.js";
import { valueAt } from "./valuation.js";
import { fundingTarget } from "./xchain/planner.js";
import { assetKey } from "./xchain/routes.js";
import type { FundingQuote } from "./xchain/types.js";

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

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
 *
 * Cross-chain funding (ctx.funding set = idle split per chain:asset): every
 * chunk asks the planner where its money comes from. Local money is free;
 * a move must pass the friction rules (cost <= one day of the chunk's yield,
 * payback, rolling-24h book budget, min size, in-flight cap) or the chunk is
 * refused. The move cost is a one-off like an entry cost, so it is amortized
 * over the hold horizon and subtracted from the ranking key (and the result
 * must still clear the entry threshold). Money already in flight towards an
 * opportunity counts as its size. Without a planner nothing here changes.
 */
export function planAllocation(opps: Opportunity[], ctx: DecisionContext): AllocationPlan {
  const { cfg } = ctx;
  const rejected: Record<string, string[]> = {};
  // Reward tokens count in total equity (for caps and drawdown) but are not
  // cash: what can be deployed is bounded by idle cash minus the idle buffer.
  // With idle buckets the cash is the sum of the buckets (same bounds otherwise).
  const funding = ctx.funding;
  const idleCash = funding ? funding.idleTotalUsd : ctx.idleUsd;
  const deployable = Math.max(
    0,
    Math.min(
      ctx.totalEquityUsd * (1 - cfg.caps.min_idle_frac) - ctx.exposure.totalDeployedUsd,
      idleCash - ctx.totalEquityUsd * cfg.caps.min_idle_frac
    )
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
  // Money already travelling towards an opportunity is its size for caps and dilution.
  const reserved: Record<string, number> = {};
  if (funding)
    for (const o of candidates) {
      const r = funding.inFlightFor(o.id);
      if (r > 0) {
        reserved[o.id] = r;
        exposure = withAddition(exposure, o, r);
      }
    }
  // Optional absolute ceiling (canary runs): deployed + already in flight + this cycle <= max_total_deployed_usd.
  const ceiling = cfg.caps.max_total_deployed_usd;
  const inFlightUsd = funding ? funding.inFlightUsd : 0;
  let left = ceiling === undefined ? deployable : Math.max(0, Math.min(deployable, ceiling - ctx.exposure.totalDeployedUsd - inFlightUsd));
  let newPositions = 0;
  const maxIter = 10_000;

  type StepEval =
    | { ok: true; to: number; marginal: number; rankApr: number; quote?: FundingQuote }
    | { ok: false; reasons: string[]; sized: boolean; report: boolean };

  /** Sized gates + (planner mode) funding for adding `step` to `o` at `from`. */
  const evalStep = (o: Opportunity, from: number, step: number): StepEval => {
    const to = from + step;
    const chk = checkSizedEntry(o, from, to, { ...ctx, exposure });
    if (!chk.ok) return { ok: false, reasons: chk.reasons, sized: true, report: true };
    if (!Number.isFinite(chk.marginalNetApr)) return { ok: false, reasons: [], sized: true, report: false };
    let rankApr = chk.marginalNetApr;
    let quote: FundingQuote | undefined;
    if (funding) {
      quote = funding.quote(o, step, chk.marginalNetApr);
      // (a dust-sized step that cannot be funded is not worth reporting)
      if (!quote.ok)
        return { ok: false, reasons: [quote.reason ?? "funding refused"], sized: false, report: step >= cfg.allocator.min_chunk_usd };
      if (quote.costUsd > 0) {
        // the move is a one-off like an entry cost: amortize it over the hold horizon
        rankApr -= (quote.costUsd / step) * (365 / cfg.hold_horizon_days);
        const th = entryThreshold(cfg, venueTier(cfg, o.primaryVenue), o.kind);
        if (!o.speculative && rankApr < th)
          return { ok: false, reasons: [`funding: marginal APR ${pct(rankApr)} after move cost < entry ${pct(th)}`], sized: false, report: true };
      }
    }
    return { ok: true, to, marginal: chk.marginalNetApr, rankApr, quote };
  };

  /**
   * Fixed move costs (gas, fixed fees) only amortize over a bigger move than
   * one chunk, and a chunk-by-chunk greedy could then never start the move.
   * Find the largest block that passes the sized gates (binary search; caps,
   * liquidity share and dilution grow with size) so the planner can quote it.
   */
  const largestSizedBlock = (o: Opportunity, from: number, minStep: number, maxStep: number): number => {
    const ok = (st: number) => {
      const c = checkSizedEntry(o, from, from + st, { ...ctx, exposure });
      return c.ok && Number.isFinite(c.marginalNetApr);
    };
    if (ok(maxStep)) return maxStep;
    // whole-dollar search: lands exactly on a cap boundary such as max_position_usd
    let lo = minStep;
    let hi = Math.floor(maxStep);
    if (hi > lo && ok(hi)) return hi;
    for (let i = 0; i < 60 && hi - lo > 1; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid <= lo) break;
      if (ok(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  for (let iter = 0; iter < maxIter && left > 0; iter++) {
    let best: { opp: Opportunity; from: number; to: number; marginal: number; quote?: FundingQuote } | null = null;
    let bestKey: [number, number] | null = null;

    for (const o of candidates) {
      const from = (current[o.id] ?? 0) + (reserved[o.id] ?? 0) + (planned[o.id] ?? 0);
      const isNew = from <= 0;
      if (isNew && newPositions >= cfg.allocator.max_new_positions_per_cycle) {
        rejected[o.id] = [`max_new_positions_per_cycle ${cfg.allocator.max_new_positions_per_cycle} reached`];
        continue;
      }
      let step = Math.min(left, isNew ? Math.max(chunk, cfg.caps.min_position_usd) : chunk);
      // never ask for more than the per-position caps leave room for: with small
      // caps (canary) a 2%-of-equity chunk would otherwise be refused forever
      const room =
        Math.min(cfg.caps.max_position_usd, cfg.caps.per_opportunity_frac * ctx.totalEquityUsd, o.maxEquityUsd ?? Infinity) - from;
      if (room < step) step = room;
      if (funding) {
        // use what is already on the right chain before paying to bring more
        const local = funding.available(assetKey(fundingTarget(o)));
        if (local < step && local >= cfg.allocator.min_chunk_usd && (!isNew || local >= cfg.caps.min_position_usd)) step = local;
      }
      if (step <= 0) continue;
      let ev = evalStep(o, from, step);
      if (!ev.ok && !ev.sized && funding && cfg.xchain.enabled) {
        const hi = Math.min(left, funding.largestRemoteUsd(o));
        if (hi > step + 1) {
          const block = largestSizedBlock(o, from, step, hi);
          if (block > step) {
            const ev2 = evalStep(o, from, block);
            // report the block's verdict: it is the move that would actually happen
            ev = ev2;
          }
        }
      }
      if (!ev.ok) {
        // keep the first reason set we saw for reporting (usually the binding one)
        if (ev.report && !planned[o.id]) rejected[o.id] = ev.reasons;
        continue;
      }
      // rank: non-speculative first, then by marginal APR (net of amortized move cost)
      const key: [number, number] = [o.speculative ? 0 : 1, ev.rankApr];
      if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = { opp: o, from, to: ev.to, marginal: ev.marginal, quote: ev.quote };
        bestKey = key;
      }
    }
    if (!best) break;
    const step = best.to - best.from;
    if (best.from <= 0) newPositions += 1;
    if (funding && best.quote) funding.commit(best.opp, step, best.quote);
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
    const existing = (current[o.id] ?? 0) + (reserved[o.id] ?? 0);
    if (existing > 0 && add < cfg.allocator.min_rebalance_usd) {
      rejected[o.id] = [`top-up $${Math.round(add)} < min_rebalance_usd`];
      continue;
    }
    const v = valueAt(o, existing + add, ctx);
    const marginalApr = lastMarginal[o.id] ?? v.netApr;
    if (!funding) {
      entries.push({ type: "enter", oppId: o.id, deltaUsd: add, netApr: v.netApr, marginalApr });
      continue;
    }
    // One entry for the locally funded part, one per cross-chain move.
    const local = funding.localFor(o.id);
    if (local > 0) {
      const t = fundingTarget(o);
      const f: FundingQuote = { ok: true, path: [], costUsd: 0, etaMinutes: 0, source: t, target: t, amountUsd: local };
      entries.push({ type: "enter", oppId: o.id, deltaUsd: local, netApr: v.netApr, marginalApr, funding: f });
    }
    for (const m of funding.plannedMoves(o.id)) {
      const f: FundingQuote = {
        ok: true,
        path: m.path,
        costUsd: m.costUsd,
        etaMinutes: m.etaMinutes,
        source: m.source,
        target: m.target,
        amountUsd: m.amountUsd,
      };
      entries.push({ type: "enter", oppId: o.id, deltaUsd: m.amountUsd ?? 0, netApr: v.netApr, marginalApr, funding: f });
    }
  }
  entries.sort((a, b) => b.marginalApr - a.marginalApr);
  return { entries, rejected, deployableUsd: ceiling === undefined ? deployable : Math.min(deployable, Math.max(0, ceiling - ctx.exposure.totalDeployedUsd - inFlightUsd)) };
}
