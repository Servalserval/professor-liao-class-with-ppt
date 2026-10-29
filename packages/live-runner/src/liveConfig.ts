/**
 * config/live.yaml schema. Secrets are never in this file: RPC URLs and keys
 * are referenced as ${ENV_VAR} and expanded at load time; the config hash
 * used by the live gate is computed BEFORE expansion so rotating an RPC key
 * does not force a re-verify, while changing an address or a cap does.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * One token. Prefer a resolver over a hand-typed address:
 *  - `aave_book: AaveV3Plasma` (+ `book_symbol` when the book's symbol differs,
 *    e.g. Arbitrum native USDC is "USDCn") -> address + decimals from
 *    @bgd-labs/aave-address-book;
 *  - `usdt0: true` -> the USDT0 token from the live-bridges deployment table
 *    (docs.usdt0.to, SOURCE comments there).
 * `verify` reads every asset back on-chain (symbol / decimals) either way.
 */
export interface AssetSpec {
  address?: string;
  decimals?: number;
  aave_book?: string;
  book_symbol?: string;
  usdt0?: boolean;
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
  /** Depeg reference: default 1 (stable pair); "oracle" only for yield-bearing collateral. */
  expected_price_ratio?: number | "oracle";
}

/** A plain deposit (supply-only) on the same venue as a lending spec. */
export interface SupplySpec {
  /** asset symbol from `assets.<chain>` */
  asset: string;
  /** Expected SupplyMarket.marketId (default: matched by asset). */
  marketId?: string;
  /** Navi: market name; Aave V4: reserve id. */
  market?: string;
  reserveId?: number;
  /** Scallop: stake the sCoin in the pool's spool when it is live (default true). */
  stakeInSpool?: boolean;
}

/** ERC-4626 vaults on one chain (Euler EVaults, MetaMorpho vaults, Fluid fTokens, sUSDS ...). */
export interface VaultSpec {
  chain: string;
  vaults: { address: string; asset: string; flavor: "euler" | "metamorpho" | "fluid" | "generic"; marketId?: string; protocol?: string; curator?: string }[];
  options?: Record<string, unknown>;
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
  /** Loop pairs (may be empty for a supply-only venue). */
  pairs: PairSpec[];
  /** Plain deposits on this venue (no borrow). */
  supply?: SupplySpec[];
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
  vaults?: VaultSpec[];
  swaps: Record<string, { type: string; options?: Record<string, unknown> }>;
  bridges: Record<string, { enabled: boolean; options?: Record<string, unknown> }>;
  rewards: {
    merkl?: { enabled: boolean; options?: Record<string, unknown> };
    keeper?: { interval_hours?: number; min_claim_usd?: number; min_sell_usd?: number };
    /** chain -> reward token symbols (from `assets`) to sell into cash_asset */
    sell?: Record<string, string[]>;
  };
  /** Reward-token profiles for the router's realizable-value model (price comes from the feed). */
  tokens?: Record<string, { chain?: string; vol?: number; depth2pctUsd?: number; trendApr?: number; perpAvailable?: boolean; hedgeCostApr?: number; priceUsd?: number }>;
  limits: { max_gas_usd: Record<string, number>; max_slippage_bps: number; max_loop_iterations: number };
  /** Hard caps on top of the core config while going live. */
  canary: { max_position_usd: number; max_total_deployed_usd: number };
  prices: { overrides?: Record<string, number>; max_age_minutes?: number; native_ids?: Record<string, string> };
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

/** Router scope is stablecoins only (same-asset + stable pairs). Extend deliberately. */
export const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "USDT0", "USDt", "USDe", "sUSDe", "GHO", "USDS", "sUSDS", "DAI", "sDAI", "USDsui", "AUSD", "USDC.e", "USDbC",
  "PYUSD", "RLUSD", "USDG", "frxUSD", "FDUSD", "USD1", "USDtb", "mUSD", "suiUSDT", "wUSDC", "wUSDT", "USDB", "LUSD", "crvUSD",
]);

export function validateLiveConfig(c: LiveConfig): string[] {
  const e: string[] = [];
  const allowNonStable = (c as { allow_non_stable?: boolean }).allow_non_stable === true;
  if (c.mode !== "shadow" && c.mode !== "live") e.push(`mode must be shadow|live, got ${String(c.mode)}`);
  for (const [chain, m] of Object.entries(c.assets ?? {}))
    for (const [sym, a] of Object.entries(m ?? {}))
      if (!a || (!a.address && !a.aave_book && !a.usdt0)) e.push(`assets.${chain}.${sym}: needs address+decimals, aave_book or usdt0`);
      else if (a.address && a.decimals === undefined) e.push(`assets.${chain}.${sym}: address without decimals`);
  for (const v of c.vaults ?? []) {
    if (!c.chains?.[v.chain]) e.push(`vaults@${v.chain}: chain has no entry in chains`);
    for (const x of v.vaults ?? []) {
      if (!c.assets?.[v.chain]?.[x.asset]) e.push(`vault ${x.address}@${v.chain}: asset ${x.asset} not in assets.${v.chain}`);
      if (!allowNonStable && !STABLE_SYMBOLS.has(x.asset)) e.push(`vault ${x.address}@${v.chain}: ${x.asset} is not a stablecoin (set allow_non_stable: true to override)`);
      if (!["euler", "metamorpho", "fluid", "generic"].includes(x.flavor)) e.push(`vault ${x.address}@${v.chain}: flavor must be euler|metamorpho|fluid|generic`);
    }
  }
  // One wallet holds one account per lending market: a plain deposit next to a
  // loop in that account becomes collateral for the loop's debt (Aave enables
  // collateral on first supply; Navi / Suilend share the account / obligation).
  // So each market gets ONE role (loops OR plain deposits) and ONE entry.
  const venueKeys = new Map<string, number>();
  for (const [i, l] of (c.lending ?? []).entries()) {
    const key = [l.type, l.chain, l.market ?? "", l.addresses ? JSON.stringify(Object.entries(l.addresses).sort()) : "", l.protocol ?? ""].join("|").toLowerCase();
    const prev = venueKeys.get(key);
    if (prev !== undefined) e.push(`lending ${l.type}@${l.chain}${l.market ? ` ${l.market}` : ""}: listed twice (entries ${prev + 1} and ${i + 1}); merge them into one entry`);
    else venueKeys.set(key, i);
    if ((l.pairs ?? []).length && (l.supply ?? []).length)
      e.push(
        `lending ${l.type}@${l.chain}${l.market ? ` ${l.market}` : ""}: has both loop pairs and plain deposits — one wallet has one account per market, so a deposit would back the loop's debt; use one role per market (or a separate wallet)`
      );
  }
  const vaultChains = new Set<string>();
  for (const v of c.vaults ?? []) {
    if (vaultChains.has(v.chain)) e.push(`vaults@${v.chain}: listed twice; put all vaults of a chain in one entry`);
    vaultChains.add(v.chain);
  }
  for (const l of c.lending ?? []) {
    if (!c.chains?.[l.chain]) e.push(`lending ${l.type}: chain ${l.chain} has no entry in chains`);
    if (!(l.pairs ?? []).length && !(l.supply ?? []).length) e.push(`lending ${l.type}@${l.chain}: needs pairs or supply`);
    for (const sp of l.supply ?? []) {
      if (!c.assets?.[l.chain]?.[sp.asset]) e.push(`lending ${l.type}@${l.chain} supply: asset ${sp.asset} not in assets.${l.chain}`);
      if (!allowNonStable && !STABLE_SYMBOLS.has(sp.asset)) e.push(`lending ${l.type}@${l.chain} supply: ${sp.asset} is not a stablecoin (set allow_non_stable: true to override)`);
    }
    for (const p of l.pairs ?? []) {
      for (const sym of [p.collateral, p.debt]) {
        if (!c.assets?.[l.chain]?.[sym]) e.push(`lending ${l.type}@${l.chain} pair ${p.pairId}: asset ${sym} not in assets.${l.chain}`);
        if (!allowNonStable && !STABLE_SYMBOLS.has(sym))
          e.push(`lending ${l.type}@${l.chain} pair ${p.pairId}: ${sym} is not a stablecoin (scope is stablecoin loops; set allow_non_stable: true to override)`);
      }
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
  for (const l of cfg.lending ?? []) l.pairs ??= []; // a supply-only entry may omit pairs
  cfg.limits = { ...(LIVE_DEFAULTS.limits as LiveConfig["limits"]), ...(expanded.limits ?? {}) };
  cfg.canary = { ...(LIVE_DEFAULTS.canary as LiveConfig["canary"]), ...(expanded.canary ?? {}) };
  const errors = validateLiveConfig(cfg);
  if (errors.length) throw new Error("invalid live config:\n  - " + errors.join("\n  - "));
  return { raw, cfg, missingEnv: [...missing] };
}
