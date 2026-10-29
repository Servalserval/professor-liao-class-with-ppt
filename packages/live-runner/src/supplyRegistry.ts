/**
 * SupplyAdapters -> core SupplySources, with market-price override and
 * opportunity-id bindings for the SupplyExecutor (the supply-side twin of
 * PairRegistry). Source id = `${adapter.id}#supply`, so a lending adapter
 * that serves both loops and plain deposits gets two sources and two
 * executors without id clashes.
 */
import { SupplySource, type SupplyMarket } from "@incentive-router/core";
import type { AssetRef, Logger, SupplyAdapter } from "@incentive-router/live-common";
import type { SupplyBinding } from "./supplyExecutor.js";

export interface SupplyWiring {
  /** Expected SupplyMarket.marketId; when absent the market is matched by asset symbol (must be unique). */
  marketId?: string;
  asset: AssetRef;
}

export const supplySourceId = (adapterId: string) => `${adapterId}#supply`;

export class SupplyRegistry {
  private readonly bindings = new Map<string, SupplyBinding>();
  private readonly wired: { sourceId: string; adapter: SupplyAdapter; w: SupplyWiring }[] = [];
  readonly adapters: SupplyAdapter[] = [];

  constructor(private readonly d: { marketPrice: (a: AssetRef) => Promise<number>; log: Logger }) {}

  private match(m: SupplyMarket, wiring: SupplyWiring[]): SupplyWiring | undefined {
    const exact = wiring.find((w) => w.marketId !== undefined && w.marketId.toLowerCase() === m.marketId.toLowerCase());
    if (exact) return exact;
    const bySym = wiring.filter((w) => w.marketId === undefined && w.asset.symbol === m.asset.symbol);
    return bySym.length === 1 ? bySym[0] : undefined;
  }

  source(adapter: SupplyAdapter, wiring: SupplyWiring[]): SupplySource {
    const sourceId = supplySourceId(adapter.id);
    this.adapters.push(adapter);
    for (const w of wiring) this.wired.push({ sourceId, adapter, w });
    return new SupplySource(sourceId, async () => {
      const markets = await adapter.supplyMarkets();
      const out: SupplyMarket[] = [];
      for (const m of markets) {
        const w = this.match(m, wiring);
        if (!w) {
          this.d.log("warn", `adapter ${adapter.id} returned unconfigured supply market ${m.marketId}; ignored`);
          continue;
        }
        let priceUsd = m.asset.priceUsd;
        try {
          const p = await this.d.marketPrice(w.asset);
          if (Number.isFinite(p) && p > 0) priceUsd = p;
        } catch (e) {
          this.d.log("warn", `${sourceId} ${m.marketId}: no market price for ${w.asset.chain}:${w.asset.symbol} (${(e as Error).message}); using protocol price`);
        }
        out.push({ ...m, asset: { ...m.asset, priceUsd } });
        this.bindings.set(`${sourceId}:${m.protocol}:${m.marketId}`, { adapter, marketId: m.marketId, asset: w.asset });
      }
      return out;
    });
  }

  /** Binding for an opportunity id; falls back to the configuration before the first read. */
  bind(oppId: string): SupplyBinding | undefined {
    const hit = this.bindings.get(oppId);
    if (hit) return hit;
    const lid = oppId.toLowerCase();
    const m = this.wired.filter(({ sourceId, w }) => oppId.startsWith(`${sourceId}:`) && w.marketId !== undefined && lid.endsWith(`:${w.marketId.toLowerCase()}`));
    if (m.length !== 1) return undefined;
    const { adapter, w } = m[0]!;
    return { adapter, marketId: w.marketId!, asset: w.asset };
  }
}
