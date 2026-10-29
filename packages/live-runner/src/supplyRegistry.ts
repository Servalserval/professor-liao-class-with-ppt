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

  /**
   * Market ids of an adapter as the adapter names them (learned on the first
   * read; before that, only explicitly configured ids). Adapters derive
   * default ids differently (Navi `main:USDC`, Aave V4 `<spoke>:<reserve>`),
   * so callers must not guess them from the asset symbol.
   */
  marketIds(adapter: SupplyAdapter): string[] {
    const seen = new Set<string>();
    for (const b of this.bindings.values()) if (b.adapter === adapter) seen.add(b.marketId);
    if (seen.size) return [...seen];
    return this.wired.filter((x) => x.adapter === adapter && x.w.marketId !== undefined).map((x) => x.w.marketId!);
  }

  /** Binding for an opportunity id; falls back to the configuration before the first read. */
  bind(oppId: string): SupplyBinding | undefined {
    const hit = this.bindings.get(oppId);
    if (hit) return hit;
    // Before the first successful market read (e.g. right after a restart while
    // a reward API is down) held deposits must still be markable and exitable.
    // oppId = `${sourceId}:${protocol}:${marketId}`; protocol ids have no ':'.
    const lid = oppId.toLowerCase();
    const mine = this.wired.filter(({ sourceId }) => oppId.startsWith(`${sourceId}:`));
    if (!mine.length) return undefined;
    const exact = mine.filter(({ w }) => w.marketId !== undefined && lid.endsWith(`:${w.marketId.toLowerCase()}`));
    if (exact.length === 1) return { adapter: exact[0]!.adapter, marketId: exact[0]!.w.marketId!, asset: exact[0]!.w.asset };
    const rest = oppId.slice(mine[0]!.sourceId.length + 1);
    const cut = rest.indexOf(":");
    const marketId = cut >= 0 ? rest.slice(cut + 1) : "";
    if (!marketId) return undefined;
    const unnamed = mine.filter(({ w }) => w.marketId === undefined);
    // the adapter's default id contains the symbol (Aave: "USDC", Navi: "main:USDC", V4: "<spoke>:USDC")
    const bySym = unnamed.filter(({ w }) => marketId.toLowerCase().split(":").includes(w.asset.symbol.toLowerCase()));
    const pick = bySym.length === 1 ? bySym[0] : unnamed.length === 1 && mine.length === 1 ? unnamed[0] : undefined;
    return pick ? { adapter: pick.adapter, marketId, asset: pick.w.asset } : undefined;
  }
}
