import type { RouterConfig } from "../config.js";
import type { Exposure } from "../exposure.js";
import type { History } from "../signals.js";
import type { Opportunity, Position, StressSignal } from "../types.js";
import type { ValuationContext } from "../valuation.js";

/** Everything a decision needs, assembled once per cycle by the monitor. */
export interface DecisionContext extends ValuationContext {
  totalEquityUsd: number;
  positions: Position[];
  exposure: Exposure;
  history: History;
  /** oppId -> epoch ms until which re-entry is blocked. */
  cooldownUntil: Record<string, number>;
  paused: boolean;
  /** Cash actually available to deploy (rewards held as tokens are NOT cash). */
  idleUsd: number;
  /** Current short hedge per reward token (USD notional). */
  hedges: Record<string, number>;
}

export function signalLevel(s: StressSignal): "ok" | "warn" | "exit" {
  const past = (v: number, lim: number) => (s.direction === "above" ? v >= lim : v <= lim);
  if (past(s.value, s.exitAt)) return "exit";
  if (past(s.value, s.warnAt)) return "warn";
  return "ok";
}

export function effectiveCapacity(cfg: RouterConfig, opp: Opportunity): number {
  const c = opp.liquidity.exitCapacityUsd;
  return opp.liquidity.estimated ? c * cfg.liquidity.estimated_capacity_haircut : c;
}

/** Share of the exit capacity my position would need to get out. */
export function liquidityUsage(cfg: RouterConfig, opp: Opportunity, equityUsd: number): number {
  const cap = effectiveCapacity(cfg, opp);
  if (cap <= 0) return Infinity;
  return (equityUsd * opp.liquidity.footprintPerEquity) / cap;
}

/** Kinds whose positions carry leverage and therefore need a health metric while held. */
export const LEVERAGED_KINDS = new Set(["lending_loop", "delta_neutral_perp"]);

export function venues(opp: Opportunity): string[] {
  return [...new Set(opp.legs.map((l) => l.venue))];
}
