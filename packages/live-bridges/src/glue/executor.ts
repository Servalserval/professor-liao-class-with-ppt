/**
 * Core BridgeExecutor (USD interface) on top of live BridgeAdapters.
 *
 * send(t):  hop = t.path[t.hop]; amount = t.receivedUsd ?? t.amountUsd; kind -> adapter;
 *           (chain, symbol) -> AssetRef via the registry; USD -> units with ctx.priceUsd,
 *           clamped to the wallet balance (hop > 0 always; hop 0 only within 0.5%);
 *           recipient = our own address on the destination; quotes the hop and refuses (nothing
 *           sent) when the live fee+gas exceeds max(1.25 x planned, planned + $0.50), planned =
 *           routeCostUsd(hop, amount); returns the adapter handle as `ref`.
 *           ok:false only when nothing left the wallet (adapters guarantee ok:true + handle
 *           once anything was broadcast).
 * poll(t):  adapter.status(t.ref):
 *             pending   -> in_flight (pending + `unconfirmed` for > 2x route ETA -> stuck)
 *             claimable -> complete() (simulated first; dry-run stays claimable)
 *                          -> re-check: completed | in_flight
 *             completed -> completed, receivedUsd from the received units
 *             failed    -> failed (+ refundedUsd when the adapter proved nothing left)
 *                          "recoverable: ..." details -> stuck (retryable, funds not lost)
 */
import { routeCostUsd, type BridgeExecutor, type BridgePollResult, type InFlightTransfer, type RouteKind, type RouteSpec } from "@incentive-router/core";
import type { AssetRef, BridgeAdapter, LiveContext } from "@incentive-router/live-common";
import { unitsToUsd, usdToUnits } from "@incentive-router/live-common";
import { errMsg, RECOVERABLE, type LiveBridgeStatus } from "../common.js";

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
  /** Wallet balance of an asset (base units). Enables clamping the send amount to what we hold. */
  balance?: (asset: AssetRef) => Promise<bigint>;
  /** Hop 0: clamp to the balance when it is at most this far below the request (default 50 bps = 0.5%). */
  hop0ClampBps?: number;
  /** Live-cost guard: refuse when quoted cost > max(costRatio x planned, planned + costSlackUsd). Defaults 1.25 / 0.5. */
  costRatio?: number;
  costSlackUsd?: number;
  now?: () => number;
}

/** Our address per chain from EVM envs (+ optional Sui env). */
export function recipientsFromEnvs(evm: Record<string, { account: string }>, sui?: { address: string }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [c, e] of Object.entries(evm)) out[c] = e.account;
  if (sui) out.sui = sui.address;
  return out;
}

export type PollResult = BridgePollResult;

export class LiveBridgeExecutor implements BridgeExecutor {
  private readonly adapters = new Map<string, BridgeAdapter>();
  private readonly registry: AssetRegistry;

  constructor(private readonly o: LiveBridgeExecutorOptions) {
    const list = Array.isArray(o.adapters) ? o.adapters.map((a) => [a.kind, a] as const) : Object.entries(o.adapters);
    for (const [k, a] of list) if (a) this.adapters.set(k, a);
    this.registry = typeof o.registry === "function" ? o.registry : registryFromTable(o.registry);
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
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

  /** Requested units, clamped to the wallet balance (hop > 0 always; hop 0 only within hop0ClampBps). */
  private async sendUnits(t: InFlightTransfer, from: AssetRef, requested: bigint): Promise<{ units: bigint; note?: string } | string> {
    if (!this.o.balance) return { units: requested };
    const bal = await this.o.balance(from);
    if (bal >= requested) return { units: requested };
    if (t.hop > 0) {
      if (bal <= 0n) return `hop ${t.hop}: no ${from.symbol} on ${from.chain} to send`;
      return { units: bal, note: `clamped to balance ${bal} (requested ${requested})` };
    }
    const floor = (requested * BigInt(10_000 - Math.round(this.o.hop0ClampBps ?? 50))) / 10_000n;
    if (bal >= floor && bal > 0n) return { units: bal, note: `clamped to balance ${bal} (requested ${requested}, within tolerance)` };
    return `insufficient ${from.symbol} on ${from.chain}: balance ${bal} < requested ${requested}`;
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
    const amountUsd = t.receivedUsd ?? t.amountUsd;
    if (!(amountUsd > 0)) return { ok: false, detail: `bad amount ${amountUsd} USD` };
    const { ctx } = this.o;

    // Everything before adapter.send moves no money: errors -> ok:false.
    let price: number;
    let units: bigint;
    let note: string | undefined;
    try {
      price = await ctx.priceUsd(from);
      const requested = usdToUnits(amountUsd, price, from.decimals);
      const s = await this.sendUnits(t, from, requested);
      if (typeof s === "string") return { ok: false, detail: s };
      units = s.units;
      note = s.note;
      if (units <= 0n) return { ok: false, detail: `amount rounds to 0 units` };
    } catch (e) {
      return { ok: false, detail: `${adapter.kind} pre-send: ${errMsg(e)}` };
    }
    const sentUsd = unitsToUsd(units, price, from.decimals);

    // Live cost guard (the one-day friction rule was checked against the planned RouteSpec costs).
    let costNote: string;
    try {
      const q = await adapter.quote(from, to, units, ctx);
      const quoted = q.feeUsd + q.gasSrcUsd + q.gasDstUsd;
      const planned = routeCostUsd(hop, sentUsd);
      const limit = Math.max((this.o.costRatio ?? 1.25) * planned, planned + (this.o.costSlackUsd ?? 0.5));
      costNote = `quoted cost $${quoted.toFixed(4)} (fee ${q.feeUsd.toFixed(4)} + gas ${q.gasSrcUsd.toFixed(4)}/${q.gasDstUsd.toFixed(4)}) vs planned $${planned.toFixed(4)}, limit $${limit.toFixed(4)}`;
      if (!(quoted <= limit)) return { ok: false, detail: `refused, nothing sent: ${costNote}` };
    } catch (e) {
      return { ok: false, detail: `${adapter.kind} quote failed, nothing sent: ${errMsg(e)}` };
    }
    const what = `sent ${sentUsd.toFixed(6)} USD (${units} units ${from.symbol} ${from.chain} -> ${to.chain})${note ? `; ${note}` : ""}; ${costNote}`;

    let res;
    try {
      res = await adapter.send(from, to, units, recipient, ctx);
    } catch (e) {
      // Adapters must not throw (they return ok:false before broadcast, ok:true + handle after).
      return { ok: false, detail: `${adapter.kind} send threw (adapter contract violation): ${errMsg(e)}` };
    }
    if (!res.ok) return { ok: false, detail: res.detail ?? `${adapter.kind} send failed` };
    if (ctx.dryRun) return { ok: true, detail: `dry-run: ${res.detail ?? "simulated"}; would have ${what}` };
    if (!res.handle) {
      const ids = res.txs.filter((x) => !x.simulated && x.id).map((x) => x.id);
      // Something was broadcast (or the adapter says ok): never report ok:false here; poll() marks it stuck.
      return { ok: true, detail: `${what}; adapter returned no handle (txs: ${ids.join(",") || "none"}) — check manually` };
    }
    return { ok: true, ref: res.handle, detail: res.detail ? `${what}; ${res.detail}` : what };
  }

  async poll(t: InFlightTransfer): Promise<BridgePollResult> {
    const hop = t.path[t.hop];
    if (!hop) return { state: "failed", ref: t.ref, detail: `no hop ${t.hop}` };
    if (t.ref === "noop") return { state: "completed", ref: t.ref, receivedUsd: t.receivedUsd ?? t.amountUsd };
    if (!t.ref) {
      if (this.o.ctx.dryRun || t.state === "planned") return { state: t.state, detail: "no bridge handle (not sent, or dry-run)" };
      return { state: "stuck", detail: `${RECOVERABLE} hop ${t.hop} has no bridge handle; check the source wallet / explorer manually` };
    }
    const r = this.resolve(hop);
    if (typeof r === "string") return { state: t.state, ref: t.ref, detail: r };
    const { adapter, from, to } = r;
    const { ctx } = this.o;

    let ref = t.ref;
    let st: LiveBridgeStatus;
    try {
      st = (await adapter.status(ref, ctx)) as LiveBridgeStatus;
    } catch (e) {
      return this.pendingResult(t, hop, ref, `status error: ${errMsg(e)}`);
    }
    if (st.handle) ref = st.handle; // adapter advanced its handle (cursor / recovered ids): router persists poll refs

    if (st.state === "claimable") {
      if (!adapter.complete) return { state: "claimable", ref, detail: st.detail };
      let res;
      try {
        res = await adapter.complete(ref, ctx);
      } catch (e) {
        return { state: "claimable", ref, detail: `complete error: ${errMsg(e)}` };
      }
      if (!res.ok) return { state: "claimable", ref, detail: res.detail ?? "complete failed" };
      if (ctx.dryRun) return { state: "claimable", ref, detail: `dry-run: ${res.detail ?? "complete simulated"}` };
      try {
        st = (await adapter.status(ref, ctx)) as LiveBridgeStatus;
      } catch (e) {
        return { state: "in_flight", ref, detail: `completed on destination; status re-check failed: ${errMsg(e)}` };
      }
      if (st.handle) ref = st.handle;
      if (st.state !== "completed") {
        const dst = res.txs.map((x) => x.id).filter(Boolean).join(",");
        return { state: "in_flight", ref, detail: `destination tx ${dst || "sent"}; waiting for confirmation` };
      }
    }
    return this.mapFinal(st, t, hop, from, to, ref);
  }

  /** pending: in_flight, or stuck when progress could not be confirmed for > 2x the route ETA. */
  private pendingResult(t: InFlightTransfer, hop: RouteSpec, ref: string | undefined, unconfirmed?: string): BridgePollResult {
    if (!unconfirmed) return { state: "in_flight", ref };
    const started = t.hopStartedAtMs ?? (t.hop === 0 ? t.createdAtMs : undefined);
    const limitMs = 2 * Math.max(1, hop.etaMinutes) * 60_000;
    if (started !== undefined && this.now() - started > limitMs) {
      const mins = Math.round((this.now() - started) / 60_000);
      return { state: "stuck", ref, detail: `${RECOVERABLE} no confirmed progress for ${mins} min (> 2x ETA ${hop.etaMinutes} min): ${unconfirmed}` };
    }
    return { state: "in_flight", ref, detail: unconfirmed };
  }

  private async usd(units: bigint, asset: AssetRef): Promise<number | undefined> {
    try {
      return unitsToUsd(units, await this.o.ctx.priceUsd(asset), asset.decimals);
    } catch {
      return undefined;
    }
  }

  private async mapFinal(st: LiveBridgeStatus, t: InFlightTransfer, hop: RouteSpec, from: AssetRef, to: AssetRef, ref: string | undefined): Promise<BridgePollResult> {
    switch (st.state) {
      case "pending":
        return this.pendingResult(t, hop, ref, st.unconfirmed);
      case "claimable":
        return { state: "claimable", ref, detail: st.detail };
      case "completed": {
        const receivedUsd = st.received !== undefined ? await this.usd(st.received, to) : undefined;
        return { state: "completed", ref, receivedUsd, detail: st.dstTx ? `dst tx ${st.dstTx}` : undefined };
      }
      case "failed": {
        const refundedUsd = st.refunded !== undefined ? await this.usd(st.refunded, from) : undefined;
        const state = st.detail.startsWith(RECOVERABLE) ? "stuck" : "failed";
        return refundedUsd !== undefined ? { state, ref, detail: st.detail, refundedUsd } : { state, ref, detail: st.detail };
      }
    }
  }
}
