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
  /** Entry vs exit swap budgets for the adapters' swappers (see swapMode.ts). */
  swapMode?: { run<T>(mode: "entry" | "exit", fn: () => Promise<T>): Promise<T> };
  /** A position read returning null this many times in a row is accepted as "gone" (default 3). */
  nullMarksBeforeZero?: number;
}

function summarize(r: LiveResult): string {
  const txs = r.txs.map((t) => `${t.chain}:${t.id ?? "sim"} ${t.description}`).join("; ");
  return [r.detail, txs].filter(Boolean).join(" | ");
}

export class LoopExecutor implements Executor {
  readonly markToMarket?: (pos: Position, opp?: Opportunity) => Promise<number>;

  private readonly nullMarks = new Map<string, number>();

  constructor(private readonly d: LoopExecutorDeps) {
    if (d.mode === "live") {
      this.markToMarket = async (pos: Position) => {
        const b = this.binding(pos.oppId);
        const v = await b.adapter.position(b.pairId);
        if (v) {
          this.nullMarks.delete(pos.oppId);
          return v.equityUsd;
        }
        // A lagging indexer / obligation lookup can return "no position" for a
        // position that exists: a single null must not mark it to $0 (fake
        // drawdown -> kill switch). Throwing keeps the router's book value.
        const n = (this.nullMarks.get(pos.oppId) ?? 0) + 1;
        this.nullMarks.set(pos.oppId, n);
        if (n < (this.d.nullMarksBeforeZero ?? 3)) throw new Error(`${pos.oppId}: adapter reports no position (${n}x); keeping book value`);
        return 0;
      };
    }
  }

  private entryMode<T>(fn: () => Promise<T>): Promise<T> {
    return this.d.swapMode ? this.d.swapMode.run("entry", fn) : fn();
  }

  /** Position read that never throws (used right after broadcasts). */
  private async safePosition(b: LoopBinding) {
    try {
      return { ok: true as const, v: await b.adapter.position(b.pairId) };
    } catch (e) {
      return { ok: false as const, err: (e as Error).message };
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
    let units = usdToUnits(deltaUsd, price, b.collateral.decimals);
    const have = await b.adapter.walletBalance(b.collateral);
    // USD -> units rounding (18-decimal tokens) can ask for a hair more than a
    // bucket that was itself measured in USD: clamp a <0.1% shortfall.
    if (have < units && have * 1000n >= units * 999n) units = have;
    if (have < units)
      return { ok: false, detail: `wallet has ${unitsToUsd(have, price, b.collateral.decimals).toFixed(2)} USD of ${b.collateral.symbol} on ${b.collateral.chain}, need ${deltaUsd.toFixed(2)}` };
    const ltv = Number((opp.meta as { ltv?: number } | undefined)?.ltv);
    if (!(ltv > 0 && ltv < 1)) return { ok: false, detail: `opportunity ${opp.id} has no target ltv in meta` };

    const before = this.d.mode === "live" ? await b.adapter.position(b.pairId) : null;
    const spentUsd = unitsToUsd(units, price, b.collateral.decimals);
    // Book what is on-chain after a broadcast; if the read itself fails, book
    // the request minus modelled costs (the router's markToMarket corrects it
    // next cycle) — never "nothing happened" once something was sent.
    const bookAfter = async (why: string): Promise<ExecResult | null> => {
      const a = await this.safePosition(b);
      if (!a.ok) {
        const est = spentUsd - (spentUsd * opp.costs.entryFrac + opp.costs.fixedEntryUsd);
        return { ok: true, amountUsd: Math.max(0, est), spentUsd, detail: `${why}; position read failed (${a.err}) — booked estimate $${est.toFixed(2)}, verify on-chain` };
      }
      const deployed = (a.v?.equityUsd ?? 0) - (before?.equityUsd ?? 0);
      if (deployed > Math.max(1, spentUsd * 0.01)) return { ok: true, amountUsd: deployed, spentUsd, detail: `${why}; position grew $${deployed.toFixed(2)}` };
      return null;
    };
    let r: LiveResult;
    try {
      r = await this.entryMode(() => b.adapter.open(b.pairId, units, ltv, this.wctx()));
    } catch (e) {
      // A throw can happen AFTER something was broadcast (receipt timeout,
      // a later step failing). Never report "nothing happened" without
      // looking: an untracked on-chain position is worse than a failed entry.
      if (this.d.mode === "shadow") return { ok: false, detail: `shadow: ${(e as Error).message}` };
      const booked = await bookAfter(`PARTIAL after error (${(e as Error).message}) — check LTV`);
      return booked ?? { ok: false, detail: `open failed: ${(e as Error).message}` };
    }
    if (!r.ok) {
      if (this.d.mode === "live" && r.txs.some((t) => !t.simulated && t.id)) {
        // Some steps were broadcast before a later one failed: book what is there.
        const booked = await bookAfter(`PARTIAL: ${summarize(r)}`);
        if (booked) return booked;
      }
      return { ok: false, detail: summarize(r) };
    }
    if (this.d.mode === "shadow") {
      const cost = spentUsd * opp.costs.entryFrac + opp.costs.fixedEntryUsd;
      return { ok: true, amountUsd: spentUsd - cost, spentUsd, detail: `shadow: simulated OK | ${summarize(r)}` };
    }
    const booked = await bookAfter(summarize(r));
    return booked ?? { ok: true, amountUsd: 0, spentUsd, detail: `${summarize(r)} | WARNING: no equity increase measured` };
  }

  async exit(pos: Position, fraction: number, opp?: Opportunity): Promise<ExecResult> {
    const b = this.binding(pos.oppId);
    const price = await this.d.ctx.priceUsd(b.collateral);
    const balBefore = await b.adapter.walletBalance(b.collateral);
    let r: LiveResult;
    try {
      r = await b.adapter.close(b.pairId, Math.min(1, fraction), this.wctx());
    } catch (e) {
      if (this.d.mode === "shadow") return { ok: false, detail: `shadow: ${(e as Error).message}` };
      // Report money that came back even if a later step threw; the router
      // keeps the position and retries the rest next cycle.
      const balAfter = await b.adapter.walletBalance(b.collateral).catch(() => balBefore);
      const back = unitsToUsd(balAfter - balBefore, price, b.collateral.decimals);
      return { ok: false, amountUsd: back > 0 ? back : undefined, detail: `close failed: ${(e as Error).message}${back > 0 ? ` (after $${back.toFixed(2)} returned)` : ""}` };
    }
    if (!r.ok) return { ok: false, detail: summarize(r) };
    if (this.d.mode === "shadow") {
      const gross = pos.equityUsd * Math.min(1, fraction);
      const cost = opp ? gross * opp.costs.exitFrac + opp.costs.fixedExitUsd : 0;
      return { ok: true, amountUsd: Math.max(0, gross - cost), detail: `shadow: simulated OK | ${summarize(r)}` };
    }
    try {
      const balAfter = await b.adapter.walletBalance(b.collateral);
      return { ok: true, amountUsd: unitsToUsd(balAfter - balBefore, price, b.collateral.decimals), detail: summarize(r) };
    } catch (e) {
      // the close succeeded: never fail after money moved (the wallet snapshot corrects idle)
      const est = r.amountUsd ?? pos.equityUsd * Math.min(1, fraction);
      return { ok: true, amountUsd: est, detail: `${summarize(r)}; wallet read failed (${(e as Error).message}) — booked $${est.toFixed(2)}` };
    }
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
    // Adapter errors (RPC down) propagate as exceptions — the router counts
    // those as "unknown", only a `false` (the unwind would revert) as a failure.
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
