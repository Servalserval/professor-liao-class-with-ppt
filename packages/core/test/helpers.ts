import { DEFAULT_CONFIG, deepMerge, type RouterConfig } from "../src/config.js";
import { computeExposure } from "../src/exposure.js";
import type { DecisionContext } from "../src/gates/common.js";
import { newHistory } from "../src/signals.js";
import type { SourceContext } from "../src/sources/types.js";
import type { Opportunity, Position, TokenProfile } from "../src/types.js";
import { constantStream } from "../src/valuation.js";

export const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
export const HOUR = 3600_000;

/** DEFAULT_CONFIG + the two tier-1 venues the fixtures use, then overrides. */
export function cfgWith(over: unknown = {}): RouterConfig {
  const base = deepMerge(DEFAULT_CONFIG, {
    venues: { navi: { enabled: true, tier: 1 }, suilend: { enabled: true, tier: 1 } },
  });
  return deepMerge(base, over);
}

export function sctx(cfg = cfgWith(), my: Record<string, number> = {}): SourceContext {
  return { cfg, nowMs: NOW, myEquityByOpp: my };
}

export function dctx(args: {
  cfg?: RouterConfig;
  equity?: number;
  positions?: Position[];
  tokens?: Record<string, TokenProfile>;
  cooldown?: Record<string, number>;
  paused?: boolean;
  idle?: number;
  hedges?: Record<string, number>;
} = {}): DecisionContext {
  const positions = args.positions ?? [];
  const equity = args.equity ?? 100_000;
  return {
    cfg: args.cfg ?? cfgWith(),
    nowMs: NOW,
    tokens: args.tokens ?? {},
    totalEquityUsd: equity,
    positions,
    exposure: computeExposure(positions),
    history: newHistory(),
    cooldownUntil: args.cooldown ?? {},
    paused: args.paused ?? false,
    idleUsd: args.idle ?? equity - positions.reduce((a, p) => a + p.equityUsd, 0),
    hedges: args.hedges ?? {},
  };
}

/** A plain tier-1 deposit with constant APR and lots of liquidity. */
export function opp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: "o1",
    sourceId: "test",
    kind: "deposit",
    name: "o1",
    primaryVenue: "navi",
    chain: "sui",
    legs: [{ venue: "navi", chain: "sui", token: "USDC", equityFrac: 1 }],
    streams: [constantStream("base", "base", 0.12)],
    costs: { entryFrac: 0, exitFrac: 0, fixedEntryUsd: 0, fixedExitUsd: 0, ongoingApr: 0 },
    liquidity: { exitCapacityUsd: 10_000_000, footprintPerEquity: 1 },
    signals: [],
    flags: [],
    metrics: {},
    myEquityUsd: 0,
    observedAtMs: NOW,
    ...over,
  };
}

export function position(o: Opportunity, equityUsd: number, over: Partial<Position> = {}): Position {
  return {
    oppId: o.id,
    sourceId: o.sourceId,
    kind: o.kind,
    primaryVenue: o.primaryVenue,
    chain: o.chain,
    legs: o.legs,
    speculative: o.speculative ?? false,
    equityUsd,
    openedAtMs: NOW - 48 * HOUR,
    lastActionAtMs: NOW - 48 * HOUR,
    rewards: {},
    exitProbe: { lastOkAtMs: NOW, consecutiveFailures: 0 },
    pending: {},
    blindCycles: 0,
    ...over,
  };
}

export const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
