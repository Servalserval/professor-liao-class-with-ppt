/**
 * config/live.yaml schema. Secrets are never in this file: RPC URLs and keys
 * are referenced as ${ENV_VAR} and expanded at load time; the config hash
 * used by the live gate is computed BEFORE expansion so rotating an RPC key
 * does not force a re-verify, while changing an address or a cap does.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export interface AssetSpec {
  address: string;
  decimals: number;
}

export interface PairSpec {
  pairId: string;
  /** asset symbols from the `assets` registry of the adapter's chain */
  collateral: string;
  debt: string;
  /** Morpho: market id */
  marketId?: string;
  /** Suilend / Navi: market name */
  market?: string;
}

export interface LendingSpec {
  /** "aave-v3" (any Aave v3 family market) | "morpho" | "navi" | "suilend" | "scallop" */
  type: string;
  chain: string;
  /** Aave: address-book market name (e.g. AaveV3Arbitrum) or explicit addresses */
  market?: string;
  addresses?: Record<string, string>;
  /** Venue id override (e.g. "spark") */
  protocol?: string;
  pairs: PairSpec[];
  options?: Record<string, unknown>;
}

export interface LiveConfig {
  mode: "shadow" | "live";
  state_dir: string;
  router_config: string;
  verify_max_age_days: number;
  wallets: { evm_address?: string; sui_address?: string };
  chains: Record<string, { rpc?: string; grpc?: string; jsonrpc?: string }>;
  /** chain -> symbol -> asset */
  assets: Record<string, Record<string, AssetSpec>>;
  /** chain -> symbol of the stablecoin that idle cash / reward proceeds are kept in */
  cash_asset: Record<string, string>;
  lending: LendingSpec[];
  swaps: Record<string, { type: string; options?: Record<string, unknown> }>;
  bridges: Record<string, { enabled: boolean; options?: Record<string, unknown> }>;
  rewards: { merkl?: { enabled: boolean; options?: Record<string, unknown> } };
  limits: { max_gas_usd: Record<string, number>; max_slippage_bps: number; max_loop_iterations: number };
  /** Hard caps on top of the core config while going live. */
  canary: { max_position_usd: number; max_total_deployed_usd: number };
  prices: { overrides?: Record<string, number>; max_age_minutes?: number };
  poll_seconds: number;
}

export const LIVE_DEFAULTS: Partial<LiveConfig> = {
  mode: "shadow",
  state_dir: "state/live",
  router_config: "config/default.yaml",
  verify_max_age_days: 7,
  wallets: {},
  cash_asset: {},
  swaps: {},
  bridges: {},
  rewards: {},
  limits: { max_gas_usd: { default: 3, ethereum: 20 }, max_slippage_bps: 15, max_loop_iterations: 8 },
  canary: { max_position_usd: 2_000, max_total_deployed_usd: 10_000 },
  prices: { max_age_minutes: 10 },
  poll_seconds: 60,
};

/** Replace ${VAR} with process env; unknown vars become "" and are reported. */
export function expandEnv(v: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof v === "string")
    return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const x = env[name];
      if (x === undefined || x === "") missing.add(name);
      return x ?? "";
    });
  if (Array.isArray(v)) return v.map((x) => expandEnv(x, env, missing));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x, env, missing)]));
  return v;
}

export function validateLiveConfig(c: LiveConfig): string[] {
  const e: string[] = [];
  if (c.mode !== "shadow" && c.mode !== "live") e.push(`mode must be shadow|live, got ${String(c.mode)}`);
  for (const l of c.lending ?? []) {
    if (!c.chains?.[l.chain]) e.push(`lending ${l.type}: chain ${l.chain} has no entry in chains`);
    for (const p of l.pairs ?? []) {
      for (const sym of [p.collateral, p.debt])
        if (!c.assets?.[l.chain]?.[sym]) e.push(`lending ${l.type}@${l.chain} pair ${p.pairId}: asset ${sym} not in assets.${l.chain}`);
      if (l.type === "morpho" && !p.marketId) e.push(`morpho pair ${p.pairId}: marketId required`);
    }
  }
  if (!(c.canary?.max_position_usd > 0)) e.push("canary.max_position_usd must be > 0");
  if (!(c.limits?.max_slippage_bps > 0 && c.limits.max_slippage_bps <= 100)) e.push("limits.max_slippage_bps must be in (0,100]");
  return e;
}

export function loadLiveConfig(path: string, env: NodeJS.ProcessEnv = process.env): { raw: unknown; cfg: LiveConfig; missingEnv: string[] } {
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const missing = new Set<string>();
  const expanded = expandEnv(raw, env, missing) as Partial<LiveConfig>;
  const cfg = { ...LIVE_DEFAULTS, ...expanded } as LiveConfig;
  cfg.limits = { ...(LIVE_DEFAULTS.limits as LiveConfig["limits"]), ...(expanded.limits ?? {}) };
  cfg.canary = { ...(LIVE_DEFAULTS.canary as LiveConfig["canary"]), ...(expanded.canary ?? {}) };
  const errors = validateLiveConfig(cfg);
  if (errors.length) throw new Error("invalid live config:\n  - " + errors.join("\n  - "));
  return { raw, cfg, missingEnv: [...missing] };
}
