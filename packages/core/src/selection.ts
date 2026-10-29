import { planAllocation, type AllocationPlan } from "./allocator.js";
import type { DecisionContext } from "./gates/common.js";
import { entryThreshold, venueTier } from "./tiers.js";
import type { Kind, Opportunity, Tier } from "./types.js";
import { valueAt } from "./valuation.js";

/**
 * Position selection on ONE risk-adjusted scale: loops, plain deposits and
 * everything else are compared by the same net APR
 *
 *   net = raw - haircuts - depeg loss - costs - move cost
 *
 *   raw        sum of the streams' raw APRs at the size (leverage included, borrow cost negative)
 *   haircuts   reward realizable (token sale model) + time weight of streams that end
 *   depeg      expected depeg loss of the stable(s) held (src/stables.ts)
 *   costs      entry/exit one-offs amortized over hold_horizon_days + other running costs
 *   move       cross-chain move cost amortized the same way (0 when the money is local)
 *
 * against the entry threshold of its venue tier and kind. The verdict comes
 * from the allocator's actual plan (so caps, liquidity, funding and dilution
 * are already in it).
 */
export interface SelectionRow {
  oppId: string;
  name: string;
  kind: Kind;
  venue: string;
  tier: Tier;
  chain: string;
  token: string;
  /** Size the numbers are evaluated at (held + picked, else one entry chunk). */
  sizeUsd: number;
  rawApr: number;
  haircutApr: number;
  depegLossApr: number;
  costsApr: number;
  moveCostApr: number;
  netApr: number;
  thresholdApr: number;
  speculativeApr: number;
  heldUsd: number;
  pickedUsd: number;
  /** picked = gets money this cycle; held = already held, no top-up; rejected = a gate said no; not_chosen = passes, but the money went elsewhere. */
  verdict: "picked" | "held" | "rejected" | "not_chosen";
  reasons: string[];
}

/**
 * Pure: explains a plan. Pass the plan the router executed; without one,
 * `planAllocation(opps, ctx)` is run (note: that consumes ctx.funding's budget).
 */
export function explainSelection(opps: Opportunity[], ctx: DecisionContext, plan: AllocationPlan = planAllocation(opps, ctx)): SelectionRow[] {
  const { cfg } = ctx;
  const chunk = Math.max(cfg.allocator.min_chunk_usd, ctx.totalEquityUsd * cfg.allocator.chunk_frac);
  const held: Record<string, number> = {};
  for (const p of ctx.positions) held[p.oppId] = (held[p.oppId] ?? 0) + p.equityUsd;
  const perYear = 365 / cfg.hold_horizon_days;
  const rows: SelectionRow[] = [];
  for (const o of opps) {
    const entries = plan.entries.filter((e) => e.oppId === o.id);
    const picked = entries.reduce((a, e) => a + e.deltaUsd, 0);
    const moved = entries.filter((e) => (e.funding?.path.length ?? 0) > 0);
    const moveCostUsd = moved.reduce((a, e) => a + (e.funding?.costUsd ?? 0), 0);
    const h = held[o.id] ?? 0;
    const size = h + picked > 0 ? h + picked : Math.max(chunk, cfg.caps.min_position_usd);
    const v = valueAt(o, size, ctx, h > 0 && picked <= 0 ? { holding: true } : {});
    const reward = v.streams.filter((s) => s.kind !== "points");
    const haircut = reward.reduce((a, s) => a + (s.rawApr - s.valuedApr), 0);
    const depeg = typeof o.meta?.["depegLossApr"] === "number" ? (o.meta["depegLossApr"] as number) : 0;
    const moveApr = picked > 0 ? (moveCostUsd / picked) * perYear * (picked / (h + picked)) : 0;
    const tier = venueTier(cfg, o.primaryVenue);
    const reasons = plan.rejected[o.id] ?? [];
    const verdict: SelectionRow["verdict"] = picked > 0 ? "picked" : reasons.length ? "rejected" : h > 0 ? "held" : "not_chosen";
    rows.push({
      oppId: o.id,
      name: o.name,
      kind: o.kind,
      venue: o.primaryVenue,
      tier,
      chain: o.chain,
      token: o.legs[0]?.token ?? "?",
      sizeUsd: size,
      rawApr: v.rawApr,
      haircutApr: haircut,
      depegLossApr: depeg,
      costsApr: v.costApr - depeg,
      moveCostApr: moveApr,
      netApr: v.netApr - moveApr,
      thresholdApr: o.speculative ? -cfg.points.max_cost_apr : entryThreshold(cfg, tier, o.kind),
      speculativeApr: v.speculativeApr,
      heldUsd: h,
      pickedUsd: picked,
      verdict,
      reasons:
        verdict === "not_chosen"
          ? ["passes the gates; outranked (lower marginal APR) or no deployable money left"]
          : verdict === "held"
            ? ["held; no top-up this cycle"]
            : reasons,
    });
  }
  const order = { picked: 0, held: 1, not_chosen: 2, rejected: 3 };
  rows.sort((a, b) => order[a.verdict] - order[b.verdict] || b.pickedUsd - a.pickedUsd || b.netApr - a.netApr);
  return rows;
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "n/a");
const usd = (x: number) => `$${(Math.abs(x) < 0.5 ? 0 : Math.round(x)).toLocaleString("en-US")}`;

/** Fixed-width text table of explainSelection rows (CLI `plan --why`, `sim --why`). */
export function formatSelection(rows: SelectionRow[], maxReasons = 2): string {
  const head = `${"verdict".padEnd(10)} ${"amount".padStart(10)} ${"@size".padStart(9)}  ${"net".padStart(7)} = ${"raw".padStart(7)} - ${"haircut".padStart(7)} - ${"depeg".padStart(6)} - ${"costs".padStart(6)} - ${"move".padStart(6)} | ${"entry".padStart(6)}  T  kind          opportunity`;
  const out = [head, "-".repeat(head.length)];
  for (const r of rows) {
    const amount = r.verdict === "picked" ? `+${usd(r.pickedUsd)}` : r.heldUsd > 0 ? usd(r.heldUsd) : "-";
    out.push(
      `${r.verdict.padEnd(10)} ${amount.padStart(10)} ${usd(r.sizeUsd).padStart(9)}  ${pct(r.netApr).padStart(7)} = ${pct(r.rawApr).padStart(7)} - ${pct(r.haircutApr).padStart(7)} - ${pct(r.depegLossApr).padStart(6)} - ${pct(r.costsApr).padStart(6)} - ${pct(r.moveCostApr).padStart(6)} | ${pct(r.thresholdApr).padStart(6)}  ${r.tier}  ${r.kind.padEnd(13)} ${r.oppId}`
    );
    if (r.verdict !== "picked") for (const x of r.reasons.slice(0, maxReasons)) out.push(`${" ".repeat(12)}- ${x}`);
  }
  return out.join("\n");
}
