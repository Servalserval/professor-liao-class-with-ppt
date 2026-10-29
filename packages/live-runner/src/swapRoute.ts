/**
 * Same-chain stable swaps as a "bridge" hop (RouteKind "swap"), so the core
 * funding planner can route e.g. arbitrum:USDT0 --usdt0_oft--> plasma:USDT0
 * --swap--> plasma:USDe and charge the swap's cost against the same
 * one-day-of-yield friction budget as the bridge fee.
 *
 * The configured RouteSpec.feeBps for a swap route is the planning estimate;
 * at send time the live quote must not exceed `maxCostBps` (normally the
 * route's feeBps plus a small tolerance) — otherwise the hop is refused and
 * the money stays where it is (the router alerts and re-plans next cycle).
 * Received amount = measured wallet balance delta of the output asset.
 */
import {
  type AssetRef,
  type BridgeAdapter,
  type BridgeQuote,
  type BridgeStatus,
  type LiveContext,
  type LiveResult,
  type SwapAdapter,
  unitsToUsd,
} from "@incentive-router/live-common";

export interface SwapRouteDeps {
  /** chain -> swapper */
  swappers: Record<string, SwapAdapter>;
  /** Wallet balance of any asset (dispatches by asset.chain). */
  balance: (asset: AssetRef) => Promise<bigint>;
  /** Max live cost for a hop from->to, bps (fees + impact vs oracle). */
  maxCostBps: (from: AssetRef, to: AssetRef) => number;
}

interface Handle {
  chain: string;
  to: string;
  received: string; // bigint as string
  simulated: boolean;
}

export class SwapRouteAdapter implements BridgeAdapter {
  readonly kind = "swap";
  constructor(private readonly d: SwapRouteDeps) {}

  supports(from: AssetRef, to: AssetRef): boolean {
    return from.chain === to.chain && from.address.toLowerCase() !== to.address.toLowerCase() && !!this.d.swappers[from.chain];
  }

  private swapper(chain: string): SwapAdapter {
    const s = this.d.swappers[chain];
    if (!s) throw new Error(`no swapper configured for ${chain}`);
    return s;
  }

  async quote(from: AssetRef, to: AssetRef, amount: bigint, ctx: LiveContext): Promise<BridgeQuote> {
    const q = await this.swapper(from.chain).quote(from, to, amount, ctx);
    const usdIn = unitsToUsd(amount, await ctx.priceUsd(from), from.decimals);
    const minOut = (q.amountOut * BigInt(10_000 - Math.ceil(ctx.limits.maxSlippageBps))) / 10_000n;
    return { amountIn: amount, minAmountOut: minOut, feeUsd: (usdIn * Math.max(0, q.costBps)) / 1e4, gasSrcUsd: 0, gasDstUsd: 0, etaSeconds: 30 };
  }

  async send(from: AssetRef, to: AssetRef, amount: bigint, _recipient: string, ctx: LiveContext): Promise<LiveResult & { handle?: string }> {
    if (!this.supports(from, to)) return { ok: false, txs: [], detail: `swap route ${from.chain}:${from.symbol}->${to.chain}:${to.symbol} not supported` };
    const sw = this.swapper(from.chain);
    const q = await sw.quote(from, to, amount, ctx);
    const max = this.d.maxCostBps(from, to);
    if (!(q.costBps <= max)) return { ok: false, txs: [], detail: `swap cost ${q.costBps.toFixed(2)} bps > allowed ${max} bps; not swapping` };
    const before = await this.d.balance(to);
    let r: LiveResult;
    try {
      r = await sw.swap(q, from, to, ctx);
    } catch (e) {
      // Core contract: never throw once something may have been broadcast.
      // Look at the wallet: if the output arrived, report success.
      if (ctx.dryRun) return { ok: false, txs: [], detail: `swap simulation failed: ${(e as Error).message}` };
      const after = await this.d.balance(to).catch(() => before);
      if (after > before) {
        const h: Handle = { chain: from.chain, to: to.symbol, received: (after - before).toString(), simulated: false };
        return { ok: true, txs: [], handle: JSON.stringify(h), detail: `swap error after broadcast (${(e as Error).message}) but output arrived` };
      }
      return { ok: false, txs: [], detail: `swap failed: ${(e as Error).message}` };
    }
    if (!r.ok) return { ...r, ok: false };
    let received: bigint;
    if (ctx.dryRun) received = q.amountOut;
    else {
      const after = await this.d.balance(to);
      received = after > before ? after - before : 0n;
    }
    const h: Handle = { chain: from.chain, to: to.symbol, received: received.toString(), simulated: ctx.dryRun };
    return { ...r, handle: JSON.stringify(h), amountUsd: unitsToUsd(received, await ctx.priceUsd(to), to.decimals) };
  }

  async status(handle: string): Promise<BridgeStatus> {
    try {
      const h = JSON.parse(handle) as Handle;
      return { state: "completed", received: BigInt(h.received) };
    } catch {
      return { state: "failed", detail: `bad swap handle ${handle.slice(0, 80)}` };
    }
  }
}
