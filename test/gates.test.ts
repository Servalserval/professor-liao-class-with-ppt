import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planAllocation } from "../src/allocator.js";
import { checkSizedEntry, entryBlockers } from "../src/gates/entry.js";
import { decideExit } from "../src/gates/exit.js";
import { planRewards } from "../src/rewards.js";
import { derivedFlags, recordOpp, recordTokenPrice, tokenDrawdown24h } from "../src/signals.js";
import type { Action } from "../src/types.js";
import { constantStream, proRataStream } from "../src/valuation.js";
import { cfgWith, dctx, HOUR, NOW, opp, position } from "./helpers.js";

const exits = (a: Action[]) => a.filter((x): x is Extract<Action, { type: "exit" }> => x.type === "exit");

describe("entry gates", () => {
  it("1/10 rule: footprint must fit in 10% of exit capacity", () => {
    const o = opp({ liquidity: { exitCapacityUsd: 1_000_000, footprintPerEquity: 3 } });
    const ctx = dctx({ equity: 10_000_000 });
    assert.ok(checkSizedEntry(o, 0, 33_000, ctx).ok);
    const bad = checkSizedEntry(o, 0, 34_000, ctx);
    assert.ok(bad.reasons.some((r) => r.includes("exit capacity")));
  });
  it("estimated capacity is haircut", () => {
    const o = opp({ liquidity: { exitCapacityUsd: 1_000_000, footprintPerEquity: 1, estimated: true } });
    const ctx = dctx({ equity: 10_000_000 });
    assert.ok(checkSizedEntry(o, 0, 50_000, ctx).ok);
    assert.ok(!checkSizedEntry(o, 0, 60_000, ctx).ok);
  });
  it("entry threshold depends on venue tier", () => {
    const cfg = cfgWith({ venues: { newbie: { enabled: true, tier: 3 } } });
    const ok1 = checkSizedEntry(opp({ streams: [constantStream("b", "base", 0.09)] }), 0, 5000, dctx({ cfg }));
    assert.ok(ok1.ok, ok1.reasons.join());
    const o3 = opp({
      primaryVenue: "newbie",
      legs: [{ venue: "newbie", chain: "sui", token: "USDC", equityFrac: 1 }],
      streams: [constantStream("b", "base", 0.09)],
    });
    assert.ok(checkSizedEntry(o3, 0, 4000, dctx({ cfg })).reasons.some((r) => r.includes("tier 3")));
  });
  it("caps by venue, chain, token, kind and opportunity", () => {
    const cfg = cfgWith({ caps: { per_venue_frac_by_tier: { 1: 0.1 }, per_chain_frac: { sui: 0.15 } } });
    const held = opp({ id: "held", primaryVenue: "suilend", legs: [{ venue: "suilend", chain: "sui", token: "USDC", equityFrac: 1 }] });
    const ctx = dctx({ cfg, positions: [position(held, 10_000)] });
    const r = checkSizedEntry(opp(), 0, 11_000, ctx).reasons.join("|");
    assert.match(r, /venue navi/);
    assert.match(r, /chain sui/);
  });
  it("speculative positions: budget and max points cost", () => {
    const o = opp({ speculative: true, streams: [constantStream("f", "funding", -0.01), constantStream("p", "points", 0.2)] });
    assert.ok(checkSizedEntry(o, 0, 5_000, dctx()).ok);
    assert.ok(checkSizedEntry(o, 0, 11_000, dctx()).reasons.some((r) => r.includes("speculative budget")));
    const pricey = opp({ speculative: true, streams: [constantStream("f", "funding", -0.05), constantStream("p", "points", 0.2)] });
    assert.ok(checkSizedEntry(pricey, 0, 5_000, dctx()).reasons.some((r) => r.includes("points cost")));
  });
  it("blocks flagged, warned, cooling-down, discovery and single-venue hedges", () => {
    const ctx = dctx({ cooldown: { o1: NOW + HOUR } });
    const r = entryBlockers(
      opp({
        discoveryOnly: true,
        flags: [{ name: "emission_drop", severity: "warn" }],
        signals: [{ name: "utilization", value: 0.91, warnAt: 0.9, exitAt: 0.95, direction: "above" }],
      }),
      ctx
    ).join("|");
    for (const s of ["discovery", "emission_drop", "utilization", "cooldown"]) assert.match(r, new RegExp(s));
    const wash = opp({
      kind: "delta_neutral_perp",
      legs: [
        { venue: "hl", chain: "offchain", token: "USDC", equityFrac: 0.5 },
        { venue: "hl", chain: "offchain", token: "USDC", equityFrac: 0.5 },
      ],
    });
    assert.match(entryBlockers(wash, dctx()).join(), /self-matching/);
  });
  it("refuses entries whose projected utilization would be at warn", () => {
    const o = opp({
      projectedSignals: (e) => [{ name: "utilization", value: 0.85 + e / 1e6, warnAt: 0.9, exitAt: 0.95, direction: "above" }],
    });
    assert.ok(checkSizedEntry(o, 0, 20_000, dctx()).ok);
    assert.ok(!checkSizedEntry(o, 0, 60_000, dctx({ equity: 1e6 })).ok);
  });
});

describe("exit gates", () => {
  const ctxFor = (o = opp(), eq = 10_000, over = {}) => {
    const p = position(o, eq, over);
    return { p, ctx: dctx({ positions: [p] }) };
  };

  it("1/5 rule: urgent full exit when the footprint reaches 20% of capacity", () => {
    const o = opp({ liquidity: { exitCapacityUsd: 100_000, footprintPerEquity: 2 } });
    const { p, ctx } = ctxFor(o, 10_000);
    const e = exits(decideExit(p, o, [], ctx).actions);
    assert.equal(e.length, 1);
    assert.equal(e[0]!.fraction, 1);
    assert.equal(e[0]!.urgent, true);
    assert.match(e[0]!.reason, /exit capacity/);
  });
  it("exit-severity signals, flags and derived flags exit immediately", () => {
    const util = opp({ signals: [{ name: "utilization", value: 0.96, warnAt: 0.9, exitAt: 0.95, direction: "above" }] });
    const a = ctxFor(util);
    assert.equal(exits(decideExit(a.p, util, [], a.ctx).actions)[0]!.urgent, true);
    const b = ctxFor();
    assert.match(exits(decideExit(b.p, opp(), [{ name: "capacity_drop", severity: "exit" }], b.ctx).actions)[0]!.reason, /capacity_drop/);
  });
  it("health: rebalance first, exit when critical", () => {
    const h = (v: number) => opp({ health: { metric: "ltv", value: v, rebalanceAt: 0.78, criticalAt: 0.85, direction: "above" } });
    const a = ctxFor(h(0.8));
    const acts = decideExit(a.p, h(0.8), [], a.ctx).actions;
    assert.ok(acts.some((x) => x.type === "rebalance"));
    assert.equal(exits(acts).length, 0);
    const b = ctxFor(h(0.86));
    assert.equal(exits(decideExit(b.p, h(0.86), [], b.ctx).actions)[0]!.urgent, true);
  });
  it("leaves when the exit path keeps failing to simulate", () => {
    const { p, ctx } = ctxFor(opp(), 10_000, { exitProbe: { lastOkAtMs: NOW - 5 * HOUR, consecutiveFailures: 2 } });
    assert.match(exits(decideExit(p, opp(), [], ctx).actions)[0]!.reason, /simulation failed/);
  });
  it("reward ending: exits (non-urgent) only if the edge needs that reward", () => {
    const mk = (base: number) =>
      opp({ streams: [constantStream("b", "base", base), constantStream("r", "reward", 0.2, { endsAtMs: NOW + 6 * HOUR })] });
    const a = ctxFor(mk(0.02));
    const e = exits(decideExit(a.p, mk(0.02), [], a.ctx).actions);
    assert.equal(e[0]!.urgent, false);
    assert.match(e[0]!.reason, /ending/);
    const b = ctxFor(mk(0.09));
    assert.equal(exits(decideExit(b.p, mk(0.09), [], b.ctx).actions).length, 0);
  });
  it("spread compression is debounced, then trims, then closes below the floor", () => {
    const thin = opp({ streams: [constantStream("b", "base", 0.03)] }); // < 4.5% exit threshold, > 0 floor
    const { p, ctx } = ctxFor(thin, 10_000);
    const d1 = decideExit(p, thin, [], ctx);
    assert.equal(exits(d1.actions).length, 0);
    p.pending = d1.pending;
    const d2 = decideExit(p, thin, [], ctx);
    const e2 = exits(d2.actions);
    assert.equal(e2[0]!.fraction, ctx.cfg.thresholds.spread_reduce_step);
    const neg = opp({ streams: [constantStream("b", "base", -0.01)] });
    const q = ctxFor(neg, 10_000, { pending: { spread: 1 } });
    assert.equal(exits(decideExit(q.p, neg, [], q.ctx).actions)[0]!.fraction, 1);
  });
  it("trims the last chunk when my own size diluted it below the exit threshold", () => {
    const diluted = opp({
      // emission $10k/yr on a $100k pool of which $60k is mine: avg 10%, marginal ~4% < 4.5%
      streams: [proRataStream({ label: "r", kind: "base", aprNow: 0.1, poolUsd: 100_000, grossPerEquity: 1, myEquityNowUsd: 60_000, aprMultiplier: 1 })],
      liquidity: { exitCapacityUsd: 1e9, footprintPerEquity: 1 },
    });
    const { p, ctx } = ctxFor(diluted, 60_000, { pending: { oversized: 1 } });
    const e = exits(decideExit(p, diluted, [], ctx).actions);
    assert.equal(e.length, 1);
    assert.ok(e[0]!.fraction < 0.1);
    assert.match(e[0]!.reason, /diluted/);
  });
  it("blind: alert after N cycles, exit after M", () => {
    const a = ctxFor(opp(), 10_000, { blindCycles: 3 });
    const acts = decideExit(a.p, undefined, [], a.ctx).actions;
    assert.equal(exits(acts).length, 0);
    assert.ok(acts.some((x) => x.type === "alert" && x.level === "critical"));
    const b = ctxFor(opp(), 10_000, { blindCycles: 10 });
    assert.equal(exits(decideExit(b.p, undefined, [], b.ctx).actions)[0]!.fraction, 1);
  });
});

describe("history signals", () => {
  it("capacity drain, metric spike and emission cut", () => {
    const cfg = cfgWith();
    const ctx = dctx({ cfg });
    const o0 = opp({
      metrics: { borrow_apr: 0.08 },
      streams: [constantStream("r", "reward", 0.3)],
    });
    recordOpp(ctx.history, o0, NOW - 30 * 60_000, 1e12);
    const o1 = opp({
      metrics: { borrow_apr: 0.2 },
      streams: [constantStream("r", "reward", 0.1)],
      liquidity: { exitCapacityUsd: 6_000_000, footprintPerEquity: 1 },
    });
    const names = derivedFlags(o1, ctx.history, cfg, NOW).map((f) => `${f.name}:${f.severity}`);
    assert.deepEqual(names.sort(), ["capacity_drop:exit", "emission_drop:warn", "spike:borrow_apr:exit"]);
  });
  it("token 24h drawdown", () => {
    const ctx = dctx();
    recordTokenPrice(ctx.history, "X", 1.0, NOW - 10 * HOUR, 1e12);
    recordTokenPrice(ctx.history, "X", 0.6, NOW, 1e12);
    assert.ok(Math.abs(tokenDrawdown24h(ctx.history, "X", NOW) - 0.4) < 1e-9);
  });
});

describe("allocator", () => {
  it("water-fills by marginal APR and stops where dilution hits the threshold", () => {
    // Fixed emission: 50%/yr on a $100k pool. avg/marginal fall as I add.
    const farm = opp({
      id: "farm",
      streams: [proRataStream({ label: "r", kind: "base", aprNow: 0.5, poolUsd: 100_000, grossPerEquity: 1, myEquityNowUsd: 0, aprMultiplier: 1 })],
      liquidity: { exitCapacityUsd: 1e9, footprintPerEquity: 1 },
    });
    const steady = opp({ id: "steady", primaryVenue: "suilend", legs: [{ venue: "suilend", chain: "sui", token: "USDC", equityFrac: 1 }], streams: [constantStream("b", "base", 0.09)] });
    const loose = { caps: { per_opportunity_frac: 1, max_position_usd: 1e9, per_venue_frac_by_tier: { 1: 1 }, per_chain_frac: { default: 1 }, per_kind_frac: { deposit: 1 } } };
    // Alone: marginal of x*E/(P+x) is E*P/(P+x)^2 = 7.5% entry threshold at x ~= 158k
    const alone = planAllocation([farm], dctx({ equity: 1_000_000, cfg: cfgWith(loose) }));
    const a = alone.entries[0]!.deltaUsd;
    assert.ok(a > 140_000 && a <= 160_000, `farm alone got ${a}`);
    // With a 9% steady alternative: farm is filled only while its marginal beats 9%,
    // then USDC hits the 80% per-token cap.
    const plan = planAllocation([farm, steady], dctx({ equity: 1_000_000, cfg: cfgWith(loose) }));
    const f = plan.entries.find((e) => e.oppId === "farm")!;
    assert.ok(f.deltaUsd < a, `farm ${f.deltaUsd} should get less than alone ${a}`);
    assert.ok(f.marginalApr >= 0.09);
    const total = plan.entries.reduce((s, e) => s + e.deltaUsd, 0);
    assert.equal(total, 800_000);
  });
  it("respects max_new_positions_per_cycle and serves non-speculative first", () => {
    const mk = (id: string, apr: number, speculative = false) =>
      opp({ id, primaryVenue: id, legs: [{ venue: id, chain: id, token: id, equityFrac: 1 }], streams: [constantStream("b", "base", apr), constantStream("p", "points", 0.1)], speculative });
    const cfg = cfgWith({ venues: { a: { tier: 1 }, b: { tier: 1 }, c: { tier: 1 } } });
    const plan = planAllocation([mk("c", 0.0, true), mk("a", 0.2), mk("b", 0.1)], dctx({ cfg }));
    assert.deepEqual(plan.entries.map((e) => e.oppId).sort(), ["a", "b"]);
    assert.match(plan.rejected.c!.join(), /max_new_positions/);
  });
});

describe("reward policy", () => {
  const withRewards = (r: Record<string, { unclaimedUsd: number; heldUsd: number; hedgedUsd: number; lastClaimAtMs: number }>) => position(opp(), 50_000, { rewards: r });

  it("claims on schedule above the gas floor and sells on claim", () => {
    const p = withRewards({ X: { unclaimedUsd: 120, heldUsd: 0, hedgedUsd: 0, lastClaimAtMs: NOW - 25 * HOUR } });
    const a = planRewards(dctx({ positions: [p] }));
    assert.deepEqual(a.map((x) => x.type), ["claim", "sell"]);
  });
  it("waits below the minimum or before the interval", () => {
    const early = withRewards({ X: { unclaimedUsd: 500, heldUsd: 0, hedgedUsd: 0, lastClaimAtMs: NOW - 2 * HOUR } });
    assert.equal(planRewards(dctx({ positions: [early] })).length, 0);
    const tiny = withRewards({ X: { unclaimedUsd: 10, heldUsd: 0, hedgedUsd: 0, lastClaimAtMs: NOW - 48 * HOUR } });
    assert.equal(planRewards(dctx({ positions: [tiny] })).length, 0);
  });
  it("hold policy sells only the excess; crash dumps everything", () => {
    const cfg = cfgWith({ rewards: { tokens: { X: { policy: "hold", max_hold_usd: 100 } } } });
    const p = withRewards({ X: { unclaimedUsd: 0, heldUsd: 300, hedgedUsd: 0, lastClaimAtMs: NOW } });
    const a = planRewards(dctx({ cfg, positions: [p] }));
    assert.equal((a[0] as Extract<Action, { type: "sell" }>).amountUsd, 200);
    const ctx = dctx({ cfg, positions: [p] });
    recordTokenPrice(ctx.history, "X", 1, NOW - 5 * HOUR, 1e12);
    recordTokenPrice(ctx.history, "X", 0.5, NOW, 1e12);
    const c = planRewards(ctx);
    assert.equal((c[0] as Extract<Action, { type: "sell" }>).amountUsd, 300);
  });
  it("hedge policy targets unclaimed + held when a perp exists", () => {
    const cfg = cfgWith({ rewards: { tokens: { X: { policy: "hedge" } } } });
    const p = withRewards({ X: { unclaimedUsd: 400, heldUsd: 600, hedgedUsd: 0, lastClaimAtMs: NOW } });
    const a = planRewards(dctx({ cfg, positions: [p], tokens: { X: { perpAvailable: true } } }));
    const h = a.find((x) => x.type === "hedge") as Extract<Action, { type: "hedge" }>;
    assert.equal(h.targetShortUsd, 1000);
    const noPerp = planRewards(dctx({ cfg, positions: [p] }));
    assert.ok(noPerp.some((x) => x.type === "sell"));
  });
  it("book-level reward exposure cap forces a sell-down", () => {
    const p = withRewards({ X: { unclaimedUsd: 0, heldUsd: 6_000, hedgedUsd: 0, lastClaimAtMs: NOW } });
    const cfg = cfgWith({ rewards: { tokens: { X: { policy: "hold", max_hold_usd: 1e9 } } } });
    const a = planRewards(dctx({ cfg, positions: [p] }));
    assert.match((a[0] as Extract<Action, { type: "sell" }>).reason, /exposure cap/);
  });
});
