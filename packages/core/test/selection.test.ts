/**
 * One risk-adjusted scale for loops and deposits: depeg-risk model, tier
 * filter, per-stable cap, kind thresholds, explainSelection, static real-math
 * specs, and the 2026-10-29 selection scenarios.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planAllocation } from "../src/allocator.js";
import { validateConfig } from "../src/config.js";
import { capViolations, withAddition } from "../src/exposure.js";
import { entryBlockers } from "../src/gates/entry.js";
import { formatScenario, loadScenario, runScenario, type Scenario } from "../src/scenario.js";
import { explainSelection, formatSelection } from "../src/selection.js";
import { loopPairOpportunity, type LoopLeg, type LoopPair } from "../src/sources/loopPair.js";
import { StaticSource, type StaticEntry } from "../src/sources/static.js";
import { supplyOpportunity, type SupplyMarket } from "../src/sources/supply.js";
import { stableRisk } from "../src/stables.js";
import { entryThreshold, exitThreshold } from "../src/tiers.js";
import { cfgWith, close, dctx, sctx } from "./helpers.js";

const market = (over: Partial<SupplyMarket> = {}): SupplyMarket => ({
  protocol: "navi",
  chain: "sui",
  marketId: "USDC",
  asset: { symbol: "USDC", priceUsd: 1 },
  totalSupplyUsd: 100e6,
  totalBorrowUsd: 60e6,
  supplyAprBase: 0.08,
  rewards: [],
  ...over,
});
const leg = (symbol: string, over: Partial<LoopLeg> = {}): LoopLeg => ({
  symbol,
  priceUsd: 1,
  totalSupplyUsd: 60e6,
  totalBorrowUsd: 30e6,
  supplyAprBase: 0.05,
  borrowAprBase: 0.04,
  supplyRewards: [],
  borrowRewards: [],
  ...over,
});
const pair = (over: Partial<LoopPair> = {}): LoopPair => ({
  protocol: "suilend",
  chain: "sui",
  pairId: "USDe/USDT",
  collateral: leg("USDe"),
  debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 20e6 }),
  maxLtv: 0.9,
  liqLtv: 0.93,
  swapCostFrac: 0.0001,
  swapDepthUsd: 50e6,
  ...over,
});

describe("depeg-risk model", () => {
  it("expected loss: per-stable value, else the tier default; unknown stables take unknown_stable_tier", () => {
    const cfg = cfgWith({ stables: { AUSD: { tier: 2, expected_loss_apr: 0.004 }, XUSD: { tier: 2 } } });
    assert.equal(stableRisk(cfg, "AUSD").lossApr, 0.004);
    assert.equal(stableRisk(cfg, "XUSD").lossApr, cfg.tiers_default_loss[2]);
    assert.equal(stableRisk(cfg, "usde").tier, 3, "case-insensitive fallback (USDe is tier 3)");
    assert.equal(stableRisk(cfg, "USDe").lossApr, 0.015);
    const unk = stableRisk(cfg, "NEWUSD");
    assert.equal(unk.known, false);
    assert.equal(unk.tier, 3);
    assert.equal(unk.lossApr, cfg.tiers_default_loss[3]);
  });

  it("charged as a running cost: deposit 1x, same-asset loop 1x, two-asset loop L x collateral", () => {
    const cfg = cfgWith();
    const loss = (s: string) => stableRisk(cfg, s).lossApr;
    assert.ok(close(supplyOpportunity(market({ asset: { symbol: "USDe", priceUsd: 1 } }), sctx(cfg), "s")!.costs.ongoingApr, loss("USDe")));
    const p = loopPairOpportunity(pair(), sctx(cfg), "s")!;
    const L = p.meta!["leverage"] as number;
    assert.ok(close(p.costs.ongoingApr, L * loss("USDe")));
    const same = loopPairOpportunity(pair({ pairId: "USDe/USDe", debt: leg("USDe") }), sctx(cfg), "s")!;
    assert.ok(close(same.costs.ongoingApr, loss("USDe")));
  });

  it("deposits above sources.supply.max_risk_tier are refused; loops only pay the haircut", () => {
    const cfg = cfgWith();
    const risky = supplyOpportunity(market({ asset: { symbol: "NEWUSD", priceUsd: 1 } }), sctx(cfg), "s")!;
    assert.ok(entryBlockers(risky, dctx({ cfg })).includes("depeg risk tier 3 > max 2 (NEWUSD)"));
    const ok = supplyOpportunity(market({ asset: { symbol: "AUSD", priceUsd: 1 } }), sctx(cfg), "s")!;
    assert.ok(!entryBlockers(ok, dctx({ cfg })).some((b) => b.startsWith("depeg risk")));
    const loop = loopPairOpportunity(pair({ collateral: leg("NEWUSD") }), sctx(cfg), "s")!;
    assert.ok(!entryBlockers(loop, dctx({ cfg })).some((b) => b.startsWith("depeg risk")));
    assert.ok(close(loop.costs.ongoingApr, (loop.meta!["leverage"] as number) * cfg.tiers_default_loss[3]));
    // a stricter book
    const strict = cfgWith({ sources: { supply: { max_risk_tier: 1 } } });
    assert.ok(entryBlockers(ok, dctx({ cfg: strict })).includes("depeg risk tier 2 > max 1 (AUSD)"));
  });

  it("per-stable depeg levels override the lending_loop levels (pair: strictest leg)", () => {
    const cfg = cfgWith({ stables: { USDe: { tier: 2, depeg_warn: 0.001, depeg_exit: 0.004 } } });
    const d = loopPairOpportunity(pair(), sctx(cfg), "s")!.signals.find((s) => s.name === "depeg")!;
    assert.equal(d.warnAt, 0.001);
    assert.equal(d.exitAt, 0.004);
    const plain = loopPairOpportunity(pair({ collateral: leg("USDC"), debt: leg("USDT") }), sctx(cfg), "s")!.signals.find((s) => s.name === "depeg")!;
    assert.equal(plain.warnAt, cfg.sources.lending_loop.depeg_warn);
  });

  it("stables.<SYM>.max_frac caps that asset across ALL positions", () => {
    const cfg = cfgWith({
      stables: { USDe: { tier: 2, max_frac: 0.1 } },
      caps: { max_position_usd: 1e9, per_opportunity_frac: 1, per_venue_frac_by_tier: { 1: 1 } },
      venues: { a: { tier: 1 }, b: { tier: 1 } },
    });
    const mk = (protocol: string) => supplyOpportunity(market({ protocol, asset: { symbol: "USDe", priceUsd: 1 } }), sctx(cfg), "s")!;
    const ctx = dctx({ cfg, equity: 1_000_000 });
    const plan = planAllocation([mk("a"), mk("b")], ctx);
    const total = plan.entries.reduce((a, e) => a + e.deltaUsd, 0);
    assert.ok(total > 0 && total <= 100_000 + 1e-6, String(total));
    assert.equal(new Set(plan.entries.map((e) => e.oppId)).size, 2, "the cap is shared by both USDe markets");
    const a = mk("a");
    assert.match(capViolations(cfg, withAddition(ctx.exposure, a, 120_000), a, 1_000_000).join(), /stables\.USDe\.max_frac 10\.0%/);
  });
});

describe("kind thresholds", () => {
  it("deposits clear a lower bar than loops at the same tier; never below baseline", () => {
    const cfg = cfgWith();
    assert.ok(close(entryThreshold(cfg, 1, "deposit"), 0.06));
    assert.ok(close(entryThreshold(cfg, 1, "lending_loop"), 0.075));
    assert.ok(close(entryThreshold(cfg, 1), 0.075));
    assert.ok(close(exitThreshold(cfg, 1, "deposit"), 0.035));
    assert.ok(close(exitThreshold(cfg, 2, "deposit"), 0.055));
    const deep = cfgWith({ thresholds: { kind_premium_adjust: { deposit: { entry: -0.1, exit: -0.2 } } } });
    assert.equal(entryThreshold(deep, 1, "deposit"), deep.baseline_apr);
    // an adjustment that inverts entry/exit is rejected
    assert.match(validateConfig(cfgWith({ thresholds: { kind_premium_adjust: { deposit: { entry: -0.03, exit: 0.01 } } } })).join(), /hysteresis/);
  });

  it("the same 6.5% net is a deposit entry but not a loop entry (tier 1)", () => {
    const cfg = cfgWith();
    const dep = supplyOpportunity(market({ supplyAprBase: 0.0655 }), sctx(cfg), "s")!;
    assert.equal(planAllocation([dep], dctx({ cfg })).entries.length, 1);
  });
});

describe("explainSelection", () => {
  it("one row per candidate: net = raw - haircut - depeg - costs - move, verdict and reasons from the plan", () => {
    const cfg = cfgWith({ venues: { weak: { tier: 2 } } });
    const good = supplyOpportunity(market({ rewards: [{ token: "NAVX", apr: 0.02 }] }), sctx(cfg), "s")!;
    const bad = supplyOpportunity(market({ protocol: "weak", supplyAprBase: 0.04 }), sctx(cfg), "s")!;
    const loop = loopPairOpportunity(pair(), sctx(cfg), "s")!;
    const ctx = dctx({ cfg });
    const plan = planAllocation([good, bad, loop], ctx);
    const rows = explainSelection([good, bad, loop], ctx, plan);
    assert.equal(rows.length, 3);
    const g = rows.find((r) => r.oppId === good.id)!;
    assert.equal(g.verdict, "picked");
    assert.equal(g.pickedUsd, plan.entries.filter((e) => e.oppId === good.id).reduce((a, e) => a + e.deltaUsd, 0));
    assert.ok(g.haircutApr > 0, "unknown reward token -> default realizable haircut");
    assert.ok(close(g.depegLossApr, stableRisk(cfg, "USDC").lossApr));
    for (const r of rows) assert.ok(close(r.netApr, r.rawApr - r.haircutApr - r.depegLossApr - r.costsApr - r.moveCostApr, 1e-9), r.oppId);
    const b = rows.find((r) => r.oppId === bad.id)!;
    assert.equal(b.verdict, "rejected");
    assert.equal(b.tier, 2);
    assert.ok(close(b.thresholdApr, 0.09));
    assert.match(b.reasons.join(), /< entry 9\.00%/);
    assert.equal(rows[0]!.verdict, "picked", "picked rows first");
    const txt = formatSelection(rows);
    assert.match(txt, /verdict.*net =\s+raw -\s+haircut -\s+depeg -\s+costs -\s+move \|\s+entry/);
    assert.ok(txt.includes(good.id) && txt.includes(bad.id) && txt.includes(loop.id));
  });
});

describe("static real-math specs", () => {
  it("supply_market / loop_pair entries are built by the real math; executable:false = discovery; duplicate ids refused", async () => {
    const entries: StaticEntry[] = [
      { supply_market: market() },
      { loop_pair: pair() },
      { supply_market: market({ marketId: "USDT", asset: { symbol: "USDT", priceUsd: 1 } }), executable: false },
      { id: "plain", kind: "deposit", venue: "navi", chain: "sui", token: "USDC", capacity_usd: 1e7, streams: [{ label: "b", kind: "base", apr: 0.05 }] },
    ];
    const src = new StaticSource(entries, "static");
    const out = await src.fetch(sctx());
    assert.deepEqual(out.map((o) => [o.id, o.kind]), [
      ["static:navi:USDC", "deposit"],
      ["static:suilend:USDe/USDT", "lending_loop"],
      ["static:navi:USDT", "deposit"],
      ["plain", "deposit"],
    ]);
    assert.equal(out[2]!.discoveryOnly, true);
    assert.equal(out[0]!.meta!["supply"], true);
    assert.throws(() => new StaticSource([{ supply_market: market() }, { supply_market: market() }]), /duplicate opportunity id static:navi:USDC/);
  });

  it("scenarios patch real-math entries by their id (deep merge) and print why", async () => {
    const sc: Scenario = {
      name: "patch",
      start_equity_usd: 100_000,
      step_minutes: 60,
      steps: 3,
      config: { venues: { navi: { enabled: true, tier: 1 } } },
      opportunities: [{ supply_market: market({ supplyAprBase: 0.03 }) }],
      events: [{ at: 1, note: "rate up", patch: { "static:navi:USDC": { supply_market: { supplyAprBase: 0.09 } } } }],
    };
    const r = await runScenario(sc);
    assert.equal(r.lines[0]!.report.executed.length, 0);
    assert.equal(r.lines[0]!.report.selection![0]!.verdict, "rejected");
    assert.ok(r.lines[1]!.report.executed.some((x) => x.action.type === "enter" && x.action.oppId === "static:navi:USDC"));
    const txt = formatScenario(r, false, true);
    assert.match(txt, /why \(one scale/);
    assert.match(txt, /picked .*static:navi:USDC/);
  });
});

describe("scenario: examples/scenarios/selection-2026-10-29*.yaml", () => {
  it("live policy (router_config: live-router.yaml): one deposit clears its bar and is funded cross-chain; the rest say why", async () => {
    const sc = loadScenario("examples/scenarios/selection-2026-10-29.yaml");
    assert.match(sc.router_config!, /config\/live-router\.yaml$/, "resolved relative to the scenario file");
    const r = await runScenario(sc);
    const s0 = r.lines[0]!.report;
    const sel = s0.selection!;
    assert.equal(sel.length, 16, "12 supply-only + 4 loops");
    const by = (id: string) => sel.find((x) => x.oppId === id)!;
    const fusdc = by("static:fluid:ethereum:fUSDC");
    assert.equal(fusdc.verdict, "picked");
    assert.equal(Math.round(fusdc.pickedUsd), 120000, "per-position cap of the live router");
    assert.equal(sel.filter((x) => x.verdict === "picked").length, 1);
    const sent = s0.transfers.filter((x) => x.kind === "sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.forOppId, "static:fluid:ethereum:fUSDC");
    assert.equal(sent[0]!.to, "ethereum:USDC");
    // a 5 bps swap into USDsui costs more than one day of its yield (the friction rule)
    assert.match(by("static:navi:sui:USDsui").reasons.join(), /one_day_yield/);
    // weekly Aave campaign ending today barely counts without a renewal assumption
    const v4 = by("static:aave-v4:ethereum:core:USDC");
    assert.equal(v4.verdict, "rejected");
    assert.ok(v4.haircutApr > 0.02, JSON.stringify(v4));
    assert.match(by("static:aave-v3:plasma:USDT0").reasons.join(), /utilization/);
    assert.match(by("static:morpho-vault:ethereum:sentora-rlusd").reasons.join(), /utilization=0\.98/);
    // USDe is a tier-3 stable: loops pay 3.33 x 1.5% expected depeg loss
    for (const id of ["static:aave-v3:plasma:USDe/GHO", "static:aave-v3:monad:USDe/USDT0"]) {
      const l = by(id);
      assert.equal(l.verdict, "rejected");
      assert.ok(l.depegLossApr > 0.045, JSON.stringify(l));
    }
    const s1 = r.lines[1]!.report;
    assert.ok(s1.transfers.some((x) => x.kind === "arrived"));
    assert.ok(s1.executed.some((x) => x.action.type === "enter" && x.action.oppId === "static:fluid:ethereum:fUSDC"));
    assert.ok(!r.lines.some((l) => l.report.killed));
  });

  it("what-if renewal (extends the base file): weekly campaigns count for more, the picks do not change", async () => {
    const base = await runScenario(loadScenario("examples/scenarios/selection-2026-10-29.yaml"));
    const sc = loadScenario("examples/scenarios/selection-2026-10-29-whatif-renewal.yaml");
    assert.equal(sc.opportunities.length, 16, "extends: markets come from the base file");
    const r = await runScenario(sc);
    const row = (x: typeof r, id: string) => x.lines[0]!.report.selection!.find((y) => y.oppId === id)!;
    const id = "static:aave-v4:ethereum:core:USDC";
    assert.ok(row(r, id).haircutApr < row(base, id).haircutApr - 0.01);
    assert.equal(row(r, id).verdict, "rejected");
    assert.equal(row(r, "static:fluid:ethereum:fUSDC").verdict, "picked");
    assert.match(row(r, "static:aave-v3:plasma:GHO").reasons.join(), /one_day_yield/);
  });
});

describe("per-tier kind premium adjustments", () => {
  it("accept a number or a per-tier map; validation keeps hysteresis", async () => {
    const { DEFAULT_CONFIG, validateConfig } = await import("../src/config.js");
    const { entryThreshold, exitThreshold } = await import("../src/tiers.js");
    const c = structuredClone(DEFAULT_CONFIG);
    c.thresholds.kind_premium_adjust = { deposit: { entry: { 1: -0.015, 2: -0.03, 3: -0.06 }, exit: { 1: -0.01, 2: -0.015, 3: -0.03 } } };
    assert.deepEqual(validateConfig(c), []);
    const b = c.baseline_apr;
    assert.ok(Math.abs(entryThreshold(c, 2, "deposit") - (b + c.thresholds.entry_premium_by_tier[2] - 0.03)) < 1e-12);
    assert.ok(Math.abs(exitThreshold(c, 3, "deposit") - (b + c.thresholds.exit_premium_by_tier[3] - 0.03)) < 1e-12);
    assert.equal(entryThreshold(c, 2, "lending_loop"), b + c.thresholds.entry_premium_by_tier[2], "other kinds untouched");
    c.thresholds.kind_premium_adjust = { deposit: { entry: { 1: -0.03 }, exit: { 1: 0 } } };
    assert.match(validateConfig(c).join(), /hysteresis/);
  });
});
