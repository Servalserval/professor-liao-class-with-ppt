/**
 * Pure helpers for the Cetus aggregator swap module: bps math, min-out,
 * contract slippage derivation and route validation. No SDK / RPC access here
 * so everything is unit-testable offline.
 */
import { fromUnits } from "@incentive-router/live-common";
import { normalizeStructTag, normalizeSuiAddress } from "../common.js";

export class SwapRejected extends Error {}

const PPM = 1_000_000n;

// ---------------------------------------------------------------------------
// bps / min-out
// ---------------------------------------------------------------------------

/**
 * Effective cost of a swap vs reference (oracle) prices, in bps:
 * (valueIn - valueOut) / valueIn * 1e4. Positive = we lose value (fees + price
 * impact + oracle deviation); negative = the route beats the oracle.
 */
export function costBpsVsOracle(a: {
  amountIn: bigint;
  decimalsIn: number;
  priceInUsd: number;
  amountOut: bigint;
  decimalsOut: number;
  priceOutUsd: number;
}): number {
  for (const [k, p] of [["priceInUsd", a.priceInUsd], ["priceOutUsd", a.priceOutUsd]] as const) {
    if (!Number.isFinite(p) || p <= 0) throw new SwapRejected(`costBps: invalid reference price ${k}=${p}`);
  }
  if (a.amountIn <= 0n) throw new SwapRejected(`costBps: amountIn must be > 0 (got ${a.amountIn})`);
  if (a.amountOut < 0n) throw new SwapRejected(`costBps: negative amountOut ${a.amountOut}`);
  const vin = fromUnits(a.amountIn, a.decimalsIn) * a.priceInUsd;
  const vout = fromUnits(a.amountOut, a.decimalsOut) * a.priceOutUsd;
  if (!(vin > 0)) throw new SwapRejected("costBps: input value rounds to 0 USD");
  return (1 - vout / vin) * 10_000;
}

/** bps (may be fractional, 0.01 bps resolution) -> ppm, validated to [0, 1e4). */
function bpsToPpm(bps: number): bigint {
  if (!Number.isFinite(bps) || bps < 0 || bps >= 10_000) throw new SwapRejected(`slippage bps out of range: ${bps}`);
  return BigInt(Math.round(bps * 100));
}

/** minOut = amountOut * (1 - slippageBps/1e4), rounded down. */
export function minOutForSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (amountOut < 0n) throw new SwapRejected(`minOut: negative amountOut ${amountOut}`);
  return (amountOut * (PPM - bpsToPpm(slippageBps))) / PPM;
}

/**
 * The aggregator v3 contract takes (quoteAmountOut, slippage) and derives its
 * own limit; the SDK converts `slippage` with floor(slippage * 1e6). We want
 * that limit to be >= minOut, so slippage ppm is floored here (tighter, never
 * looser). Float noise in the SDK's own floor can only make it 1 ppm tighter.
 * Returns the fraction to pass as the SDK's `slippage` argument.
 */
export function contractSlippageFor(quoteAmountOut: bigint, minOut: bigint): number {
  if (quoteAmountOut <= 0n) throw new SwapRejected(`slippage: quoteAmountOut must be > 0 (got ${quoteAmountOut})`);
  if (minOut <= 0n) throw new SwapRejected(`slippage: minOut must be > 0 (got ${minOut}); refusing an unprotected swap`);
  if (minOut > quoteAmountOut) throw new SwapRejected(`slippage: minOut ${minOut} > quoted amountOut ${quoteAmountOut}`);
  const ppm = ((quoteAmountOut - minOut) * PPM) / quoteAmountOut; // floor
  return Number(ppm) / 1e6;
}

// ---------------------------------------------------------------------------
// Route validation (RouterDataV3.paths is a flat, topologically ordered list
// of pool hops; split routes share intermediate coins)
// ---------------------------------------------------------------------------

export interface RoutePathLike {
  id: string;
  provider: string;
  from: string;
  target: string;
  publishedAt?: string;
}

export function sameCoinType(a: string, b: string): boolean {
  return normalizeStructTag(a) === normalizeStructTag(b);
}

/**
 * Longest hop chain from `fromType` through the route DAG. Throws when a path
 * consumes a coin the route never produced (disconnected / unordered route).
 */
export function routeHops(paths: RoutePathLike[], fromType: string): number {
  const depth = new Map<string, number>([[normalizeStructTag(fromType), 0]]);
  let max = 0;
  for (const p of paths) {
    const f = normalizeStructTag(p.from);
    const d0 = depth.get(f);
    if (d0 === undefined) throw new SwapRejected(`route: path ${p.id} spends ${p.from} which no earlier hop produced`);
    const d = d0 + 1;
    const t = normalizeStructTag(p.target);
    depth.set(t, Math.max(depth.get(t) ?? 0, d));
    if (d > max) max = d;
  }
  return max;
}

export interface RouteRules {
  fromType: string;
  toType: string;
  /** Exact provider names (SDK constants, e.g. "CETUS"). */
  allowedProviders: ReadonlySet<string>;
  maxHops: number;
  /** When set, every Move package the route calls must be in here (normalized addresses). */
  allowedPackages?: ReadonlySet<string>;
}

export interface RouteSummary {
  hops: number;
  pools: number;
  providers: string[];
  packages: string[];
}

/** Validate a route returned by the aggregator API against our rules. Throws SwapRejected. */
export function validateRoute(
  r: { paths: RoutePathLike[]; packages?: Map<string, string> },
  rules: RouteRules
): RouteSummary {
  const paths = r.paths;
  if (!paths.length) throw new SwapRejected("route: empty path list");
  // The SDK takes the swap's type arguments from the route itself
  // (paths[0].from / paths[last].target), so they must be exactly ours.
  if (!sameCoinType(paths[0]!.from, rules.fromType)) throw new SwapRejected(`route: starts at ${paths[0]!.from}, expected ${rules.fromType}`);
  const last = paths[paths.length - 1]!;
  if (!sameCoinType(last.target, rules.toType)) throw new SwapRejected(`route: ends at ${last.target}, expected ${rules.toType}`);
  const providers: string[] = [];
  for (const p of paths) {
    if (!rules.allowedProviders.has(p.provider)) throw new SwapRejected(`route: provider ${p.provider} not in allowlist [${[...rules.allowedProviders].join(",")}]`);
    if (!providers.includes(p.provider)) providers.push(p.provider);
  }
  const hops = routeHops(paths, rules.fromType);
  if (hops > rules.maxHops) throw new SwapRejected(`route: ${hops} hops > max ${rules.maxHops}`);
  const packages: string[] = [];
  const addPkg = (id: string | undefined, what: string) => {
    if (!id) throw new SwapRejected(`route: missing package id for ${what}`);
    const n = normalizeSuiAddress(id);
    if (rules.allowedPackages && !rules.allowedPackages.has(n)) throw new SwapRejected(`route: package ${n} (${what}) not in allowedPackages`);
    if (!packages.includes(n)) packages.push(n);
  };
  if (rules.allowedPackages) {
    addPkg(r.packages?.get("aggregator_v3"), "aggregator_v3");
    for (const p of paths) addPkg(p.publishedAt, `${p.provider} pool ${p.id}`);
  } else {
    const agg = r.packages?.get("aggregator_v3");
    if (agg) packages.push(normalizeSuiAddress(agg));
    for (const p of paths) if (p.publishedAt && !packages.includes(normalizeSuiAddress(p.publishedAt))) packages.push(normalizeSuiAddress(p.publishedAt));
  }
  return { hops, pools: paths.length, providers, packages };
}

export function describeRoute(s: RouteSummary): string {
  return `cetus-aggregator ${s.providers.join("+")} hops=${s.hops} pools=${s.pools}`;
}
