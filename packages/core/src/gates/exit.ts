import { exitThreshold, venueTier } from "../tiers.js";
import type { Action, ExitCause, Flag, Opportunity, Position } from "../types.js";
import { marginalHoldApr, valueAt } from "../valuation.js";
import { LEVERAGED_KINDS, liquidityUsage, signalLevel, type DecisionContext } from "./common.js";

const HOUR = 3600_000;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export interface ExitDecision {
  actions: Action[];
  /** Updated debounce counters for the position. */
  pending: Record<string, number>;
  pendingSince: Record<string, number>;
}

function fullExit(oppId: string, reason: string, urgent: boolean, cause?: ExitCause): Action[] {
  return [
    { type: "exit", oppId, fraction: 1, urgent, reason, ...(cause ? { cause } : {}) },
    { type: "alert", level: urgent ? "critical" : "warn", message: `EXIT ${oppId}: ${reason}` },
  ];
}

/**
 * Exit rules in priority order. The first full-exit rule wins and returns
 * immediately: in a bank run the first one out gets paid, so liquidity and
 * stress exits are always full and never debounced (loop-farm: "流動性警報要一次全跑").
 * Any full exit is LATCHED by the router (Position.forcedExit) and retried
 * every cycle until it succeeds. Spread compression is debounced and stepwise.
 *
 *  F. forced           a previously decided full exit has not succeeded yet
 *  5. exit path        simulated exit failed repeatedly -> leave while it still works
 *                      (checked before blind: a blind position with a dead exit path must not wait 10 cycles)
 *  0. blind            source has not (validly) reported the opportunity for N cycles
 *  1. exit flags       paused market, depeg, capacity drain, metric spike ...
 *                      (a capacity drain set by swap depth needs confirm_cycles)
 *  2. liquidity        my exit footprint >= 20% of exit capacity (the 1/5 rule;
 *                      confirm_cycles when swap depth, not pool liquidity, binds)
 *  3. stress signals   utilization >= 95%, basis blow-out ...
 *  4. health           critical -> exit; drifting -> rebalance; missing on a leveraged position -> warn/exit
 *  6. reward ending    edge does not survive without the streams that end soon
 *  7. spread           realized net APR < exit threshold (hysteresis) -> trim / close
 *  8. oversized        held marginal dollars earn < exit threshold -> trim one chunk
 */
export function decideExit(
  pos: Position,
  opp: Opportunity | undefined,
  derived: Flag[],
  ctx: DecisionContext
): ExitDecision {
  const { cfg } = ctx;
  const pending = { ...pos.pending };
  const pendingSince = { ...(pos.pendingSince ?? {}) };
  const actions: Action[] = [];
  const done = (a: Action[]): ExitDecision => ({ actions: a, pending, pendingSince });

  /**
   * Cycle-only debounce for urgent rules driven by a swap quote (a quote can
   * fail or flicker; pool liquidity cannot). Still urgent once confirmed.
   */
  const cyclesConfirmed = (key: string, active: boolean): boolean => {
    if (!active) {
      delete pending[key];
      delete pendingSince[key];
      return false;
    }
    pending[key] = (pending[key] ?? 0) + 1;
    pendingSince[key] ??= ctx.nowMs;
    if (pending[key]! < cfg.thresholds.confirm_cycles) return false;
    delete pending[key];
    delete pendingSince[key];
    return true;
  };

  // F) latched exit
  if (pos.forcedExit) {
    const f = pos.forcedExit;
    return done(fullExit(pos.oppId, f.sinceMs < ctx.nowMs ? `retry: ${f.reason}` : f.reason, f.urgent));
  }

  // 5) exit path (before blind on purpose)
  if (pos.exitProbe.consecutiveFailures >= cfg.exit_probe.max_consecutive_failures)
    return done(
      fullExit(pos.oppId, `exit simulation failed ${pos.exitProbe.consecutiveFailures}x — leaving while the path may still work`, true, "probe")
    );

  // 0) blind
  if (!opp) {
    // counters measured on data we can no longer see are meaningless
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(pendingSince)) delete pendingSince[k];
    if (pos.blindCycles >= cfg.portfolio.blind_exit_cycles)
      return done(fullExit(pos.oppId, `source blind for ${pos.blindCycles} cycles`, true, "blind"));
    if (pos.blindCycles >= cfg.portfolio.blind_alert_cycles)
      actions.push({
        type: "alert",
        level: "critical",
        message: `${pos.oppId}: source blind for ${pos.blindCycles} cycles`,
        dedupeKey: `${pos.oppId}|blind`,
      });
    return done(actions);
  }

  // 1) exit-severity flags (source + derived)
  const flags = [...opp.flags, ...derived];
  const swapBound = opp.liquidity.binding === "swap";
  const debouncedFlag = (f: Flag) => swapBound && f.name === "capacity_drop";
  const exitFlags = flags.filter((f) => f.severity === "exit");
  const exitFlag = exitFlags.find((f) => !debouncedFlag(f));
  if (exitFlag) return done(fullExit(pos.oppId, `flag ${exitFlag.name}${exitFlag.detail ? `: ${exitFlag.detail}` : ""}`, true));
  const swapDrop = exitFlags.find(debouncedFlag);
  if (cyclesConfirmed("capacity_drop:swap", !!swapDrop))
    return done(
      fullExit(pos.oppId, `flag capacity_drop (swap depth, ${cfg.thresholds.confirm_cycles} cycles)${swapDrop?.detail ? `: ${swapDrop.detail}` : ""}`, true)
    );

  // 2) liquidity (the 1/5 rule) — immediate when pool liquidity binds, confirmed when swap depth does
  const usage = liquidityUsage(cfg, opp, pos.equityUsd, true);
  const breach = usage >= cfg.liquidity.exit_frac_of_capacity;
  if (breach && !swapBound)
    return done(fullExit(pos.oppId, `position needs ${pct(usage)} of exit capacity >= ${pct(cfg.liquidity.exit_frac_of_capacity)}`, true));
  if (cyclesConfirmed("liquidity:swap", breach && swapBound))
    return done(
      fullExit(
        pos.oppId,
        `position needs ${pct(usage)} of swap-limited exit capacity >= ${pct(cfg.liquidity.exit_frac_of_capacity)} (${cfg.thresholds.confirm_cycles} cycles)`,
        true
      )
    );
  if (breach || swapDrop)
    actions.push({
      type: "alert",
      level: "warn",
      message: `${pos.oppId}: swap-depth liquidity ${breach ? `usage ${pct(usage)}` : "drop"} — confirming before exit`,
      dedupeKey: `${pos.oppId}|liquidity_swap`,
    });

  // 3) stress signals at exit level
  for (const s of opp.signals)
    if (signalLevel(s) === "exit") return done(fullExit(pos.oppId, `signal ${s.name}=${s.value.toFixed(4)} past ${s.exitAt}`, true));

  // 4) health
  if (opp.health) {
    const h = opp.health;
    const past = (v: number, lim: number) => (h.direction === "above" ? v >= lim : v <= lim);
    if (past(h.value, h.criticalAt)) return done(fullExit(pos.oppId, `health ${h.metric}=${h.value.toFixed(4)} critical`, true));
    if (past(h.value, h.rebalanceAt))
      actions.push({ type: "rebalance", oppId: pos.oppId, reason: `${h.metric}=${h.value.toFixed(4)} past ${h.rebalanceAt}` });
  } else if (LEVERAGED_KINDS.has(opp.kind)) {
    if (cfg.portfolio.health_missing === "exit")
      return done(fullExit(pos.oppId, "leveraged position without a health metric", true));
    actions.push({
      type: "alert",
      level: "warn",
      message: `${pos.oppId}: leveraged position but the source reports no health metric`,
      dedupeKey: `${pos.oppId}|health_missing`,
    });
  }

  const tier = venueTier(cfg, opp.primaryVenue);
  const threshold = opp.speculative ? -cfg.points.max_cost_apr : exitThreshold(cfg, tier, opp.kind);

  // 6) reward ending: does the edge survive without the streams that end soon?
  const endingMs = cfg.rewards.ending_hours * HOUR;
  const ending = opp.streams.filter(
    (s) => s.endsAtMs !== null && s.endsAtMs !== undefined && s.endsAtMs - ctx.nowMs <= endingMs
  );
  if (ending.length) {
    const exEnding = valueAt(opp, pos.equityUsd, ctx, { holding: true, noTimeWeight: true, excludeEndingWithinMs: endingMs });
    if (exEnding.netApr < threshold)
      return done(
        fullExit(
          pos.oppId,
          `${ending.map((s) => s.label).join(",")} ending within ${cfg.rewards.ending_hours}h; net without them ${pct(exEnding.netApr)} < ${pct(threshold)}`,
          false
        )
      );
  }

  /** Debounce: the reason must persist confirm_cycles cycles AND confirm_minutes. */
  const confirmed = (key: string, active: boolean): boolean => {
    if (!active) {
      delete pending[key];
      delete pendingSince[key];
      return false;
    }
    pending[key] = (pending[key] ?? 0) + 1;
    pendingSince[key] ??= ctx.nowMs;
    const ok =
      pending[key]! >= cfg.thresholds.confirm_cycles &&
      ctx.nowMs - pendingSince[key]! >= cfg.thresholds.confirm_minutes * 60_000;
    if (ok) {
      delete pending[key];
      delete pendingSince[key];
    }
    return ok;
  };

  // 7) spread compression (debounced, stepwise). Streams valued at their
  //    current rate: an ending stream is rule 6's business.
  const hold = valueAt(opp, pos.equityUsd, ctx, { holding: true, noTimeWeight: true });
  if (confirmed("spread", hold.netApr < threshold)) {
    const floor = opp.speculative ? -cfg.points.max_cost_apr * 2 : cfg.thresholds.hard_floor_apr;
    if (hold.netApr < floor || pos.equityUsd * (1 - cfg.thresholds.spread_reduce_step) < cfg.caps.min_position_usd)
      return done(fullExit(pos.oppId, `net APR ${pct(hold.netApr)} below floor/exit ${pct(threshold)}`, false));
    actions.push(
      { type: "exit", oppId: pos.oppId, fraction: cfg.thresholds.spread_reduce_step, urgent: false, reason: `net APR ${pct(hold.netApr)} < exit ${pct(threshold)}` },
      { type: "alert", level: "warn", message: `TRIM ${pos.oppId} by ${pct(cfg.thresholds.spread_reduce_step)}: net ${pct(hold.netApr)}` }
    );
    return done(actions);
  }

  // 8) oversized: the last held chunk earns less than the exit threshold
  //    (holding-only marginal: one-offs of money already in are sunk).
  const chunk = Math.max(cfg.allocator.min_chunk_usd, ctx.totalEquityUsd * cfg.allocator.chunk_frac);
  const canTrim = pos.equityUsd - chunk >= cfg.caps.min_position_usd;
  const m = canTrim ? marginalHoldApr(opp, pos.equityUsd - chunk, pos.equityUsd, ctx) : Infinity;
  if (confirmed("oversized", canTrim && m < threshold)) {
    actions.push({
      type: "exit",
      oppId: pos.oppId,
      fraction: chunk / pos.equityUsd,
      urgent: false,
      reason: `last $${Math.round(chunk)} earns ${pct(m)} < ${pct(threshold)} (diluted)`,
    });
  }

  // warnings only
  for (const f of flags.filter((f) => f.severity === "warn"))
    actions.push({
      type: "alert",
      level: "warn",
      message: `${pos.oppId}: ${f.name}${f.detail ? ` (${f.detail})` : ""}`,
      dedupeKey: `${pos.oppId}|flag|${f.name}`,
    });
  for (const s of opp.signals)
    if (signalLevel(s) === "warn")
      actions.push({
        type: "alert",
        level: "warn",
        message: `${pos.oppId}: ${s.name}=${s.value.toFixed(4)} past warn ${s.warnAt}`,
        dedupeKey: `${pos.oppId}|signal|${s.name}`,
      });
  if (usage >= cfg.liquidity.entry_max_frac_of_capacity)
    actions.push({
      type: "alert",
      level: "warn",
      message: `${pos.oppId}: uses ${pct(usage)} of exit capacity`,
      dedupeKey: `${pos.oppId}|usage`,
    });

  return done(actions);
}
