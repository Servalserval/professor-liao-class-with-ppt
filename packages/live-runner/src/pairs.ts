/**
 * Turns live LendingAdapters into core Sources and remembers which adapter /
 * pair / asset each opportunity id belongs to, so the LoopExecutor can route
 * the router's USD-level actions back to the right adapter.
 *
 * It also replaces each leg's priceUsd with the MARKET price from the price
 * feed (DefiLlama): protocol oracles are often pegged or capped (e.g. a
 * stable priced off another stable's feed), which would hide a real depeg
 * from the core's depeg signal. If the market price is unavailable the
 * adapter's price is kept and a warning is logged once per cycle.
 */
import { LoopPairSource, type LoopPair } from "@incentive-router/core";
import type { AssetRef, LendingAdapter, Logger } from "@incentive-router/live-common";
import type { LoopBinding } from "./loopExecutor.js";

export interface PairWiring {
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
  /**
   * Expected debt/collateral price ratio for the depeg signal. Default 1 (two
   * stablecoins: any market deviation from 1:1 is a depeg). "oracle" = use the
   * protocol's own price ratio — ONLY for yield-bearing collateral (sUSDe ...),
   * since an oracle that follows the market would otherwise hide a real depeg.
   */
  expectedPriceRatio?: number | "oracle";
}

export interface PairRegistryDeps {
  marketPrice: (a: AssetRef) => Promise<number>;
  log: Logger;
}

export function opportunityId(sourceId: string, pair: Pick<LoopPair, "protocol" | "pairId">): string {
  return `${sourceId}:${pair.protocol}:${pair.pairId}`;
}

export class PairRegistry {
  private readonly bindings = new Map<string, LoopBinding & { debt: AssetRef }>();
  private readonly wired: { adapter: LendingAdapter; w: PairWiring }[] = [];
  readonly adapters: LendingAdapter[] = [];

  constructor(private readonly d: PairRegistryDeps) {}

  /** Register an adapter and its configured pairs; returns the core Source (id = adapter.id). */
  source(adapter: LendingAdapter, wiring: PairWiring[]): LoopPairSource {
    this.adapters.push(adapter);
    for (const w of wiring) this.wired.push({ adapter, w });
    const byPair = new Map(wiring.map((w) => [w.pairId, w]));
    return new LoopPairSource(adapter.id, async () => {
      const pairs = await adapter.markets();
      const out: LoopPair[] = [];
      for (const p of pairs) {
        const w = byPair.get(p.pairId);
        if (!w) {
          this.d.log("warn", `adapter ${adapter.id} returned unconfigured pair ${p.pairId}; ignored`);
          continue;
        }
        out.push(await this.withMarketPrices(adapter.id, p, w));
        this.bindings.set(opportunityId(adapter.id, p), { adapter, pairId: p.pairId, collateral: w.collateral, debt: w.debt });
      }
      return out;
    });
  }

  private async withMarketPrices(sourceId: string, p: LoopPair, w: PairWiring): Promise<LoopPair> {
    const px = async (a: AssetRef, fallback: number) => {
      try {
        const v = await this.d.marketPrice(a);
        return Number.isFinite(v) && v > 0 ? v : fallback;
      } catch (e) {
        this.d.log("warn", `${sourceId} ${p.pairId}: no market price for ${a.chain}:${a.symbol} (${(e as Error).message}); using protocol price`);
        return fallback;
      }
    };
    const collateral = { ...p.collateral, priceUsd: await px(w.collateral, p.collateral.priceUsd) };
    const debt =
      p.debt === p.collateral ? collateral : { ...p.debt, priceUsd: await px(w.debt, p.debt.priceUsd) };
    const out: LoopPair = { ...p, collateral, debt };
    if (w.expectedPriceRatio === "oracle") {
      const r = p.debt.priceUsd / p.collateral.priceUsd;
      if (Number.isFinite(r) && r > 0) out.expectedPriceRatio = r;
    } else if (typeof w.expectedPriceRatio === "number") out.expectedPriceRatio = w.expectedPriceRatio;
    else delete out.expectedPriceRatio; // stable pair: 1:1 is the only acceptable ratio
    return out;
  }

  /**
   * Binding for an opportunity id. Before the first successful markets() read
   * (e.g. after a restart while an RPC is down) the id is matched against the
   * configuration (`<adapter.id>:<protocol>:<pairId>`) so open positions can
   * still be marked, deleveraged and closed.
   */
  bind(oppId: string): LoopBinding | undefined {
    const hit = this.bindings.get(oppId);
    if (hit) return hit;
    const m = this.wired.filter(({ adapter, w }) => oppId.startsWith(`${adapter.id}:`) && oppId.endsWith(`:${w.pairId}`));
    if (m.length !== 1) return undefined;
    const { adapter, w } = m[0]!;
    return { adapter, pairId: w.pairId, collateral: w.collateral };
  }

  /** Every asset any configured pair touches (for wallet-balance buckets). */
  static assetsOf(wiring: PairWiring[]): AssetRef[] {
    return wiring.flatMap((w) => [w.collateral, w.debt]);
  }
}
