/**
 * One test per finding of the independent risk review (see docs/design.md §14).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planAllocation } from "../src/allocator.js";
import { PaperExecutor, type Executor } from "../src/executor.js";
import { entryBlockers } from "../src/gates/entry.js";
import { decideExit } from "../src/gates/exit.js";
import { Router } from "../src/monitor.js";
import { CollectingNotifier } from "../src/notify.js";
import { planRewards } from "../src/rewards.js";
import { loopOpportunity } from "../src/sources/loopLending.js";
import { StaticSource, type StaticOppSpec } from "../src/sources/static.js";
import { MemoryStore, newState } from "../src/store.js";
import type { Action } from "../src/types.js";
import { validateOpportunity } from "../src/validate.js";
import { constantStream, costAprAt, rewardRealizable, valueAt } from "../src/valuation.js";
import { cfgWith, dctx, HOUR, NOW, opp, position, sctx } from "./helpers.js";

const exits = (a: Action[]) => a.filter((x): x is Extract<Action, { type: "exit" }> => x.type === "exit");

const spec = (id: string, over: Partial<StaticOppSpec> = {}): StaticOppSpec => ({
  id,
  kind: "deposit",
  venue: "navi",
  chain: "sui",
  token: "USDC",
  capacity_usd: 50_000_000,
  streams: [{ label: "base", kind: "base", apr: 0.15 }],
  ...over,
});

function rig(specs: StaticOppSpec[], exec: Executor = new PaperExecutor(), cfgOver: unknown = {}) {
  let t = NOW;
  const src = new StaticSource(specs, "static", NOW);
  const store = new MemoryStore(newState(100_000));
  const notifier = new CollectingNotifier();
  const router = new Router({
    cfg: cfgWith(cfgOver),
    sources: [src],
    executors: { static: exec },
    store,
    notifier,
    tokens: () => ({}),
    now: () => t,
    paperAccrual: true,
  });
  return { router, store, notifier, src, tick: (h = 1) => (t += h * HOUR) };
}

describe("review: high", () => {
  it("#1 a drained market is not entered in the same cycle (derived flags reach entry gates)", async () => {
    const r = rig([spec("a")]);
    r.router.handleCommand({ cmd: "/pause", args: [] });
    await r.router.cycle(); // records capacity history, enters nothing
    r.router.handleCommand({ cmd: "/resume", args: [] });
    r.src.specs[0]!.capacity_usd = 20_000_000; // -60% within the window
    r.tick(0.5);
    const rep = await r.router.cycle();
    assert.equal(rep.executed.filter((x) => x.action.type === "enter").length, 0);
  });

  it("#1/#2 a failed urgent exit is latched, retried after the trigger is gone, and blocks top-ups", async () => {
    const exec = new PaperExecutor();
    const r = rig([spec("a", { metrics: { borrow_apr: 0.08 } })], exec);
    await r.router.cycle(); // enter
    exec.opts.failExit = () => true;
    r.src.specs[0]!.metrics = { borrow_apr: 0.3 }; // one-cycle spike
    r.tick();
    const rep1 = await r.router.cycle();
    assert.ok(rep1.executed.some((x) => x.action.type === "exit" && !x.ok));
    assert.equal(rep1.executed.filter((x) => x.action.type === "enter").length, 0, "no top-up into a failing exit");
    assert.ok(r.store.load().positions[0]!.forcedExit);
    exec.opts.failExit = undefined;
    r.src.specs[0]!.metrics = { borrow_apr: 0.08 }; // spike gone (but window low is still 0.08 -> no new flag)
    r.tick(2);
    const rep2 = await r.router.cycle();
    assert.ok(rep2.executed.some((x) => x.action.type === "exit" && x.ok && x.action.reason.startsWith("retry:")));
    assert.equal(r.store.load().positions.length, 0);
  });

  it("#2 kill switch exits are retried until they succeed", async () => {
    const exec = new PaperExecutor();
    const r = rig([spec("a")], exec);
    await r.router.cycle();
    const st = r.store.load();
    st.positions[0]!.equityUsd *= 0.8;
    r.store.save(st);
    exec.opts.failExit = () => true;
    r.tick();
    await r.router.cycle();
    assert.equal(r.store.load().positions.length, 1);
    exec.opts.failExit = undefined;
    r.tick();
    await r.router.cycle();
    assert.equal(r.store.load().positions.length, 0, "the kill switch exit was retried");
  });

  it("#3 an adapter throwing mid-cycle does not lose the state of what already executed", async () => {
    const exec = new PaperExecutor();
    let throwOnClaim = false;
    exec.claim = async (...args) => {
      if (throwOnClaim) throw new Error("rpc exploded");
      return PaperExecutor.prototype.claim.apply(exec, args);
    };
    const r = rig([spec("a"), spec("b", { venue: "suilend", streams: [{ label: "x", kind: "reward", apr: 0.2, reward_token: "X" }] })], exec, {
      caps: { per_venue_frac_by_tier: { 1: 0.4 } },
    });
    await r.router.cycle();
    r.tick(150); // rewards accrue past claim_min_usd, claim interval passes
    r.src.specs[0]!.capacity_usd = 1_000; // force an urgent exit of "a" in the same cycle
    throwOnClaim = true;
    const rep = await r.router.cycle();
    assert.ok(rep.executed.some((x) => x.action.type === "exit" && x.action.oppId === "a" && x.ok));
    assert.ok(rep.executed.some((x) => x.action.type === "claim" && !x.ok));
    assert.ok(!r.store.load().positions.some((p) => p.oppId === "a"), "exit was persisted");
  });

  it("#4 NaN data is rejected at ingestion; a held position with NaN data goes blind", async () => {
    assert.ok(loopOpportunity({ protocol: "x", chain: "sui", symbol: "USDC", totalSupplyUsd: NaN, totalBorrowUsd: 1, supplyAprBase: 0.1, borrowAprBase: 0.05, supplyRewards: [], borrowRewards: [], openLtv: 0.8, closeLtv: 0.85 }, sctx(), "s") === null);
    const bad = opp({ liquidity: { exitCapacityUsd: NaN, footprintPerEquity: 1 } });
    assert.ok(validateOpportunity(bad, cfgWith(), NOW).length > 0);
    const nanStream = opp({ streams: [constantStream("b", "base", NaN)] });
    assert.ok(validateOpportunity(nanStream, cfgWith(), NOW).some((e) => e.includes("not finite")));
    const r = rig([spec("a")]);
    await r.router.cycle();
    r.src.specs[0]!.capacity_usd = NaN;
    r.tick();
    await r.router.cycle();
    assert.equal(r.store.load().positions[0]!.blindCycles, 1);
  });

  it("#5 the oversized rule does not charge one-offs on money already held", () => {
    const o = opp({
      streams: [constantStream("b", "base", 0.1)],
      costs: { entryFrac: 0.003, exitFrac: 0.003, fixedEntryUsd: 8, fixedExitUsd: 8, ongoingApr: 0 },
    });
    const p = position(o, 30_000, { pending: { oversized: 5 }, pendingSince: { oversized: NOW - HOUR } });
    assert.equal(exits(decideExit(p, o, [], dctx({ positions: [p] })).actions).length, 0);
  });

  it("#6 a hedge with no remaining exposure is closed, not orphaned", () => {
    const a = planRewards(dctx({ hedges: { X: 800 } }));
    const h = a.find((x) => x.type === "hedge") as Extract<Action, { type: "hedge" }>;
    assert.equal(h.targetShortUsd, 0);
  });
});

describe("review: medium", () => {
  it("#8 deployable cash excludes reward tokens", () => {
    const o = opp({ streams: [constantStream("b", "base", 0.2)] });
    const held = position(opp({ id: "h", primaryVenue: "suilend", legs: [{ venue: "suilend", chain: "sui", token: "USDT", equityFrac: 1 }] }), 20_000, {
      rewards: { X: { unclaimedUsd: 0, heldUsd: 30_000, hedgedUsd: 0, lastClaimAtMs: NOW } },
    });
    const ctx = dctx({ positions: [held], equity: 100_000, idle: 50_000, cfg: cfgWith({ caps: { per_opportunity_frac: 1, per_venue_frac_by_tier: { 1: 1 }, per_kind_frac: { deposit: 1 }, max_position_usd: 1e9, per_chain_frac: { default: 1 } } }) });
    const plan = planAllocation([o], ctx);
    assert.ok(plan.deployableUsd <= 45_000, `deployable ${plan.deployableUsd}`);
  });

  it("#9 a price-only token profile uses the default realizable", () => {
    assert.equal(rewardRealizable(dctx({ tokens: { X: { priceUsd: 1 } } }), "X", 100), 0.5);
  });

  it("#10 a blind position whose exit path keeps failing is exited without waiting", () => {
    const p = position(opp(), 10_000, { blindCycles: 1, exitProbe: { lastOkAtMs: NOW - 5 * HOUR, consecutiveFailures: 3 } });
    assert.equal(exits(decideExit(p, undefined, [], dctx({ positions: [p] })).actions).length, 1);
  });

  it("#11 held leveraged position without health warns; drifting health blocks top-ups", () => {
    const loop = opp({ kind: "lending_loop" });
    const p = position(loop, 10_000);
    const acts = decideExit(p, loop, [], dctx({ positions: [p] })).actions;
    assert.ok(acts.some((a) => a.type === "alert" && a.message.includes("no health")));
    const drifting = opp({ kind: "lending_loop", health: { metric: "ltv", value: 0.8, rebalanceAt: 0.78, criticalAt: 0.85, direction: "above" } });
    assert.match(entryBlockers(drifting, dctx({ positions: [position(drifting, 10_000)] })).join(), /health/);
    const fine = opp({ kind: "lending_loop", health: { metric: "ltv", value: 0.7, rebalanceAt: 0.78, criticalAt: 0.85, direction: "above" } });
    assert.equal(entryBlockers(fine, dctx({ positions: [position(fine, 10_000)] })).length, 0);
  });

  it("#12 stale data is rejected", () => {
    const o = opp({ dataAsOfMs: NOW - 30 * 60_000 });
    assert.match(validateOpportunity(o, cfgWith(), NOW).join(), /stale/);
    assert.equal(validateOpportunity(opp({ dataAsOfMs: NOW - 60_000 }), cfgWith(), NOW).length, 0);
  });

  it("#13 dedupe keys keep different positions apart", async () => {
    const r = rig([spec("pool-1"), spec("pool-2", { venue: "suilend" })]);
    await r.router.cycle();
    r.src.hidden.add("pool-1");
    r.src.hidden.add("pool-2");
    for (let i = 0; i < 3; i++) {
      r.tick();
      await r.router.cycle();
    }
    const blind = r.notifier.messages.filter((m) => m.text.includes("blind"));
    assert.equal(blind.length, 2, blind.map((m) => m.text).join(" | "));
  });
});

describe("review: low / design", () => {
  it("costApr is finite at size 0 when there are no fixed costs", () => {
    assert.equal(costAprAt(opp(), 0, dctx(), false), 0);
  });

  it("a trim that leaves dust closes the remainder instead of booking it as cash", async () => {
    const r = rig([spec("a")], new PaperExecutor(), { caps: { min_position_usd: 500 } });
    await r.router.cycle();
    const st = r.store.load();
    st.positions[0]!.equityUsd = 600; // next spread trim (50%) would leave 300 < 250? no: force via manual small position
    st.positions[0]!.pending = {};
    r.store.save(st);
    // drive a 50% trim: make the opportunity thin
    r.src.specs[0]!.streams[0]!.apr = 0.03;
    const cfgFast = cfgWith({ thresholds: { confirm_minutes: 0 }, caps: { min_position_usd: 500 } });
    const p = r.store.load().positions[0]!;
    // 600 * 0.5 = 300 < min_position -> rule 7 closes fully instead of trimming
    const d = decideExit({ ...p, pending: { spread: 1 } }, (await r.src.fetch({ cfg: cfgFast, nowMs: NOW, myEquityByOpp: { a: 600 } }))[0], [], dctx({ cfg: cfgFast, positions: [p] }));
    assert.equal(exits(d.actions)[0]!.fraction, 1);
  });

  it("holding valuation does not time-weight a stream that is still paying", () => {
    const o = opp({ streams: [constantStream("r", "base", 0.3, { endsAtMs: NOW + 3 * 24 * HOUR })] });
    assert.ok(Math.abs(valueAt(o, 10_000, dctx(), { holding: true, noTimeWeight: true }).netApr - 0.3) < 1e-9);
    assert.ok(valueAt(o, 10_000, dctx()).netApr < 0.1, "entry valuation still time-weights");
  });

  it("discovery-only opportunities are not kept in history", async () => {
    const r = rig([spec("a", { executable: false })]);
    await r.router.cycle();
    assert.equal(Object.keys(r.store.load().history.opps).length, 0);
  });
});
