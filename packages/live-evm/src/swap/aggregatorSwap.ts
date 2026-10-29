/**
 * Same-chain EVM swaps through a public DEX aggregator API (KyberSwap primary,
 * Odos fallback). The calldata comes from a THIRD PARTY, so nothing is approved
 * or signed until all of these hold:
 *
 *   1. tx.to is in the per-chain allowlist of the aggregator's official routers
 *      (config, default from ./addresses.ts; checked on-chain by verifyConfig()),
 *      and equals the router named in the quote (when the API named one);
 *   2. the calldata decodes with the router's ABI and its recipient is OUR account,
 *      its src/dst tokens and input amount are exactly what we asked for, and it
 *      carries no fee / permit side data;
 *   3. its on-chain min-out >= quote.amountOut * (1 - ctx.limits.maxSlippageBps),
 *      which is also passed to the API (slippage) so the router enforces it;
 *   4. tx.value == 0 (ERC20 input only);
 *   5. the approval is exactly amountIn, to that verified router (ensureAllowance);
 *   6. the swap is simulated via sendTx (dry-run stops there).
 *
 * costBps is measured against ctx.priceUsd oracle prices — never the API's own
 * USD numbers — and quotes above `maxCostBps` are rejected.
 */
import { getAddress, isAddress, zeroAddress } from "viem";
import { BroadcastUnconfirmedError, fromUnits, minusBps, type AssetRef, type LiveContext, type LiveResult, type SwapAdapter, type SwapQuote, type TxRecord } from "@incentive-router/live-common";
import { assertChainId, call, ensureAllowance, erc20Abi, erc20Balance, sendTx, SimulationError, type Address, type EvmEnv } from "@incentive-router/live-evm-base";
import { kyberswapRouters, odosRouters } from "./addresses.js";
import { defaultFetch, lc, sameAddr, type HttpFetch } from "./http.js";
import { KyberSwapClient, type KyberSwapOptions } from "./kyberswap.js";
import { OdosClient, type OdosOptions } from "./odos.js";
import type { AggQuote, AggregatorClient, AggregatorName, BuiltTx, DecodedSwap } from "./types.js";

export interface AggregatorSwapConfig {
  chain: string;
  /** Default `aggregator:<chain>`. */
  id?: string;
  /** Priority order. Default ["kyberswap", "odos"] (those supported on the chain). */
  aggregators?: AggregatorName[];
  /** "fallback" (default): first aggregator that returns an acceptable quote. "best": quote all, take max out. */
  mode?: "fallback" | "best";
  /** Reject quotes whose oracle-measured cost exceeds this (bps). */
  maxCostBps: number;
  /**
   * Router allowlist per aggregator for THIS chain. Defaults to the official
   * addresses in ./addresses.ts (SOURCE comments there). Pass [] to disable one.
   */
  routerAllowlist?: Partial<Record<AggregatorName, Address[]>>;
  kyberswap?: KyberSwapOptions;
  odos?: OdosOptions;
  /** Refuse to execute a quote older than this (the caller must re-quote). Default 120_000. */
  maxQuoteAgeMs?: number;
  /** Hard ceiling on ctx.limits.maxSlippageBps accepted by this adapter. Default 300. */
  maxSlippageBpsCeiling?: number;
  now?: () => number;
}

/** Opaque SwapQuote.payload produced by this adapter. */
export interface AggregatorSwapPayload {
  kind: "aggregator-swap/v1";
  adapterId: string;
  quote: AggQuote;
}

/** Oracle-measured cost of a swap, bps: (1 - outUsd / inUsd) * 1e4. Negative = we gain vs oracle. */
export function oracleCostBps(amountIn: bigint, inDecimals: number, inPriceUsd: number, amountOut: bigint, outDecimals: number, outPriceUsd: number): number {
  if (!(inPriceUsd > 0) || !(outPriceUsd > 0)) throw new Error(`oracleCostBps: invalid prices ${inPriceUsd} / ${outPriceUsd}`);
  const inUsd = fromUnits(amountIn, inDecimals) * inPriceUsd;
  const outUsd = fromUnits(amountOut, outDecimals) * outPriceUsd;
  if (!(inUsd > 0)) throw new Error("oracleCostBps: zero input value");
  return (1 - outUsd / inUsd) * 10_000;
}

const NATIVE_PLACEHOLDERS = new Set([zeroAddress, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]);

export class AggregatorSwapAdapter implements SwapAdapter {
  readonly id: string;
  readonly chain: string;
  private readonly clients: AggregatorClient[];
  private readonly allow: Record<AggregatorName, Set<string>>;
  private readonly now: () => number;

  constructor(
    private readonly env: EvmEnv,
    private readonly cfg: AggregatorSwapConfig,
    fetchImpl: HttpFetch = defaultFetch
  ) {
    if (env.chain !== cfg.chain) throw new Error(`AggregatorSwapAdapter: env chain ${env.chain} != config chain ${cfg.chain}`);
    if (!(cfg.maxCostBps >= 0)) throw new Error("AggregatorSwapAdapter: maxCostBps required");
    this.chain = cfg.chain;
    this.id = cfg.id ?? `aggregator:${cfg.chain}`;
    this.now = cfg.now ?? Date.now;
    const defaults: Record<AggregatorName, Address[]> = { kyberswap: kyberswapRouters(cfg.chain), odos: odosRouters(cfg.chain) };
    this.allow = {
      kyberswap: new Set((cfg.routerAllowlist?.kyberswap ?? defaults.kyberswap).map(lc)),
      odos: new Set((cfg.routerAllowlist?.odos ?? defaults.odos).map(lc)),
    };
    const order = cfg.aggregators ?? (["kyberswap", "odos"] as AggregatorName[]);
    this.clients = [];
    for (const name of order) {
      if (this.allow[name].size === 0) continue; // no official router known/allowed on this chain
      if (name === "kyberswap") this.clients.push(new KyberSwapClient(cfg.chain, { now: this.now, ...cfg.kyberswap }, fetchImpl));
      else if (name === "odos") this.clients.push(new OdosClient(cfg.chain, { now: this.now, ...cfg.odos }, fetchImpl));
    }
    if (!this.clients.length) throw new Error(`AggregatorSwapAdapter: no aggregator with an allowlisted router on ${cfg.chain}`);
  }

  /** Allowlisted routers, per aggregator (lowercase). */
  routers(): Record<AggregatorName, string[]> {
    return { kyberswap: [...this.allow.kyberswap], odos: [...this.allow.odos] };
  }

  private isAllowed(agg: AggregatorName, router: string): boolean {
    return this.allow[agg].has(lc(router));
  }

  private checkAssets(from: AssetRef, to: AssetRef): void {
    for (const a of [from, to]) {
      if (a.chain !== this.chain) throw new Error(`${this.id}: asset ${a.symbol} is on ${a.chain}, adapter is ${this.chain}`);
      if (!isAddress(a.address)) throw new Error(`${this.id}: ${a.symbol} address ${a.address} is not an EVM address`);
      if (NATIVE_PLACEHOLDERS.has(lc(a.address))) throw new Error(`${this.id}: native-token swaps are not supported (${a.symbol})`);
    }
    if (sameAddr(from.address, to.address)) throw new Error(`${this.id}: from == to (${from.symbol})`);
  }

  async quote(from: AssetRef, to: AssetRef, amountIn: bigint, ctx: LiveContext): Promise<SwapQuote> {
    this.checkAssets(from, to);
    if (amountIn <= 0n) throw new Error(`${this.id}: amountIn must be > 0`);
    const [pIn, pOut] = await Promise.all([ctx.priceUsd(from), ctx.priceUsd(to)]);
    const tokenIn = getAddress(from.address) as Address;
    const tokenOut = getAddress(to.address) as Address;
    const failures: string[] = [];
    const ok: { q: AggQuote; costBps: number }[] = [];
    for (const c of this.clients) {
      try {
        const q = await c.quote({ tokenIn, tokenOut, amountIn, account: this.env.account, slippageBps: ctx.limits.maxSlippageBps });
        if (q.router && !this.isAllowed(c.name, q.router)) throw new Error(`router ${q.router} is not in the ${c.name} allowlist for ${this.chain}`);
        const costBps = oracleCostBps(amountIn, from.decimals, pIn, q.amountOut, to.decimals, pOut);
        if (costBps > this.cfg.maxCostBps) throw new Error(`cost ${costBps.toFixed(1)} bps > max ${this.cfg.maxCostBps} bps (oracle)`);
        if (costBps < -100) ctx.log("warn", `${this.id}: ${c.name} quote beats oracle by ${(-costBps).toFixed(0)} bps — check oracle prices`, { from: from.symbol, to: to.symbol });
        ctx.log("debug", `${this.id}: ${c.name} quote`, { amountIn: amountIn.toString(), amountOut: q.amountOut.toString(), costBps, apiUsd: q.apiUsd });
        ok.push({ q, costBps });
        if ((this.cfg.mode ?? "fallback") === "fallback") break;
      } catch (e) {
        failures.push(`${c.name}: ${(e as Error).message}`);
      }
    }
    if (!ok.length) throw new Error(`${this.id}: no acceptable quote ${from.symbol}->${to.symbol}: ${failures.join("; ")}`);
    const best = ok.reduce((a, b) => (b.q.amountOut > a.q.amountOut ? b : a));
    const payload: AggregatorSwapPayload = { kind: "aggregator-swap/v1", adapterId: this.id, quote: best.q };
    return {
      amountIn,
      amountOut: best.q.amountOut,
      costBps: best.costBps,
      route: `${best.q.aggregator}:${best.q.route}`,
      validUntilMs: best.q.validUntilMs,
      payload,
    };
  }

  /**
   * Verify API-built calldata. Throws with the reason on any mismatch.
   * Exposed for tests and for callers that want to pre-check.
   */
  verifyBuilt(agg: AggregatorClient, q: AggQuote, built: BuiltTx, minOut: bigint): DecodedSwap {
    if (!this.isAllowed(agg.name, built.to)) throw new Error(`tx.to ${built.to} is not an allowlisted ${agg.name} router on ${this.chain}`);
    if (q.router && !sameAddr(q.router, built.to)) throw new Error(`tx.to ${built.to} != quoted router ${q.router}`);
    if (built.value !== 0n) throw new Error(`tx.value ${built.value} != 0 for an ERC20 swap`);
    let d: DecodedSwap;
    try {
      d = agg.decode(built.data);
    } catch (e) {
      throw new Error(`cannot decode ${agg.name} router calldata: ${(e as Error).message.split("\n")[0]}`);
    }
    if (!sameAddr(d.recipient, this.env.account)) throw new Error(`recipient ${d.recipient} is not our account ${this.env.account}`);
    if (!sameAddr(d.srcToken, q.tokenIn)) throw new Error(`calldata srcToken ${d.srcToken} != ${q.tokenIn}`);
    if (!sameAddr(d.dstToken, q.tokenOut)) throw new Error(`calldata dstToken ${d.dstToken} != ${q.tokenOut}`);
    if (d.amountIn !== q.amountIn) throw new Error(`calldata amountIn ${d.amountIn} != ${q.amountIn}`);
    if (d.minOut < minOut) throw new Error(`calldata min-out ${d.minOut} < required ${minOut}`);
    if (d.feeTotal !== 0n) throw new Error(`calldata carries fees (${d.feeTotal})`);
    if (d.unexpected) throw new Error(`calldata rejected: ${d.unexpected}`);
    return d;
  }

  async swap(sq: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    try {
      this.checkAssets(from, to);
      const p = sq.payload as AggregatorSwapPayload | undefined;
      if (!p || p.kind !== "aggregator-swap/v1" || p.adapterId !== this.id) throw new Error("quote was not produced by this adapter");
      const q = p.quote;
      if (!sameAddr(q.tokenIn, from.address) || !sameAddr(q.tokenOut, to.address)) throw new Error("quote tokens do not match from/to");
      if (q.amountIn !== sq.amountIn || q.amountOut !== sq.amountOut) throw new Error("SwapQuote amounts differ from the aggregator quote");
      if (this.now() - q.quotedAtMs > (this.cfg.maxQuoteAgeMs ?? 120_000)) throw new Error("quote too old — re-quote");
      const slip = ctx.limits.maxSlippageBps;
      const ceiling = this.cfg.maxSlippageBpsCeiling ?? 300;
      if (!(Number.isFinite(slip) && slip >= 0 && slip <= ceiling)) throw new Error(`maxSlippageBps ${slip} outside [0, ${ceiling}]`);
      const minOut = minusBps(q.amountOut, slip);
      if (minOut <= 0n) throw new Error("min-out rounds to 0");
      const agg = this.clients.find((c) => c.name === q.aggregator);
      if (!agg) throw new Error(`aggregator ${q.aggregator} not enabled`);

      const built = await agg.build(q, { account: this.env.account, minOut });
      const d = this.verifyBuilt(agg, q, built, minOut);
      const router = getAddress(built.to) as Address;
      const tokenIn = getAddress(from.address) as Address;
      const tokenOut = getAddress(to.address) as Address;

      const approvals = await ensureAllowance(this.env, ctx, tokenIn, router, q.amountIn);
      txs.push(...approvals);
      const before = ctx.dryRun ? 0n : await erc20Balance(this.env, tokenOut);
      const desc = `${q.aggregator} swap ${q.amountIn} ${from.symbol} -> >=${minOut} ${to.symbol} via ${router} (${d.fn})`;
      try {
        txs.push(await sendTx(this.env, ctx, { to: router, data: built.data, value: 0n, description: desc }));
      } catch (e) {
        if (e instanceof BroadcastUnconfirmedError) {
          // The swap may still land: keep the allowance, report the hash; the runner re-reads balances.
          txs.push({ chain: this.chain, id: e.id, description: desc, simulated: false, unconfirmed: true, nonce: e.nonce });
          const msg = `${this.id}: swap broadcast unconfirmed (may have landed) hash=${e.id}: ${e.message}`;
          ctx.log("error", msg);
          return { ok: false, txs, detail: msg };
        }
        if (ctx.dryRun && txs.length && e instanceof SimulationError) {
          // eth_call cannot see an approval that was only simulated; everything else was verified.
          ctx.log("warn", `[dry-run] ${this.id}: swap simulation reverted with the approval pending — calldata verified, not simulated`, { reason: e.message });
          return { ok: true, txs, detail: `dry-run: calldata verified (router allowlisted, recipient, min-out ${minOut}); swap simulation needs the approval mined first`, amountUsd: fromUnits(q.amountOut, to.decimals) * (await ctx.priceUsd(to)) };
        }
        if (!ctx.dryRun && approvals.length) {
          // We granted an allowance for a swap that did not happen: take it back.
          try {
            txs.push(await sendTx(this.env, ctx, { to: tokenIn, data: call(erc20Abi, "approve", [router, 0n]), description: `reset allowance ${tokenIn} -> ${router} after failed swap` }));
          } catch (re) {
            ctx.log("error", `${this.id}: allowance reset to ${router} failed: ${(re as Error).message}`);
            throw new Error(`${(e as Error).message}; allowance reset FAILED: ${(re as Error).message}`);
          }
        }
        throw e;
      }
      const pOut = await ctx.priceUsd(to);
      if (ctx.dryRun) return { ok: true, txs, detail: `dry-run: min-out ${minOut}`, amountUsd: fromUnits(q.amountOut, to.decimals) * pOut };
      const received = (await erc20Balance(this.env, tokenOut)) - before;
      if (received < minOut) ctx.log("error", `${this.id}: received ${received} < min-out ${minOut} (balance diff)`, {});
      return { ok: received >= minOut, txs, detail: `received ${received} (min ${minOut})`, amountUsd: fromUnits(received, to.decimals) * pOut };
    } catch (e) {
      if (e instanceof BroadcastUnconfirmedError) {
        // e.g. the approval: it may have landed; nothing else was sent after it
        txs.push({ chain: this.chain, id: e.id, description: e.description, simulated: false, unconfirmed: true, nonce: e.nonce });
        const msg = `${this.id}: broadcast unconfirmed (may have landed) hash=${e.id}: ${e.message}`;
        ctx.log("error", msg);
        return { ok: false, txs, detail: msg };
      }
      const msg = `${this.id}: swap rejected: ${(e as Error).message}`;
      ctx.log("error", msg);
      return { ok: false, txs, detail: msg };
    }
  }

  /** On-chain check of every allowlisted router (+ RPC chain id). Empty = ok. */
  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    try {
      await assertChainId(this.env);
    } catch (e) {
      issues.push((e as Error).message);
    }
    for (const c of this.clients) {
      for (const r of this.allow[c.name]) {
        try {
          issues.push(...(await c.verifyRouter(this.env, getAddress(r) as Address)));
        } catch (e) {
          issues.push(`${c.name} router ${r}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    return issues;
  }
}
