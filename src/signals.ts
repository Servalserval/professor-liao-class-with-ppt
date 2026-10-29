import type { RouterConfig } from "./config.js";
import type { Flag, Opportunity } from "./types.js";

/**
 * History-derived signals. Level signals (utilization > 95%) come from the
 * source; anything that needs a time series (a jump, a drain, an emission cut,
 * a reward-token crash) is computed here from snapshots, the same way
 * loop-farm compared borrow APR with the previous cycle.
 */

export interface OppSnapshot {
  t: number;
  capacityUsd: number;
  /** Reward APR of the pool ignoring my own dilution (= emission / others' TVL). */
  rewardAprExMe: number;
  metrics: Record<string, number>;
}

export interface History {
  opps: Record<string, OppSnapshot[]>;
  tokenPrices: Record<string, { t: number; p: number }[]>;
  equity: { t: number; usd: number }[];
}

export function newHistory(): History {
  return { opps: {}, tokenPrices: {}, equity: [] };
}

const HOUR = 3600_000;

function rewardAprExMe(opp: Opportunity): number {
  return opp.streams.filter((s) => s.kind === "reward").reduce((a, s) => a + s.aprAt(0), 0);
}

function trim<T extends { t: number }>(arr: T[], now: number, keepMs: number): T[] {
  const cutoff = now - keepMs;
  let i = 0;
  while (i < arr.length && arr[i]!.t < cutoff) i++;
  return i > 0 ? arr.slice(i) : arr;
}

export function historyKeepMs(cfg: RouterConfig): number {
  return Math.max(
    cfg.liquidity.capacity_drop_window_minutes * 60_000,
    cfg.rewards.emission_drop_window_hours * HOUR,
    cfg.portfolio.kill_window_hours * HOUR,
    24 * HOUR
  ) + HOUR;
}

/**
 * Flags derived by comparing the CURRENT observation with history (history
 * must not yet contain the current observation).
 */
export function derivedFlags(opp: Opportunity, hist: History, cfg: RouterConfig, now: number): Flag[] {
  const flags: Flag[] = [];
  const snaps = hist.opps[opp.id] ?? [];

  // 1) liquidity drain: capacity down X% vs the max within the window
  const win = cfg.liquidity.capacity_drop_window_minutes * 60_000;
  const recent = snaps.filter((s) => s.t >= now - win);
  if (recent.length) {
    const peak = Math.max(...recent.map((s) => s.capacityUsd));
    if (peak > 0) {
      const drop = 1 - opp.liquidity.exitCapacityUsd / peak;
      if (drop >= cfg.liquidity.capacity_drop_exit_frac)
        flags.push({
          name: "capacity_drop",
          severity: "exit",
          detail: `exit capacity -${(drop * 100).toFixed(0)}% within ${cfg.liquidity.capacity_drop_window_minutes}m`,
        });
    }
  }

  // 2) spikes on tracked metrics vs previous cycle (loop-farm: borrow APR +10pp)
  const prev = snaps[snaps.length - 1];
  if (prev) {
    for (const [metric, absUp] of Object.entries(cfg.spike_rules)) {
      const cur = opp.metrics[metric];
      const old = prev.metrics[metric];
      if (cur === undefined || old === undefined) continue;
      if (cur - old >= absUp)
        flags.push({ name: `spike:${metric}`, severity: "exit", detail: `${metric} ${old.toFixed(4)} -> ${cur.toFixed(4)}` });
    }
  }

  // 3) emission cut: pool reward APR (ex-me) down X% within the window
  const ewin = cfg.rewards.emission_drop_window_hours * HOUR;
  const eRecent = snaps.filter((s) => s.t >= now - ewin);
  if (eRecent.length) {
    const peak = Math.max(...eRecent.map((s) => s.rewardAprExMe));
    const cur = rewardAprExMe(opp);
    if (peak > 0 && 1 - cur / peak >= cfg.rewards.emission_drop_frac)
      flags.push({
        name: "emission_drop",
        severity: "warn",
        detail: `reward APR ${(peak * 100).toFixed(2)}% -> ${(cur * 100).toFixed(2)}%`,
      });
  }
  return flags;
}

export function recordOpp(hist: History, opp: Opportunity, now: number, keepMs: number) {
  const arr = hist.opps[opp.id] ?? [];
  arr.push({
    t: now,
    capacityUsd: opp.liquidity.exitCapacityUsd,
    rewardAprExMe: rewardAprExMe(opp),
    metrics: { ...opp.metrics },
  });
  hist.opps[opp.id] = trim(arr, now, keepMs);
}

export function recordTokenPrice(hist: History, token: string, price: number, now: number, keepMs: number) {
  const arr = hist.tokenPrices[token] ?? [];
  arr.push({ t: now, p: price });
  hist.tokenPrices[token] = trim(arr, now, keepMs);
}

/** Drop of a token's price from its 24h high, as a fraction (0.3 = -30%). */
export function tokenDrawdown24h(hist: History, token: string, now: number): number {
  const arr = (hist.tokenPrices[token] ?? []).filter((x) => x.t >= now - 24 * HOUR);
  if (arr.length < 2) return 0;
  const peak = Math.max(...arr.map((x) => x.p));
  const cur = arr[arr.length - 1]!.p;
  return peak > 0 ? Math.max(0, 1 - cur / peak) : 0;
}

export function recordEquity(hist: History, usd: number, now: number, keepMs: number) {
  hist.equity.push({ t: now, usd });
  hist.equity = trim(hist.equity, now, keepMs);
}

/** Portfolio drawdown from the peak within the kill window. */
export function equityDrawdown(hist: History, cfg: RouterConfig, now: number): number {
  const arr = hist.equity.filter((x) => x.t >= now - cfg.portfolio.kill_window_hours * HOUR);
  if (arr.length < 2) return 0;
  const peak = Math.max(...arr.map((x) => x.usd));
  const cur = arr[arr.length - 1]!.usd;
  return peak > 0 ? Math.max(0, 1 - cur / peak) : 0;
}
