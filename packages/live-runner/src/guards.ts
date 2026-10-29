/**
 * Hard guards that sit between the core Router and the live executors.
 *
 *  - CanaryExecutor: while going live, caps every position and the total
 *    deployed USD regardless of what the allocator wants. The core config's
 *    caps.max_position_usd is also clamped (see applyCanaryToRouterConfig) so
 *    the allocator plans within the same limits; this wrapper is the backstop.
 *  - Exits, deleverages, claims and sells are never blocked by the canary:
 *    getting OUT must always be possible.
 */
import type { Executor, ExecResult, Opportunity, Position, RouterConfig } from "@incentive-router/core";

export interface CanaryLimits {
  max_position_usd: number;
  max_total_deployed_usd: number;
}

export class CanaryExecutor implements Executor {
  readonly markToMarket?: (pos: Position, opp?: Opportunity) => Promise<number>;

  constructor(
    private readonly inner: Executor,
    private readonly limits: CanaryLimits,
    /** Current positions (from the router's store) — read at call time. */
    private readonly positions: () => Position[]
  ) {
    if (inner.markToMarket) this.markToMarket = inner.markToMarket.bind(inner);
  }

  /** Pure check, exported for tests. */
  static check(limits: CanaryLimits, positions: Position[], oppId: string, deltaUsd: number): string | null {
    if (!(deltaUsd > 0)) return `refusing non-positive entry ${deltaUsd}`;
    const cur = positions.find((p) => p.oppId === oppId)?.equityUsd ?? 0;
    const total = positions.reduce((a, p) => a + p.equityUsd, 0);
    if (cur + deltaUsd > limits.max_position_usd + 1e-6)
      return `canary: position ${oppId} would be $${(cur + deltaUsd).toFixed(0)} > max_position_usd $${limits.max_position_usd}`;
    if (total + deltaUsd > limits.max_total_deployed_usd + 1e-6)
      return `canary: total deployed would be $${(total + deltaUsd).toFixed(0)} > max_total_deployed_usd $${limits.max_total_deployed_usd}`;
    return null;
  }

  async enter(opp: Opportunity, deltaUsd: number): Promise<ExecResult> {
    const why = CanaryExecutor.check(this.limits, this.positions(), opp.id, deltaUsd);
    if (why) return { ok: false, detail: why };
    return this.inner.enter(opp, deltaUsd);
  }
  exit(pos: Position, fraction: number, opp?: Opportunity): Promise<ExecResult> {
    return this.inner.exit(pos, fraction, opp);
  }
  rebalance(pos: Position, opp: Opportunity): Promise<ExecResult> {
    return this.inner.rebalance(pos, opp);
  }
  simulateExit(pos: Position, opp?: Opportunity): Promise<boolean> {
    return this.inner.simulateExit(pos, opp);
  }
  claim(pos: Position, token: string, amountUsd: number): Promise<ExecResult> {
    return this.inner.claim(pos, token, amountUsd);
  }
  sell(pos: Position, token: string, amountUsd: number): Promise<ExecResult> {
    return this.inner.sell(pos, token, amountUsd);
  }
  hedge(token: string, targetShortUsd: number): Promise<ExecResult> {
    return this.inner.hedge(token, targetShortUsd);
  }
}

/** Clamp the router's own sizing caps to the canary (returns a new config). */
export function applyCanaryToRouterConfig(cfg: RouterConfig, canary: CanaryLimits): RouterConfig {
  return {
    ...cfg,
    caps: { ...cfg.caps, max_position_usd: Math.min(cfg.caps.max_position_usd, canary.max_position_usd) },
  };
}
