/**
 * Wallet balances as the router's idle buckets (`${chain}:${symbol}` -> USD).
 *
 * A failed read must never look like lost money (the kill switch watches
 * total equity), so a bucket whose read fails keeps its last known value for
 * up to `maxStaleMs`; past that, or with no previous value, the whole read
 * throws and the router keeps its own last state for that cycle.
 */
import { type AssetRef, type Logger, unitsToUsd } from "@incentive-router/live-common";

export const bucketKey = (a: Pick<AssetRef, "chain" | "symbol">) => `${a.chain}:${a.symbol}`;

export interface BucketReaderDeps {
  assets: AssetRef[];
  balance: (a: AssetRef) => Promise<bigint>;
  priceUsd: (a: AssetRef) => Promise<number>;
  log: Logger;
  maxStaleMs?: number;
  now?: () => number;
}

export class BucketReader {
  private readonly last = new Map<string, { usd: number; atMs: number }>();
  private readonly assets: AssetRef[];
  private readonly now: () => number;

  constructor(private readonly d: BucketReaderDeps) {
    const seen = new Map<string, AssetRef>();
    for (const a of d.assets) {
      const k = bucketKey(a);
      const prev = seen.get(k);
      if (prev && prev.address.toLowerCase() !== a.address.toLowerCase())
        throw new Error(`asset ${k} configured with two addresses (${prev.address} vs ${a.address})`);
      seen.set(k, a);
    }
    this.assets = [...seen.values()];
    this.now = d.now ?? (() => Date.now());
  }

  keys(): string[] {
    return this.assets.map(bucketKey);
  }

  async read(): Promise<Record<string, number>> {
    const now = this.now();
    const maxStale = this.d.maxStaleMs ?? 15 * 60_000;
    const out: Record<string, number> = {};
    const results = await Promise.allSettled(
      this.assets.map(async (a) => unitsToUsd(await this.d.balance(a), await this.d.priceUsd(a), a.decimals))
    );
    results.forEach((r, i) => {
      const a = this.assets[i]!;
      const k = bucketKey(a);
      if (r.status === "fulfilled" && Number.isFinite(r.value)) {
        out[k] = r.value;
        this.last.set(k, { usd: r.value, atMs: now });
        return;
      }
      const prev = this.last.get(k);
      const why = r.status === "rejected" ? (r.reason as Error).message : "non-finite value";
      if (!prev || now - prev.atMs > maxStale) throw new Error(`balance read failed for ${k} (${why}) and no recent value`);
      this.d.log("warn", `balance read failed for ${k} (${why}); using value from ${Math.round((now - prev.atMs) / 1000)}s ago`);
      out[k] = prev.usd;
    });
    return out;
  }
}
