/** Opt-in reward renewal assumption (rewards.renewal): valuation time weight and the reward-ending exit rule. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateConfig } from "../src/config.js";
import { decideExit } from "../src/gates/exit.js";
import { supplyOpportunity, type SupplyMarket } from "../src/sources/supply.js";
import { timeWeight, valueAt } from "../src/valuation.js";
import { cfgWith, dctx, NOW, position, sctx } from "./helpers.js";

const H = 3600_000;
const D = 24 * H;
const market = (endsAtMs: number): SupplyMarket => ({
  protocol: "aave-v4",
  chain: "ethereum",
  marketId: "core:USDC",
  asset: { symbol: "USDC", priceUsd: 1 },
  totalSupplyUsd: 60e6,
  totalBorrowUsd: 50e6,
  supplyAprBase: 0.0335,
  rewards: [{ token: "USDC", apr: 0.0265, endsAtMs }],
});

describe("reward renewal assumption", () => {
  it("time weight: plain = remaining/horizon; with renewal each further period counts prob^k", () => {
    const cfg = cfgWith({ hold_horizon_days: 21 });
    const ctx = { cfg, nowMs: NOW, tokens: {} };
    const end = NOW + 0.5 * D;
    assert.ok(Math.abs(timeWeight(ctx, end) - 0.5 / 21) < 1e-12);
    const tw = timeWeight(ctx, end, false, { prob: 0.8, period_days: 7 });
    assert.ok(Math.abs(tw - (0.5 + 7 * 0.8 + 7 * 0.64 + 6.5 * 0.512) / 21) < 1e-9, String(tw));
    assert.equal(timeWeight(ctx, NOW - 1, false, { prob: 0.8, period_days: 7 }), 0, "an ended stream stays dead");
    assert.equal(timeWeight(ctx, null, false, { prob: 0.8, period_days: 7 }), 1);
  });

  it("valuation uses the venue's renewal entry only", () => {
    const end = NOW + 0.5 * D;
    const off = cfgWith({ hold_horizon_days: 21 });
    const on = cfgWith({ hold_horizon_days: 21, rewards: { renewal: { "aave-v4": { prob: 0.8, period_days: 7 } } } });
    const other = cfgWith({ hold_horizon_days: 21, rewards: { renewal: { "aave-v3": { prob: 0.8, period_days: 7 } } } });
    const v = (cfg: ReturnType<typeof cfgWith>) => {
      const o = supplyOpportunity(market(end), sctx(cfg), "s")!;
      return valueAt(o, 10_000, { cfg, nowMs: NOW, tokens: {} }).realizableApr;
    };
    assert.ok(v(on) > v(off) + 0.01, `${v(on)} vs ${v(off)}`);
    assert.equal(v(other), v(off));
  });

  it("reward-ending rule: exits without renewal, holds when prob x reward keeps the edge", () => {
    const end = NOW + 6 * H; // inside ending_hours (12h)
    const mk = (cfg: ReturnType<typeof cfgWith>) => {
      const opp = supplyOpportunity(market(end), sctx(cfg), "s")!;
      const pos = position(opp, 10_000);
      return decideExit(pos, opp, [], dctx({ cfg, positions: [pos] })).actions.filter((a) => a.type === "exit");
    };
    // tier 1 venue so the deposit exit threshold is 4.5% + 0 - 1% = 3.5%? use explicit thresholds for clarity
    const thresholds = { exit_premium_by_tier: { 1: 0.0, 2: 0.0, 3: 0.0 }, kind_premium_adjust: { deposit: { entry: 0, exit: 0 } } };
    const venues = { "aave-v4": { enabled: true, tier: 2 as const } };
    const off = cfgWith({ baseline_apr: 0.045, venues, thresholds });
    const on = cfgWith({ baseline_apr: 0.045, venues, thresholds, rewards: { renewal: { "aave-v4": { prob: 0.8, period_days: 7 } } } });
    const a = mk(off);
    assert.equal(a.length, 1, "3.35% base alone < 4.5%: exit");
    assert.match((a[0] as { reason: string }).reason, /without them/);
    assert.equal(mk(on).length, 0, "3.35% + 0.8 x 2.65% = 5.47% >= 4.5%: hold");
  });

  it("validation", () => {
    assert.match(validateConfig(cfgWith({ rewards: { renewal: { x: { prob: 1, period_days: 7 } } } })).join(), /prob must be in \[0,1\)/);
    assert.match(validateConfig(cfgWith({ rewards: { renewal: { x: { prob: 0.5, period_days: 0 } } } })).join(), /period_days/);
  });
});
