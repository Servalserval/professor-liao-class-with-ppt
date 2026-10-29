/**
 * USD prices for valuation, swap-cost measurement and USD<->unit conversion.
 *
 * Primary source: DefiLlama coins API (one batched call per cycle, covers EVM
 * tokens by `chain:address` and Sui coins by `sui:<coinType>`). Stablecoin
 * prices are NOT assumed to be 1: a depeg must show up in the numbers.
 * Static overrides (config) win, for tokens the API does not know.
 * Native gas tokens are looked up by coingecko id.
 *
 * Prices older than `maxAgeMs` are refused (throws), so a dead feed stops
 * new actions instead of trading on stale numbers.
 */
import type { AssetRef } from "@incentive-router/live-common";

export interface PriceFeedOptions {
  baseUrl?: string;
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  overrides?: Record<string, number>;
  /** chain -> coingecko id of the native gas token */
  nativeIds?: Record<string, string>;
  cacheMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_NATIVE: Record<string, string> = {
  ethereum: "ethereum",
  arbitrum: "ethereum",
  base: "ethereum",
  optimism: "ethereum",
  linea: "ethereum",
  unichain: "ethereum",
  bsc: "binancecoin",
  avalanche: "avalanche-2",
  polygon: "polygon-ecosystem-token",
  sonic: "sonic-3",
  plasma: "plasma",
  hyperevm: "hyperliquid",
  gnosis: "xdai",
  mantle: "mantle",
  sui: "sui",
};

/** DefiLlama chain slugs differ from ours in a few places. */
const LLAMA_CHAIN: Record<string, string> = { bsc: "bsc", hyperevm: "hyperliquid", avalanche: "avax" };

export function llamaKey(a: AssetRef): string {
  const chain = LLAMA_CHAIN[a.chain] ?? a.chain;
  return `${chain}:${a.address}`;
}

export class PriceFeed {
  private cache = new Map<string, { p: number; at: number }>();
  private readonly o: Required<Omit<PriceFeedOptions, "overrides" | "nativeIds">> & Pick<PriceFeedOptions, "overrides" | "nativeIds">;

  constructor(opts: PriceFeedOptions = {}) {
    this.o = {
      baseUrl: opts.baseUrl ?? "https://coins.llama.fi",
      fetchImpl: opts.fetchImpl ?? (fetch as unknown as NonNullable<PriceFeedOptions["fetchImpl"]>),
      overrides: opts.overrides,
      nativeIds: opts.nativeIds,
      cacheMs: opts.cacheMs ?? 30_000,
      maxAgeMs: opts.maxAgeMs ?? 10 * 60_000,
      now: opts.now ?? (() => Date.now()),
    };
  }

  /** Prefetch many keys in one call (call once per cycle). */
  async prefetch(keys: string[]): Promise<void> {
    const need = keys.filter((k) => this.o.overrides?.[k] === undefined && !this.fresh(k));
    if (!need.length) return;
    for (let i = 0; i < need.length; i += 80) {
      const batch = need.slice(i, i + 80);
      const url = `${this.o.baseUrl}/prices/current/${batch.map(encodeURIComponent).join(",")}?searchWidth=4h`;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15_000);
      try {
        const res = await this.o.fetchImpl(url, { signal: ac.signal });
        if (!res.ok) throw new Error(`price feed HTTP ${res.status}`);
        const body = (await res.json()) as { coins?: Record<string, { price?: number; timestamp?: number }> };
        for (const [k, v] of Object.entries(body.coins ?? {})) {
          if (typeof v.price !== "number" || !Number.isFinite(v.price) || v.price <= 0) continue;
          const at = typeof v.timestamp === "number" ? v.timestamp * 1000 : this.o.now();
          this.cache.set(k, { p: v.price, at });
        }
      } finally {
        clearTimeout(t);
      }
    }
  }

  private fresh(k: string): boolean {
    const c = this.cache.get(k);
    return !!c && this.o.now() - c.at < this.o.cacheMs;
  }

  async byKey(k: string): Promise<number> {
    const ov = this.o.overrides?.[k];
    if (ov !== undefined) return ov;
    if (!this.fresh(k)) await this.prefetch([k]);
    const c = this.cache.get(k);
    if (!c) throw new Error(`no price for ${k}`);
    if (this.o.now() - c.at > this.o.maxAgeMs) throw new Error(`stale price for ${k} (${Math.round((this.o.now() - c.at) / 60_000)} min old)`);
    return c.p;
  }

  priceUsd(a: AssetRef): Promise<number> {
    return this.byKey(llamaKey(a));
  }

  nativePriceUsd(chain: string): Promise<number> {
    const id = this.o.nativeIds?.[chain] ?? DEFAULT_NATIVE[chain];
    if (!id) throw new Error(`no native price id for chain ${chain}`);
    return this.byKey(`coingecko:${id}`);
  }
}
