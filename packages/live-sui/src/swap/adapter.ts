/**
 * Standalone same-chain swaps on Sui through a PtbSwapper (Cetus aggregator):
 * fresh PTB = input coin from the wallet -> appendSwap (on-chain min-out) ->
 * transfer output to the sender -> executePtb (simulate, gas cap, dry-run stop).
 */
import type { AssetRef, LiveContext, LiveResult, SwapAdapter, SwapQuote } from "@incentive-router/live-common";
import { SuiSimulationError, Transaction, executePtb, normalizeStructTag, type PtbSwapQuote, type PtbSwapper, type SuiEnv } from "../common.js";
import { buildInputCoin } from "./coins.js";
import { SwapRejected, minOutForSlippage, sameCoinType } from "./math.js";

export interface CetusSwapAdapterOptions {
  env: SuiEnv;
  swapper: PtbSwapper & { describe?(q: PtbSwapQuote): string };
  /** SwapQuote.validUntilMs = quote time + this. Default 20s (keep <= the swapper's own TTL). */
  quoteTtlMs?: number;
  /** SUI (MIST) left in the wallet for gas when selling SUI. Default 0.1 SUI. */
  suiGasReserve?: bigint;
  /** Max coin objects merged into the input coin. Default 256. */
  maxInputCoins?: number;
  now?: () => number;
}

interface Payload {
  kind: "cetus-ptb";
  fromType: string;
  toType: string;
  ptb: PtbSwapQuote;
}

function assertSui(a: AssetRef, what: string): void {
  if (a.chain !== "sui") throw new SwapRejected(`cetus-aggregator: ${what} asset ${a.symbol} is on ${a.chain}, not sui`);
}

export class CetusSwapAdapter implements SwapAdapter {
  readonly id = "cetus-aggregator";
  readonly chain = "sui";
  private readonly ttlMs: number;
  private readonly suiGasReserve: bigint;
  private readonly maxInputCoins: number;
  private readonly now: () => number;

  constructor(private readonly o: CetusSwapAdapterOptions) {
    this.ttlMs = o.quoteTtlMs ?? 20_000;
    this.suiGasReserve = o.suiGasReserve ?? 100_000_000n;
    this.maxInputCoins = o.maxInputCoins ?? 256;
    this.now = o.now ?? Date.now;
  }

  async quote(from: AssetRef, to: AssetRef, amountIn: bigint, _ctx: LiveContext): Promise<SwapQuote> {
    assertSui(from, "from");
    assertSui(to, "to");
    const fromType = normalizeStructTag(from.address);
    const toType = normalizeStructTag(to.address);
    const ptb = await this.o.swapper.quote(fromType, toType, amountIn);
    const payload: Payload = { kind: "cetus-ptb", fromType, toType, ptb };
    return {
      amountIn: ptb.amountIn,
      amountOut: ptb.amountOut,
      costBps: ptb.costBps,
      route: this.o.swapper.describe?.(ptb) ?? "cetus-aggregator",
      validUntilMs: this.now() + this.ttlMs,
      payload,
    };
  }

  async swap(q: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext): Promise<LiveResult> {
    const label = `cetus swap ${q.amountIn} ${from.symbol} -> ${to.symbol}`;
    let tx: Transaction;
    let minOut: bigint;
    try {
      assertSui(from, "from");
      assertSui(to, "to");
      const p = q.payload as Payload | undefined;
      if (!p || p.kind !== "cetus-ptb") throw new SwapRejected("cetus-aggregator: quote payload is not from this adapter");
      if (!sameCoinType(p.fromType, from.address) || !sameCoinType(p.toType, to.address)) {
        throw new SwapRejected(`cetus-aggregator: quote is for ${p.fromType} -> ${p.toType}, not ${from.address} -> ${to.address}`);
      }
      if (q.amountIn !== p.ptb.amountIn || q.amountOut !== p.ptb.amountOut) throw new SwapRejected("cetus-aggregator: quote amounts were modified");
      if (this.now() > q.validUntilMs) throw new SwapRejected("cetus-aggregator: quote expired; re-quote");
      minOut = minOutForSlippage(q.amountOut, ctx.limits.maxSlippageBps);
      if (minOut <= 0n) throw new SwapRejected(`cetus-aggregator: minOut rounds to 0 for amountOut ${q.amountOut}`);

      tx = new Transaction();
      tx.setSender(this.o.env.address);
      const { coin, plan } = await buildInputCoin(this.o.env, tx, p.fromType, q.amountIn, {
        suiGasReserve: this.suiGasReserve,
        maxCoins: this.maxInputCoins,
      });
      ctx.log("debug", `${label}: input coin plan ${plan.kind}`, { minOut: minOut.toString(), costBps: q.costBps, route: q.route });
      const out = await this.o.swapper.appendSwap(tx, { fromType: p.fromType, toType: p.toType, coinIn: coin, quote: p.ptb, minOut });
      tx.transferObjects([out], this.o.env.address);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      ctx.log("warn", `${label}: not built`, { detail });
      return { ok: false, txs: [], detail };
    }

    try {
      const rec = await executePtb(this.o.env, ctx, tx, `${label} (minOut ${minOut} ${to.symbol} base units)`);
      return { ok: true, txs: [rec], detail: `${q.route} out>=${minOut}` };
    } catch (e) {
      // Simulation failures never broadcast: report. Anything else (gas cap,
      // post-broadcast failure / wait timeout) propagates so the caller sees it.
      if (e instanceof SuiSimulationError) {
        ctx.log("warn", `${label}: simulation failed`, { detail: e.message });
        return { ok: false, txs: [], detail: e.message };
      }
      throw e;
    }
  }
}
