/**
 * Cross-chain funding: routes, friction rules (a)-(e), planner, allocator.
 * Router lifecycle + the scenario live in xchain-router.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planAllocation } from "../src/allocator.js";
import { DEFAULT_CONFIG, loadConfig, type RouterConfig } from "../src/config.js";
import type { Opportunity } from "../src/types.js";
import { constantStream } from "../src/valuation.js";
import { checkFriction, type FrictionInput } from "../src/xchain/friction.js";
import { FundingPlanner } from "../src/xchain/planner.js";
import { assetKey, RouteGraph, routeCostUsd, transitCostUsd } from "../src/xchain/routes.js";
import type { RouteSpec } from "../src/xchain/types.js";
import { cfgWith, close, dctx, HOUR, NOW, opp } from "./helpers.js";

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

const ca = (k: string) => {
  const [chain, asset] = k.split(":") as [string, string];
  return { chain, asset };
};

const xcfg = (routes: RouteSpec[], over: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): RouterConfig =>
  cfgWith({ xchain: { enabled: true, routes, ...over }, ...rest });

const onChain = (id: string, chain: string, apr: number, token = "USDC", venue = "navi"): Opportunity =>
  opp({
    id,
    name: id,
    chain,
    primaryVenue: venue,
    legs: [{ venue, chain, token, equityFrac: 1 }],
    streams: [constantStream("base", "base", apr)],
  });

describe("xchain config", () => {
  it("config/default.yaml xchain section mirrors DEFAULT_CONFIG.xchain (off by default)", () => {
    const c = loadConfig("config/default.yaml");
    assert.deepEqual(c.xchain, DEFAULT_CONFIG.xchain);
    assert.equal(c.xchain.enabled, false);
  });
});

describe("xchain routes", () => {
  it("routeCostUsd = bps x amount + fixed + gas on both sides", () => {
    const r = route("r", "a:USDC", "b:USDC", { feeBps: 10, feeFixedUsd: 2, gasSrcUsd: 0.5, gasDstUsd: 0.7 });
    assert.ok(close(routeCostUsd(r, 10_000), 10 + 2 + 1.2));
    assert.equal(assetKey({ chain: "sui", asset: "USDC" }), "sui:USDC");
  });

  it("same node is an empty, free path", () => {
    const g = new RouteGraph([route("r", "a:USDC", "b:USDC")]);
    assert.deepEqual(g.findPath(ca("a:USDC"), ca("a:USDC"), 1e6, 0.1), { path: [], costUsd: 0, feesUsd: 0, etaMinutes: 0 });
  });

  it("Dijkstra prefers a cheap 2-hop path over an expensive direct route", () => {
    const g = new RouteGraph([
      route("direct", "a:USDC", "c:USDC", { feeBps: 50 }),
      route("ab", "a:USDC", "b:USDC"),
      route("bc", "b:USDC", "c:USDC"),
    ]);
    const p = g.findPath(ca("a:USDC"), ca("c:USDC"), 100_000, 0.1)!;
    assert.deepEqual(p.path.map((r) => r.id), ["ab", "bc"]);
    assert.equal(p.etaMinutes, 40);
    assert.ok(close(p.feesUsd, 2 * (10 + 1)));
    assert.ok(close(p.costUsd, p.feesUsd + transitCostUsd(100_000, 0.1, 40)));
  });

  it("disabled routes and min/max size limits are respected", () => {
    const routes = [
      route("cheap-capped", "a:USDC", "b:USDC", { maxUsd: 50_000 }),
      route("off", "a:USDC", "b:USDC", { feeBps: 0, gasSrcUsd: 0, gasDstUsd: 0, enabled: false }),
      route("pricey", "a:USDC", "b:USDC", { feeBps: 20 }),
    ];
    const g = new RouteGraph(routes);
    assert.equal(g.findPath(ca("a:USDC"), ca("b:USDC"), 10_000, 0.1)!.path[0]!.id, "cheap-capped");
    assert.equal(g.findPath(ca("a:USDC"), ca("b:USDC"), 100_000, 0.1)!.path[0]!.id, "pricey");
    const g2 = new RouteGraph([route("min", "a:USDC", "b:USDC", { minUsd: 5_000 })]);
    assert.equal(g2.findPath(ca("a:USDC"), ca("b:USDC"), 1_000, 0.1), null);
  });

  it("paths are limited to 3 hops", () => {
    const g = new RouteGraph([route("1", "a:X", "b:X"), route("2", "b:X", "c:X"), route("3", "c:X", "d:X"), route("4", "d:X", "e:X")]);
    assert.equal(g.findPath(ca("a:X"), ca("d:X"), 1000, 0.1)!.path.length, 3);
    assert.equal(g.findPath(ca("a:X"), ca("e:X"), 1000, 0.1), null);
  });

  it("money in flight earns nothing: a slow free route loses to a fast paid one at high APR", () => {
    const g = new RouteGraph([
      route("slow", "a:USDC", "b:USDC", { feeBps: 0, gasSrcUsd: 0, gasDstUsd: 0, etaMinutes: 7 * 24 * 60 }),
      route("fast", "a:USDC", "b:USDC", { feeBps: 0, feeFixedUsd: 5, gasSrcUsd: 0, gasDstUsd: 0, etaMinutes: 1 }),
    ]);
    assert.equal(g.findPath(ca("a:USDC"), ca("b:USDC"), 100_000, 0.1)!.path[0]!.id, "fast");
    assert.equal(g.findPath(ca("a:USDC"), ca("b:USDC"), 100_000, 0)!.path[0]!.id, "slow");
  });

  it("xchain disabled = no routes at all", () => {
    const c = cfgWith({ xchain: { enabled: false, routes: [route("r", "a:USDC", "b:USDC")] } });
    assert.equal(RouteGraph.fromConfig(c).findPath(ca("a:USDC"), ca("b:USDC"), 1000, 0.1), null);
  });
});

describe("xchain friction rules", () => {
  const base = (over: Partial<FrictionInput> = {}, cfgOver: Record<string, unknown> = {}): FrictionInput => ({
    cfg: xcfg([], cfgOver),
    nowMs: NOW,
    amountUsd: 100_000,
    costUsd: 10,
    destNetApr: 0.1,
    ledger: [],
    plannedCostUsd: 0,
    bookYieldPerYearUsd: 1_000_000,
    inFlightUsd: 0,
    totalEquityUsd: 1_000_000,
    ...over,
  });
  const oneDay = (100_000 * 0.1) / 365; // $27.40

  it("passes a cheap move", () => {
    const r = checkFriction(base());
    assert.equal(r.ok, true, r.reasons.join("; "));
    assert.ok(close(r.oneDayYieldUsd, oneDay));
  });

  it("(a) cost exactly one day of yield passes; a cent more fails", () => {
    assert.equal(checkFriction(base({ costUsd: oneDay })).ok, true);
    const over = checkFriction(base({ costUsd: oneDay + 0.01 }));
    assert.deepEqual(over.rules, ["one_day_yield"]);
    assert.match(over.reasons[0]!, /1 day\(s\) of yield \$27\.40/);
    // the multiplier is configurable
    assert.equal(checkFriction(base({ costUsd: 2 * oneDay }, { max_cost_days_of_yield: 2 })).ok, true);
  });

  it("(b) payback against what the money earns idle where it is", () => {
    // idle earns 9.5%: gain over 14 days = 0.5% x 100k x 14/365 = $19.18
    const cfgOver = { idle_apr: 0.095, payback_days: 14 };
    assert.equal(checkFriction(base({ costUsd: 19 }, cfgOver)).ok, true);
    const r = checkFriction(base({ costUsd: 20 }, cfgOver));
    assert.deepEqual(r.rules, ["payback"]);
  });

  it("(c) rolling 24h book budget counts the ledger and moves planned this cycle", () => {
    // empty book: budget = one day of this move's yield ($27.40)
    const empty = { bookYieldPerYearUsd: 0 };
    assert.equal(checkFriction(base({ ...empty, costUsd: 10 })).ok, true);
    const recent = [{ t: NOW - 1 * HOUR, costUsd: 20, transferId: "x" }];
    const r = checkFriction(base({ ...empty, costUsd: 10, ledger: recent }));
    assert.deepEqual(r.rules, ["book_budget"]);
    assert.ok(close(r.spent24hUsd, 20));
    // older than 24h: out of the window
    const old = [{ t: NOW - 25 * HOUR, costUsd: 20, transferId: "x" }];
    assert.equal(checkFriction(base({ ...empty, costUsd: 10, ledger: old })).ok, true);
    // planned this cycle counts too
    assert.deepEqual(checkFriction(base({ ...empty, costUsd: 10, plannedCostUsd: 18 })).rules, ["book_budget"]);
    // a bigger book raises the budget
    assert.equal(checkFriction(base({ bookYieldPerYearUsd: 365 * 100, costUsd: 10, ledger: recent })).ok, true);
  });

  it("(d) minimum move size", () => {
    const r = checkFriction(base({ amountUsd: 999, costUsd: 0.01 }));
    assert.deepEqual(r.rules, ["min_move"]);
    assert.equal(checkFriction(base({ amountUsd: 1000, costUsd: 0.01 })).ok, true);
  });

  it("(e) in-flight cap as a share of total equity", () => {
    const eq = { totalEquityUsd: 300_000 }; // 50% = $150k
    assert.equal(checkFriction(base({ ...eq, inFlightUsd: 50_000 })).ok, true);
    assert.deepEqual(checkFriction(base({ ...eq, inFlightUsd: 60_000 })).rules, ["in_flight"]);
  });

  it("a destination that does not earn always fails, even for free", () => {
    assert.ok(checkFriction(base({ destNetApr: 0, costUsd: 0 })).rules.includes("dest_apr"));
    assert.ok(checkFriction(base({ destNetApr: -0.05, costUsd: 0 })).rules.includes("dest_apr"));
    assert.equal(checkFriction(base({ destNetApr: NaN })).ok, false);
  });
});

describe("xchain funding planner", () => {
  const routes = [
    route("arb-sui", "arbitrum:USDC", "sui:USDC"),
    route("eth-sui", "ethereum:USDC", "sui:USDC", { gasSrcUsd: 8 }),
  ];
  const planner = (idle: Record<string, number>, over: Partial<ConstructorParameters<typeof FundingPlanner>[0]> = {}, cfg = xcfg(routes)) =>
    new FundingPlanner({ cfg, nowMs: NOW, idle, ledger: [], transfers: [], totalEquityUsd: 1_000_000, bookYieldPerYearUsd: 0, ...over });
  const sui = onChain("s", "sui", 0.12);

  it("uses money already on the right chain first, for free", () => {
    const p = planner({ "sui:USDC": 50_000, "arbitrum:USDC": 50_000 });
    const q = p.quote(sui, 6_000, 0.12);
    assert.equal(q.ok, true);
    assert.deepEqual(q.path, []);
    assert.equal(q.costUsd, 0);
    assert.equal(assetKey(q.source!), "sui:USDC");
    p.commit(sui, 6_000, q);
    assert.equal(p.available("sui:USDC"), 44_000);
    assert.equal(p.localFor("s"), 6_000);
  });

  it("picks the cheapest source whose path passes friction", () => {
    const p = planner({ "sui:USDC": 0, "arbitrum:USDC": 50_000, "ethereum:USDC": 50_000 });
    const q = p.quote(sui, 20_000, 0.12);
    assert.equal(q.ok, true, q.reason);
    assert.equal(assetKey(q.source!), "arbitrum:USDC");
    assert.deepEqual(q.path.map((r) => r.id), ["arb-sui"]);
  });

  it("a source must hold the whole chunk; an expensive one fails the one-day rule", () => {
    // arbitrum too small; ethereum gas $8.5 > one day of $6k at 12% ($1.97)
    const p = planner({ "arbitrum:USDC": 3_000, "ethereum:USDC": 50_000 });
    const q = p.quote(sui, 6_000, 0.12);
    assert.equal(q.ok, false);
    assert.match(q.reason!, /ethereum:USDC->sui:USDC.*one_day_yield/);
    assert.equal(planner({ "arbitrum:USDC": 3_000 }).quote(sui, 6_000, 0.12).ok, false);
  });

  it("chunks for the same opportunity aggregate into one move (fixed costs paid once)", () => {
    const p = planner({ "arbitrum:USDC": 100_000 });
    const q1 = p.quote(sui, 20_000, 0.12);
    p.commit(sui, 20_000, q1);
    const q2 = p.quote(sui, 20_000, 0.12);
    assert.ok(q2.ok);
    // second chunk: only the proportional fee + its transit cost, no gas
    assert.ok(close(q2.costUsd, 2 + transitCostUsd(20_000, 0.12, 20), 1e-6), String(q2.costUsd));
    p.commit(sui, 20_000, q2);
    const moves = p.plannedMoves("s");
    assert.equal(moves.length, 1);
    assert.equal(moves[0]!.amountUsd, 40_000);
    assert.ok(close(moves[0]!.costUsd, 4 + 1 + transitCostUsd(40_000, 0.12, 20), 1e-6));
    assert.equal(p.available("arbitrum:USDC"), 60_000);
  });

  it("committed moves use up the 24h budget seen by later moves", () => {
    // ledger: $1.50 paid an hour ago; empty book -> budget = one day of the move's own yield
    const ledger = [{ t: NOW - HOUR, costUsd: 1.5, transferId: "old" }];
    const a = onChain("a", "sui", 0.2);
    const b = onChain("b", "sui", 0.2);
    const p = planner({ "arbitrum:USDC": 100_000 }, { ledger });
    // 20k at 20%: one day = $10.96; cost ~= $3.02 -> passes with the ledger
    const qa = p.quote(a, 20_000, 0.2);
    assert.ok(qa.ok, qa.reason);
    p.commit(a, 20_000, qa);
    // 5k at 20%: one day = $2.74 >= its own cost ($1.50) but ledger 1.5 + planned 3.02 + 1.5 > 2.74
    const qb = p.quote(b, 5_000, 0.2);
    assert.equal(qb.ok, false);
    assert.match(qb.reason!, /book_budget/);
    // without the earlier commit the same move passes rule (c)
    const fresh = planner({ "arbitrum:USDC": 100_000 });
    assert.ok(fresh.quote(b, 5_000, 0.2).ok);
  });

  it("cross-chain moves are refused when xchain is disabled", () => {
    const p = planner({ "arbitrum:USDC": 100_000 }, {}, cfgWith({ xchain: { enabled: false, routes } }));
    const q = p.quote(sui, 6_000, 0.12);
    assert.equal(q.ok, false);
    assert.match(q.reason!, /disabled/);
  });

  it("money in flight for an opportunity is visible to the allocator", () => {
    const t = { id: "t", forOppId: "s", path: [routes[0]!], hop: 0, amountUsd: 7_000, costUsd: 1, state: "in_flight" as const, createdAtMs: NOW, updatedAtMs: NOW };
    const p = planner({ "arbitrum:USDC": 100_000 }, { transfers: [t] });
    assert.equal(p.inFlightFor("s"), 7_000);
    assert.equal(p.inFlightFor("other"), 0);
  });
});

describe("allocator with cross-chain funding", () => {
  const arbSui = route("arb-sui", "arbitrum:USDC", "sui:USDC");
  const withPlanner = (cfg: RouterConfig, idle: Record<string, number>, equity = 1_000_000) => {
    const ctx = dctx({ cfg, equity, idle: equity });
    ctx.funding = new FundingPlanner({ cfg, nowMs: NOW, idle, ledger: [], transfers: [], totalEquityUsd: equity, bookYieldPerYearUsd: 0 });
    return ctx;
  };

  it("folds the amortized move cost into the ranking", () => {
    const cfg = xcfg([arbSui], {}, { allocator: { max_new_positions_per_cycle: 1 } });
    const local = onChain("arb-local", "arbitrum", 0.101, "USDC", "navi");
    const remote = onChain("sui-remote", "sui", 0.103, "USDC", "suilend");
    // legacy (one bucket): the higher APR wins
    const legacy = planAllocation([local, remote], dctx({ cfg, equity: 1_000_000 }));
    assert.equal(legacy.entries[0]!.oppId, "sui-remote");
    // all money on Arbitrum: 10.3% minus the amortized move (~0.27%) < 10.1% local
    const plan = planAllocation([local, remote], withPlanner(cfg, { "arbitrum:USDC": 1_000_000 }));
    assert.deepEqual(plan.entries.map((e) => e.oppId), ["arb-local"]);
    assert.deepEqual(plan.entries[0]!.funding!.path, []);
  });

  it("refuses a move that costs more than one day of the yield it buys", () => {
    const cex = route("cex", "arbitrum:USDC", "plasma:USDT0", { kind: "cex", feeBps: 30, feeFixedUsd: 1 });
    const cfg = xcfg([cex]);
    const plasma = onChain("plasma", "plasma", 0.25, "USDT0");
    const plan = planAllocation([plasma], withPlanner(cfg, { "arbitrum:USDC": 1_000_000 }));
    assert.equal(plan.entries.length, 0);
    assert.match(plan.rejected["plasma"]!.join(" "), /one_day_yield/);
  });

  const bigPositions = { caps: { max_position_usd: 1_000_000 } };

  it("a passing move becomes one enter action that carries the bridge path and its total cost", () => {
    const cfg = xcfg([arbSui], {}, bigPositions);
    const s = onChain("s", "sui", 0.15);
    const plan = planAllocation([s], withPlanner(cfg, { "arbitrum:USDC": 1_000_000 }));
    assert.equal(plan.entries.length, 1);
    const e = plan.entries[0]!;
    assert.deepEqual(e.funding!.path.map((r) => r.id), ["arb-sui"]);
    assert.equal(e.deltaUsd, 300_000); // per_opportunity_frac 30%
    assert.ok(close(e.funding!.costUsd, 30 + 1 + transitCostUsd(300_000, 0.15, 20), 1e-6));
    assert.ok(e.funding!.costUsd <= (e.deltaUsd * 0.15) / 365);
  });

  it("fixed costs that only amortize over a bigger move do not block it (block quote)", () => {
    // one $20k chunk at 4.6% would pay $3 of fixed+prop costs vs $2.52 of daily yield;
    // the whole $300k move pays $31 vs $37.8: allowed.
    const cfg = xcfg([arbSui], {}, { ...bigPositions, baseline_apr: 0.01, thresholds: { entry_premium_by_tier: { 1: 0.03 } } });
    const s = onChain("s", "sui", 0.046);
    const plan = planAllocation([s], withPlanner(cfg, { "arbitrum:USDC": 1_000_000 }));
    assert.equal(plan.entries.length, 1, JSON.stringify(plan.rejected));
    assert.equal(plan.entries[0]!.deltaUsd, 300_000);
  });

  it("everything already in the right bucket = exactly the legacy plan", () => {
    const cfg = xcfg([arbSui]);
    const opps = [onChain("a", "sui", 0.12), onChain("b", "sui", 0.1, "USDC", "suilend")];
    const legacy = planAllocation(opps, dctx({ cfg, equity: 1_000_000 }));
    const bucketed = planAllocation(opps, withPlanner(cfg, { "sui:USDC": 1_000_000 }));
    assert.deepEqual(
      bucketed.entries.map((e) => [e.oppId, e.deltaUsd]),
      legacy.entries.map((e) => [e.oppId, e.deltaUsd])
    );
    assert.ok(legacy.entries.every((e) => e.funding === undefined));
    assert.ok(bucketed.entries.every((e) => e.funding!.path.length === 0));
  });

  it("money in flight towards an opportunity counts against its caps", () => {
    const cfg = xcfg([arbSui], {}, bigPositions);
    const s = onChain("s", "sui", 0.15);
    const ctx = dctx({ cfg, equity: 1_000_000, idle: 1_000_000 });
    const t = { id: "t", forOppId: "s", path: [arbSui], hop: 0, amountUsd: 250_000, costUsd: 1, state: "in_flight" as const, createdAtMs: NOW, updatedAtMs: NOW };
    ctx.funding = new FundingPlanner({ cfg, nowMs: NOW, idle: { "sui:USDC": 750_000 }, ledger: [], transfers: [t], totalEquityUsd: 1_000_000, bookYieldPerYearUsd: 0 });
    const plan = planAllocation([s], ctx);
    // 30% per-opportunity cap = $300k and $250k is already on its way: at most $50k more
    // (whole $20k chunks -> $40k); without the transfer it would get the full $300k
    const added = plan.entries.reduce((a, e) => a + e.deltaUsd, 0);
    assert.ok(added > 0 && added <= 50_000, String(added));
    ctx.funding = new FundingPlanner({ cfg, nowMs: NOW, idle: { "sui:USDC": 750_000 }, ledger: [], transfers: [], totalEquityUsd: 1_000_000, bookYieldPerYearUsd: 0 });
    assert.equal(planAllocation([s], ctx).entries.reduce((a, e) => a + e.deltaUsd, 0), 300_000);
  });
});
