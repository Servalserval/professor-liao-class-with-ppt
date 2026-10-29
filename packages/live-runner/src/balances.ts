/**
 * Wallet balances as the router's idle buckets (`${chain}:${symbol}` -> USD).
 *
 * A failed read must never look like lost (or found) money — the kill switch
 * watches total equity. A bucket whose read fails is OMITTED from the result;
 * the router keeps its own last value for omitted keys (partial map). Using a
 * stale cached value instead would overwrite the router's up-to-date books
 * (e.g. right after an entry spent from that bucket) and fake a peak.
 * If every read fails the call throws and the router keeps its state.
 */
import { type AssetRef, type Logger, unitsToUsd } from "@incentive-router/live-common";

export const bucketKey = (a: Pick<AssetRef, "chain" | "symbol">) => `${a.chain}:${a.symbol}`;

export interface BucketReaderDeps {
  assets: AssetRef[];
  balance: (a: AssetRef) => Promise<bigint>;
  priceUsd: (a: AssetRef) => Promise<number>;
  log: Logger;
  /** @deprecated kept for config compatibility; failed buckets are omitted, never substituted. */
  maxStaleMs?: number;
  now?: () => number;
}

export class BucketReader {
  private readonly assets: AssetRef[];

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
  }

  keys(): string[] {
    return this.assets.map(bucketKey);
  }

  async read(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const failed: string[] = [];
    const results = await Promise.allSettled(
      this.assets.map(async (a) => unitsToUsd(await this.d.balance(a), await this.d.priceUsd(a), a.decimals))
    );
    results.forEach((r, i) => {
      const k = bucketKey(this.assets[i]!);
      if (r.status === "fulfilled" && Number.isFinite(r.value)) out[k] = r.value;
      else failed.push(`${k} (${r.status === "rejected" ? (r.reason as Error).message.split("\n")[0] : "non-finite"})`);
    });
    if (failed.length) {
      if (!Object.keys(out).length) throw new Error(`every wallet balance read failed: ${failed.slice(0, 3).join("; ")}`);
      this.d.log("warn", `balance read failed for ${failed.length} bucket(s); the router keeps its last values: ${failed.slice(0, 3).join("; ")}`);
    }
    return out;
  }
}
