import type { Flag, Kind, Opportunity, StressSignal, YieldStream } from "../types.js";
import { constantStream, proRataStream } from "../valuation.js";
import { loopPairOpportunity, type LoopPair } from "./loopPair.js";
import { supplyOpportunity, type SupplyMarket } from "./supply.js";
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

/** A static entry priced by the real supply math (sources/supply.ts). Opportunity id: `${sourceId}:${protocol}:${marketId}`. */
export interface StaticSupplySpec {
  supply_market: SupplyMarket;
  executable?: boolean;
}

/** A static entry priced by the real loop math (sources/loopPair.ts). Opportunity id: `${sourceId}:${protocol}:${pairId}`. */
export interface StaticLoopSpec {
  loop_pair: LoopPair;
  executable?: boolean;
}

export type StaticEntry = StaticOppSpec | StaticSupplySpec | StaticLoopSpec;

export const isSupplySpec = (e: StaticEntry): e is StaticSupplySpec => typeof (e as StaticSupplySpec).supply_market === "object";
export const isLoopSpec = (e: StaticEntry): e is StaticLoopSpec => typeof (e as StaticLoopSpec).loop_pair === "object";
export const isPlainSpec = (e: StaticEntry): e is StaticOppSpec => !isSupplySpec(e) && !isLoopSpec(e);

/** Opportunity id a static entry produces. */
export function staticEntryId(e: StaticEntry, sourceId: string): string {
  if (isSupplySpec(e)) return `${sourceId}:${e.supply_market.protocol}:${e.supply_market.marketId}`;
  if (isLoopSpec(e)) return `${sourceId}:${e.loop_pair.protocol}:${e.loop_pair.pairId}`;
  return e.id;
}

/** Any static entry -> Opportunity (null when the real-math builders reject the input). */
export function staticEntryToOpportunity(e: StaticEntry, ctx: SourceContext, sourceId: string, startMs: number): Opportunity | null {
  if (isPlainSpec(e)) return staticToOpportunity(e, ctx, sourceId, startMs);
  const o = isSupplySpec(e) ? supplyOpportunity(e.supply_market, ctx, sourceId) : loopPairOpportunity(e.loop_pair, ctx, sourceId);
  if (o && e.executable === false) o.discoveryOnly = true;
  return o;
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

export class StaticSource<T extends StaticEntry = StaticEntry> implements Source {
  readonly specs: T[];
  constructor(
    specs: T[],
    readonly id = "static",
    private readonly startMs = Date.now()
  ) {
    this.specs = structuredClone(specs);
    // ids must be unique within a source (real-math ids carry no chain: qualify marketId / pairId)
    const seen = new Set<string>();
    for (const s of this.specs) {
      const id = staticEntryId(s, this.id);
      if (seen.has(id)) throw new Error(`static source ${this.id}: duplicate opportunity id ${id} (make marketId / pairId unique, e.g. "<chain>:<market>")`);
      seen.add(id);
    }
  }
  /** Removed opportunities simulate a source that stops reporting (or a delisted market). Keys: opportunity ids. */
  hidden = new Set<string>();
  /** Entry by the opportunity id it produces. */
  find(oppId: string): T | undefined {
    return this.specs.find((s) => staticEntryId(s, this.id) === oppId);
  }
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const out: Opportunity[] = [];
    for (const s of this.specs) {
      if (this.hidden.has(staticEntryId(s, this.id))) continue;
      const o = staticEntryToOpportunity(s, ctx, this.id, this.startMs);
      if (o) out.push(o);
    }
    return out;
  }
}
