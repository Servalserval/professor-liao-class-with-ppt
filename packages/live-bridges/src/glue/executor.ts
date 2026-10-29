/**
 * Core BridgeExecutor (USD interface) on top of live BridgeAdapters.
 *
 * send(t):  hop = t.path[t.hop]; kind -> adapter; (chain, symbol) -> AssetRef via the
 *           registry; USD -> units with ctx.priceUsd; recipient = our own address on
 *           the destination; returns the adapter handle as `ref`.
 * poll(t):  adapter.status(t.ref):
 *             pending   -> in_flight
 *             claimable -> complete() (simulated first; dry-run stays claimable)
 *                          -> re-check: completed | in_flight
 *             completed -> completed, receivedUsd from the received units
 *             failed    -> failed ("recoverable: ..." details -> stuck: retryable, funds not lost)
 */
import type { BridgeExecutor, InFlightTransfer, RouteKind, RouteSpec, TransferState } from "@incentive-router/core";
import type { AssetRef, BridgeAdapter, BridgeStatus, LiveContext } from "@incentive-router/live-common";
import { unitsToUsd, usdToUnits } from "@incentive-router/live-common";
import { errMsg } from "../common.js";

/** (chain, canonical symbol) -> AssetRef. */
export type AssetRegistry = (chain: string, symbol: string) => AssetRef | undefined;

export function registryFromTable(table: Record<string, Record<string, AssetRef>>): AssetRegistry {
  return (chain, symbol) => table[chain]?.[symbol] ?? table[chain]?.[symbol.toUpperCase()];
}

export interface LiveBridgeExecutorOptions {
  adapters: BridgeAdapter[] | Partial<Record<RouteKind | string, BridgeAdapter>>;
  registry: AssetRegistry | Record<string, Record<string, AssetRef>>;
  /** Our own address per chain (see recipientsFromEnvs). */
  recipients: Record<string, string>;
  ctx: LiveContext;
}

/** Our address per chain from EVM envs (+ optional Sui env). */
export function recipientsFromEnvs(evm: Record<string, { account: string }>, sui?: { address: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [c, e] of Object.entries(evm)) out[c] = e.account;
  if (sui) out.sui = sui.address;
  return out;
}

export type PollResult = { state: TransferState; ref?: string; detail?: string; receivedUsd?: number };

export class LiveBridgeExecutor implements BridgeExecutor {
  private readonly adapters = new Map<string, BridgeAdapter>();
  private readonly registry: AssetRegistry;

  constructor(private readonly o: LiveBridgeExecutorOptions) {
    const list = Array.isArray(o.adapters) ? o.adapters.map((a) => [a.kind, a] as const) : Object.entries(o.adapters);
    for (const [k, a] of list) if (a) this.adapters.set(k, a);
    this.registry = typeof o.registry === "function" ? o.registry : registryFromTable(o.registry);
  }

  private resolve(hop: RouteSpec): { adapter: BridgeAdapter; from: AssetRef; to: AssetRef } | string {
    const adapter = this.adapters.get(hop.kind);
    if (!adapter) return `no live adapter for route kind "${hop.kind}" (${hop.id})`;
    const from = this.registry(hop.from.chain, hop.from.asset);
    const to = this.registry(hop.to.chain, hop.to.asset);
    if (!from) return `unknown asset ${hop.from.chain}:${hop.from.asset}`;
    if (!to) return `unknown asset ${hop.to.chain}:${hop.to.asset}`;
    return { adapter, from, to };
  }

  async send(t: InFlightTransfer): Promise<{ ok: boolean; ref?: string; detail?: string }> {
    const hop = t.path[t.hop];
    if (!hop) return { ok: false, detail: `transfer ${t.id}: no hop ${t.hop}` };
    if (!hop.enabled) return { ok: false, detail: `route ${hop.id} is disabled` };
    if (hop.kind === "noop") return { ok: true, ref: "noop" };
    const r = this.resolve(hop);
    if (typeof r === "string") return { ok: false, detail: r };
    const { adapter, from, to } = r;
    const recipient = this.o.recipients[to.chain];
    if (!recipient) return { ok: false, detail: `no own address configured for ${to.chain}` };
    if (!adapter.supports(from, to)) return { ok: false, detail: `${adapter.kind} does not support ${from.chain}:${from.symbol} -> ${to.chain}:${to.symbol}` };
    if (!(t.amountUsd > 0)) return { ok: false, detail: `bad amountUsd ${t.amountUsd}` };
    const { ctx } = this.o;
    try {
      const price = await ctx.priceUsd(from);
      const units = usdToUnits(t.amountUsd, price, from.decimals);
      if (units <= 0n) return { ok: false, detail: `amount rounds to 0 units` };
      const res = await adapter.send(from, to, units, recipient, ctx);
      if (!res.ok) return { ok: false, detail: res.detail ?? `${adapter.kind} send failed` };
      if (ctx.dryRun) return { ok: true, detail: `dry-run: ${res.detail ?? "simulated"}` };
      if (!res.handle) return { ok: false, detail: `${adapter.kind} sent but returned no handle (txs: ${res.txs.map((x) => x.id).join(",")})` };
      return { ok: true, ref: res.handle, detail: res.detail };
    } catch (e) {
      return { ok: false, detail: `${adapter.kind} send: ${errMsg(e)}` };
    }
  }

  async poll(t: InFlightTransfer): Promise<PollResult> {
    const hop = t.path[t.hop];
    if (!hop) return { state: "failed", ref: t.ref, detail: `no hop ${t.hop}` };
    if (t.ref === "noop") return { state: "completed", ref: t.ref, receivedUsd: t.amountUsd };
    if (!t.ref) return { state: t.state, detail: "no bridge handle (not sent, or dry-run)" };
    const r = this.resolve(hop);
    if (typeof r === "string") return { state: t.state, ref: t.ref, detail: r };
    const { adapter, to } = r;
    const { ctx } = this.o;

    let st: BridgeStatus;
    try {
      st = await adapter.status(t.ref, ctx);
    } catch (e) {
      return { state: "in_flight", ref: t.ref, detail: `status error: ${errMsg(e)}` };
    }

    if (st.state === "claimable") {
      if (!adapter.complete) return { state: "claimable", ref: t.ref, detail: st.detail };
      let res;
      try {
        res = await adapter.complete(t.ref, ctx);
      } catch (e) {
        return { state: "claimable", ref: t.ref, detail: `complete error: ${errMsg(e)}` };
      }
      if (!res.ok) return { state: "claimable", ref: t.ref, detail: res.detail ?? "complete failed" };
      if (ctx.dryRun) return { state: "claimable", ref: t.ref, detail: `dry-run: ${res.detail ?? "complete simulated"}` };
      try {
        st = await adapter.status(t.ref, ctx);
      } catch (e) {
        return { state: "in_flight", ref: t.ref, detail: `completed on destination; status re-check failed: ${errMsg(e)}` };
      }
      if (st.state !== "completed") {
        const dst = res.txs.map((x) => x.id).filter(Boolean).join(",");
        return { state: "in_flight", ref: t.ref, detail: `destination tx ${dst || "sent"}; waiting for confirmation` };
      }
    }
    return this.mapFinal(st, t, to);
  }

  private async mapFinal(st: BridgeStatus, t: InFlightTransfer, to: AssetRef): Promise<PollResult> {
    switch (st.state) {
      case "pending":
        return { state: "in_flight", ref: t.ref };
      case "claimable":
        return { state: "claimable", ref: t.ref, detail: st.detail };
      case "completed": {
        let receivedUsd: number | undefined;
        if (st.received !== undefined) {
          try {
            receivedUsd = unitsToUsd(st.received, await this.o.ctx.priceUsd(to), to.decimals);
          } catch {
            receivedUsd = undefined;
          }
        }
        return { state: "completed", ref: t.ref, receivedUsd, detail: st.dstTx ? `dst tx ${st.dstTx}` : undefined };
      }
      case "failed":
        return { state: st.detail.startsWith("recoverable:") ? "stuck" : "failed", ref: t.ref, detail: st.detail };
    }
  }
}
