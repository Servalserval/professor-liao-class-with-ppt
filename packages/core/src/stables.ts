import type { RouterConfig, StableConfig } from "./config.js";
import type { Tier } from "./types.js";

/**
 * Stablecoin depeg-risk model (shared by supply deposits and loops).
 *
 *  tier      from `stables[SYMBOL].tier`, else sources.supply.unknown_stable_tier
 *  lossApr   expected yearly depeg loss: stables[SYMBOL].expected_loss_apr,
 *            else tiers_default_loss[tier]. Charged as an ongoing cost:
 *            deposit 1x, same-asset loop 1x, two-asset loop L x (collateral).
 *  depeg     |price - 1| levels: per-stable override, else the lending_loop levels.
 */
export interface StableRisk {
  symbol: string;
  /** false = not in the `stables` table (unknown_stable_tier applies). */
  known: boolean;
  tier: Tier;
  lossApr: number;
  depegWarn: number;
  depegExit: number;
  maxFrac?: number;
}

/** Exact symbol first, then case-insensitive (USDe vs USDE). */
export function stableConfig(cfg: RouterConfig, symbol: string): StableConfig | undefined {
  const t = cfg.stables ?? {};
  if (t[symbol]) return t[symbol];
  const lower = symbol.toLowerCase();
  for (const [k, v] of Object.entries(t)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function stableRisk(cfg: RouterConfig, symbol: string): StableRisk {
  const sc = stableConfig(cfg, symbol);
  const tier: Tier = sc?.tier ?? cfg.sources.supply.unknown_stable_tier;
  const ll = cfg.sources.lending_loop;
  return {
    symbol,
    known: !!sc,
    tier,
    lossApr: sc?.expected_loss_apr ?? cfg.tiers_default_loss[tier] ?? 0,
    depegWarn: sc?.depeg_warn ?? ll.depeg_warn,
    depegExit: sc?.depeg_exit ?? ll.depeg_exit,
    ...(sc?.max_frac !== undefined ? { maxFrac: sc.max_frac } : {}),
  };
}

/** Depeg levels for a position exposed to several stables: the strictest of them. */
export function depegLevels(cfg: RouterConfig, symbols: string[]): { warn: number; exit: number } {
  const rs = symbols.map((s) => stableRisk(cfg, s));
  return { warn: Math.min(...rs.map((r) => r.depegWarn)), exit: Math.min(...rs.map((r) => r.depegExit)) };
}

/** Peg target in USD for the depeg signal; null for non-USD stables (EUR*, ...), which get no |p-1| signal. */
export function usdPeg(symbol: string): number | null {
  return /eur|chf|gbp|jpy|xau|gold/i.test(symbol) ? null : 1;
}
