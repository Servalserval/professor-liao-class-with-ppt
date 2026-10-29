/**
 * Router-level cross-chain funding: transfer lifecycle, failure handling,
 * bucket accounting, legacy mode, live wallet reads, and the example scenario.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deepMerge } from "../src/config.js";
import { PaperExecutor } from "../src/executor.js";
import { Router, type CycleReport } from "../src/monitor.js";
import { CollectingNotifier } from "../src/notify.js";
import { loadScenario, runScenario } from "../src/scenario.js";
import { StaticSource, type StaticOppSpec } from "../src/sources/static.js";
import { FileStore, idleInvariantOk, MemoryStore, newState, sumIdle } from "../src/store.js";
import { PaperBridgeExecutor, type PaperBridgeBehavior } from "../src/xchain/paper.js";
import { routeCostUsd } from "../src/xchain/routes.js";
import type { BridgeExecutor, BridgePollResult, RouteSpec, TransferState } from "../src/xchain/types.js";
import { cfgWith, close, HOUR, NOW } from "./helpers.js";

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

const ARB = "arbitrum:USDC";
const SUI = "sui:USDC";

const suiSpec = (id: string, apr = 0.15, over: Partial<StaticOppSpec> = {}): StaticOppSpec => ({
  id,
  kind: "deposit",
  venue: "navi",
  chain: "sui",
  token: "USDC",
  capacity_usd: 50_000_000,
  streams: [{ label: "base", kind: "base", apr }],
  ...over,
});

interface RigOpts {
  specs: StaticOppSpec[];
  idle?: Record<string, number>;
  legacyIdle?: number;
  routes?: RouteSpec[];
  cfgOver?: Record<string, unknown>;
  bridges?: Record<string, BridgeExecutor>;
  idleBalances?: () => Promise<Record<string, number>>;
}

function xrig(o: RigOpts) {
  let t = NOW;
  const now = () => t;
  const routes = o.routes ?? [route("arb-sui", ARB, SUI)];
  const cfg = cfgWith(deepMerge({ xchain: { enabled: true, routes } }, o.cfgOver ?? {}));
  const src = new StaticSource(o.specs, "static", NOW);
  const store = new MemoryStore(o.idle ? newState(0, o.idle) : newState(o.legacyIdle ?? 100_000));
  const notifier = new CollectingNotifier();
  const exec = new PaperExecutor();
  const behavior: { v: PaperBridgeBehavior } = { v: "ok" };
  const paper = new PaperBridgeExecutor(now, { behavior: () => behavior.v });
  const bridges = o.bridges ?? Object.fromEntries(routes.map((r) => [r.kind, paper]));
  const router = new Router({
    cfg,
    sources: [src],
    executors: { static: exec },
    store,
    notifier,
    tokens: () => ({}),
    now,
    paperAccrual: true,
    bridges,
    idleBalances: o.idleBalances,
  });
  const cycle = async (): Promise<CycleReport> => {
    const r = await router.cycle();
    assert.ok(idleInvariantOk(store.load()), "idleUsd must equal sum(idle)");
    return r;
  };
  return { router, store, notifier, src, exec, paper, behavior, cfg, cycle, tick: (h = 1) => (t += h * HOUR) };
}

const enters = (r: CycleReport) => r.executed.filter((x) => x.action.type === "enter").map((x) => x.action as Extract<typeof x.action, { type: "enter" }>);
const crit = (n: CollectingNotifier, re: RegExp) => n.messages.filter((m) => m.level === "critical" && re.test(m.text));

describe("router: cross-chain transfer lifecycle", () => {
  it("send -> in flight counted in equity -> arrival -> entry, with the idle invariant every cycle", async () => {
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 } });
    const c0 = await r.cycle();
    const sent = c0.transfers.filter((x) => x.kind === "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.forOppId, "s");
    assert.equal(sent[0]!.from, ARB);
    assert.equal(sent[0]!.to, SUI);
    assert.equal(enters(c0).length, 0, "no entry before the money is there");
    const amt = sent[0]!.amountUsd;
    assert.equal(amt, 30_000); // per_opportunity_frac 30%
    const st0 = r.store.load();
    assert.equal(st0.transfers.length, 1);
    assert.equal(st0.transfers[0]!.state, "submitted");
    assert.equal(st0.idle[ARB], 70_000);
    assert.equal(c0.inFlightUsd, 30_000);
    assert.ok(close(c0.totalEquityUsd, 100_000), "in-flight money counts in equity");
    assert.equal(st0.frictionLedger.length, 1);
    assert.ok(st0.frictionLedger[0]!.costUsd <= (amt * 0.15) / 365, "cost <= one day of yield");

    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.transfers.some((x) => x.kind === "arrived"));
    const e = enters(c1);
    assert.equal(e.length, 1);
    assert.equal(e[0]!.oppId, "s");
    assert.equal(`${e[0]!.funding!.source!.chain}:${e[0]!.funding!.source!.asset}`, SUI);
    const fees = routeCostUsd(route("arb-sui", ARB, SUI), amt);
    const st1 = r.store.load();
    assert.equal(st1.transfers.length, 0);
    assert.ok(close(st1.positions[0]!.equityUsd, amt - fees, 1e-6));
    assert.deepEqual(st1.positions[0]!.fundingAsset, { chain: "sui", asset: "USDC" });
    assert.equal(st1.idle[ARB], 70_000);
    assert.ok(close(c1.totalEquityUsd, 100_000 - fees, 1e-4));
    assert.equal(c1.killed, false);
    assert.ok(r.store.events.some((ev) => ev["type"] === "transfer" && ev["kind"] === "arrived"));
  });

  it("a long bridge never looks like a drawdown", async () => {
    const slow = route("arb-sui", ARB, SUI, { etaMinutes: 300 });
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 }, routes: [slow] });
    for (let i = 0; i < 4; i++) {
      const rep = await r.cycle();
      assert.ok(close(rep.totalEquityUsd, 100_000), String(rep.totalEquityUsd));
      assert.equal(rep.killed, false);
      r.tick();
    }
    const rep = await r.cycle(); // t = 4h < 5h eta: still in flight
    assert.equal(rep.inFlightUsd, 30_000);
    r.tick(2);
    assert.ok((await r.cycle()).transfers.some((x) => x.kind === "arrived"));
  });

  it("stuck: critical alert once per dedupe window, never re-sent automatically", async () => {
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 } });
    r.behavior.v = "stuck";
    await r.cycle();
    r.tick(); // 60 min < max(60, 20 x 4 = 80) min
    await r.cycle();
    assert.equal(crit(r.notifier, /STUCK/).length, 0);
    r.tick(); // 120 min
    const c2 = await r.cycle();
    assert.ok(c2.transfers.some((x) => x.kind === "stuck"));
    assert.equal(crit(r.notifier, /STUCK/).length, 1);
    r.tick();
    const c3 = await r.cycle();
    assert.equal(crit(r.notifier, /STUCK/).length, 1, "deduped");
    assert.ok(!c3.transfers.some((x) => x.kind === "stuck"), "event only on the transition");
    assert.equal(r.store.load().transfers[0]!.state, "stuck");
    assert.equal(c3.inFlightUsd, 30_000, "still counted: the money is not lost yet");
    assert.equal(r.paper.log.filter((l) => l.startsWith("send")).length, 1, "never re-sent");
    r.tick(7);
    await r.cycle();
    assert.equal(crit(r.notifier, /STUCK/).length, 2, "repeated after alert_repeat_hours");
    // a stuck transfer that eventually lands is still credited
    r.behavior.v = "ok";
    r.tick();
    const late = await r.cycle();
    assert.ok(late.transfers.some((x) => x.kind === "arrived"));
  });

  it("failed without refund: critical alert, nothing credited back (a real loss is a loss)", async () => {
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 } });
    r.behavior.v = "fail";
    await r.cycle();
    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.transfers.some((x) => x.kind === "failed"));
    assert.equal(crit(r.notifier, /FAILED.*NOT returned/).length, 1);
    const st = r.store.load();
    assert.equal(st.transfers.length, 0);
    assert.equal(st.idle[ARB], 70_000);
    assert.equal(st.idle[SUI] ?? 0, 0);
    // the books lost $30k of $100k: the kill switch sees it and fires once confirmed
    assert.equal(c1.killed, false);
    r.tick();
    assert.equal((await r.cycle()).killed, true);
  });

  it("failed with refund: the refunded USD goes back to the source bucket", async () => {
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 } });
    r.behavior.v = "fail_refund";
    await r.cycle();
    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.transfers.some((x) => x.kind === "refunded"));
    assert.equal(crit(r.notifier, /FAILED.*refunded to arbitrum:USDC/).length, 1);
    const st = r.store.load();
    assert.ok(close(st.idle[ARB]!, 100_000 - 0.5)); // paper refund keeps the source gas
    assert.equal(c1.killed, false);
    // the failed route cools down: no immediate re-send over it (no gas churn) ...
    assert.ok(!c1.transfers.some((x) => x.kind === "sent"));
    assert.ok(r.notifier.messages.some((m) => /route arb-sui paused/.test(m.text)));
    r.tick();
    assert.ok(!(await r.cycle()).transfers.some((x) => x.kind === "sent"));
    // ... and is planned over again after reentry_cooldown_hours (6h)
    r.behavior.v = "ok";
    r.tick(6);
    assert.ok((await r.cycle()).transfers.some((x) => x.kind === "sent"));
  });

  it("a refused send keeps the money idle where it was", async () => {
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 } });
    r.behavior.v = "send_fail";
    const c0 = await r.cycle();
    assert.ok(c0.transfers.some((x) => x.kind === "send_failed"));
    assert.equal(crit(r.notifier, /bridge send FAILED/).length, 1);
    const st = r.store.load();
    assert.equal(st.idle[ARB], 100_000);
    assert.equal(st.transfers.length, 0);
    assert.equal(st.frictionLedger.length, 0, "no cost booked for a move that did not happen");
  });

  it("missing bridge executor: critical alert, money stays idle", async () => {
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 }, bridges: {} });
    await r.cycle();
    r.tick();
    await r.cycle();
    assert.equal(crit(r.notifier, /no bridge executor for cctp_v2_fast/).length, 1, "deduped");
    const st = r.store.load();
    assert.equal(st.idle[ARB], 100_000);
    assert.equal(st.transfers.length, 0);
  });

  it("multi-hop: each hop is sent when the previous one lands; arrival nets all hop fees", async () => {
    const hop1 = route("arb-eth", ARB, "ethereum:USDC");
    const hop2 = route("eth-sui", "ethereum:USDC", SUI, { kind: "wormhole" });
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 100_000 }, routes: [hop1, hop2] });
    const c0 = await r.cycle();
    assert.equal(c0.transfers.find((x) => x.kind === "sent")!.route, "arb-eth>eth-sui");
    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.transfers.some((x) => x.kind === "hop"));
    const t = r.store.load().transfers[0]!;
    assert.equal(t.hop, 1);
    assert.equal(t.state, "submitted");
    assert.equal(c1.inFlightUsd, t.receivedUsd, "value in flight after the first hop's fees");
    r.tick();
    const c2 = await r.cycle();
    const arrived = c2.transfers.find((x) => x.kind === "arrived")!;
    const after1 = 30_000 - routeCostUsd(hop1, 30_000);
    assert.ok(close(arrived.amountUsd, after1 - routeCostUsd(hop2, after1), 1e-9));
    assert.equal(enters(c2).length, 1);
  });
});

describe("router: idle buckets", () => {
  it("exit and reward-sale proceeds go back to the position's funding bucket", async () => {
    const spec = suiSpec("s", 0.15, {
      streams: [
        { label: "base", kind: "base", apr: 0.15 },
        { label: "sui", kind: "reward", apr: 0.0001, reward_token: "SUI" },
      ],
    });
    const r = xrig({ specs: [spec], idle: { [SUI]: 50_000, [ARB]: 50_000 } });
    await r.cycle();
    let st = r.store.load();
    assert.equal(st.positions[0]!.equityUsd, 30_000);
    assert.equal(st.idle[SUI], 20_000);
    assert.equal(st.idle[ARB], 50_000, "nothing to move: the opportunity is at its cap");
    st.positions[0]!.rewards["SUI"]!.heldUsd = 1_000;
    r.store.save(st);
    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.executed.some((x) => x.action.type === "sell"));
    st = r.store.load();
    assert.ok(close(st.idle[SUI]!, 20_000 + 980, 1e-6), String(st.idle[SUI]));
    assert.equal(st.idle[ARB], 50_000);
    r.router.handleCommand({ cmd: "/exit", args: ["s"] });
    r.tick();
    await r.cycle();
    st = r.store.load();
    assert.equal(st.positions.length, 0);
    assert.ok(st.idle[SUI]! > 50_000, String(st.idle[SUI]));
    assert.equal(st.idle[ARB], 50_000);
    assert.ok(close(st.idleUsd, sumIdle(st.idle)));
    assert.match(r.router.handleCommand({ cmd: "/status", args: [] }), /idle: .*sui:USDC/);
  });

  it("legacy mode (no idle map) is unchanged: no buckets, no transfers, no funding on actions", async () => {
    const r = xrig({ specs: [suiSpec("a"), suiSpec("b", 0.12, { venue: "suilend" })], legacyIdle: 100_000, cfgOver: { xchain: { enabled: false } } });
    const c0 = await r.cycle();
    assert.deepEqual(enters(c0).map((e) => e.oppId).sort(), ["a", "b"]);
    assert.ok(enters(c0).every((e) => e.funding === undefined));
    const st = r.store.load();
    assert.deepEqual(st.idle, {});
    assert.deepEqual(st.transfers, []);
    assert.deepEqual(c0.idle, {});
    assert.equal(c0.inFlightUsd, 0);
    assert.ok(close(st.idleUsd + st.positions.reduce((a, p) => a + p.equityUsd, 0), 100_000));
  });

  it("xchain enabled without an idle split: warns and stays single-bucket", async () => {
    const r = xrig({ specs: [suiSpec("a")], legacyIdle: 100_000 });
    const c0 = await r.cycle();
    assert.equal(enters(c0).length, 1);
    assert.ok(r.notifier.messages.some((m) => m.level === "warn" && /single-bucket mode/.test(m.text)));
    assert.equal(c0.transfers.length, 0);
  });

  it("FileStore loads old state files (no idle / transfers / ledger) as legacy state", () => {
    const dir = mkdtempSync(join(tmpdir(), "xchain-store-"));
    const old = { ...newState(42_000) } as Record<string, unknown>;
    delete old["idle"];
    delete old["transfers"];
    delete old["frictionLedger"];
    writeFileSync(join(dir, "state.json"), JSON.stringify(old));
    const s = new FileStore(join(dir, "state.json"), join(dir, "journal.jsonl")).load();
    assert.deepEqual(s.idle, {});
    assert.deepEqual(s.transfers, []);
    assert.deepEqual(s.frictionLedger, []);
    assert.equal(s.idleUsd, 42_000);
    // a bucketed file whose total drifted is normalized to sum(idle)
    writeFileSync(join(dir, "state.json"), JSON.stringify({ ...newState(0, { [ARB]: 10, [SUI]: 5 }), idleUsd: 99 }));
    const b = new FileStore(join(dir, "state.json"), join(dir, "journal.jsonl")).load();
    assert.equal(b.idleUsd, 15);
    assert.ok(idleInvariantOk(b));
    // a fresh FileStore can start split per chain:asset
    const f = new FileStore(join(dir, "none.json"), join(dir, "j.jsonl"), 0, { [ARB]: 7 }).load();
    assert.equal(f.idleUsd, 7);
  });
});

describe("router: live wallet balances", () => {
  /** Adapter that reports whatever the test says. */
  class FakeBridge implements BridgeExecutor {
    state: TransferState = "in_flight";
    receivedUsd?: number;
    sends = 0;
    async send() {
      this.sends += 1;
      return { ok: true, ref: "0xabc" };
    }
    async poll(): Promise<BridgePollResult> {
      return { state: this.state, receivedUsd: this.receivedUsd };
    }
  }

  it("idleBalances overrides the buckets; funds seen in the wallet before confirmation are never counted twice", async () => {
    const fake = new FakeBridge();
    let wallet: Record<string, number> = { [ARB]: 100_000 };
    const r = xrig({ specs: [suiSpec("s")], idle: { [ARB]: 1 }, bridges: { cctp_v2_fast: fake }, idleBalances: async () => ({ ...wallet }) });
    const c0 = await r.cycle();
    assert.equal(c0.transfers.filter((x) => x.kind === "sent").length, 1);
    assert.ok(close(c0.totalEquityUsd, 100_000));
    // on chain: the source was debited and the destination already credited,
    // but the adapter has not confirmed yet
    const fees = routeCostUsd(route("arb-sui", ARB, SUI), 30_000);
    wallet = { [ARB]: 70_000, [SUI]: 30_000 - fees };
    r.tick();
    const c1 = await r.cycle();
    assert.ok(c1.transfers.some((x) => x.kind === "wallet_seen"));
    assert.equal(c1.inFlightUsd, 0);
    assert.ok(close(c1.totalEquityUsd, 100_000 - fees, 1e-6), `equity ${c1.totalEquityUsd} must not double count`);
    assert.equal(enters(c1).length, 1, "money visible in the wallet is deployed");
    // the adapter confirms later: no second credit
    wallet = { [ARB]: 70_000, [SUI]: 0 };
    fake.state = "completed";
    fake.receivedUsd = 30_000 - fees;
    r.tick();
    const c2 = await r.cycle();
    assert.ok(c2.transfers.some((x) => x.kind === "arrived"));
    const st = r.store.load();
    assert.equal(st.transfers.length, 0);
    assert.deepEqual(st.idle, { [ARB]: 70_000, [SUI]: 0 });
    assert.ok(close(c2.totalEquityUsd, 100_000 - fees, 1e-4));
    assert.equal(c2.killed, false);
    assert.equal(fake.sends, 1);
  });

  it("a partial wallet read updates only the buckets it contains", async () => {
    const r = xrig({ specs: [], idle: { [ARB]: 5_000, [SUI]: 1_000 }, idleBalances: async () => ({ [SUI]: 1_200 }) });
    const c = await r.cycle();
    assert.deepEqual(r.store.load().idle, { [ARB]: 5_000, [SUI]: 1_200 });
    assert.deepEqual(c.idle, { [ARB]: 5_000, [SUI]: 1_200 });
    const empty = xrig({ specs: [], idle: { [ARB]: 5_000 }, idleBalances: async () => ({}) });
    await empty.cycle();
    assert.deepEqual(empty.store.load().idle, { [ARB]: 5_000 }, "an empty read changes nothing");
  });

  it("an invalid wallet read keeps the last buckets", async () => {
    const r = xrig({ specs: [], idle: { [ARB]: 5_000 }, idleBalances: async () => ({ [ARB]: NaN }) });
    await r.cycle();
    assert.equal(r.store.load().idle[ARB], 5_000);
    assert.ok(r.notifier.messages.some((m) => /idle balances read failed/.test(m.text)));
  });
});

describe("scenario: examples/scenarios/cross-chain.yaml", () => {
  it("moves money only when it costs <= one day of yield, then deploys it on arrival", async () => {
    const r = await runScenario(loadScenario("examples/scenarios/cross-chain.yaml"));
    const line = (s: number) => r.lines[s]!.report;
    // step 0: Sui money into the best loop, a CCTP move tops it up; Plasma is refused (30 bps route)
    const s0 = line(0);
    const sent0 = s0.transfers.filter((x) => x.kind === "sent");
    assert.equal(sent0.length, 1);
    assert.equal(sent0[0]!.forOppId, "sui-navi-loop");
    assert.equal(`${sent0[0]!.from}->${sent0[0]!.to}`, "arbitrum:USDC->sui:USDC");
    assert.match((s0.allocationRejected?.["plasma-usdt0-vault"] ?? []).join(" "), /one_day_yield/);
    assert.ok(close(s0.totalEquityUsd, 300_000), "in flight counted");
    // step 1: arrival, then entry with the arrived money
    const s1 = line(1);
    assert.ok(s1.transfers.some((x) => x.kind === "arrived"));
    assert.ok(enters(s1).some((e) => e.oppId === "sui-navi-loop" && e.funding?.source?.chain === "sui"));
    // Arbitrum loop collapses -> exit; proceeds stay idle on Arbitrum (no move passes friction)
    const exitStep = r.lines.find((l) => l.report.executed.some((x) => x.action.type === "exit" && x.action.oppId === "arb-aave-loop"))!.step;
    assert.ok(exitStep > 20 && exitStep < 30, String(exitStep));
    for (let s = exitStep; s < 30; s++) assert.equal(line(s).transfers.length, 0, `no move at step ${s}`);
    assert.ok(line(29).idle["arbitrum:USDC"]! > 100_000);
    // step 30: a cheap destination appears -> CCTP move; step 31: arrival + entry
    const sent30 = line(30).transfers.filter((x) => x.kind === "sent");
    assert.equal(sent30.length, 1);
    assert.equal(sent30[0]!.to, "base:USDC");
    assert.ok(line(31).transfers.some((x) => x.kind === "arrived"));
    assert.ok(enters(line(31)).some((e) => e.oppId === "base-morpho-usdc"));
    // never a plasma move, never killed, books consistent
    assert.ok(!r.lines.some((l) => l.report.transfers.some((x) => x.to === "plasma:USDT0")));
    assert.ok(!r.lines.some((l) => l.report.killed));
    assert.ok(r.finalEquityUsd > r.startEquityUsd);
    assert.ok(close(r.lines.at(-1)!.report.idleUsd, sumIdle(r.finalIdle)));
  });
});
