import type { RouterConfig } from "../config.js";
import type { Opportunity } from "../types.js";

export interface SourceContext {
  cfg: RouterConfig;
  nowMs: number;
  /** oppId -> my equity currently in it (from the router's positions). */
  myEquityByOpp: Record<string, number>;
}

/**
 * A source turns one protocol / scanner into Opportunities. It must:
 *  - report APRs on EQUITY (apply leverage itself),
 *  - give a dilution-aware `aprAt(myEquity)` per stream,
 *  - fill `liquidity` with its notion of exit capacity and footprint,
 *  - put protocol level risk into `signals` / `flags`.
 * A source never decides anything.
 */
export interface Source {
  id: string;
  fetch(ctx: SourceContext): Promise<Opportunity[]>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export async function fetchJson(fetchImpl: FetchLike, url: string, timeoutMs = 15_000, headers?: Record<string, string>): Promise<unknown> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
