import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaperExecutor } from "../src/executor.js";
import { Router } from "../src/monitor.js";
import { CollectingNotifier } from "../src/notify.js";
import { loadScenario, runScenario } from "../src/scenario.js";
import { StaticSource, type StaticOppSpec } from "../src/sources/static.js";
import type { Source } from "../src/sources/types.js";
import { MemoryStore, newState } from "../src/store.js";
import { cfgWith, HOUR, NOW } from "./helpers.js";

const spec = (id: string, venue = "navi", apr = 0.15): StaticOppSpec => ({
  id,
  kind: "deposit",
  venue,
  chain: "sui",
  token: "USDC",
  capacity_usd: 50_000_000,
  streams: [{ label: "base", kind: "base", apr }],
});

function rig(specs: StaticOppSpec[], extraSources: Source[] = [], cfgOver: unknown = {}) {
  let t = NOW;
  const src = new StaticSource(specs, "static", NOW);
  const store = new MemoryStore(newState(100_000));
  const notifier = new CollectingNotifier();
  const exec = new PaperExecutor();
  const router = new Router({
    cfg: cfgWith(cfgOver),
    sources: [src, ...extraSources],
    executors: { static: exec },
    store,
    notifier,
    tokens: () => ({}),
    now: () => t,
    paperAccrual: true,
  });
  return { router, store, notifier, src, exec, tick: (h = 1) => (t += h * HOUR) };
}

describe("router", () => {
  it("enters, and a failing extra source does not stop the cycle", async () => {
    const broken: Source = { id: "broken", fetch: async () => { throw new Error("rpc down"); } };
    const r = rig([spec("a"), spec("b", "suilend", 0.12)], [broken]);
    const rep = await r.router.cycle();
    assert.equal(rep.sourceErrors.length, 1);
    assert.deepEqual(rep.executed.filter((x) => x.action.type === "enter").map((x) => x.action.type === "enter" && x.action.oppId).sort(), ["a", "b"]);
    assert.ok(r.notifier.messages.some((m) => m.text.includes("rpc down")));
  });

  it("dedupes repeated status alerts but not actions", async () => {
    const broken: Source = { id: "broken", fetch: async () => { throw new Error("rpc down 1"); } };
    const r = rig([spec("a")], [broken]);
    await r.router.cycle();
    r.tick();
    await r.router.cycle();
    const errs = r.notifier.messages.filter((m) => m.text.includes("rpc down"));
    assert.equal(errs.length, 1);
    r.tick(7);
    await r.router.cycle();
    assert.equal(r.notifier.messages.filter((m) => m.text.includes("rpc down")).length, 2);
  });

  it("kill switch: equity drawdown exits everything and pauses", async () => {
    const r = rig([spec("a")]);
    await r.router.cycle();
    // simulate a loss outside the model (e.g. exploit): mark the position down 20%
    const st = r.store.load();
    st.positions[0]!.equityUsd *= 0.8;
    r.store.save(st);
    r.tick();
    // first cycle that sees the drawdown: warned, not fired (portfolio.kill_confirm_cycles = 2)
    const first = await r.router.cycle();
    assert.equal(first.killed, false);
    assert.ok(r.notifier.messages.some((m) => m.level === "critical" && m.text.includes("(1/2)")));
    r.tick();
    const rep = await r.router.cycle();
    assert.equal(rep.killed, true);
    assert.ok(rep.executed.some((x) => x.action.type === "exit" && x.action.reason === "kill switch"));
    assert.equal(r.store.load().positions.length, 0);
    assert.ok(r.notifier.messages.some((m) => m.level === "critical" && m.text.includes("KILL SWITCH")));
    r.tick();
    const after = await r.router.cycle();
    assert.equal(after.executed.filter((x) => x.action.type === "enter").length, 0, "paused after kill");
    assert.match(r.router.handleCommand({ cmd: "/resume", args: [] }), /resumed/);
    r.tick();
    const re = await r.router.cycle();
    assert.equal(re.killed, false, "resume re-arms the window instead of re-killing");
  });

  it("manual /exit via telegram command", async () => {
    const r = rig([spec("a")]);
    await r.router.cycle();
    assert.match(r.router.handleCommand({ cmd: "/exit", args: ["a"] }), /will exit/);
    r.tick();
    const rep = await r.router.cycle();
    assert.ok(rep.executed.some((x) => x.action.type === "exit" && x.action.reason === "manual /exit"));
    assert.match(r.router.handleCommand({ cmd: "/status", args: [] }), /0 positions/);
  });

  it("failed exits are retried and reported as critical", async () => {
    const r = rig([spec("a")]);
    await r.router.cycle();
    const st = r.store.load();
    st.positions[0]!.exitProbe.consecutiveFailures = 5; // forces an urgent exit decision
    r.store.save(st);
    (r.exec as unknown as { opts: { failExit: () => boolean } }).opts.failExit = () => true;
    r.tick();
    await r.router.cycle();
    assert.equal(r.store.load().positions.length, 1);
    assert.ok(r.notifier.messages.some((m) => m.level === "critical" && m.text.includes("exit FAILED")));
  });

  it("skips allocation in the cycle of an urgent exit", async () => {
    const r = rig([spec("a"), { ...spec("b", "suilend"), capacity_usd: 50_000_000 }], [], {
      caps: { per_venue_frac_by_tier: { 1: 0.3 }, per_opportunity_frac: 0.3 },
      allocator: { max_new_positions_per_cycle: 1 },
    });
    await r.router.cycle(); // enters one
    r.src.specs.find((s) => s.id === "a")!.capacity_usd = 100_000; // 1/5 rule breach
    r.tick();
    const rep = await r.router.cycle();
    assert.ok(rep.executed.some((x) => x.action.type === "exit" && x.action.urgent));
    assert.equal(rep.executed.filter((x) => x.action.type === "enter").length, 0);
  });
});

describe("scenarios (examples/scenarios)", () => {
  it("plasma: dumps on crash, survives the emission cut, leaves before the campaign ends", async () => {
    const r = await runScenario(loadScenario("examples/scenarios/plasma-reward-collapse.yaml"));
    const at = (step: number) => r.lines[step]!.report.executed.map((x) => x.action);
    assert.ok(at(20).some((a) => a.type === "sell" && a.reason.includes("crash")));
    assert.ok(!r.lines.slice(40, 60).some((l) => l.report.executed.some((x) => x.action.type === "exit")), "emission cut alone is not an exit (edge still > threshold)");
    const ex = at(60).find((a) => a.type === "exit");
    assert.ok(ex && ex.type === "exit" && ex.reason.includes("ending") && !ex.urgent);
    assert.ok(r.finalEquityUsd > r.startEquityUsd);
  });

  it("bank run: urgent exit on the drain, dead exit path, blind source", async () => {
    const r = await runScenario(loadScenario("examples/scenarios/bank-run.yaml"));
    const exitAt = (id: string) =>
      r.lines.find((l) => l.report.executed.some((x) => x.action.type === "exit" && x.action.oppId === id))?.step;
    assert.equal(exitAt("newlend-usdc"), 12);
    assert.equal(exitAt("suilend-usdc"), 32);
    assert.equal(exitAt("navi-usdc"), 54);
  });
});
