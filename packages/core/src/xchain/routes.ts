import type { RouterConfig } from "../config.js";
import type { ChainAsset, RouteSpec } from "./types.js";

/** Minutes per year: transit opportunity cost = amount x APR x minutes / this. */
export const MINUTES_PER_YEAR = 365 * 24 * 60;

/** Max hops a funding path may have (each hop adds fees, latency and trust assumptions). */
export const MAX_HOPS = 3;

/** Node / idle-bucket key: `${chain}:${asset}` (e.g. "arbitrum:USDC"). */
export function assetKey(ca: ChainAsset): string {
  return `${ca.chain}:${ca.asset}`;
}

export function parseAssetKey(key: string): ChainAsset {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) throw new Error(`invalid chain:asset key "${key}"`);
  return { chain: key.slice(0, i), asset: key.slice(i + 1) };
}

/** Cash cost of one hop: proportional fee + fixed fee + gas on both sides (USD). */
export function routeCostUsd(route: RouteSpec, amountUsd: number): number {
  return (route.feeBps * amountUsd) / 1e4 + route.feeFixedUsd + route.gasSrcUsd + route.gasDstUsd;
}

/** Cash fees of a whole path (what the money actually loses on the way). */
export function pathFeesUsd(path: RouteSpec[], amountUsd: number): number {
  return path.reduce((a, r) => a + routeCostUsd(r, amountUsd), 0);
}

export function pathEtaMinutes(path: RouteSpec[]): number {
  return path.reduce((a, r) => a + r.etaMinutes, 0);
}

/** Yield the money does not earn while it is in flight (USD). */
export function transitCostUsd(amountUsd: number, destNetApr: number, etaMinutes: number): number {
  return (amountUsd * Math.max(0, destNetApr) * etaMinutes) / MINUTES_PER_YEAR;
}

export interface PathResult {
  path: RouteSpec[];
  /** Fees + gas + transit opportunity cost (USD). */
  costUsd: number;
  /** Fees + gas only (USD). */
  feesUsd: number;
  etaMinutes: number;
}

function usable(r: RouteSpec, amountUsd: number): boolean {
  if (!r.enabled) return false;
  if (r.minUsd !== undefined && amountUsd < r.minUsd) return false;
  if (r.maxUsd !== undefined && amountUsd > r.maxUsd) return false;
  const nums = [r.feeBps, r.feeFixedUsd, r.gasSrcUsd, r.gasDstUsd, r.etaMinutes];
  return nums.every((x) => Number.isFinite(x) && x >= 0);
}

/**
 * Directed graph over `chain:asset` nodes built from `cfg.xchain.routes`.
 * Disabled routes and routes with invalid numbers are dropped; min/max size
 * limits are applied per query (they depend on the amount).
 */
export class RouteGraph {
  readonly edges = new Map<string, RouteSpec[]>();

  constructor(routes: RouteSpec[]) {
    for (const r of routes) {
      if (!r.enabled) continue;
      const k = assetKey(r.from);
      if (k === assetKey(r.to)) continue;
      const list = this.edges.get(k) ?? [];
      list.push(r);
      this.edges.set(k, list);
    }
  }

  /** Enabled routes from the config, minus `excludeIds` (e.g. routes cooling down after a failure). */
  static fromConfig(cfg: RouterConfig, excludeIds: Iterable<string> = []): RouteGraph {
    const ex = new Set(excludeIds);
    return new RouteGraph(cfg.xchain.enabled ? cfg.xchain.routes.filter((r) => !ex.has(r.id)) : []);
  }

  /**
   * Cheapest path from `from` to `to` for `amountUsd`, minimizing
   *   Σ routeCostUsd(hop) + amount x destNetApr x Σ eta / (365 x 24 x 60)
   * (money in flight earns nothing). Label-setting Dijkstra over
   * (node, hops-used) states, so the 3-hop limit is exact rather than a
   * truncation of the unconstrained shortest path. Same node -> empty path.
   */
  findPath(from: ChainAsset, to: ChainAsset, amountUsd: number, destNetApr: number, maxHops = MAX_HOPS): PathResult | null {
    const src = assetKey(from);
    const dst = assetKey(to);
    if (src === dst) return { path: [], costUsd: 0, feesUsd: 0, etaMinutes: 0 };
    const w = (r: RouteSpec) => routeCostUsd(r, amountUsd) + transitCostUsd(amountUsd, destNetApr, r.etaMinutes);

    interface Label {
      node: string;
      hops: number;
      cost: number;
      path: RouteSpec[];
    }
    const best = new Map<string, number>(); // `${node}|${hops}` -> cost
    const open: Label[] = [{ node: src, hops: 0, cost: 0, path: [] }];
    const done = new Set<string>();
    while (open.length) {
      // tiny graphs: linear scan beats a heap
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i]!.cost < open[bi]!.cost) bi = i;
      const cur = open.splice(bi, 1)[0]!;
      const sk = `${cur.node}|${cur.hops}`;
      if (done.has(sk)) continue;
      done.add(sk);
      if (cur.node === dst) {
        return {
          path: cur.path,
          costUsd: cur.cost,
          feesUsd: pathFeesUsd(cur.path, amountUsd),
          etaMinutes: pathEtaMinutes(cur.path),
        };
      }
      if (cur.hops >= maxHops) continue;
      for (const r of this.edges.get(cur.node) ?? []) {
        if (!usable(r, amountUsd)) continue;
        const nk = assetKey(r.to);
        if (nk === src || cur.path.some((h) => assetKey(h.from) === nk)) continue; // no cycles
        const cost = cur.cost + w(r);
        const key = `${nk}|${cur.hops + 1}`;
        if ((best.get(key) ?? Infinity) <= cost) continue;
        best.set(key, cost);
        open.push({ node: nk, hops: cur.hops + 1, cost, path: [...cur.path, r] });
      }
    }
    return null;
  }
}
