import type { Opportunity } from "../types.js";
import { proRataStream } from "../valuation.js";
import { fetchJson, type FetchLike, type Source, type SourceContext } from "./types.js";

/**
 * Merkl discovery scanner (https://api.merkl.xyz/v4/opportunities).
 *
 * Field names used, from Merkl's developer docs / public integrations:
 *   apr (already in %), tvl (USD), dailyRewards (USD/day), status (LIVE/PAST/SOON),
 *   identifier, chainId, type, name, latestCampaignEnd,
 *   chain.name, protocol.id / mainProtocolId, tokens[].symbol,
 *   rewardsRecord.breakdowns[].token.symbol
 * The full schema is not published as a static page, so every field is read
 * defensively and `checkMerklShape` reports what is missing. Run
 * `tsx src/cli.ts verify-sources` on a box with internet before trusting it.
 *
 * Merkl opportunities are DISCOVERY ONLY: they tell you where incentive budget
 * is being spent; you still need an executor (adapter) before the router may
 * allocate to one.
 */
export interface MerklOptions {
  chainIds?: number[];
  minTvlUsd?: number;
  apiKey?: string;
  baseUrl?: string;
  /** Optional mapping chainId -> name used in caps/gas config. */
  chainNames?: Record<number, string>;
}

type J = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
const obj = (v: unknown): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : undefined);

/** Timestamps may come as seconds or ms. */
export function toMs(v: unknown): number | null {
  const n = num(v);
  if (n === undefined || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function checkMerklShape(items: unknown): string[] {
  const issues: string[] = [];
  if (!Array.isArray(items)) return ["response is not an array"];
  const first = obj(items[0]);
  if (!first) return items.length ? ["first item is not an object"] : [];
  for (const k of ["apr", "tvl", "dailyRewards", "status", "chainId", "name"]) if (!(k in first)) issues.push(`missing field ${k}`);
  if (!("latestCampaignEnd" in first)) issues.push("missing latestCampaignEnd (campaign end unknown -> no ending protection)");
  return issues;
}

export function merklToOpportunity(item: unknown, ctx: SourceContext, sourceId: string, opts: MerklOptions = {}): Opportunity | null {
  const o = obj(item);
  if (!o) return null;
  const status = str(o.status);
  if (status && status !== "LIVE") return null;
  const tvl = num(o.tvl) ?? 0;
  const aprPct = num(o.apr) ?? 0;
  const daily = num(o.dailyRewards);
  if (tvl <= 0 || (opts.minTvlUsd !== undefined && tvl < opts.minTvlUsd)) return null;
  const chainId = num(o.chainId);
  const chain = str(obj(o.chain)?.name)?.toLowerCase() ?? (chainId !== undefined ? opts.chainNames?.[chainId] ?? String(chainId) : "unknown");
  const venue = str(obj(o.protocol)?.id) ?? str(o.mainProtocolId) ?? "unknown";
  const tokens = Array.isArray(o.tokens) ? (o.tokens as unknown[]).map((t) => str(obj(t)?.symbol)).filter((x): x is string => !!x) : [];
  const breakdowns = obj(o.rewardsRecord)?.breakdowns;
  const rewardToken =
    (Array.isArray(breakdowns) ? str(obj(obj(breakdowns[0])?.token)?.symbol) : undefined) ?? "MERKL_REWARD";
  const ident = str(o.identifier) ?? str(o.id) ?? str(o.name) ?? "?";
  const id = `${sourceId}:${chain}:${ident}`;
  // Prefer dailyRewards/tvl (what the APR is made of); fall back to the quoted apr.
  const aprNow = daily !== undefined ? (daily * 365) / tvl : aprPct / 100;

  return {
    id,
    sourceId,
    kind: "deposit",
    name: str(o.name) ?? ident,
    primaryVenue: venue,
    chain,
    legs: [{ venue, chain, token: tokens.join("-") || "?", equityFrac: 1 }],
    streams: [
      proRataStream({
        label: `merkl:${rewardToken}`,
        kind: "reward",
        aprNow,
        poolUsd: tvl,
        grossPerEquity: 1,
        myEquityNowUsd: ctx.myEquityByOpp[id] ?? 0,
        aprMultiplier: 1,
        rewardToken,
        endsAtMs: toMs(o.latestCampaignEnd),
      }),
    ],
    costs: { entryFrac: 0.0005, exitFrac: 0.0005, fixedEntryUsd: 0, fixedExitUsd: 0, ongoingApr: 0 },
    liquidity: {
      exitCapacityUsd: tvl * ctx.cfg.sources.discovery.assumed_withdrawable_frac,
      footprintPerEquity: 1,
      estimated: true,
    },
    signals: [],
    flags: [],
    metrics: { tvl_usd: tvl, daily_rewards_usd: daily ?? 0 },
    discoveryOnly: true,
    myEquityUsd: ctx.myEquityByOpp[id] ?? 0,
    observedAtMs: ctx.nowMs,
    meta: { type: str(o.type), depositUrl: str(o.depositUrl), aprQuotedPct: aprPct, note: "base APR unknown (0)" },
  };
}

export class MerklSource implements Source {
  readonly id: string;
  constructor(
    private readonly opts: MerklOptions = {},
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    id = "merkl"
  ) {
    this.id = id;
  }
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const base = this.opts.baseUrl ?? "https://api.merkl.xyz/v4";
    const headers = this.opts.apiKey ? { "X-API-Key": this.opts.apiKey } : undefined;
    const urls = (this.opts.chainIds?.length ? this.opts.chainIds : [undefined]).map(
      (c) => `${base}/opportunities?status=LIVE&items=100${c !== undefined ? `&chainId=${c}` : ""}`
    );
    const out: Opportunity[] = [];
    for (const u of urls) {
      const items = await fetchJson(this.fetchImpl, u, 15_000, headers);
      if (!Array.isArray(items)) throw new Error(`merkl: unexpected response shape from ${u}`);
      for (const it of items) {
        const op = merklToOpportunity(it, ctx, this.id, this.opts);
        if (op) out.push(op);
      }
    }
    return out;
  }
}
