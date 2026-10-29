import { exitThreshold, venueTier } from "../tiers.js";
import type { Action, Flag, Opportunity, Position } from "../types.js";
import { marginalNetApr, valueAt } from "../valuation.js";
import { liquidityUsage, signalLevel, type DecisionContext } from "./common.js";

const HOUR = 3600_000;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export interface ExitDecision {
  actions: Action[];
  /** Updated debounce counters for the position. */
  pending: Record<string, number>;
}

function fullExit(oppId: string, reason: string, urgent: boolean): Action[] {
  return [
    { type: "exit", oppId, fraction: 1, urgent, reason },
    { type: "alert", level: urgent ? "critical" : "warn", message: `EXIT ${oppId}: ${reason}` },
  ];
}

/**
 * Exit rules in priority order. The first urgent rule wins and returns
 * immediately: in a bank run the first one out gets paid, so liquidity and
 * stress exits are always full and never debounced (loop-farm: "流動性警報要一次全跑").
 * Spread compression is debounced and handled stepwise.
 *
 *  0. blind            source has not reported the opportunity for N cycles
 *  1. exit flags       paused market, depeg, capacity drain, metric spike ...
 *  2. liquidity        my exit footprint >= 20% of exit capacity (the 1/5 rule)
 *  3. stress signals   utilization >= 95%, basis blow-out ...
 *  4. health           LTV / liquidation distance critical (rebalance first if only drifting)
 *  5. exit path        simulated exit failed repeatedly -> leave while it still works
 *  6. reward ending    edge does not survive without the streams that end soon
 *  7. spread           realized net APR < exit threshold (hysteresis) -> trim / close
 *  8. oversized        marginal dollars earn < exit threshold -> trim one chunk
 */
export function decideExit(
  pos: Position,
  opp: Opportunity | undefined,
  derived: Flag[],
  ctx: DecisionContext
): ExitDecision {
  const { cfg } = ctx;
  const pending = { ...pos.pending };
  const actions: Action[] = [];

  // 0) blind
  if (!opp) {
    if (pos.blindCycles >= cfg.portfolio.blind_exit_cycles)
      return { actions: fullExit(pos.oppId, `source blind for ${pos.blindCycles} cycles`, true), pending };
    if (pos.blindCycles >= cfg.portfolio.blind_alert_cycles)
      actions.push({ type: "alert", level: "critical", message: `${pos.oppId}: source blind for ${pos.blindCycles} cycles`, dedupe: true });
    return { actions, pending };
  }

  // 1) exit-severity flags (source + derived)
  const flags = [...opp.flags, ...derived];
  const exitFlag = flags.find((f) => f.severity === "exit");
  if (exitFlag) return { actions: fullExit(pos.oppId, `flag ${exitFlag.name}${exitFlag.detail ? `: ${exitFlag.detail}` : ""}`, true), pending };

  // 2) liquidity (the 1/5 rule)
  const usage = liquidityUsage(cfg, opp, pos.equityUsd);
  if (usage >= cfg.liquidity.exit_frac_of_capacity)
    return {
      actions: fullExit(pos.oppId, `position needs ${pct(usage)} of exit capacity >= ${pct(cfg.liquidity.exit_frac_of_capacity)}`, true),
      pending,
    };

  // 3) stress signals at exit level
  for (const s of opp.signals) {
    if (signalLevel(s) === "exit")
      return { actions: fullExit(pos.oppId, `signal ${s.name}=${s.value.toFixed(4)} past ${s.exitAt}`, true), pending };
  }

  // 4) health
  if (opp.health) {
    const h = opp.health;
    const past = (v: number, lim: number) => (h.direction === "above" ? v >= lim : v <= lim);
    if (past(h.value, h.criticalAt))
      return { actions: fullExit(pos.oppId, `health ${h.metric}=${h.value.toFixed(4)} critical`, true), pending };
    if (past(h.value, h.rebalanceAt))
      actions.push({ type: "rebalance", oppId: pos.oppId, reason: `${h.metric}=${h.value.toFixed(4)} past ${h.rebalanceAt}` });
  }

  // 5) exit path
  if (pos.exitProbe.consecutiveFailures >= cfg.exit_probe.max_consecutive_failures)
    return {
      actions: fullExit(pos.oppId, `exit simulation failed ${pos.exitProbe.consecutiveFailures}x — leaving while the path may still work`, true),
      pending,
    };

  const tier = venueTier(cfg, opp.primaryVenue);
  const threshold = opp.speculative ? -cfg.points.max_cost_apr : exitThreshold(cfg, tier);

  // 6) reward ending: does the edge survive without the streams that end soon?
  const endingMs = cfg.rewards.ending_hours * HOUR;
  const ending = opp.streams.filter(
    (s) => s.endsAtMs !== null && s.endsAtMs !== undefined && s.endsAtMs - ctx.nowMs <= endingMs
  );
  if (ending.length) {
    const exEnding = valueAt(opp, pos.equityUsd, ctx, { holding: true, excludeEndingWithinMs: endingMs });
    if (exEnding.netApr < threshold)
      return {
        actions: fullExit(
          pos.oppId,
          `${ending.map((s) => s.label).join(",")} ending within ${cfg.rewards.ending_hours}h; net without them ${pct(exEnding.netApr)} < ${pct(threshold)}`,
          false
        ),
        pending,
      };
  }

  // 7) spread compression (debounced, stepwise)
  const hold = valueAt(opp, pos.equityUsd, ctx, { holding: true });
  if (hold.netApr < threshold) {
    pending.spread = (pending.spread ?? 0) + 1;
    if (pending.spread >= cfg.thresholds.confirm_cycles) {
      pending.spread = 0;
      const floor = opp.speculative ? -cfg.points.max_cost_apr * 2 : cfg.thresholds.hard_floor_apr;
      if (hold.netApr < floor || pos.equityUsd * (1 - cfg.thresholds.spread_reduce_step) < cfg.caps.min_position_usd)
        return { actions: fullExit(pos.oppId, `net APR ${pct(hold.netApr)} below floor/exit ${pct(threshold)}`, false), pending };
      actions.push(
        { type: "exit", oppId: pos.oppId, fraction: cfg.thresholds.spread_reduce_step, urgent: false, reason: `net APR ${pct(hold.netApr)} < exit ${pct(threshold)}` },
        { type: "alert", level: "warn", message: `TRIM ${pos.oppId} by ${pct(cfg.thresholds.spread_reduce_step)}: net ${pct(hold.netApr)}` }
      );
      return { actions, pending };
    }
  } else {
    pending.spread = 0;
  }

  // 8) oversized: the last chunk earns less than the exit threshold
  const chunk = Math.max(cfg.allocator.min_chunk_usd, ctx.totalEquityUsd * cfg.allocator.chunk_frac);
  if (pos.equityUsd - chunk >= cfg.caps.min_position_usd) {
    const m = marginalNetApr(opp, pos.equityUsd - chunk, pos.equityUsd, ctx);
    if (m < threshold) {
      pending.oversized = (pending.oversized ?? 0) + 1;
      if (pending.oversized >= cfg.thresholds.confirm_cycles) {
        pending.oversized = 0;
        actions.push({
          type: "exit",
          oppId: pos.oppId,
          fraction: chunk / pos.equityUsd,
          urgent: false,
          reason: `last $${Math.round(chunk)} earns ${pct(m)} < ${pct(threshold)} (diluted)`,
        });
      }
    } else pending.oversized = 0;
  }

  // warnings only
  for (const f of flags.filter((f) => f.severity === "warn"))
    actions.push({ type: "alert", level: "warn", message: `${pos.oppId}: ${f.name}${f.detail ? ` (${f.detail})` : ""}`, dedupe: true });
  for (const s of opp.signals)
    if (signalLevel(s) === "warn")
      actions.push({ type: "alert", level: "warn", message: `${pos.oppId}: ${s.name}=${s.value.toFixed(4)} past warn ${s.warnAt}`, dedupe: true });
  if (usage >= cfg.liquidity.entry_max_frac_of_capacity)
    actions.push({ type: "alert", level: "warn", message: `${pos.oppId}: uses ${pct(usage)} of exit capacity`, dedupe: true });

  return { actions, pending };
}
