import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, deepMerge, loadConfig, validateConfig } from "../src/config.js";
import { scoreVenue, venueTier } from "../src/tiers.js";
import { constantStream, marginalNetApr, proRataStream, rewardRealizable, valueAt } from "../src/valuation.js";
import { cfgWith, close, dctx, HOUR, NOW, opp } from "./helpers.js";

describe("config", () => {
  it("default config and config/default.yaml are valid", () => {
    assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
    const c = loadConfig("config/default.yaml");
    assert.equal(c.liquidity.entry_max_frac_of_capacity, 0.1);
    assert.deepEqual(c.rewards.tokens, {}); // all-commented YAML block must not null it out
  });
  it("rejects missing hysteresis and inverted liquidity rule", () => {
    const bad = deepMerge(DEFAULT_CONFIG, {
      thresholds: { exit_premium_by_tier: { 1: 0.05 } },
      liquidity: { exit_frac_of_capacity: 0.05 },
    });
    const errs = validateConfig(bad);
    assert.ok(errs.some((e) => e.includes("hysteresis")));
    assert.ok(errs.some((e) => e.includes("exit_frac_of_capacity")));
  });
});

describe("tiers", () => {
  it("scores venues and defaults unknown to tier 3", () => {
    const cfg = cfgWith({
      venues: {
        blue: { enabled: true, meta: { audits: 3, age_days: 900, tvl_usd: 2e9, admin_multisig: true, timelock_hours: 48 } },
        mid: { enabled: true, meta: { audits: 1, age_days: 200, tvl_usd: 80e6, admin_multisig: true } },
        hacked: { enabled: true, meta: { audits: 2, age_days: 400, tvl_usd: 600e6, incidents: 1, upgradeable: true } },
      },
    });
    assert.equal(venueTier(cfg, "blue"), 1);
    assert.equal(venueTier(cfg, "mid"), 2);
    // audits+2, age+2, tvl+2, upgradeable without timelock -1, past exploit -2 = 3 -> tier 3
    assert.equal(scoreVenue({ audits: 2, age_days: 400, tvl_usd: 600e6, incidents: 1, upgradeable: true }), 3);
    assert.equal(venueTier(cfg, "hacked"), 3);
    assert.equal(venueTier(cfg, "nobody"), 3);
  });
});

describe("pro-rata dilution", () => {
  it("shares a fixed emission over pool + my contribution", () => {
    // 10% APR on a $1M pool = $100k/yr. I add $1M -> 5%.
    const s = proRataStream({ label: "r", kind: "reward", aprNow: 0.1, poolUsd: 1e6, grossPerEquity: 1, myEquityNowUsd: 0, aprMultiplier: 1 });
    assert.ok(close(s.aprAt(0), 0.1));
    assert.ok(close(s.aprAt(1e6), 0.05));
  });
  it("backs out my current position when the pool includes me", () => {
    // pool $2M of which $1M is mine, shows 5% -> emission $100k; ex-me APR = 10%
    const s = proRataStream({ label: "r", kind: "reward", aprNow: 0.05, poolUsd: 2e6, grossPerEquity: 1, myEquityNowUsd: 1e6, aprMultiplier: 1 });
    assert.ok(close(s.aprAt(1e6), 0.05));
    assert.ok(close(s.aprAt(0), 0.1));
  });
  it("leverage multiplies both footprint and APR", () => {
    const s = proRataStream({ label: "r", kind: "reward", aprNow: 0.06, poolUsd: 50e6, grossPerEquity: 3, myEquityNowUsd: 0, aprMultiplier: 3 });
    assert.ok(close(s.aprAt(0), 0.18));
    assert.ok(close(s.aprAt(1e6), (0.06 * 50e6) / 53e6 * 3));
  });
});

describe("reward haircut", () => {
  it("unknown token falls back to default_realizable", () => {
    const ctx = dctx();
    assert.equal(rewardRealizable(ctx, "WHO", 100), ctx.cfg.rewards.default_realizable);
  });
  it("a falling token is worth less, more so when held", () => {
    const tokens = { X: { depth2pctUsd: 1e6, vol: 1.0, trendApr: -0.9 } };
    const sell = rewardRealizable(dctx({ tokens }), "X", 100);
    const hold = rewardRealizable(dctx({ tokens, cfg: cfgWith({ rewards: { tokens: { X: { policy: "hold" } } } }) }), "X", 100);
    assert.ok(sell > hold, `sell ${sell} should beat hold ${hold}`);
    assert.ok(hold < 0.8);
  });
  it("hedging removes the vol penalty when a perp exists", () => {
    const tokens = { X: { depth2pctUsd: 1e6, vol: 1.5, trendApr: -0.9, perpAvailable: true, hedgeCostApr: 0.2 } };
    const hedged = rewardRealizable(dctx({ tokens, cfg: cfgWith({ rewards: { tokens: { X: { policy: "hedge" } } } }) }), "X", 100);
    const sold = rewardRealizable(dctx({ tokens }), "X", 100);
    assert.ok(hedged > sold);
  });
  it("big claims into thin books pay slippage", () => {
    const tokens = { X: { depth2pctUsd: 10_000, vol: 0, trendApr: 0 } };
    assert.ok(close(rewardRealizable(dctx({ tokens }), "X", 10_000), 0.95)); // capped at max 0.95 (slip 2%)
    assert.ok(rewardRealizable(dctx({ tokens }), "X", 200_000) < 0.65);
  });
});

describe("valueAt", () => {
  it("never haircuts costs, excludes points, time-weights ending rewards", () => {
    const o = opp({
      streams: [
        constantStream("base", "base", 0.1),
        constantStream("debt", "borrow_cost", -0.05),
        constantStream("pts", "points", 0.5),
        constantStream("r", "reward", 0.2, { rewardToken: "X", endsAtMs: NOW + 10.5 * 24 * HOUR }),
      ],
    });
    const v = valueAt(o, 10_000, dctx());
    // reward: 0.2 * 0.5 (unknown token) * (10.5/21) = 0.05
    assert.ok(close(v.realizableApr, 0.1 - 0.05 + 0.05));
    assert.ok(close(v.speculativeApr, 0.5));
    assert.equal(v.streams.find((s) => s.label === "debt")!.valuedApr, -0.05);
  });
  it("excludeEndingWithinMs drops soon-ending streams", () => {
    const o = opp({ streams: [constantStream("base", "base", 0.03), constantStream("r", "reward", 0.2, { endsAtMs: NOW + 5 * HOUR })] });
    const v = valueAt(o, 10_000, dctx(), { holding: true, excludeEndingWithinMs: 12 * HOUR });
    assert.ok(close(v.netApr, 0.03));
  });
  it("amortizes one-offs for entry, not while holding", () => {
    const o = opp({ costs: { entryFrac: 0.001, exitFrac: 0.001, fixedEntryUsd: 10, fixedExitUsd: 10, ongoingApr: 0.01 } });
    const ctx = dctx();
    const perYear = 365 / ctx.cfg.hold_horizon_days;
    assert.ok(close(valueAt(o, 10_000, ctx).costApr, 0.01 + 0.002 * perYear + (20 / 10_000) * perYear));
    assert.ok(close(valueAt(o, 10_000, ctx, { holding: true }).costApr, 0.01));
  });
  it("marginal APR falls below average under dilution", () => {
    const o = opp({
      streams: [proRataStream({ label: "r", kind: "base", aprNow: 0.2, poolUsd: 1e6, grossPerEquity: 1, myEquityNowUsd: 0, aprMultiplier: 1 })],
    });
    const ctx = dctx();
    const avg = valueAt(o, 500_000, ctx).netApr;
    const m = marginalNetApr(o, 400_000, 500_000, ctx);
    assert.ok(m < avg, `marginal ${m} < avg ${avg}`);
  });
});
