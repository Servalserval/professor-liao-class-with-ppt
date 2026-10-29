/**
 * Adapts SupplyAdapters (plain deposits: Aave reserves, Navi / Suilend /
 * Scallop pools, ERC-4626 vaults) to the core Router's Executor interface.
 * Same two modes and the same post-broadcast honesty as LoopExecutor:
 *  - live:   real deposits / withdrawals; amounts measured from the position
 *            and the wallet; markToMarket reads the on-chain deposit.
 *  - shadow: every write is built and simulated (dryRun) and booked on paper.
 * A deposit has no leverage, so rebalance is a no-op and there is no health.
 */
import type { Executor, ExecResult, Opportunity, Position } from "@incentive-router/core";
import {
  type AssetRef,
  type LiveContext,
  type LiveResult,
  type SupplyAdapter,
  type SwapAdapter,
  unitsToUsd,
  usdToUnits,
} from "@incentive-router/live-common";

export interface SupplyBinding {
  adapter: SupplyAdapter;
  marketId: string;
  asset: AssetRef;
}

export interface SupplyExecutorDeps {
  mode: "live" | "shadow";
  ctx: LiveContext;
  bind: (oppId: string) => SupplyBinding | undefined;
  swappers: Record<string, SwapAdapter>;
  rewardAssets: Record<string, Record<string, AssetRef>>;
  proceedsAsset: Record<string, AssetRef>;
  nullMarksBeforeZero?: number;
}

function summarize(r: LiveResult): string {
  const txs = r.txs.map((t) => `${t.chain}:${t.id ?? "sim"} ${t.description}${t.unconfirmed ? " (unconfirmed)" : ""}`).join("; ");
  return [r.detail, txs].filter(Boolean).join(" | ");
}

export class SupplyExecutor implements Executor {
  readonly markToMarket?: (pos: Position, opp?: Opportunity) => Promise<number>;
  private readonly nullMarks = new Map<string, number>();

  constructor(private readonly d: SupplyExecutorDeps) {
    if (d.mode === "live") {
      this.markToMarket = async (pos: Position) => {
        const b = this.binding(pos.oppId);
        const v = await b.adapter.supplyPosition(b.marketId);
        if (v) {
          this.nullMarks.delete(pos.oppId);
          return v.depositUsd;
        }
        const n = (this.nullMarks.get(pos.oppId) ?? 0) + 1;
        this.nullMarks.set(pos.oppId, n);
        if (n < (this.d.nullMarksBeforeZero ?? 3)) throw new Error(`${pos.oppId}: adapter reports no deposit (${n}x); keeping book value`);
        return 0;
      };
    }
  }

  private binding(oppId: string): SupplyBinding {
    const b = this.d.bind(oppId);
    if (!b) throw new Error(`no supply binding for ${oppId}`);
    return b;
  }

  private wctx(): LiveContext {
    return { ...this.d.ctx, dryRun: this.d.mode === "shadow" };
  }

  private async depositUsd(b: SupplyBinding): Promise<{ ok: true; usd: number } | { ok: false; err: string }> {
    try {
      const v = await b.adapter.supplyPosition(b.marketId);
      return { ok: true, usd: v?.depositUsd ?? 0 };
    } catch (e) {
      return { ok: false, err: (e as Error).message };
    }
  }

  async enter(opp: Opportunity, deltaUsd: number): Promise<ExecResult> {
    const b = this.binding(opp.id);
    const price = await this.d.ctx.priceUsd(b.asset);
    let units = usdToUnits(deltaUsd, price, b.asset.decimals);
    const have = await b.adapter.walletBalance(b.asset);
    if (have < units && have * 1000n >= units * 999n) units = have; // USD<->units rounding
    if (have < units)
      return { ok: false, detail: `wallet has ${unitsToUsd(have, price, b.asset.decimals).toFixed(2)} USD of ${b.asset.symbol} on ${b.asset.chain}, need ${deltaUsd.toFixed(2)}` };
    const spentUsd = unitsToUsd(units, price, b.asset.decimals);
    const before = this.d.mode === "live" ? await this.depositUsd(b) : { ok: true as const, usd: 0 };
    const book = async (why: string): Promise<ExecResult | null> => {
      const a = await this.depositUsd(b);
      if (!a.ok || !before.ok) {
        const est = spentUsd * (1 - opp.costs.entryFrac) - opp.costs.fixedEntryUsd;
        return { ok: true, amountUsd: Math.max(0, est), spentUsd, detail: `${why}; deposit read failed — booked estimate $${est.toFixed(2)}, verify on-chain` };
      }
      const grew = a.usd - before.usd;
      return grew > Math.max(1, spentUsd * 0.01) ? { ok: true, amountUsd: grew, spentUsd, detail: `${why}; deposit grew $${grew.toFixed(2)}` } : null;
    };
    let r: LiveResult;
    try {
      r = await b.adapter.deposit(b.marketId, units, this.wctx());
    } catch (e) {
      if (this.d.mode === "shadow") return { ok: false, detail: `shadow: ${(e as Error).message}` };
      return (await book(`PARTIAL after error (${(e as Error).message})`)) ?? { ok: false, detail: `deposit failed: ${(e as Error).message}` };
    }
    if (!r.ok) {
      if (this.d.mode === "live" && r.txs.some((t) => !t.simulated && t.id)) {
        const booked = await book(`PARTIAL: ${summarize(r)}`);
        if (booked) return booked;
      }
      return { ok: false, detail: summarize(r) };
    }
    if (this.d.mode === "shadow") {
      const cost = spentUsd * opp.costs.entryFrac + opp.costs.fixedEntryUsd;
      return { ok: true, amountUsd: spentUsd - cost, spentUsd, detail: `shadow: simulated OK | ${summarize(r)}` };
    }
    return (await book(summarize(r))) ?? { ok: true, amountUsd: 0, spentUsd, detail: `${summarize(r)} | WARNING: no deposit increase measured` };
  }

  async exit(pos: Position, fraction: number, opp?: Opportunity): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const price = await this.d.ctx.priceUsd(b.asset);
    const balBefore = await b.adapter.walletBalance(b.asset);
    let r: LiveResult;
    try {
      r = await b.adapter.withdraw(b.marketId, Math.min(1, fraction), this.wctx());
    } catch (e) {
      if (this.d.mode === "shadow") return { ok: false, detail: `shadow: ${(e as Error).message}` };
      const balAfter = await b.adapter.walletBalance(b.asset).catch(() => balBefore);
      const back = unitsToUsd(balAfter - balBefore, price, b.asset.decimals);
      return { ok: false, amountUsd: back > 0 ? back : undefined, detail: `withdraw failed: ${(e as Error).message}${back > 0 ? ` (after $${back.toFixed(2)} returned)` : ""}` };
    }
    if (!r.ok) return { ok: false, detail: summarize(r) };
    if (this.d.mode === "shadow") {
      const gross = pos.equityUsd * Math.min(1, fraction);
      const cost = opp ? gross * opp.costs.exitFrac + opp.costs.fixedExitUsd : 0;
      return { ok: true, amountUsd: Math.max(0, gross - cost), detail: `shadow: simulated OK | ${summarize(r)}` };
    }
    const balAfter = await b.adapter.walletBalance(b.asset);
    return { ok: true, amountUsd: unitsToUsd(balAfter - balBefore, price, b.asset.decimals), detail: summarize(r) };
  }

  async rebalance(): Promise<ExecResult> {
    return { ok: true, detail: "plain deposit: nothing to rebalance" };
  }

  async simulateExit(pos: Position): Promise<boolean> {
    if (this.d.mode === "shadow") return true;
    const b = this.binding(pos.oppId);
    return b.adapter.simulateWithdraw(b.marketId, { ...this.d.ctx, dryRun: true });
  }

  async claim(pos: Position, _token: string, amountUsd: number): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const r = await b.adapter.claimRewards(this.wctx(), b.marketId);
    if (!r.ok) return { ok: false, detail: summarize(r) };
    if (this.d.mode === "shadow") return { ok: true, amountUsd, detail: `shadow: simulated OK | ${summarize(r)}` };
    let usd = 0;
    for (const c of r.claimed) {
      const asset = this.d.rewardAssets[b.adapter.chain]?.[c.token];
      if (asset) usd += unitsToUsd(c.amount, await this.d.ctx.priceUsd(asset), c.decimals);
    }
    return { ok: true, amountUsd: usd, detail: summarize(r) };
  }

  async sell(pos: Position, token: string, amountUsd: number): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const chain = b.adapter.chain;
    const from = this.d.rewardAssets[chain]?.[token];
    const to = this.d.proceedsAsset[chain];
    const swapper = this.d.swappers[chain];
    if (!from || !to || !swapper) return { ok: false, detail: `cannot sell ${token} on ${chain}: missing asset/proceeds/swapper config` };
    const price = await this.d.ctx.priceUsd(from);
    const want = usdToUnits(amountUsd, price, from.decimals);
    const bal = await b.adapter.walletBalance(from);
    const amt = want <= bal ? want : bal;
    if (amt <= 0n) return { ok: false, detail: `no ${token} in wallet` };
    const q = await swapper.quote(from, to, amt, this.d.ctx);
    const r = await swapper.swap(q, from, to, this.wctx());
    if (!r.ok) return { ok: false, detail: summarize(r) };
    return { ok: true, amountUsd: unitsToUsd(q.amountOut, await this.d.ctx.priceUsd(to), to.decimals), detail: summarize(r) };
  }

  async hedge(token: string): Promise<ExecResult> {
    return { ok: false, detail: `no hedge venue wired for ${token}; set its reward policy to sell_on_claim` };
  }
}
