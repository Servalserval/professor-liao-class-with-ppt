import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Kind, Tier } from "./types.js";
import { entryThreshold, exitThreshold } from "./tiers.js";
import type { RouteSpec } from "./xchain/types.js";

export type RewardPolicy = "sell_on_claim" | "hedge" | "hold";

export interface RewardTokenConfig {
  policy: RewardPolicy;
  /** Never hold more than this much of the token after claims (hold policy). */
  max_hold_usd: number;
  claim_interval_hours: number;
  claim_min_usd: number;
}

export interface VenueConfig {
  enabled: boolean;
  /** Explicit tier; otherwise scored from `meta`, unknown -> tier 3. */
  tier?: Tier;
  chain?: string;
  meta?: {
    audits?: number;
    age_days?: number;
    tvl_usd?: number;
    admin_multisig?: boolean;
    timelock_hours?: number;
    upgradeable?: boolean;
    incidents?: number;
  };
}

/**
 * Depeg-risk profile of one stablecoin (provisional defaults below; replace
 * with researched values). Used by supply deposits and loops.
 */
export interface StableConfig {
  /** 1 = fiat-backed blue chip, 2 = established synthetic / smaller issuer, 3 = new / unverified. */
  tier: Tier;
  /** Expected yearly loss from depegs (probability x severity), APR fraction. Default: tiers_default_loss[tier]. */
  expected_loss_apr?: number;
  /** |price - 1| warn / exit levels for this asset (override sources.lending_loop.depeg_warn / depeg_exit). */
  depeg_warn?: number;
  depeg_exit?: number;
  /** Max share of total equity held in this asset across ALL positions (legs by token). */
  max_frac?: number;
}

export interface RouterConfig {
  /** What idle capital earns elsewhere (T-bill / sUSDS). Thresholds are premia over it. */
  baseline_apr: number;
  hold_horizon_days: number;
  poll_seconds: number;

  thresholds: {
    entry_premium_by_tier: Record<Tier, number>;
    exit_premium_by_tier: Record<Tier, number>;
    /** Below this realized net APR a position is fully closed, not trimmed. */
    hard_floor_apr: number;
    /** Fraction to trim per decision when the spread is merely below the exit threshold. */
    spread_reduce_step: number;
    /** Non-urgent exit reasons must persist this many cycles AND this many minutes. */
    confirm_cycles: number;
    confirm_minutes: number;
    /**
     * Per-kind adjustment added to the tier premia (entry is never below
     * baseline_apr). Plain deposits carry no liquidation / swap risk, so they
     * clear a lower bar than loops at the same venue tier.
     */
    kind_premium_adjust: Partial<Record<Kind, { entry: number | Partial<Record<Tier, number>>; exit: number | Partial<Record<Tier, number>> }>>;
  };

  liquidity: {
    entry_max_frac_of_capacity: number;
    exit_frac_of_capacity: number;
    min_capacity_usd: number;
    capacity_drop_exit_frac: number;
    capacity_drop_window_minutes: number;
    /** Estimated capacity (discovery data) is multiplied by this before use. */
    estimated_capacity_haircut: number;
  };

  rewards: {
    /** Realizable fraction when we know nothing about the token (loop-farm used 0.5). */
    default_realizable: number;
    min_realizable: number;
    max_realizable: number;
    /** Streams ending within this window are dropped for the "does the edge survive" test. */
    ending_hours: number;
    /**
     * Opt-in renewal assumption per venue (opp.primaryVenue) for reward
     * campaigns that are re-posted on a fixed cycle (Aave / Merkl weekly
     * top-ups). Valuation counts each further period with prob^k; the
     * reward-ending exit rule keeps an ending stream at `prob` instead of 0.
     * Without an entry a stream is worth nothing after its end time.
     */
    renewal?: Record<string, { prob: number; period_days: number }>;
    claim_gas_multiple: number;
    vol_penalty_k: number;
    /** 24h price drop that triggers claim-and-dump. */
    price_crash_frac: number;
    /** Crash / over-cap claims skip the schedule but not this minimum spacing (gas churn). */
    urgent_claim_min_interval_hours: number;
    /** Reward APR drop within the window that raises an emission-cut warning. */
    emission_drop_frac: number;
    emission_drop_window_hours: number;
    default_token: RewardTokenConfig;
    tokens: Record<string, Partial<RewardTokenConfig>>;
  };

  points: {
    /** Annualized cost (negative net APR) we accept to farm points. */
    max_cost_apr: number;
    /** Max fraction of equity in speculative (points-driven) positions. */
    budget_frac: number;
  };

  funding: {
    /** Positive funding is valued at this fraction (it flips). Negative counts in full. */
    realizable: number;
  };

  /** Raise an exit flag when a tracked metric rises by >= abs value vs its low within the window. */
  spike_rules: Record<string, number>;
  spike_window_minutes: number;

  caps: {
    per_venue_frac_by_tier: Record<Tier, number>;
    per_chain_frac: Record<string, number>;
    per_token_frac: number;
    per_reward_token_frac: number;
    per_kind_frac: Record<Kind, number>;
    per_opportunity_frac: number;
    max_concurrent_positions: number;
    min_position_usd: number;
    max_position_usd: number;
    min_idle_frac: number;
    reentry_cooldown_hours: number;
    urgent_reentry_cooldown_hours: number;
    /** Optional absolute ceiling on deployed + in-flight USD (canary / small-cap runs). */
    max_total_deployed_usd?: number;
  };

  allocator: {
    chunk_frac: number;
    min_chunk_usd: number;
    max_new_positions_per_cycle: number;
    min_rebalance_usd: number;
  };

  exit_probe: {
    max_age_minutes: number;
    /** Simulations that returned false (path broken) before an urgent exit. */
    max_consecutive_failures: number;
    /** Simulations that could not run (RPC error) before a warning; they never cause an exit. */
    error_alert_after: number;
  };

  portfolio: {
    kill_drawdown_frac: number;
    kill_window_hours: number;
    blind_alert_cycles: number;
    blind_exit_cycles: number;
    /** Repeated status alerts (same oppId + rule) are re-sent at most this often. */
    alert_repeat_hours: number;
    /** Data older than this (Opportunity.dataAsOfMs) counts as not reported. */
    max_data_age_minutes: number;
    /** Held leveraged position (loop / perp hedge) whose source reports no health metric. */
    health_missing: "warn" | "exit";
    /** The drawdown must be seen on this many consecutive cycles before the kill switch fires. */
    kill_confirm_cycles: number;
  };

  tiers: {
    tier1_min_score: number;
    tier2_min_score: number;
  };

  /** Gas estimate per transaction, USD, by chain. */
  gas_usd: Record<string, number>;

  venues: Record<string, VenueConfig>;

  sources: {
    lending_loop: {
      target_ltv: number;
      max_ltv_frac_of_open: number;
      deleverage_at_ltv: number;
      critical_ltv_frac_of_close: number;
      utilization_warn: number;
      utilization_exit: number;
      /** "gross" = L x equity must fit in liquidity (loop-farm default); "net" = flashloan exit. */
      footprint: "gross" | "net";
      rate_uncertainty_mult: number;
      txs_per_entry: number;
      txs_per_exit: number;
      /** Stable-pair loops: |price(debt)/price(collateral) - 1| warn / exit levels. */
      depeg_warn: number;
      depeg_exit: number;
      /** Swap cost assumed when the adapter's probe failed (NaN) and no recent quote exists. */
      unknown_swap_cost_frac: number;
    };
    discovery: {
      min_tvl_usd: number;
      chains: string[];
      assumed_withdrawable_frac: number;
    };
    /** Supply-only lending (sources/supply.ts). */
    supply: {
      /**
       * Utilization levels for plain deposits (a deposit LOWERS utilization;
       * the risk is being unable to withdraw, which the 1/10 and 1/5
       * withdrawable-liquidity rules cover). warn blocks entries; exit leaves.
       * Not used for vaults (SupplyMarket.kind "vault").
       */
      utilization_warn: number;
      utilization_exit: number;
      /** Deposits into a stable whose depeg tier is above this are refused. */
      max_risk_tier: Tier;
      /** Tier assumed for a stablecoin that is not in `stables`. */
      unknown_stable_tier: Tier;
      txs_per_entry: number;
      txs_per_exit: number;
    };
  };

  /** Depeg-risk table per stablecoin symbol (see StableConfig). */
  stables: Record<string, StableConfig>;
  /** Expected depeg loss APR used for a stable that has a tier but no expected_loss_apr. */
  tiers_default_loss: Record<Tier, number>;

  /** Cross-chain funding (packages/core/src/xchain). */
  xchain: {
    enabled: boolean;
    /** A single move may cost at most this many days of the moved money's net yield at the destination. */
    max_cost_days_of_yield: number;
    /** All cross-chain costs within any rolling 24h <= this many days of the whole book's expected yield. */
    book_daily_budget_days: number;
    /** The move must pay back its cost within this many days from the APR improvement over leaving it idle where it is. */
    payback_days: number;
    /** Never move less than this (fixed costs dominate). */
    min_move_usd: number;
    /** Max fraction of total equity in flight at once. */
    max_in_flight_frac: number;
    /** A hop not finished after eta x this factor (and >= stuck_min_minutes) is flagged stuck. */
    stuck_eta_multiple: number;
    stuck_min_minutes: number;
    /** APR assumed for idle cash at the source while deciding (0 = idle earns nothing). */
    idle_apr: number;
    /** Known routes. Live adapters refresh fees; these are the planning defaults. */
    routes: RouteSpec[];
  };

  telegram?: { bot_token_env: string; chat_id_env: string };
}

export const DEFAULT_CONFIG: RouterConfig = {
  baseline_apr: 0.045,
  hold_horizon_days: 21,
  poll_seconds: 60,
  thresholds: {
    entry_premium_by_tier: { 1: 0.03, 2: 0.06, 3: 0.12 },
    exit_premium_by_tier: { 1: 0.0, 2: 0.02, 3: 0.05 },
    hard_floor_apr: 0.0,
    spread_reduce_step: 0.5,
    confirm_cycles: 2,
    confirm_minutes: 10,
    kind_premium_adjust: { deposit: { entry: -0.015, exit: -0.01 } },
  },
  liquidity: {
    entry_max_frac_of_capacity: 0.1,
    exit_frac_of_capacity: 0.2,
    min_capacity_usd: 200_000,
    capacity_drop_exit_frac: 0.3,
    capacity_drop_window_minutes: 60,
    estimated_capacity_haircut: 0.5,
  },
  rewards: {
    default_realizable: 0.5,
    min_realizable: 0.1,
    max_realizable: 0.95,
    ending_hours: 12,
    claim_gas_multiple: 5,
    vol_penalty_k: 1.0,
    price_crash_frac: 0.25,
    urgent_claim_min_interval_hours: 6,
    emission_drop_frac: 0.5,
    emission_drop_window_hours: 24,
    default_token: {
      policy: "sell_on_claim",
      max_hold_usd: 0,
      claim_interval_hours: 24,
      claim_min_usd: 50,
    },
    tokens: {},
  },
  points: { max_cost_apr: 0.03, budget_frac: 0.1 },
  funding: { realizable: 0.7 },
  spike_rules: { borrow_apr: 0.1 },
  spike_window_minutes: 60,
  caps: {
    per_venue_frac_by_tier: { 1: 0.4, 2: 0.15, 3: 0.05 },
    per_chain_frac: { default: 0.6 },
    per_token_frac: 0.8,
    per_reward_token_frac: 0.05,
    per_kind_frac: { lending_loop: 0.8, lp_incentive: 0.4, delta_neutral_perp: 0.4, deposit: 0.5 },
    per_opportunity_frac: 0.3,
    max_concurrent_positions: 8,
    min_position_usd: 500,
    max_position_usd: 100_000,
    min_idle_frac: 0.05,
    reentry_cooldown_hours: 6,
    urgent_reentry_cooldown_hours: 48,
  },
  allocator: {
    chunk_frac: 0.02,
    min_chunk_usd: 500,
    max_new_positions_per_cycle: 2,
    min_rebalance_usd: 1_000,
  },
  exit_probe: { max_age_minutes: 30, max_consecutive_failures: 2, error_alert_after: 3 },
  portfolio: {
    kill_drawdown_frac: 0.05,
    kill_window_hours: 24,
    blind_alert_cycles: 3,
    blind_exit_cycles: 10,
    alert_repeat_hours: 6,
    max_data_age_minutes: 10,
    health_missing: "warn",
    kill_confirm_cycles: 2,
  },
  tiers: { tier1_min_score: 7, tier2_min_score: 4 },
  gas_usd: { default: 0.5, ethereum: 8, sui: 0.05, arbitrum: 0.1, base: 0.05 },
  venues: {},
  sources: {
    lending_loop: {
      target_ltv: 0.7,
      max_ltv_frac_of_open: 0.85,
      deleverage_at_ltv: 0.78,
      critical_ltv_frac_of_close: 0.95,
      utilization_warn: 0.9,
      utilization_exit: 0.95,
      footprint: "gross",
      rate_uncertainty_mult: 1.3,
      txs_per_entry: 1,
      txs_per_exit: 1,
      depeg_warn: 0.003,
      depeg_exit: 0.01,
      unknown_swap_cost_frac: 0.003,
    },
    discovery: {
      min_tvl_usd: 1_000_000,
      chains: [],
      assumed_withdrawable_frac: 0.3,
    },
    supply: { utilization_warn: 0.95, utilization_exit: 0.99, max_risk_tier: 2, unknown_stable_tier: 3, txs_per_entry: 2, txs_per_exit: 1 },
  },
  // Researched 2026-10-29 (docs/selection.md §3): tier, expected yearly depeg loss, |p-1| warn/exit.
  stables: {
    USDC: { tier: 1, expected_loss_apr: 0.0005, depeg_warn: 0.003, depeg_exit: 0.01 },
    USDT: { tier: 1, expected_loss_apr: 0.001, depeg_warn: 0.003, depeg_exit: 0.01 },
    USDS: { tier: 1, expected_loss_apr: 0.001, depeg_warn: 0.003, depeg_exit: 0.01 },
    DAI: { tier: 1, expected_loss_apr: 0.001, depeg_warn: 0.003, depeg_exit: 0.01 },
    PYUSD: { tier: 1, expected_loss_apr: 0.0008, depeg_warn: 0.003, depeg_exit: 0.01 },
    RLUSD: { tier: 1, expected_loss_apr: 0.0008, depeg_warn: 0.003, depeg_exit: 0.01 },
    USDG: { tier: 1, expected_loss_apr: 0.0008, depeg_warn: 0.003, depeg_exit: 0.01 },
    "USDC.e": { tier: 2, expected_loss_apr: 0.002, depeg_warn: 0.005, depeg_exit: 0.015 },
    USDT0: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    GHO: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    AUSD: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    USDsui: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    mUSD: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    frxUSD: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    USDtb: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    USD1: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    suiUSDT: { tier: 2, expected_loss_apr: 0.003, depeg_warn: 0.005, depeg_exit: 0.015 },
    USDe: { tier: 3, expected_loss_apr: 0.015, depeg_warn: 0.007, depeg_exit: 0.02 },
    sUSDe: { tier: 3, expected_loss_apr: 0.02, depeg_warn: 0.007, depeg_exit: 0.02 },
    crvUSD: { tier: 3, expected_loss_apr: 0.015, depeg_warn: 0.007, depeg_exit: 0.02 },
    FDUSD: { tier: 3, expected_loss_apr: 0.015, depeg_warn: 0.007, depeg_exit: 0.02 },
    wUSDC: { tier: 3, expected_loss_apr: 0.02, depeg_warn: 0.007, depeg_exit: 0.02 },
    wUSDT: { tier: 3, expected_loss_apr: 0.02, depeg_warn: 0.007, depeg_exit: 0.02 },
  },
  tiers_default_loss: { 1: 0.0008, 2: 0.003, 3: 0.015 },
  xchain: {
    enabled: false,
    max_cost_days_of_yield: 1,
    book_daily_budget_days: 1,
    payback_days: 14,
    min_move_usd: 1_000,
    max_in_flight_frac: 0.5,
    stuck_eta_multiple: 4,
    stuck_min_minutes: 60,
    idle_apr: 0,
    routes: [],
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep merge: plain objects merge key-by-key, everything else (arrays, scalars)
 * replaces. null/undefined never override (a YAML key whose children are all
 * commented out parses as null).
 */
export function deepMerge<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function validateConfig(c: RouterConfig): string[] {
  const e: string[] = [];
  const frac = (name: string, v: number) => {
    if (!(v >= 0 && v <= 1)) e.push(`${name} must be within [0,1], got ${v}`);
  };
  frac("liquidity.entry_max_frac_of_capacity", c.liquidity.entry_max_frac_of_capacity);
  frac("liquidity.exit_frac_of_capacity", c.liquidity.exit_frac_of_capacity);
  if (c.liquidity.exit_frac_of_capacity <= c.liquidity.entry_max_frac_of_capacity)
    e.push("liquidity.exit_frac_of_capacity must be > entry_max_frac_of_capacity (otherwise you exit right after entering)");
  for (const t of [1, 2, 3] as Tier[]) {
    if (c.thresholds.exit_premium_by_tier[t] >= c.thresholds.entry_premium_by_tier[t])
      e.push(`thresholds: exit premium must be below entry premium for tier ${t} (hysteresis)`);
  }
  frac("rewards.default_realizable", c.rewards.default_realizable);
  if (c.rewards.min_realizable > c.rewards.max_realizable) e.push("rewards.min_realizable > max_realizable");
  frac("funding.realizable", c.funding.realizable);
  frac("thresholds.spread_reduce_step", c.thresholds.spread_reduce_step);
  frac("caps.min_idle_frac", c.caps.min_idle_frac);
  if (c.caps.min_position_usd > c.caps.max_position_usd) e.push("caps.min_position_usd > max_position_usd");
  const ll = c.sources.lending_loop;
  if (!(ll.target_ltv > 0 && ll.target_ltv < 1)) e.push("sources.lending_loop.target_ltv must be in (0,1)");
  if (ll.deleverage_at_ltv <= ll.target_ltv) e.push("sources.lending_loop.deleverage_at_ltv must be > target_ltv");
  if (ll.utilization_exit <= ll.utilization_warn) e.push("sources.lending_loop.utilization_exit must be > utilization_warn");
  if (!(Number.isInteger(c.portfolio.kill_confirm_cycles) && c.portfolio.kill_confirm_cycles >= 1))
    e.push("portfolio.kill_confirm_cycles must be an integer >= 1");
  if (c.caps.max_total_deployed_usd !== undefined && !(c.caps.max_total_deployed_usd >= 0))
    e.push("caps.max_total_deployed_usd must be >= 0");
  const tierOk = (t: unknown) => t === 1 || t === 2 || t === 3;
  {
    const seen = new Map<string, string>();
    for (const sym of Object.keys(c.stables ?? {})) {
      const k = sym.toLowerCase();
      const prev = seen.get(k);
      if (prev !== undefined)
        e.push(`stables.${sym} and stables.${prev} differ only by case (keys are case-insensitive; keep one spelling — the defaults use ${prev})`);
      else seen.set(k, sym);
    }
  }
  for (const [sym, sc] of Object.entries(c.stables ?? {})) {
    if (!tierOk(sc.tier)) e.push(`stables.${sym}.tier must be 1, 2 or 3`);
    if (sc.expected_loss_apr !== undefined && !(sc.expected_loss_apr >= 0 && sc.expected_loss_apr < 1)) e.push(`stables.${sym}.expected_loss_apr must be in [0,1)`);
    if (sc.max_frac !== undefined) frac(`stables.${sym}.max_frac`, sc.max_frac);
    if (sc.depeg_warn !== undefined && sc.depeg_exit !== undefined && !(sc.depeg_exit > sc.depeg_warn))
      e.push(`stables.${sym}.depeg_exit must be > depeg_warn`);
  }
  for (const t of [1, 2, 3] as Tier[]) if (!(c.tiers_default_loss[t] >= 0)) e.push(`tiers_default_loss.${t} must be >= 0`);
  {
    const sp = c.sources.supply;
    if (!(sp.utilization_warn > 0 && sp.utilization_warn < sp.utilization_exit && sp.utilization_exit <= 1))
      e.push("sources.supply: need 0 < utilization_warn < utilization_exit <= 1");
  }
  if (!tierOk(c.sources.supply.max_risk_tier)) e.push("sources.supply.max_risk_tier must be 1, 2 or 3");
  if (!tierOk(c.sources.supply.unknown_stable_tier)) e.push("sources.supply.unknown_stable_tier must be 1, 2 or 3");
  for (const [kind, adj] of Object.entries(c.thresholds.kind_premium_adjust ?? {})) {
    if (!adj) continue;
    for (const side of ["entry", "exit"] as const) {
      const v = adj[side];
      const vals = typeof v === "number" ? [v] : Object.values(v ?? {});
      if (vals.some((x) => typeof x !== "number" || !Number.isFinite(x))) e.push(`thresholds.kind_premium_adjust.${kind}.${side} must be a number or a {1,2,3} map of numbers`);
    }
    for (const t of [1, 2, 3] as Tier[]) {
      const entry = entryThreshold(c, t, kind as Kind);
      const exit = exitThreshold(c, t, kind as Kind);
      if (exit >= entry) e.push(`thresholds.kind_premium_adjust.${kind}: exit must stay below entry for tier ${t} (hysteresis)`);
    }
  }
  for (const [v, r] of Object.entries(c.rewards.renewal ?? {})) {
    if (!(r.prob >= 0 && r.prob < 1)) e.push(`rewards.renewal.${v}.prob must be in [0,1)`);
    if (!(r.period_days > 0)) e.push(`rewards.renewal.${v}.period_days must be > 0`);
  }
  if (c.portfolio.blind_exit_cycles < c.portfolio.blind_alert_cycles)
    e.push("portfolio.blind_exit_cycles must be >= blind_alert_cycles");
  return e;
}

export function loadConfig(path?: string): RouterConfig {
  let cfg = DEFAULT_CONFIG;
  if (path) {
    const raw = parse(readFileSync(path, "utf8"));
    cfg = deepMerge(DEFAULT_CONFIG, raw);
  }
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error("invalid config:\n  - " + errors.join("\n  - "));
  return cfg;
}

export function rewardTokenConfig(cfg: RouterConfig, token: string): RewardTokenConfig {
  return { ...cfg.rewards.default_token, ...(cfg.rewards.tokens[token] ?? {}) };
}

export function gasUsd(cfg: RouterConfig, chain: string): number {
  return cfg.gas_usd[chain] ?? cfg.gas_usd.default ?? 0.5;
}

export function chainCap(cfg: RouterConfig, chain: string): number {
  return cfg.caps.per_chain_frac[chain] ?? cfg.caps.per_chain_frac.default ?? 1;
}
