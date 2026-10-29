/**
 * Second independent review (core + runner): one test group per finding.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { planAllocation } from "../src/allocator.js";
import { deepMerge } from "../src/config.js";
import { PaperExecutor, type ExecResult } from "../src/executor.js";
import { entryBlockers } from "../src/gates/entry.js";
import { decideExit } from "../src/gates/exit.js";
import { Router, type CycleReport } from "../src/monitor.js";
import { CollectingNotifier, TelegramNotifier } from "../src/notify.js";
import { newHistory, type History } from "../src/signals.js";
import { loopPairOpportunity, LoopPairSource, type LoopLeg, type LoopPair } from "../src/sources/loopPair.js";
import { StaticSource, type StaticOppSpec } from "../src/sources/static.js";
import { FileStore, idleInvariantOk, MemoryStore, newState, type RouterState } from "../src/store.js";
import type { Action, Opportunity, Position } from "../src/types.js";
import { constantStream } from "../src/valuation.js";
import { FundingPlanner } from "../src/xchain/planner.js";
import { routeCostUsd } from "../src/xchain/routes.js";
import type { BridgeExecutor, BridgePollResult, InFlightTransfer, RouteSpec, TransferState } from "../src/xchain/types.js";
import { cfgWith, close, dctx, HOUR, NOW, opp, position, sctx } from "./helpers.js";

const MIN = 60_000;
const exits = (a: Action[]) => a.filter((x): x is Extract<Action, { type: "exit" }> => x.type === "exit");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const leg = (symbol: string, over: Partial<LoopLeg> = {}): LoopLeg => ({
  symbol,
  priceUsd: 1,
  totalSupplyUsd: 50e6,
  totalBorrowUsd: 40e6,
  supplyAprBase: 0.06,
  borrowAprBase: 0.08,
  supplyRewards: [],
  borrowRewards: [],
  ...over,
});

/** USDC/USDT pair: pool capacity 30M, swap capacity 20M x L/(L-1) = 28.6M -> swap binds. */
const pair = (over: Partial<LoopPair> = {}): LoopPair => ({
  protocol: "navi",
  chain: "sui",
  pairId: "USDC/USDT",
  collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, supplyAprBase: 0.1, borrowAprBase: 0.07 }),
  debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, supplyAprBase: 0.04, borrowAprBase: 0.06 }),
  maxLtv: 0.9,
  liqLtv: 0.93,
  swapCostFrac: 0.0005,
  swapDepthUsd: 20e6,
  myLtv: 0.7,
  ...over,
});
const PID = "s:navi:USDC/USDT";

function histWith(points: { ago: number; depth?: number; cost?: number }[]): History {
  const h = newHistory();
  h.opps[PID] = points.map((p) => ({
    t: NOW - p.ago,
    capacityUsd: 0,
    rewardAprExMe: 0,
    metrics: { ...(p.depth !== undefined ? { swap_depth_usd: p.depth } : {}), ...(p.cost !== undefined ? { swap_cost_frac: p.cost } : {}) },
  }));
  return h;
}

function route(id: string, from: string, to: string, over: Partial<RouteSpec> = {}): RouteSpec {
  const [fc, fa] = from.split(":") as [string, string];
  const [tc, ta] = to.split(":") as [string, string];
  return {
    id,
    kind: "cctp_v2_fast",
    from: { chain: fc, asset: fa },
    to: { chain: tc, asset: ta },
    feeBps: 1,
    feeFixedUsd: 0,
    gasSrcUsd: 0.5,
    gasDstUsd: 0.5,
    etaMinutes: 20,
    enabled: true,
    ...over,
  };
}

/** Scriptable bridge: records what was persisted when send() was called. */
class ScriptBridge implements BridgeExecutor {
  sends: { id: string; hop: number; persisted?: { hop: number; state: TransferState } }[] = [];
  state: TransferState = "in_flight";
  receivedUsd?: number;
  throwOnSend = false;
  constructor(private readonly store?: MemoryStore) {}
  async send(t: InFlightTransfer) {
    const saved = this.store?.load().transfers.find((x) => x.id === t.id);
    this.sends.push({ id: t.id, hop: t.hop, persisted: saved ? { hop: saved.hop, state: saved.state } : undefined });
    if (this.throwOnSend) throw new Error("rpc timeout after broadcast?");
    return { ok: true, ref: `ref-${t.hop}` };
  }
  async poll(): Promise<BridgePollResult> {
    return { state: this.state, receivedUsd: this.receivedUsd };
  }
}

const ARB = "arbitrum:USDC";
const SUI = "sui:USDC";
const ETH = "ethereum:USDC";

function xrouter(o: {
  idle: Record<string, number>;
  specs?: StaticOppSpec[];
  routes?: RouteSpec[];
  bridge?: (store: MemoryStore) => BridgeExecutor;
  idleBalances?: () => Promise<Record<string, number>>;
  state?: (s: RouterState) => void;
  cfgOver?: Record<string, unknown>;
}) {
  let t = NOW;
  const routes = o.routes ?? [route("arb-sui", ARB, SUI)];
  const cfg = cfgWith(deepMerge({ xchain: { enabled: true, routes } }, o.cfgOver ?? {}));
  const st = newState(0, o.idle);
  o.state?.(st);
  const store = new MemoryStore(st);
  const bridge = o.bridge ? o.bridge(store) : new ScriptBridge(store);
  const notifier = new CollectingNotifier();
  const specs = o.specs ?? [
    { id: "s", kind: "deposit", venue: "navi", chain: "sui", token: "USDC", capacity_usd: 50e6, streams: [{ label: "base", kind: "base", apr: 0.15 }] },
  ];
  const router = new Router({
    cfg,
    sources: [new StaticSource(specs, "static", NOW)],
    executors: { static: new PaperExecutor() },
    store,
    notifier,
    tokens: () => ({}),
    now: () => t,
    paperAccrual: true,
    bridges: Object.fromEntries(routes.map((r) => [r.kind, bridge])),
    idleBalances: o.idleBalances,
  });
  const cycle = async (): Promise<CycleReport> => {
    const r = await router.cycle();
    assert.ok(idleInvariantOk(store.load()));
    return r;
  };
  return { router, store, notifier, bridge, cycle, tick: (h = 1) => (t += h * HOUR) };
}

const crit = (n: CollectingNotifier, re: RegExp) => n.messages.filter((m) => m.level === "critical" && re.test(m.text));

// ---------------------------------------------------------------------------
// 1. failed swap probe
// ---------------------------------------------------------------------------

describe("review #1: unknown swap quotes never cause an exit by themselves", () => {
  it("NaN depth without recent history: not reported (blind), never a 0-capacity opportunity", () => {
    assert.equal(loopPairOpportunity(pair({ swapDepthUsd: NaN }), sctx(), "s"), null);
    const stale = { ...sctx(), history: histWith([{ ago: 30 * MIN, depth: 20e6 }]) }; // older than max_data_age_minutes (10)
    assert.equal(loopPairOpportunity(pair({ swapDepthUsd: NaN }), stale, "s"), null);
  });

  it("NaN depth with recent quotes: capacity from them, estimated + reused, entries blocked", () => {
    const ctx = { ...sctx(), history: histWith([{ ago: 3 * MIN, depth: 18e6 }, { ago: 2 * MIN, depth: 20e6 }, { ago: 1 * MIN, depth: 22e6 }]) };
    const o = loopPairOpportunity(pair({ swapDepthUsd: NaN }), ctx, "s")!;
    const L = o.meta!["leverage"] as number;
    assert.ok(close(o.liquidity.exitCapacityUsd, (20e6 * L) / (L - 1)), "median of the last 3");
    assert.equal(o.liquidity.estimated, true);
    assert.equal(o.liquidity.reusedQuote, true);
    assert.equal(o.liquidity.binding, "swap");
    assert.equal(o.metrics["swap_depth_usd"], undefined, "a reused quote is not recorded as fresh");
    assert.ok(o.flags.some((f) => f.name === "swap_quote_unknown" && f.severity === "warn"));
    assert.ok(entryBlockers(o, dctx()).some((b) => b.includes("swap_quote_unknown")));
  });

  it("NaN cost: last recent cost, else unknown_swap_cost_frac; estimated and entry-blocked", () => {
    const withHist = loopPairOpportunity(pair({ swapCostFrac: NaN }), { ...sctx(), history: histWith([{ ago: MIN, cost: 0.001, depth: 20e6 }]) }, "s")!;
    const L = withHist.meta!["leverage"] as number;
    assert.ok(close(withHist.costs.exitFrac, (L - 1) * 0.001));
    const fallback = loopPairOpportunity(pair({ swapCostFrac: NaN }), sctx(), "s")!;
    assert.ok(close(fallback.costs.exitFrac, (L - 1) * 0.003));
    for (const o of [withHist, fallback]) {
      assert.equal(o.liquidity.estimated, true);
      assert.ok(o.flags.some((f) => f.name === "swap_quote_unknown"));
      assert.equal(o.metrics["swap_cost_frac"], undefined);
    }
    const fresh = loopPairOpportunity(pair(), sctx(), "s")!;
    assert.equal(fresh.metrics["swap_cost_frac"], 0.0005);
    assert.equal(fresh.metrics["swap_depth_usd"], 20e6);
    assert.equal(fresh.liquidity.estimated, undefined);
  });

  it("depth is smoothed (median of the last 3): one bad quote does not drain the capacity", () => {
    const ctx = { ...sctx(), history: histWith([{ ago: 2 * MIN, depth: 20e6 }, { ago: MIN, depth: 20e6 }]) };
    const o = loopPairOpportunity(pair({ swapDepthUsd: 1_000 }), ctx, "s")!;
    const L = o.meta!["leverage"] as number;
    assert.ok(close(o.liquidity.exitCapacityUsd, (20e6 * L) / (L - 1)));
    assert.equal(o.metrics["swap_depth_usd"], 1_000, "the raw quote is still recorded");
    // two bad quotes in a row are believed
    const ctx2 = { ...sctx(), history: histWith([{ ago: 2 * MIN, depth: 20e6 }, { ago: MIN, depth: 1_000 }]) };
    assert.ok(close(loopPairOpportunity(pair({ swapDepthUsd: 1_000 }), ctx2, "s")!.liquidity.exitCapacityUsd, (1_000 * L) / (L - 1)));
  });

  it("a held position is not exited because of a reused quote (no estimate haircut on the exit side)", () => {
    const ctx = { ...sctx(), history: histWith([{ ago: MIN, depth: 20e6 }]) };
    const o = loopPairOpportunity(pair({ swapDepthUsd: NaN }), ctx, "s")!;
    // 1.5M equity x 3.33 = 5M = 17.5% of 28.6M: fine unhaircut, 35% if it were haircut by 0.5
    const p = position(o, 1_500_000);
    const d = decideExit(p, o, [], dctx({ equity: 10e6, positions: [p] }));
    assert.equal(exits(d.actions).length, 0, JSON.stringify(d.actions));
    assert.equal(d.pending["liquidity:swap"], undefined, "not even a breach under confirmation");
    // the same capacity marked as a discovery estimate (no reused quote) IS haircut
    const guessed = { ...o, liquidity: { ...o.liquidity, reusedQuote: undefined } };
    assert.equal(decideExit(p, guessed, [], dctx({ equity: 10e6, positions: [p] })).pending["liquidity:swap"], 1);
  });

  it("1/5 rule: immediate when pool liquidity binds, confirm_cycles when swap depth binds", () => {
    const mk = (binding: "pool" | "swap") =>
      opp({ id: "lp", liquidity: { exitCapacityUsd: 1_000_000, footprintPerEquity: 1, binding } });
    const pool = mk("pool");
    const pp = position(pool, 250_000);
    assert.equal(exits(decideExit(pp, pool, [], dctx({ positions: [pp], equity: 1e6 })).actions).length, 1);
    const swap = mk("swap");
    const ps = position(swap, 250_000);
    const d1 = decideExit(ps, swap, [], dctx({ positions: [ps], equity: 1e6 }));
    assert.equal(exits(d1.actions).length, 0);
    assert.equal(d1.pending["liquidity:swap"], 1);
    const d2 = decideExit({ ...ps, pending: d1.pending, pendingSince: d1.pendingSince }, swap, [], dctx({ positions: [ps], equity: 1e6 }));
    const e = exits(d2.actions);
    assert.equal(e.length, 1);
    assert.equal(e[0]!.urgent, true);
    // the counter resets when the breach goes away
    const ok = mk("swap");
    ok.liquidity.exitCapacityUsd = 10e6;
    assert.equal(decideExit({ ...ps, pending: d1.pending }, ok, [], dctx({ positions: [ps], equity: 1e6 })).pending["liquidity:swap"], undefined);
  });

  it("capacity_drop: immediate when pool-driven, confirm_cycles when swap depth binds", () => {
    const drop = { name: "capacity_drop", severity: "exit" as const, detail: "-40%" };
    const pool = opp({ id: "a", flags: [drop], liquidity: { exitCapacityUsd: 10e6, footprintPerEquity: 1, binding: "pool" } });
    const p = position(pool, 10_000);
    assert.equal(exits(decideExit(p, pool, [], dctx({ positions: [p] })).actions).length, 1);
    const swap = opp({ id: "a", flags: [drop], liquidity: { exitCapacityUsd: 10e6, footprintPerEquity: 1, binding: "swap" } });
    const d1 = decideExit(p, swap, [], dctx({ positions: [p] }));
    assert.equal(exits(d1.actions).length, 0);
    const d2 = decideExit({ ...p, pending: d1.pending }, swap, [], dctx({ positions: [p] }));
    assert.equal(exits(d2.actions).length, 1);
    // any other exit flag stays immediate
    const paused = opp({ id: "a", flags: [{ name: "market_paused", severity: "exit" }], liquidity: { exitCapacityUsd: 10e6, footprintPerEquity: 1, binding: "swap" } });
    assert.equal(exits(decideExit(p, paused, [], dctx({ positions: [p] })).actions).length, 1);
  });

  it("router: one failed quote on a held pair is a warning, not an exit; history comes from state", async () => {
    let cur = pair();
    let t = NOW;
    const src = new LoopPairSource("s", async () => [cur]);
    const o0 = loopPairOpportunity(cur, sctx(), "s")!;
    const st = newState(9_000_000);
    st.positions.push(position(o0, 1_000_000, { sourceId: "s" }));
    const store = new MemoryStore(st);
    const notifier = new CollectingNotifier();
    const router = new Router({ cfg: cfgWith(), sources: [src], executors: { s: new PaperExecutor() }, store, notifier, tokens: () => ({}), now: () => t, paperAccrual: true });
    await router.cycle(); // records a fresh quote
    cur = pair({ swapDepthUsd: NaN, swapCostFrac: NaN });
    t += MIN;
    const r1 = await router.cycle();
    assert.equal(r1.executed.filter((x) => x.action.type === "exit").length, 0);
    assert.equal(store.load().positions[0]!.blindCycles, 0, "reported (from history), not blind");
    assert.ok(notifier.messages.some((m) => m.text.includes("swap_quote_unknown")));
    // long outage: no recent quote any more -> blind, still no exit until blind_exit_cycles
    t += 30 * MIN;
    const r2 = await router.cycle();
    assert.equal(r2.executed.filter((x) => x.action.type === "exit").length, 0);
    assert.equal(store.load().positions[0]!.blindCycles, 1);
  });
});

// ---------------------------------------------------------------------------
// 2. fake drawdowns
// ---------------------------------------------------------------------------

describe("review #2: no fake drawdowns", () => {
  it("a one-cycle equity dip does not fire the kill switch; it must persist kill_confirm_cycles", async () => {
    let idle = 100_000;
    let t = NOW;
    const store = new MemoryStore(newState(100_000));
    const notifier = new CollectingNotifier();
    const router = new Router({ cfg: cfgWith(), sources: [], executors: {}, store, notifier, tokens: () => ({}), now: () => t, idleUsd: async () => idle });
    await router.cycle();
    idle = 80_000; // one bad wallet read
    t += MIN;
    assert.equal((await router.cycle()).killed, false);
    assert.equal(store.load().killPending, 1);
    idle = 100_000;
    t += MIN;
    assert.equal((await router.cycle()).killed, false);
    assert.equal(store.load().killPending, 0, "reset when the drawdown is gone");
    idle = 80_000;
    t += MIN;
    assert.equal((await router.cycle()).killed, false);
    t += MIN;
    assert.equal((await router.cycle()).killed, true, "fires on the second consecutive cycle");
    // configurable
    const one = new MemoryStore(newState(100_000));
    let i1 = 100_000;
    const r1 = new Router({ cfg: cfgWith({ portfolio: { kill_confirm_cycles: 1 } }), sources: [], executors: {}, store: one, notifier, tokens: () => ({}), now: () => t, idleUsd: async () => i1 });
    await r1.cycle();
    i1 = 80_000;
    t += MIN;
    assert.equal((await r1.cycle()).killed, true);
  });

  it("a partial wallet read keeps the buckets it does not contain (covered in xchain-router) and never zeroes them", async () => {
    const r = xrouter({ idle: { [ARB]: 100_000, [SUI]: 10 }, specs: [], idleBalances: async () => ({ [SUI]: 20 }) });
    const c = await r.cycle();
    assert.deepEqual(c.idle, { [ARB]: 100_000, [SUI]: 20 });
    assert.ok(close(c.totalEquityUsd, 100_020));
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. crash safety, unknown sends, manual resolution
// ---------------------------------------------------------------------------

describe("review #3/#4: crash safety and manual resolution of transfers", () => {
  it("every hop is persisted as planned BEFORE its send", async () => {
    const r = xrouter({ idle: { [ARB]: 100_000 }, routes: [route("arb-eth", ARB, ETH), route("eth-sui", ETH, SUI, { kind: "wormhole" })] });
    const b = r.bridge as ScriptBridge;
    await r.cycle();
    assert.deepEqual(b.sends[0]!.persisted, { hop: 0, state: "planned" });
    b.state = "completed";
    r.tick();
    await r.cycle();
    assert.equal(b.sends.length, 2);
    assert.deepEqual(b.sends[1]!.persisted, { hop: 1, state: "planned" }, "hop advanced and saved before sending it");
  });

  it("a planned hop found on restart is never auto-sent: stuck + critical (deduped), still in equity", async () => {
    const t: InFlightTransfer = {
      id: "xf-crash",
      forOppId: "s",
      path: [route("arb-sui", ARB, SUI)],
      hop: 0,
      amountUsd: 30_000,
      costUsd: 4,
      state: "planned",
      createdAtMs: NOW - MIN,
      updatedAtMs: NOW - MIN,
      hopStartedAtMs: NOW - MIN,
    };
    const r = xrouter({ idle: { [ARB]: 70_000 }, specs: [], state: (s) => s.transfers.push(t) });
    const b = r.bridge as ScriptBridge;
    const c0 = await r.cycle();
    assert.equal(b.sends.length, 0, "never re-sent");
    assert.ok(c0.transfers.some((x) => x.kind === "send_unknown"));
    assert.equal(r.store.load().transfers[0]!.state, "stuck");
    assert.equal(c0.inFlightUsd, 30_000);
    assert.ok(close(c0.totalEquityUsd, 100_000));
    assert.equal(crit(r.notifier, /never confirmed.*\/transfer xf-crash/).length, 1);
    r.tick();
    await r.cycle();
    assert.equal(crit(r.notifier, /xf-crash/).length, 1, "deduped");
    assert.equal(b.sends.length, 0);
  });

  it("a send that throws is UNKNOWN: kept in flight (stuck), never credited back, never re-sent", async () => {
    const r = xrouter({ idle: { [ARB]: 100_000 } });
    const b = r.bridge as ScriptBridge;
    b.throwOnSend = true;
    const c0 = await r.cycle();
    assert.ok(c0.transfers.some((x) => x.kind === "send_unknown"));
    const st = r.store.load();
    assert.equal(st.idle[ARB], 70_000, "not credited back");
    assert.equal(st.transfers[0]!.state, "stuck");
    assert.ok(close(c0.totalEquityUsd, 100_000));
    assert.equal(st.frictionLedger.length, 1, "cost booked conservatively");
    r.tick();
    await r.cycle();
    assert.equal(b.sends.length, 1);
  });

  it("/transfer resolves arrived / refunded / failed, credits the right bucket and re-arms the kill window", async () => {
    const mk = () => {
      const r = xrouter({ idle: { [ARB]: 100_000 } });
      (r.bridge as ScriptBridge).throwOnSend = true;
      return r;
    };
    // refunded (default amount = what is in flight)
    const a = mk();
    await a.cycle();
    const id = a.store.load().transfers[0]!.id;
    assert.match(a.router.handleCommand({ cmd: "/transfer", args: [id, "refunded"] }), /resolved as refunded: \$30000 credited to arbitrum:USDC/);
    let st = a.store.load();
    assert.equal(st.transfers.length, 0);
    assert.equal(st.idle[ARB], 100_000);
    assert.deepEqual(st.history.equity, []);
    assert.ok(a.store.events.some((e) => e["type"] === "transfer_resolved" && e["outcome"] === "refunded"));
    a.tick();
    assert.equal((await a.cycle()).killed, false);
    // arrived with an explicit amount
    const b = mk();
    await b.cycle();
    const idb = b.store.load().transfers[0]!.id;
    b.router.handleCommand({ cmd: "/transfer", args: [idb, "arrived", "29990"] });
    st = b.store.load();
    assert.equal(st.idle[SUI], 29_990);
    assert.equal(st.idle[ARB], 70_000);
    // arrived without an amount: in flight minus the remaining hops' fees
    const c = mk();
    await c.cycle();
    c.router.handleCommand({ cmd: "/transfer", args: [c.store.load().transfers[0]!.id, "arrived"] });
    assert.ok(close(c.store.load().idle[SUI]!, 30_000 - routeCostUsd(route("arb-sui", ARB, SUI), 30_000)));
    // failed: nothing credited, equity window reset so the loss does not liquidate the book
    const d = mk();
    await d.cycle();
    d.router.handleCommand({ cmd: "/transfer", args: [d.store.load().transfers[0]!.id, "failed"] });
    st = d.store.load();
    assert.equal(st.transfers.length, 0);
    assert.equal(st.idle[ARB], 70_000);
    assert.equal(st.idle[SUI] ?? 0, 0);
    // bad input
    assert.match(d.router.handleCommand({ cmd: "/transfer", args: ["nope", "arrived"] }), /unknown transfer/);
    const e = mk();
    await e.cycle();
    const ide = e.store.load().transfers[0]!.id;
    assert.match(e.router.handleCommand({ cmd: "/transfer", args: [ide, "lost"] }), /usage/);
    assert.match(e.router.handleCommand({ cmd: "/transfer", args: [ide, "arrived", "-5"] }), /invalid usd/);
    assert.equal(e.store.load().transfers.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. wallet-seen on intermediate hops
// ---------------------------------------------------------------------------

describe("review #5: money landing on a hub wallet is never counted twice", () => {
  it("intermediate hop: wallet-seen, then debited from the hub when it leaves with the next hop", async () => {
    let wallet: Record<string, number> = { [ARB]: 100_000 };
    const hop1 = route("arb-eth", ARB, ETH);
    const hop2 = route("eth-sui", ETH, SUI, { kind: "wormhole" });
    const r = xrouter({ idle: { [ARB]: 100_000 }, routes: [hop1, hop2], idleBalances: async () => ({ ...wallet }) });
    const b = r.bridge as ScriptBridge;
    const c0 = await r.cycle();
    assert.ok(close(c0.totalEquityUsd, 100_000));
    // on chain: hop 1 landed on the Ethereum wallet, adapter still says in flight
    const f1 = routeCostUsd(hop1, 30_000);
    wallet = { [ARB]: 70_000, [ETH]: 30_000 - f1 };
    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.transfers.some((x) => x.kind === "wallet_seen"));
    assert.equal(c1.inFlightUsd, 0);
    assert.ok(close(c1.totalEquityUsd, 100_000 - f1, 1e-6), String(c1.totalEquityUsd));
    // adapter confirms hop 1. The wallet snapshot (taken before the poll) still shows
    // the ETH funds; the next hop is sent during the poll and the hub bucket is debited
    b.state = "completed";
    b.receivedUsd = 30_000 - f1;
    r.tick();
    const c2 = await r.cycle();
    assert.ok(c2.transfers.some((x) => x.kind === "hop"));
    assert.equal(c2.idle[ETH], 0);
    assert.ok(close(c2.inFlightUsd, 30_000 - f1, 1e-6));
    assert.ok(close(c2.totalEquityUsd, 100_000 - f1, 1e-6), `no double count: ${c2.totalEquityUsd}`);
    // next snapshot: the hub wallet is empty, the money is on hop 2
    wallet = { [ARB]: 70_000, [ETH]: 0 };
    r.tick();
    b.state = "in_flight";
    const c3 = await r.cycle();
    assert.ok(close(c3.inFlightUsd, 30_000 - f1, 1e-6));
    assert.ok(close(c3.totalEquityUsd, 100_000 - f1, 1e-6), String(c3.totalEquityUsd));
    assert.equal(c3.killed, false);
  });
});

// ---------------------------------------------------------------------------
// 6. exit probes and recovered latches
// ---------------------------------------------------------------------------

class ProbeExec extends PaperExecutor {
  sim: "ok" | "false" | "throw" = "ok";
  exitFails = false;
  override async simulateExit(): Promise<boolean> {
    if (this.sim === "throw") throw new Error("RPC 503");
    return this.sim === "ok";
  }
  override async exit(pos: Position, fraction: number, o?: Opportunity): Promise<ExecResult> {
    if (this.exitFails) return { ok: false, detail: "paper: exit refused" };
    return super.exit(pos, fraction, o);
  }
}

function probeRig() {
  let t = NOW;
  const src = new StaticSource([{ id: "a", kind: "deposit", venue: "navi", chain: "sui", token: "USDC", capacity_usd: 50e6, streams: [{ label: "base", kind: "base", apr: 0.15 }] }], "static", NOW);
  const store = new MemoryStore(newState(100_000));
  const notifier = new CollectingNotifier();
  const exec = new ProbeExec();
  const router = new Router({ cfg: cfgWith(), sources: [src], executors: { static: exec }, store, notifier, tokens: () => ({}), now: () => t, paperAccrual: true });
  return { router, store, notifier, exec, src, tick: (m = 31) => (t += m * MIN) };
}

describe("review #6: exit probes and latches", () => {
  it("a simulation that throws is unknown: never counted as a failure, warned after error_alert_after", async () => {
    const r = probeRig();
    await r.router.cycle(); // enter + first probe ok
    r.exec.sim = "throw";
    for (let i = 0; i < 4; i++) {
      r.tick();
      const rep = await r.router.cycle();
      assert.equal(rep.executed.filter((x) => x.action.type === "exit").length, 0);
    }
    const p = r.store.load().positions[0]!;
    assert.equal(p.exitProbe.consecutiveFailures, 0);
    assert.equal(p.exitProbe.consecutiveErrors, 4);
    assert.ok(r.notifier.messages.some((m) => /could not run 3x/.test(m.text)));
    // false still counts
    r.exec.sim = "false";
    r.tick();
    await r.router.cycle();
    r.tick();
    await r.router.cycle();
    r.tick();
    const rep = await r.router.cycle();
    assert.ok(rep.executed.some((x) => x.action.type === "exit" && x.action.urgent));
  });

  it("a probe latch is cleared when the simulation passes again before the exit executed", async () => {
    const r = probeRig();
    await r.router.cycle();
    r.exec.sim = "false";
    r.exec.exitFails = true;
    r.tick();
    await r.router.cycle(); // 1 failure
    r.tick();
    await r.router.cycle(); // 2 failures
    r.tick();
    await r.router.cycle(); // urgent exit decided, fails -> latched
    let p = r.store.load().positions[0]!;
    assert.equal(p.forcedExit?.cause, "probe");
    r.exec.sim = "ok";
    r.tick();
    const rep = await r.router.cycle();
    p = r.store.load().positions[0]!;
    assert.equal(p.forcedExit, undefined);
    assert.equal(rep.executed.filter((x) => x.action.type === "exit").length, 0);
    assert.ok(r.store.events.some((e) => e["type"] === "latch_cleared" && e["cause"] === "probe"));
  });

  it("a blind latch is cleared when the source reports valid data again; a kill-switch latch never is", async () => {
    const r = probeRig();
    await r.router.cycle();
    r.exec.exitFails = true;
    r.src.hidden.add("a");
    for (let i = 0; i < 10; i++) {
      r.tick(1);
      await r.router.cycle();
    }
    let p = r.store.load().positions[0]!;
    assert.equal(p.forcedExit?.cause, "blind");
    r.src.hidden.delete("a");
    r.tick(1);
    await r.router.cycle();
    p = r.store.load().positions[0]!;
    assert.equal(p.forcedExit, undefined);
    assert.ok(r.store.events.some((e) => e["type"] === "latch_cleared" && e["cause"] === "blind"));
    // kill-switch / manual latches carry no cause: they stay
    const st = r.store.load();
    st.positions[0]!.forcedExit = { reason: "kill switch", urgent: true, sinceMs: NOW };
    r.store.save(st);
    r.tick(1);
    await r.router.cycle();
    assert.equal(r.store.load().positions[0]!.forcedExit?.reason, "kill switch");
  });
});

// ---------------------------------------------------------------------------
// 7. canary sizing
// ---------------------------------------------------------------------------

describe("review #7: canary sizing", () => {
  it("chunks are clamped to the room under max_position_usd (small caps still enter)", () => {
    const cfg = cfgWith({ caps: { max_position_usd: 300, min_position_usd: 100 } });
    const plan = planAllocation([opp()], dctx({ cfg, equity: 100_000 }));
    assert.equal(plan.entries.length, 1, JSON.stringify(plan.rejected));
    assert.equal(plan.entries[0]!.deltaUsd, 300);
  });

  it("chunks are clamped to the per-opportunity cap", () => {
    const cfg = cfgWith({ caps: { per_opportunity_frac: 0.25, max_position_usd: 1e9 } });
    const plan = planAllocation([opp()], dctx({ cfg, equity: 100_000 }));
    assert.equal(plan.entries[0]!.deltaUsd, 25_000);
  });

  it("max_total_deployed_usd bounds the allocator and the funding planner", () => {
    const cfg = cfgWith({ caps: { max_total_deployed_usd: 1_000, min_position_usd: 100 }, xchain: { enabled: true, routes: [route("arb-sui", ARB, SUI)] } });
    const plan = planAllocation([opp(), opp({ id: "o2", primaryVenue: "suilend", legs: [{ venue: "suilend", chain: "sui", token: "USDC", equityFrac: 1 }] })], dctx({ cfg, equity: 100_000 }));
    assert.ok(plan.entries.reduce((a, e) => a + e.deltaUsd, 0) <= 1_000);
    assert.ok(plan.entries.length >= 1);
    // planner: never bridge what the ceiling would refuse
    const p = new FundingPlanner({ cfg, nowMs: NOW, idle: { [ARB]: 100_000 }, ledger: [], transfers: [], totalEquityUsd: 100_000, bookYieldPerYearUsd: 0, deployedUsd: 900 });
    const q = p.quote(opp({ streams: [constantStream("base", "base", 0.5)] }), 500, 0.5);
    assert.equal(q.ok, false);
    assert.match(q.reason!, /max_total_deployed/);
  });
});

// ---------------------------------------------------------------------------
// 8. durability
// ---------------------------------------------------------------------------

describe("review #8: durable state and telegram offset", () => {
  it("FileStore writes atomically (no temp file left, readable after every save)", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const fs = new FileStore(join(dir, "state.json"), join(dir, "journal.jsonl"), 5);
    const s = fs.load();
    s.idleUsd = 123;
    fs.save(s);
    fs.save(s);
    assert.equal(fs.load().idleUsd, 123);
    assert.deepEqual(readdirSync(dir).sort(), ["state.json"]);
  });

  it("TelegramNotifier persists the update offset: commands are not re-run after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-"));
    const offsetPath = join(dir, "offset.json");
    const updates = [
      { update_id: 7, message: { chat: { id: 42 }, text: "/exitall" } },
      { update_id: 8, message: { chat: { id: 42 }, text: "/status" } },
    ];
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      const off = Number(new URL(url).searchParams.get("offset"));
      return { ok: true, json: async () => ({ ok: true, result: updates.filter((u) => u.update_id >= off) }) };
    }) as unknown as typeof fetch;
    const a = new TelegramNotifier("tok", "42", fakeFetch, { offsetPath });
    assert.deepEqual((await a.pollCommands()).map((c) => c.cmd), ["/exitall", "/status"]);
    assert.ok(existsSync(offsetPath));
    const b = new TelegramNotifier("tok", "42", fakeFetch, { offsetPath }); // restart
    assert.equal(b.lastUpdateId, 8);
    assert.deepEqual(await b.pollCommands(), []);
    assert.match(urls.at(-1)!, /offset=9/);
    // without a path: old behaviour (in-memory only)
    const c = new TelegramNotifier("tok", "42", fakeFetch);
    assert.equal((await c.pollCommands()).length, 2);
  });
});
