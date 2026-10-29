import type { Flag, Kind, Opportunity, StressSignal, YieldStream } from "../types.js";
import { constantStream, proRataStream } from "../valuation.js";
import type { Source, SourceContext } from "./types.js";

/**
 * Hand-written opportunities (YAML). Useful for things no scanner covers —
 * a CEX earn promo, a Boros fixed rate, a points program you are evaluating —
 * and as the driver of the scenario simulator.
 */
export interface StaticStreamSpec {
  label: string;
  kind: YieldStream["kind"];
  apr: number;
  reward_token?: string;
  /** If set, the APR is a fixed emission shared pro-rata over this pool size. */
  pool_usd?: number;
  /** Pool dollars per USD of my equity (leverage for loops). Default 1. */
  gross_per_equity?: number;
  ends_at?: string;
  ends_in_hours?: number;
}

export interface StaticOppSpec {
  id: string;
  name?: string;
  kind: Kind;
  venue: string;
  chain: string;
  token: string;
  /** Extra legs (e.g. second venue of a hedge). If given, replaces the single default leg. */
  legs?: { venue: string; chain: string; token: string; equity_frac: number }[];
  capacity_usd: number;
  footprint_per_equity?: number;
  capacity_estimated?: boolean;
  executable?: boolean;
  speculative?: boolean;
  max_equity_usd?: number;
  costs?: { entry_frac?: number; exit_frac?: number; fixed_entry_usd?: number; fixed_exit_usd?: number; ongoing_apr?: number };
  streams: StaticStreamSpec[];
  signals?: { name: string; value: number; warn_at: number; exit_at: number; direction?: "above" | "below" }[];
  flags?: Flag[];
  metrics?: Record<string, number>;
  health?: { metric: string; value: number; rebalance_at: number; critical_at: number; direction?: "above" | "below" };
}

export function staticToOpportunity(spec: StaticOppSpec, ctx: SourceContext, sourceId: string, startMs: number): Opportunity {
  const myE = ctx.myEquityByOpp[spec.id] ?? 0;
  const streams: YieldStream[] = spec.streams.map((s) => {
    const endsAtMs = s.ends_at ? Date.parse(s.ends_at) : s.ends_in_hours !== undefined ? startMs + s.ends_in_hours * 3600_000 : null;
    if (s.pool_usd !== undefined) {
      const g = s.gross_per_equity ?? 1;
      return proRataStream({
        label: s.label,
        kind: s.kind,
        aprNow: s.apr,
        poolUsd: s.pool_usd,
        grossPerEquity: g,
        myEquityNowUsd: myE,
        aprMultiplier: g,
        rewardToken: s.reward_token,
        endsAtMs,
      });
    }
    return constantStream(s.label, s.kind, s.apr, { rewardToken: s.reward_token, endsAtMs });
  });
  const signals: StressSignal[] = (spec.signals ?? []).map((s) => ({
    name: s.name,
    value: s.value,
    warnAt: s.warn_at,
    exitAt: s.exit_at,
    direction: s.direction ?? "above",
  }));
  return {
    id: spec.id,
    sourceId,
    kind: spec.kind,
    name: spec.name ?? spec.id,
    primaryVenue: spec.venue,
    chain: spec.chain,
    legs: spec.legs?.map((l) => ({ venue: l.venue, chain: l.chain, token: l.token, equityFrac: l.equity_frac })) ?? [
      { venue: spec.venue, chain: spec.chain, token: spec.token, equityFrac: 1 },
    ],
    streams,
    costs: {
      entryFrac: spec.costs?.entry_frac ?? 0,
      exitFrac: spec.costs?.exit_frac ?? 0,
      fixedEntryUsd: spec.costs?.fixed_entry_usd ?? 0,
      fixedExitUsd: spec.costs?.fixed_exit_usd ?? 0,
      ongoingApr: spec.costs?.ongoing_apr ?? 0,
    },
    liquidity: {
      exitCapacityUsd: spec.capacity_usd,
      footprintPerEquity: spec.footprint_per_equity ?? 1,
      estimated: spec.capacity_estimated,
    },
    signals,
    flags: spec.flags ?? [],
    metrics: spec.metrics ?? {},
    health: spec.health
      ? {
          metric: spec.health.metric,
          value: spec.health.value,
          rebalanceAt: spec.health.rebalance_at,
          criticalAt: spec.health.critical_at,
          direction: spec.health.direction ?? "above",
        }
      : undefined,
    maxEquityUsd: spec.max_equity_usd,
    speculative: spec.speculative,
    discoveryOnly: spec.executable === false,
    myEquityUsd: myE,
    observedAtMs: ctx.nowMs,
  };
}

export class StaticSource implements Source {
  readonly specs: StaticOppSpec[];
  constructor(
    specs: StaticOppSpec[],
    readonly id = "static",
    private readonly startMs = Date.now()
  ) {
    this.specs = structuredClone(specs);
  }
  /** Removed opportunities simulate a source that stops reporting (or a delisted market). */
  hidden = new Set<string>();
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    return this.specs.filter((s) => !this.hidden.has(s.id)).map((s) => staticToOpportunity(s, ctx, this.id, this.startMs));
  }
}
