import type { Opportunity } from "../types.js";
import { constantStream, proRataStream } from "../valuation.js";
import { loopOpportunity, type LoopMarket } from "./loopLending.js";
import { fetchJson, type FetchLike, type Source, type SourceContext } from "./types.js";

/**
 * DefiLlama yields scanner (https://yields.llama.fi/pools).
 *
 * Pool fields per the DefiLlama yield-server adaptor spec: pool, chain,
 * project, symbol, tvlUsd, apyBase, apyReward (both APY in %), rewardTokens,
 * underlyingTokens, poolMeta, and for lending markets apyBaseBorrow,
 * apyRewardBorrow, totalSupplyUsd, totalBorrowUsd, ltv (0..1).
 * For lending pools tvlUsd = totalSupplyUsd - totalBorrowUsd (= available
 * liquidity, exactly what the 1/10 rule needs).
 *
 * The public API appears to serve the borrow-side fields from a separate
 * endpoint (/lendBorrow, keyed by `pool`) rather than inside /pools; the
 * source fetches both and joins them (a /lendBorrow failure just means no
 * loop candidates). Verify with `verify-sources` before trusting it.
 * All APYs are converted to APR (daily compounding) because every rule in
 * the router works in APR.
 *
 * Two kinds of candidates come out of it:
 *  - lending pools with borrow data -> a same-asset loop candidate, priced at
 *    the configured target LTV (no IRM available here, so the borrow APR is
 *    ramped by rate_uncertainty_mult as size grows),
 *  - any pool with apyReward > 0 -> a plain deposit candidate.
 * All discovery-only. Note: rewardTokens are ADDRESSES; we name the reward
 * `${project}:reward` unless you map them in `rewardSymbols`.
 */
export interface DefiLlamaOptions {
  chains?: string[];
  projects?: string[];
  minTvlUsd?: number;
  rewardSymbols?: Record<string, string>;
  baseUrl?: string;
  lendBorrowUrl?: string;
}

type J = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);

/** APY in percent -> APR as a yearly fraction, assuming daily compounding. */
export function apyPctToApr(pct: number | undefined): number {
  if (pct === undefined) return 0;
  const apy = pct / 100;
  if (apy <= -1) return apy;
  return 365 * (Math.pow(1 + apy, 1 / 365) - 1);
}

const LEND_BORROW_FIELDS = ["apyBaseBorrow", "apyRewardBorrow", "totalSupplyUsd", "totalBorrowUsd", "ltv", "borrowable"];

/** Merge /lendBorrow rows into /pools rows by `pool` id (borrow fields only). */
export function joinLendBorrow(pools: J[], lendBorrow: unknown): J[] {
  const rows = Array.isArray(lendBorrow) ? lendBorrow : Array.isArray((lendBorrow as J)?.data) ? ((lendBorrow as J).data as unknown[]) : [];
  const byPool = new Map<string, J>();
  for (const r of rows) if (r && typeof r === "object" && str((r as J).pool)) byPool.set(str((r as J).pool)!, r as J);
  return pools.map((p) => {
    const lb = byPool.get(str(p.pool) ?? "");
    if (!lb) return p;
    const extra: J = {};
    for (const k of LEND_BORROW_FIELDS) if (lb[k] !== undefined && lb[k] !== null) extra[k] = lb[k];
    return { ...p, ...extra };
  });
}

export function llamaPoolToOpportunities(p: J, ctx: SourceContext, sourceId: string, opts: DefiLlamaOptions = {}): Opportunity[] {
  const out: Opportunity[] = [];
  const chain = str(p.chain)?.toLowerCase() ?? "unknown";
  const project = str(p.project) ?? "unknown";
  const symbol = str(p.symbol) ?? "?";
  const poolId = str(p.pool) ?? `${project}-${symbol}`;
  const tvl = num(p.tvlUsd) ?? 0;
  if (opts.chains?.length && !opts.chains.map((c) => c.toLowerCase()).includes(chain)) return out;
  if (opts.projects?.length && !opts.projects.includes(project)) return out;
  if (tvl < (opts.minTvlUsd ?? ctx.cfg.sources.discovery.min_tvl_usd)) return out;

  const apyBase = apyPctToApr(num(p.apyBase));
  const apyReward = apyPctToApr(num(p.apyReward));
  const rewardAddrs = Array.isArray(p.rewardTokens) ? (p.rewardTokens as unknown[]).map(str).filter((x): x is string => !!x) : [];
  const rewardToken = rewardAddrs.length ? opts.rewardSymbols?.[rewardAddrs[0]!.toLowerCase()] ?? `${project}:reward` : `${project}:reward`;

  const totalSupply = num(p.totalSupplyUsd);
  const totalBorrow = num(p.totalBorrowUsd);
  const borrowBase = num(p.apyBaseBorrow);
  const ltv = num(p.ltv);
  if (totalSupply !== undefined && totalBorrow !== undefined && borrowBase !== undefined && ltv !== undefined && ltv > 0 && !symbol.includes("-")) {
    const m: LoopMarket = {
      protocol: project,
      chain,
      symbol,
      totalSupplyUsd: totalSupply,
      totalBorrowUsd: totalBorrow,
      supplyAprBase: apyBase,
      borrowAprBase: apyPctToApr(borrowBase),
      supplyRewards: apyReward > 0 ? [{ token: rewardToken, apr: apyReward }] : [],
      borrowRewards: (num(p.apyRewardBorrow) ?? 0) > 0 ? [{ token: rewardToken, apr: apyPctToApr(num(p.apyRewardBorrow)) }] : [],
      openLtv: ltv,
      closeLtv: Math.min(0.99, ltv + 0.05),
    };
    const loop = loopOpportunity(m, ctx, `${sourceId}:loop`);
    if (loop) {
      loop.id = `${sourceId}:loop:${poolId}`;
      loop.sourceId = sourceId;
      loop.discoveryOnly = true;
      loop.meta = { ...loop.meta, poolMeta: str(p.poolMeta), note: "no IRM / caps / pause state from DefiLlama" };
      out.push(loop);
    }
  }

  if (apyReward > 0) {
    const id = `${sourceId}:deposit:${poolId}`;
    const capacity = totalSupply !== undefined && totalBorrow !== undefined ? totalSupply - totalBorrow : tvl * ctx.cfg.sources.discovery.assumed_withdrawable_frac;
    out.push({
      id,
      sourceId,
      kind: "deposit",
      name: `${project} ${symbol}${str(p.poolMeta) ? ` (${str(p.poolMeta)})` : ""}`,
      primaryVenue: project,
      chain,
      legs: [{ venue: project, chain, token: symbol, equityFrac: 1 }],
      streams: [
        constantStream("base", "base", apyBase),
        proRataStream({
          label: `reward:${rewardToken}`,
          kind: "reward",
          aprNow: apyReward,
          poolUsd: totalSupply ?? tvl,
          grossPerEquity: 1,
          myEquityNowUsd: ctx.myEquityByOpp[id] ?? 0,
          aprMultiplier: 1,
          rewardToken,
        }),
      ],
      costs: { entryFrac: 0.0005, exitFrac: 0.0005, fixedEntryUsd: 0, fixedExitUsd: 0, ongoingApr: 0 },
      liquidity: { exitCapacityUsd: capacity, footprintPerEquity: 1, estimated: totalSupply === undefined },
      signals: [],
      flags: [],
      metrics: { tvl_usd: tvl },
      discoveryOnly: true,
      myEquityUsd: ctx.myEquityByOpp[id] ?? 0,
      observedAtMs: ctx.nowMs,
      meta: { pool: poolId, ilRisk: p.ilRisk, exposure: p.exposure },
    });
  }
  return out;
}

export class DefiLlamaSource implements Source {
  readonly id: string;
  constructor(
    private readonly opts: DefiLlamaOptions = {},
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    id = "defillama"
  ) {
    this.id = id;
  }
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const [body, lb] = await Promise.all([
      fetchJson(this.fetchImpl, this.opts.baseUrl ?? "https://yields.llama.fi/pools", 30_000),
      fetchJson(this.fetchImpl, this.opts.lendBorrowUrl ?? "https://yields.llama.fi/lendBorrow", 30_000).catch(() => []),
    ]);
    const data = (body as J)?.data;
    if (!Array.isArray(data)) throw new Error("defillama: response has no data[]");
    const pools = joinLendBorrow(data.filter((p): p is J => !!p && typeof p === "object"), lb);
    return pools.flatMap((p) => llamaPoolToOpportunities(p, ctx, this.id, this.opts));
  }
}
