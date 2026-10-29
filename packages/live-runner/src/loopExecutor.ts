/**
 * Adapts live LendingAdapters to the core Router's Executor interface.
 *
 * Two modes:
 *  - "live":   every call goes to the adapter with ctx.dryRun=false; amounts
 *              come from measured wallet / position deltas; markToMarket reads
 *              the on-chain position so the kill switch sees real PnL.
 *  - "shadow": every write is BUILT AND SIMULATED on-chain (ctx.dryRun=true)
 *              but nothing is broadcast; if the simulation succeeds the result
 *              is booked like paper trading (opportunity cost model). This is
 *              how the bot runs on the staging box before going live: it
 *              proves the transactions would work, against the real wallet,
 *              without moving money. Shadow has no markToMarket (the router
 *              runs with paper accrual instead).
 */
import type { Executor, ExecResult, Opportunity, Position } from "@incentive-router/core";
import {
  applyFraction,
  type AssetRef,
  type LendingAdapter,
  type LiveContext,
  type LiveResult,
  type SwapAdapter,
  unitsToUsd,
  usdToUnits,
} from "@incentive-router/live-common";

export interface LoopBinding {
  adapter: LendingAdapter;
  pairId: string;
  /** Asset deposited as equity (collateral side). */
  collateral: AssetRef;
}

export interface LoopExecutorDeps {
  mode: "live" | "shadow";
  ctx: LiveContext;
  /** oppId -> binding (built from the same adapters that produced the opportunities). */
  bind: (oppId: string) => LoopBinding | undefined;
  /** Same-chain swappers used to sell reward tokens. */
  swappers: Record<string, SwapAdapter>;
  /** chain -> reward token symbol -> AssetRef (reward tokens we know how to sell). */
  rewardAssets: Record<string, Record<string, AssetRef>>;
  /** chain -> stablecoin that reward sales go into (normally the collateral asset). */
  proceedsAsset: Record<string, AssetRef>;
}

function summarize(r: LiveResult): string {
  const txs = r.txs.map((t) => `${t.chain}:${t.id ?? "sim"} ${t.description}`).join("; ");
  return [r.detail, txs].filter(Boolean).join(" | ");
}

export class LoopExecutor implements Executor {
  readonly markToMarket?: (pos: Position, opp?: Opportunity) => Promise<number>;

  constructor(private readonly d: LoopExecutorDeps) {
    if (d.mode === "live") {
      this.markToMarket = async (pos: Position) => {
        const b = this.binding(pos.oppId);
        const v = await b.adapter.position(b.pairId);
        return v ? v.equityUsd : 0;
      };
    }
  }

  private binding(oppId: string): LoopBinding {
    const b = this.d.bind(oppId);
    if (!b) throw new Error(`no adapter binding for ${oppId}`);
    return b;
  }

  private wctx(): LiveContext {
    return { ...this.d.ctx, dryRun: this.d.mode === "shadow" };
  }

  async enter(opp: Opportunity, deltaUsd: number): Promise<ExecResult> {
    const b = this.binding(opp.id);
    const price = await this.d.ctx.priceUsd(b.collateral);
    const units = usdToUnits(deltaUsd, price, b.collateral.decimals);
    const have = await b.adapter.walletBalance(b.collateral);
    if (have < units)
      return { ok: false, detail: `wallet has ${unitsToUsd(have, price, b.collateral.decimals).toFixed(2)} USD of ${b.collateral.symbol} on ${b.collateral.chain}, need ${deltaUsd.toFixed(2)}` };
    const ltv = Number((opp.meta as { ltv?: number } | undefined)?.ltv);
    if (!(ltv > 0 && ltv < 1)) return { ok: false, detail: `opportunity ${opp.id} has no target ltv in meta` };

    const before = this.d.mode === "live" ? await b.adapter.position(b.pairId) : null;
    const r = await b.adapter.open(b.pairId, units, ltv, this.wctx());
    if (!r.ok) return { ok: false, detail: summarize(r) };
    if (this.d.mode === "shadow") {
      const cost = deltaUsd * opp.costs.entryFrac + opp.costs.fixedEntryUsd;
      return { ok: true, amountUsd: deltaUsd - cost, spentUsd: deltaUsd, detail: `shadow: simulated OK | ${summarize(r)}` };
    }
    const after = await b.adapter.position(b.pairId);
    const deployed = (after?.equityUsd ?? 0) - (before?.equityUsd ?? 0);
    return { ok: true, amountUsd: Math.max(0, deployed), spentUsd: deltaUsd, detail: summarize(r) };
  }

  async exit(pos: Position, fraction: number, opp?: Opportunity): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const price = await this.d.ctx.priceUsd(b.collateral);
    const balBefore = await b.adapter.walletBalance(b.collateral);
    const r = await b.adapter.close(b.pairId, Math.min(1, fraction), this.wctx());
    if (!r.ok) return { ok: false, detail: summarize(r) };
    if (this.d.mode === "shadow") {
      const gross = pos.equityUsd * Math.min(1, fraction);
      const cost = opp ? gross * opp.costs.exitFrac + opp.costs.fixedExitUsd : 0;
      return { ok: true, amountUsd: Math.max(0, gross - cost), detail: `shadow: simulated OK | ${summarize(r)}` };
    }
    const balAfter = await b.adapter.walletBalance(b.collateral);
    return { ok: true, amountUsd: unitsToUsd(balAfter - balBefore, price, b.collateral.decimals), detail: summarize(r) };
  }

  async rebalance(pos: Position, opp: Opportunity): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const ltv = Number((opp.meta as { ltv?: number } | undefined)?.ltv);
    if (!(ltv > 0 && ltv < 1)) return { ok: false, detail: "no target ltv" };
    const r = await b.adapter.deleverage(b.pairId, ltv, this.wctx());
    return { ok: r.ok, detail: summarize(r) };
  }

  async simulateExit(pos: Position): Promise<boolean> {
    const b = this.binding(pos.oppId);
    // In shadow mode there is no on-chain position to unwind; probing the
    // close of a non-existent position would always fail. Treat as healthy.
    if (this.d.mode === "shadow") return true;
    return b.adapter.simulateClose(b.pairId, { ...this.d.ctx, dryRun: true });
  }

  async claim(pos: Position, token: string, amountUsd: number): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const r = await b.adapter.claimRewards(this.wctx(), b.pairId);
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
    const outUsd = unitsToUsd(q.amountOut, await this.d.ctx.priceUsd(to), to.decimals);
    return { ok: true, amountUsd: outUsd, detail: `${this.d.mode === "shadow" ? "shadow: " : ""}${summarize(r)}` };
  }

  async hedge(token: string): Promise<ExecResult> {
    return { ok: false, detail: `no hedge venue wired for ${token}; set its reward policy to sell_on_claim` };
  }
}

/** Fraction helper re-exported for callers that convert partial exits to units. */
export { applyFraction };
