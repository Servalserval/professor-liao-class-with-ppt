import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RouterConfig } from "../src/config.js";
import { interpIrm, loopLeverage, loopMarketToPair, loopOpportunity, type IrmModel, type LoopMarket, type RewardRate } from "../src/sources/loopLending.js";
import { isSameAsset, loopPairOpportunity, LoopPairSource, type LoopLeg, type LoopPair } from "../src/sources/loopPair.js";
import type { Opportunity } from "../src/types.js";
import { validateOpportunity } from "../src/validate.js";
import { cfgWith, close, NOW, sctx } from "./helpers.js";

const IRM: IrmModel = { points: [[0, 0.0], [0.8, 0.08], [1, 0.5]], reserveFactor: 0.1 };
const IRM_D: IrmModel = { points: [[0, 0.01], [0.9, 0.06], [1, 0.8]], reserveFactor: 0.15 };

const market = (over: Partial<LoopMarket> = {}): LoopMarket => ({
  protocol: "suilend",
  chain: "sui",
  symbol: "USDC",
  totalSupplyUsd: 50e6,
  totalBorrowUsd: 40e6,
  supplyAprBase: 0.06,
  borrowAprBase: 0.08,
  supplyRewards: [],
  borrowRewards: [],
  openLtv: 0.9,
  closeLtv: 0.95,
  ...over,
});

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

/** USDC collateral (60M supplied / 30M borrowed) against USDT debt (40M / 32M). */
const pair = (over: Partial<LoopPair> = {}): LoopPair => ({
  protocol: "navi",
  chain: "sui",
  pairId: "USDC/USDT",
  collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, supplyAprBase: 0.05, borrowAprBase: 0.07 }),
  debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, supplyAprBase: 0.04, borrowAprBase: 0.06 }),
  maxLtv: 0.9,
  liqLtv: 0.93,
  swapCostFrac: 0.0005,
  swapDepthUsd: 20e6,
  ...over,
});

const L70 = loopLeverage(0.7);
const total = (o: Opportunity, E: number) => o.streams.reduce((a, s) => a + s.aprAt(E), 0);
const stream = (o: Opportunity, label: string) => o.streams.find((s) => s.label === label)!;
const signal = (o: Opportunity, name: string, E?: number) =>
  (E === undefined ? o.signals : o.projectedSignals!(E)).find((s) => s.name === name)!;

/** Reference copy of the pre-refactor single-market loopOpportunity (numbers only). */
function legacyLoop(m: LoopMarket, cfg: RouterConfig, myE: number) {
  const ll = cfg.sources.lending_loop;
  const ltv = Math.min(ll.target_ltv, m.openLtv * ll.max_ltv_frac_of_open);
  const L = 1 / (1 - ltv);
  const S = m.totalSupplyUsd;
  const B = m.totalBorrowUsd;
  const exS = Math.max(0, S - L * myE);
  const exB = Math.max(0, B - (L - 1) * myE);
  const uAt = (E: number) => {
    const d = exS + L * Math.max(0, E);
    return d > 0 ? (exB + (L - 1) * Math.max(0, E)) / d : 0;
  };
  const available = Math.max(0, S - B);
  const borrowAt = (E: number) => {
    if (m.irm) return interpIrm(m.irm, uAt(E));
    const added = Math.max(0, E - myE) * L;
    const denom = Math.max(1, available * cfg.liquidity.entry_max_frac_of_capacity);
    return m.borrowAprBase * (1 + (ll.rate_uncertainty_mult - 1) * Math.min(1, added / denom));
  };
  const supplyAt = (E: number) => (m.irm ? interpIrm(m.irm, uAt(E)) * uAt(E) * (1 - m.irm.reserveFactor) : m.supplyAprBase);
  const pro = (aprNow: number, pool: number, g: number) => (E: number) => {
    const exMe = Math.max(0, pool - g * myE);
    const d = exMe + g * Math.max(0, E);
    return d <= 0 ? 0 : ((aprNow * pool) / d) * g;
  };
  const streams: Record<string, (E: number) => number> = {
    supply_base: (E) => L * supplyAt(E),
    borrow_base: (E) => -(L - 1) * borrowAt(E),
  };
  for (const r of m.supplyRewards) streams[`supply_reward:${r.token}`] = pro(r.apr, S, L);
  for (const r of m.borrowRewards) streams[`borrow_reward:${r.token}`] = pro(r.apr, B, L - 1);
  return { L, ltv, uAt, available, streams };
}

describe("loopPair: same-asset equivalence with loopOpportunity", () => {
  const cases: { name: string; m: LoopMarket; cfg?: RouterConfig; myE?: number }[] = [
    { name: "no IRM, no rewards", m: market() },
    { name: "no IRM, rewards + caps + fees", m: market({ supplyRewards: [{ token: "SUI", apr: 0.04, endsAtMs: NOW + 86400e3 }], borrowRewards: [{ token: "SUI", apr: 0.02 }], supplyCapRemainingUsd: 2e6, borrowCapRemainingUsd: 3e6, borrowFeeFrac: 0.001, flashloanFeeFrac: 0.0009 }) },
    { name: "IRM, held position", m: market({ irm: IRM, myLtv: 0.71, supplyRewards: [{ token: "NAVX", apr: 0.05 }] }), myE: 2e5 },
    { name: "IRM, 90% LTV, net footprint", m: market({ irm: IRM, flashloanFeeFrac: 0.0009, borrowRewards: [{ token: "X", apr: 0.03 }] }), cfg: cfgWith({ sources: { lending_loop: { target_ltv: 0.9, max_ltv_frac_of_open: 1, deleverage_at_ltv: 0.92, footprint: "net" } } }), myE: 1e5 },
    { name: "openLtv-capped, paused, tight close LTV", m: market({ openLtv: 0.6, closeLtv: 0.65, paused: true, myLtv: 0.5 }), myE: 1e3 },
    { name: "tiny market (ramp clamps at denom 1)", m: market({ totalSupplyUsd: 5, totalBorrowUsd: 4.99 }) },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const cfg = c.cfg ?? cfgWith();
      const myE = c.myE ?? 0;
      const ctx = sctx(cfg, myE ? { [`s:${c.m.protocol}:${c.m.symbol}`]: myE } : {});
      const a = loopOpportunity(c.m, ctx, "s")!;
      const b = loopPairOpportunity(loopMarketToPair(c.m), ctx, "s")!;
      const ref = legacyLoop(c.m, cfg, myE);
      assert.equal(a.id, `s:${c.m.protocol}:${c.m.symbol}`);
      assert.equal(b.id, a.id);
      assert.equal(a.myEquityUsd, myE);
      assert.ok(isSameAsset(loopMarketToPair(c.m)));
      for (const o of [a, b]) {
        assert.equal(o.name, `${c.m.protocol} ${c.m.symbol} loop @${(ref.ltv * 100).toFixed(0)}% LTV`);
        assert.deepEqual(o.streams.map((s) => s.label), Object.keys(ref.streams));
        for (const E of [0, 1, 1e3, myE, 5e4, 1e6, 5e6]) {
          for (const s of o.streams) assert.ok(close(s.aprAt(E), ref.streams[s.label]!(E)), `${s.label}@${E}`);
          assert.deepEqual(o.projectedSignals!(E), [{ name: "utilization", value: ref.uAt(E), warnAt: cfg.sources.lending_loop.utilization_warn, exitAt: cfg.sources.lending_loop.utilization_exit, direction: "above" }]);
        }
        assert.deepEqual(o.signals.map((s) => s.name), ["utilization"]);
        assert.equal(o.signals[0]!.value, c.m.totalBorrowUsd / c.m.totalSupplyUsd);
        assert.deepEqual(o.metrics, { borrow_apr: c.m.borrowAprBase, supply_apr: c.m.supplyAprBase, utilization: c.m.totalBorrowUsd / c.m.totalSupplyUsd, tvl_usd: c.m.totalSupplyUsd });
        const ll = cfg.sources.lending_loop;
        assert.deepEqual(o.costs, {
          entryFrac: (ref.L - 1) * (c.m.borrowFeeFrac ?? 0),
          exitFrac: ll.footprint === "net" ? (ref.L - 1) * (c.m.flashloanFeeFrac ?? 0) : 0,
          fixedEntryUsd: 0.05 * ll.txs_per_entry,
          fixedExitUsd: 0.05 * ll.txs_per_exit,
          ongoingApr: 0,
        });
        assert.deepEqual(o.liquidity, { exitCapacityUsd: ref.available, footprintPerEquity: ll.footprint === "gross" ? ref.L : 1, estimated: undefined });
        assert.deepEqual(o.flags, c.m.paused ? [{ name: "market_paused", severity: "exit" }] : []);
        assert.deepEqual(
          o.health,
          myE > 0 && c.m.myLtv !== undefined
            ? { metric: "ltv", value: c.m.myLtv, rebalanceAt: ll.deleverage_at_ltv, criticalAt: c.m.closeLtv * ll.critical_ltv_frac_of_close, direction: "above" }
            : undefined
        );
        const caps: number[] = [];
        if (c.m.supplyCapRemainingUsd != null) caps.push(myE + c.m.supplyCapRemainingUsd / ref.L);
        if (c.m.borrowCapRemainingUsd != null) caps.push(myE + c.m.borrowCapRemainingUsd / (ref.L - 1));
        assert.equal(o.maxEquityUsd, caps.length ? Math.min(...caps) : undefined);
        assert.equal((o.meta as { leverage: number }).leverage, ref.L);
        assert.equal((o.meta as { ltv: number }).ltv, ref.ltv);
        assert.deepEqual(o.legs, [{ venue: c.m.protocol, chain: c.m.chain, token: c.m.symbol, equityFrac: 1 }]);
        assert.deepEqual(validateOpportunity(o, cfg, NOW), []);
      }
      // the delegated output is the pair output, key for key (functions aside)
      const strip = (o: Opportunity) => ({ ...o, streams: o.streams.map((s) => ({ ...s, aprAt: null })), projectedSignals: null });
      assert.deepEqual(strip(a), strip(b));
    });
  }
  it("a same-asset pair given as two equal leg objects is still same-asset", () => {
    const m = market({ irm: IRM });
    const p = loopMarketToPair(m);
    const twin = { ...p, debt: { ...p.collateral } };
    const a = loopOpportunity(m, sctx(), "s")!;
    const b = loopPairOpportunity(twin, sctx(), "s")!;
    for (const E of [0, 1e6]) assert.ok(close(total(a, E), total(b, E)));
    assert.equal(b.signals.length, 1);
    assert.equal(b.metrics.depeg, undefined);
  });
});

describe("loopPair: two-asset math", () => {
  it("collateral market only gains supply, debt market only gains borrow", () => {
    const p = pair({ collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, irm: IRM }), debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, irm: IRM_D }) });
    const o = loopPairOpportunity(p, sctx(), "s")!;
    assert.equal(o.id, "s:navi:USDC/USDT");
    assert.ok(!isSameAsset(p));
    const E = 3e6;
    const uc = 30e6 / (60e6 + L70 * E);
    const ud = (32e6 + (L70 - 1) * E) / 40e6;
    assert.ok(close(signal(o, "utilization:collateral", E).value, uc));
    assert.ok(close(signal(o, "utilization:debt", E).value, ud));
    assert.ok(close(signal(o, "utilization:collateral").value, 0.5));
    assert.ok(close(signal(o, "utilization:debt").value, 0.8));
    // rates: supply via collateral IRM at u_c, borrow via debt IRM at u_d
    assert.ok(close(stream(o, "supply_base").aprAt(E), L70 * interpIrm(IRM, uc) * uc * 0.9));
    assert.ok(close(stream(o, "borrow_base").aprAt(E), -(L70 - 1) * interpIrm(IRM_D, ud)));
    assert.equal(stream(o, "borrow_base").kind, "borrow_cost");
    // a pair loop always pushes debt utilization up and collateral utilization down
    assert.ok(signal(o, "utilization:debt", E).value > 0.8);
    assert.ok(signal(o, "utilization:collateral", E).value < 0.5);
    assert.deepEqual(Object.keys(o.metrics).sort(), ["borrow_apr", "depeg", "supply_apr", "tvl_usd", "utilization_c", "utilization_d"]);
    assert.equal(o.metrics.utilization_c, 0.5);
    assert.equal(o.metrics.utilization_d, 0.8);
    assert.equal(o.metrics.tvl_usd, 60e6);
    assert.deepEqual(o.legs, [{ venue: "navi", chain: "sui", token: "USDC", equityFrac: 1 }]);
    assert.deepEqual(o.funding, { chain: "sui", asset: "USDC" });
    assert.deepEqual(o.meta, { leverage: L70, ltv: 0.7, pairId: "USDC/USDT", debtSymbol: "USDT" });
  });

  it("backs my own position out of both markets", () => {
    const p = pair({ collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, irm: IRM }), debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, irm: IRM_D }) });
    const myE = 2e6;
    const o = loopPairOpportunity(p, sctx(cfgWith(), { "s:navi:USDC/USDT": myE }), "s")!;
    assert.equal(o.myEquityUsd, myE);
    // at my current size the projection equals the observed state
    assert.ok(close(signal(o, "utilization:collateral", myE).value, 0.5));
    assert.ok(close(signal(o, "utilization:debt", myE).value, 0.8));
    // at 0 it is the market without me
    assert.ok(close(signal(o, "utilization:collateral", 0).value, 30e6 / (60e6 - L70 * myE)));
    assert.ok(close(signal(o, "utilization:debt", 0).value, (32e6 - (L70 - 1) * myE) / 40e6));
  });

  it("without IRMs: observed supply APR, debt borrow APR ramped on added debt vs debt-market liquidity", () => {
    const o = loopPairOpportunity(pair(), sctx(), "s")!;
    assert.ok(close(total(o, 0), L70 * 0.05 - (L70 - 1) * 0.06));
    assert.ok(close(stream(o, "supply_base").aprAt(5e6), L70 * 0.05));
    const atCap = (0.1 * (40e6 - 32e6)) / (L70 - 1); // added debt = 10% of the DEBT market's available
    const borrow = stream(o, "borrow_base");
    assert.ok(close(borrow.aprAt(atCap), -(L70 - 1) * 0.06 * 1.3));
    assert.ok(close(borrow.aprAt(atCap * 4), -(L70 - 1) * 0.06 * 1.3), "capped at rate_uncertainty_mult");
    assert.ok(close(borrow.aprAt(atCap / 2), -(L70 - 1) * 0.06 * 1.15));
  });

  it("rewards: collateral supply rewards pro-rata on S_c (g=L), debt borrow rewards on B_d (g=L-1)", () => {
    const p = pair({
      collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, supplyRewards: [{ token: "NAVX", apr: 0.04 }], borrowRewards: [{ token: "IGNORED", apr: 0.5 }] }),
      debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, borrowRewards: [{ token: "SUI", apr: 0.03 }], supplyRewards: [{ token: "IGNORED", apr: 0.5 }] }),
    });
    const o = loopPairOpportunity(p, sctx(), "s")!;
    assert.deepEqual(o.streams.map((s) => s.label), ["supply_base", "borrow_base", "supply_reward:NAVX", "borrow_reward:SUI"]);
    const E = 1e6;
    assert.ok(close(stream(o, "supply_reward:NAVX").aprAt(E), ((0.04 * 60e6) / (60e6 + L70 * E)) * L70));
    assert.ok(close(stream(o, "borrow_reward:SUI").aprAt(E), ((0.03 * 32e6) / (32e6 + (L70 - 1) * E)) * (L70 - 1)));
    assert.equal(stream(o, "borrow_reward:SUI").rewardToken, "SUI");
  });

  it("swap cost is paid on (L-1) at entry and exit; borrow fee from the debt leg; flashloan only with net footprint", () => {
    const p = pair({ swapCostFrac: 0.001, flashloanFeeFrac: 0.0005, debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, borrowFeeFrac: 0.002 }) });
    const g = loopPairOpportunity(p, sctx(), "s")!;
    assert.ok(close(g.costs.entryFrac, (L70 - 1) * (0.002 + 0.001)));
    assert.ok(close(g.costs.exitFrac, (L70 - 1) * 0.001));
    assert.equal(g.costs.fixedEntryUsd, 0.05);
    assert.equal(g.costs.fixedExitUsd, 0.05);
    const n = loopPairOpportunity(p, sctx(cfgWith({ sources: { lending_loop: { footprint: "net", txs_per_entry: 3, txs_per_exit: 2 } } })), "s")!;
    assert.ok(close(n.costs.exitFrac, (L70 - 1) * (0.001 + 0.0005)));
    assert.ok(close(n.costs.fixedEntryUsd, 0.15));
    assert.ok(close(n.costs.fixedExitUsd, 0.1));
    assert.equal(n.liquidity.footprintPerEquity, 1);
    assert.ok(close(g.liquidity.footprintPerEquity, L70));
  });

  it("depeg signal: |p_debt/p_collateral - 1| at warn / exit levels", () => {
    const at = (debtPrice: number, collPrice = 1) =>
      loopPairOpportunity(
        pair({ collateral: leg("USDC", { priceUsd: collPrice, totalSupplyUsd: 60e6, totalBorrowUsd: 30e6 }), debt: leg("USDT", { priceUsd: debtPrice, totalSupplyUsd: 40e6, totalBorrowUsd: 32e6 }) }),
        sctx(),
        "s"
      )!;
    const ok = signal(at(1.0005), "depeg");
    assert.ok(close(ok.value, 0.0005));
    assert.equal(ok.warnAt, 0.003);
    assert.equal(ok.exitAt, 0.01);
    assert.equal(ok.direction, "above");
    assert.ok(ok.value < ok.warnAt);
    const warn = signal(at(0.995), "depeg");
    assert.ok(close(warn.value, 0.005) && warn.value >= warn.warnAt && warn.value < warn.exitAt);
    const exit = signal(at(1, 1.02), "depeg");
    assert.ok(close(exit.value, 1 - 1 / 1.02) && exit.value >= exit.exitAt);
    assert.ok(close(at(0.995).metrics.depeg!, 0.005));
    // projected signals carry the depeg too (unchanged by size)
    assert.ok(close(signal(at(0.995), "depeg", 1e6).value, 0.005));
    assert.deepEqual(at(1).signals.map((s) => s.name), ["utilization:collateral", "utilization:debt", "depeg"]);
  });

  it("exit capacity is the tighter of collateral liquidity and swap depth (scaled to the footprint)", () => {
    // collateral available 30M; swap depth 20M -> 20M * L/(L-1) = 28.57M binds
    const a = loopPairOpportunity(pair({ swapDepthUsd: 20e6 }), sctx(), "s")!;
    assert.ok(close(a.liquidity.exitCapacityUsd, (20e6 * L70) / (L70 - 1)));
    // deep swap -> collateral liquidity binds
    const b = loopPairOpportunity(pair({ swapDepthUsd: 1e9 }), sctx(), "s")!;
    assert.equal(b.liquidity.exitCapacityUsd, 30e6);
    const inf = loopPairOpportunity(pair({ swapDepthUsd: Infinity }), sctx(), "s")!;
    assert.equal(inf.liquidity.exitCapacityUsd, 30e6);
    // net footprint (1 per equity): both limits divided by their per-equity need
    const n = loopPairOpportunity(pair({ swapDepthUsd: 20e6 }), sctx(cfgWith({ sources: { lending_loop: { footprint: "net" } } })), "s")!;
    assert.ok(close(n.liquidity.exitCapacityUsd, Math.min(30e6 / L70, 20e6 / (L70 - 1))));
    // max exitable equity is the same either way
    assert.ok(close(a.liquidity.exitCapacityUsd / a.liquidity.footprintPerEquity, n.liquidity.exitCapacityUsd / n.liquidity.footprintPerEquity));
  });

  it("health: ltv with rebalance at min(deleverage, 0.97 x liqLtv) and critical at liqLtv x frac", () => {
    const held = { "s:navi:USDC/USDT": 1e4 };
    const o = loopPairOpportunity(pair({ myLtv: 0.72, liqLtv: 0.93 }), sctx(cfgWith(), held), "s")!;
    assert.deepEqual(o.health, { metric: "ltv", value: 0.72, rebalanceAt: 0.78, criticalAt: 0.93 * 0.95, direction: "above" });
    // a low LLTV pulls the rebalance level below deleverage_at_ltv
    const low = loopPairOpportunity(pair({ maxLtv: 0.77, liqLtv: 0.77, myLtv: 0.6 }), sctx(cfgWith(), held), "s")!;
    assert.ok(close(low.health!.rebalanceAt, 0.77 * 0.97));
    assert.ok(close(low.health!.criticalAt, 0.77 * 0.95));
    // no health without a position or without a measured LTV
    assert.equal(loopPairOpportunity(pair({ myLtv: 0.72 }), sctx(), "s")!.health, undefined);
    assert.equal(loopPairOpportunity(pair(), sctx(cfgWith(), held), "s")!.health, undefined);
  });

  it("max equity from collateral supply cap / L and debt borrow cap / (L-1), plus what I hold", () => {
    const caps = (s?: number | null, b?: number | null, myE = 0) =>
      loopPairOpportunity(
        pair({
          collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, supplyCapRemainingUsd: s, borrowCapRemainingUsd: 1 }),
          debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, borrowCapRemainingUsd: b, supplyCapRemainingUsd: 1 }),
        }),
        sctx(cfgWith(), myE ? { "s:navi:USDC/USDT": myE } : {}),
        "s"
      )!.maxEquityUsd;
    assert.equal(caps(undefined, undefined), undefined, "the other legs' caps are irrelevant");
    assert.equal(caps(null, null), undefined);
    assert.ok(close(caps(1e6, null)!, 1e6 / L70));
    assert.ok(close(caps(null, 1e6)!, 1e6 / (L70 - 1)));
    assert.ok(close(caps(1e6, 1e6)!, Math.min(1e6 / L70, 1e6 / (L70 - 1))));
    assert.ok(close(caps(1e6, 1e6, 5e4)!, 5e4 + 1e6 / L70));
  });

  it("paused pair is an exit flag; LTV is capped by max_ltv_frac_of_open; dataAsOfMs passes through", () => {
    const o = loopPairOpportunity(pair({ paused: true, maxLtv: 0.6, dataAsOfMs: NOW - 60_000 }), sctx(), "s", { estimated: true })!;
    assert.deepEqual(o.flags, [{ name: "market_paused", severity: "exit" }]);
    assert.ok(close((o.meta as { ltv: number }).ltv, 0.6 * 0.85));
    assert.equal(o.dataAsOfMs, NOW - 60_000);
    assert.equal(o.liquidity.estimated, true);
    assert.equal(o.name, "navi USDC/USDT loop @51% LTV");
  });

  it("output passes validateOpportunity (fresh data; stale data is caught by the validator)", () => {
    const cfg = cfgWith();
    const full = pair({
      collateral: leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, irm: IRM, supplyRewards: [{ token: "NAVX", apr: 0.04 }], supplyCapRemainingUsd: 5e6 }),
      debt: leg("USDT", { priceUsd: 0.999, totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, irm: IRM_D, borrowRewards: [{ token: "SUI", apr: 0.02 }], borrowCapRemainingUsd: 2e6, borrowFeeFrac: 0.001 }),
      myLtv: 0.7,
      flashloanFeeFrac: 0.0009,
      dataAsOfMs: NOW - 30_000,
    });
    const o = loopPairOpportunity(full, sctx(cfg, { "s:navi:USDC/USDT": 1e5 }), "s")!;
    assert.deepEqual(validateOpportunity(o, cfg, NOW), []);
    assert.deepEqual(validateOpportunity(loopPairOpportunity(pair(), sctx(cfg), "s")!, cfg, NOW), []);
    const stale = loopPairOpportunity({ ...full, dataAsOfMs: NOW - 3600_000 }, sctx(cfg), "s")!;
    assert.ok(validateOpportunity(stale, cfg, NOW).some((e) => e.includes("stale")));
  });

  it("returns null on NaN / non-finite / degenerate inputs", () => {
    const c = (over: Partial<LoopLeg>) => leg("USDC", { totalSupplyUsd: 60e6, totalBorrowUsd: 30e6, ...over });
    const d = (over: Partial<LoopLeg>) => leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: 32e6, ...over });
    const bad: Partial<LoopPair>[] = [
      { collateral: c({ totalSupplyUsd: NaN }) },
      { collateral: c({ totalSupplyUsd: 0 }) },
      { collateral: c({ totalBorrowUsd: NaN }) },
      { collateral: c({ totalSupplyUsd: Infinity }) },
      { collateral: c({ supplyAprBase: NaN }) },
      { collateral: c({ priceUsd: NaN }) },
      { collateral: c({ priceUsd: 0 }) },
      { collateral: c({ supplyRewards: [{ token: "X", apr: NaN }] }) },
      { debt: d({ totalSupplyUsd: NaN }) },
      { debt: d({ totalSupplyUsd: 0 }) },
      { debt: d({ totalBorrowUsd: -1 }) },
      { debt: d({ borrowAprBase: NaN }) },
      { debt: d({ priceUsd: NaN }) },
      { debt: d({ borrowFeeFrac: NaN }) },
      { debt: d({ borrowRewards: [{ token: "X", apr: NaN }] }) },
      { maxLtv: NaN },
      { maxLtv: 0 },
      { liqLtv: NaN },
      { swapCostFrac: NaN },
      { swapDepthUsd: NaN },
      { swapDepthUsd: -1 },
      { flashloanFeeFrac: NaN },
    ];
    for (const over of bad) assert.equal(loopPairOpportunity(pair(over), sctx(), "s"), null, JSON.stringify(over, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)));
    // same-asset path too (loopOpportunity delegates)
    assert.equal(loopOpportunity(market({ totalSupplyUsd: NaN }), sctx(), "s"), null);
    assert.equal(loopOpportunity(market({ closeLtv: NaN }), sctx(), "s"), null);
    assert.equal(loopOpportunity(market({ borrowAprBase: NaN }), sctx(), "s"), null);
    // a debt leg with no borrow yet is fine (B_d = 0)
    assert.ok(loopPairOpportunity(pair({ debt: d({ totalBorrowUsd: 0 }) }), sctx(), "s"));
  });
});

describe("LoopPairSource", () => {
  it("maps provider pairs to opportunities and drops invalid ones", async () => {
    const src = new LoopPairSource("pairs", async () => [pair(), pair({ pairId: "bad", maxLtv: NaN }), loopMarketToPair(market())]);
    const out = await src.fetch(sctx());
    assert.deepEqual(out.map((o) => o.id), ["pairs:navi:USDC/USDT", "pairs:suilend:USDC"]);
    assert.equal(src.id, "pairs");
    assert.ok(out.every((o) => o.sourceId === "pairs" && o.kind === "lending_loop"));
  });
});

describe("loopPair: reward eligibility (netOf / perUserCapUsd / maxHealthFactor)", () => {
  const S_C = 60e6;
  const B_D = 32e6;
  const withRewards = (supply: RewardRate[], borrow: RewardRate[], over: Partial<LoopPair> = {}) =>
    pair({
      collateral: leg("USDC", { totalSupplyUsd: S_C, totalBorrowUsd: 30e6, supplyRewards: supply }),
      debt: leg("USDT", { totalSupplyUsd: 40e6, totalBorrowUsd: B_D, borrowRewards: borrow }),
      ...over,
    });
  const proRata = (apr: number, pool: number, g: number, E: number, myE = 0) => ((apr * pool) / (pool - g * myE + g * E)) * g;

  it("net-lending supply reward (netOf matches the debt symbol, or '*') is paid on E, not L*E", () => {
    for (const netOf of [["USDT"], ["*"], ["DAI", "USDT"]]) {
      const o = loopPairOpportunity(withRewards([{ token: "AAVE", apr: 0.05, netOf }], []), sctx(), "s")!;
      const s = stream(o, "supply_reward:AAVE");
      for (const E of [0, 1e5, 5e6]) assert.ok(close(s.aprAt(E), proRata(0.05, S_C, 1, E)), `${netOf}@${E}`);
      assert.ok(close(s.aprAt(0), 0.05), "multiplier 1: the loop earns the plain supplier rate on equity");
      assert.deepEqual((o.meta as { rewardNotes: Record<string, string[]> }).rewardNotes["supply_reward:AAVE"], ["net_basis"]);
    }
    // netOf a symbol I do not borrow -> still gross (multiplier L)
    const g = loopPairOpportunity(withRewards([{ token: "AAVE", apr: 0.05, netOf: ["DAI"] }], []), sctx(), "s")!;
    assert.ok(close(stream(g, "supply_reward:AAVE").aprAt(1e5), proRata(0.05, S_C, L70, 1e5)));
  });

  it("net-lending supply reward on a same-asset loop (via loopOpportunity) also uses multiplier 1", () => {
    for (const netOf of [["USDC"], ["*"]]) {
      const o = loopOpportunity(market({ supplyRewards: [{ token: "AAVE", apr: 0.05, netOf }] }), sctx(), "s")!;
      assert.ok(close(stream(o, "supply_reward:AAVE").aprAt(1e6), proRata(0.05, 50e6, 1, 1e6)));
    }
    // a held position is backed out of the pool at g = 1
    const myE = 2e5;
    const held = loopOpportunity(market({ supplyRewards: [{ token: "AAVE", apr: 0.05, netOf: ["USDC"] }] }), sctx(cfgWith(), { "s:suilend:USDC": myE }), "s")!;
    assert.ok(close(stream(held, "supply_reward:AAVE").aprAt(myE), 0.05));
  });

  it("net-borrowing borrow reward (netOf matches the collateral symbol, or '*') pays nothing to a loop", () => {
    for (const netOf of [["USDC"], ["*"]]) {
      const o = loopPairOpportunity(withRewards([], [{ token: "AAVE", apr: 0.04, netOf }]), sctx(), "s")!;
      const s = stream(o, "borrow_reward:AAVE");
      for (const E of [0, 1, 1e6]) assert.equal(s.aprAt(E), 0);
      assert.equal(s.kind, "reward");
      assert.deepEqual(validateOpportunity(o, cfgWith(), NOW), []);
    }
    const same = loopOpportunity(market({ borrowRewards: [{ token: "AAVE", apr: 0.04, netOf: ["USDC"] }] }), sctx(), "s")!;
    assert.equal(stream(same, "borrow_reward:AAVE").aprAt(1e5), 0);
    // netOf something I do not supply -> gross (L-1)
    const g = loopPairOpportunity(withRewards([], [{ token: "AAVE", apr: 0.04, netOf: ["DAI"] }]), sctx(), "s")!;
    assert.ok(close(stream(g, "borrow_reward:AAVE").aprAt(1e5), proRata(0.04, B_D, L70 - 1, 1e5)));
  });

  it("perUserCapUsd scales the APR by min(1, cap / basis) with basis L*E (gross) or E (net)", () => {
    const cap = 100_000;
    const o = loopPairOpportunity(
      withRewards(
        [{ token: "G", apr: 0.05, perUserCapUsd: cap }, { token: "N", apr: 0.05, perUserCapUsd: cap, netOf: ["USDT"] }],
        [{ token: "B", apr: 0.04, perUserCapUsd: cap }]
      ),
      sctx(),
      "s"
    )!;
    const gross = stream(o, "supply_reward:G");
    const net = stream(o, "supply_reward:N");
    const bor = stream(o, "borrow_reward:B");
    // under the cap: identical to the uncapped pro-rata stream
    const small = 20_000; // L*E = 66.7k < 100k
    assert.ok(close(gross.aprAt(small), proRata(0.05, S_C, L70, small)));
    assert.ok(close(gross.aprAt(0), 0.05 * L70));
    // over the cap: scaled by cap / (L*E)
    const big = 120_000; // L*E = 400k
    assert.ok(close(gross.aprAt(big), proRata(0.05, S_C, L70, big) * (cap / (L70 * big))));
    // net basis is E: 120k equity -> scaled by 100k / 120k
    assert.ok(close(net.aprAt(big), proRata(0.05, S_C, 1, big) * (cap / big)));
    assert.ok(close(net.aprAt(90_000), proRata(0.05, S_C, 1, 90_000)), "net basis 90k is under the cap");
    // borrow basis is (L-1)*E
    const bb = 300_000; // (L-1)*E = 700k
    assert.ok(close(bor.aprAt(bb), proRata(0.04, B_D, L70 - 1, bb) * (cap / ((L70 - 1) * bb))));
    // diminishing returns: reward USD/yr flattens out once over the cap
    const usd = (E: number) => gross.aprAt(E) * E;
    assert.ok(usd(2e5) <= usd(1e5), "past the cap, more equity earns no more reward USD");
    assert.ok(usd(1e5) > usd(2e4), "below the cap it still grows");
    assert.ok(gross.aprAt(2e5) < gross.aprAt(1e5));
    assert.ok(close(usd(1e6), proRata(0.05, S_C, L70, 1e6) * cap / L70, 1e-9));
    assert.deepEqual((o.meta as { rewardNotes: Record<string, string[]> }).rewardNotes["supply_reward:N"], ["net_basis", "per_user_cap_usd_100000"]);
    // a zero cap pays nothing
    const zero = loopPairOpportunity(withRewards([{ token: "Z", apr: 0.05, perUserCapUsd: 0 }], []), sctx(), "s")!;
    assert.equal(stream(zero, "supply_reward:Z").aprAt(1e4), 0);
  });

  it("maxHealthFactor: reward is 0 when HF = liqLtv / ltv is above the limit", () => {
    // ltv 0.7, liqLtv 0.93 -> HF 1.33
    const ok = loopPairOpportunity(withRewards([{ token: "ENA", apr: 0.05, maxHealthFactor: 2 }], [{ token: "ENA", apr: 0.02, maxHealthFactor: 2 }]), sctx(), "s")!;
    assert.ok(close(stream(ok, "supply_reward:ENA").aprAt(1e5), proRata(0.05, S_C, L70, 1e5)));
    assert.ok(close(stream(ok, "borrow_reward:ENA").aprAt(1e5), proRata(0.02, B_D, L70 - 1, 1e5)));
    assert.equal((ok.meta as { rewardNotes?: unknown }).rewardNotes, undefined);
    const tight = loopPairOpportunity(withRewards([{ token: "ENA", apr: 0.05, maxHealthFactor: 1.3 }], [{ token: "ENA", apr: 0.02, maxHealthFactor: 1.3 }]), sctx(), "s")!;
    assert.equal(stream(tight, "supply_reward:ENA").aprAt(1e5), 0);
    assert.equal(stream(tight, "borrow_reward:ENA").aprAt(0), 0);
    assert.ok((tight.meta as { rewardNotes: Record<string, string[]> }).rewardNotes["supply_reward:ENA"]![0]!.startsWith("hf_1.329"));
    // a lower target LTV (40%) gives HF 2.33 > 2 -> the "must loop" campaign does not pay
    const lowLev = cfgWith({ sources: { lending_loop: { target_ltv: 0.4 } } });
    const o = loopPairOpportunity(withRewards([{ token: "ENA", apr: 0.05, maxHealthFactor: 2 }], []), sctx(lowLev), "s")!;
    assert.equal(stream(o, "supply_reward:ENA").aprAt(1e5), 0);
    // same-asset path: closeLtv 0.95 / 0.7 = 1.357
    assert.equal(stream(loopOpportunity(market({ supplyRewards: [{ token: "ENA", apr: 0.05, maxHealthFactor: 1.35 }] }), sctx(), "s")!, "supply_reward:ENA").aprAt(1e5), 0);
    assert.ok(stream(loopOpportunity(market({ supplyRewards: [{ token: "ENA", apr: 0.05, maxHealthFactor: 1.36 }] }), sctx(), "s")!, "supply_reward:ENA").aprAt(1e5) > 0);
  });

  it("combined fields + validation; plain rewards untouched; bad reward fields -> null", () => {
    const o = loopPairOpportunity(
      withRewards([{ token: "A", apr: 0.05, netOf: ["*"], perUserCapUsd: 5e4, maxHealthFactor: 2 }, { token: "P", apr: 0.03 }], [{ token: "B", apr: 0.02, netOf: ["*"] }]),
      sctx(cfgWith(), { "s:navi:USDC/USDT": 1e5 }),
      "s"
    )!;
    assert.deepEqual(validateOpportunity(o, cfgWith(), NOW), []);
    const myE = 1e5;
    assert.ok(close(stream(o, "supply_reward:A").aprAt(myE), proRata(0.05, S_C, 1, myE, myE) * (5e4 / myE)));
    assert.ok(close(stream(o, "supply_reward:P").aprAt(myE), proRata(0.03, S_C, L70, myE, myE)), "plain reward is the gross pro-rata stream");
    assert.equal(stream(o, "borrow_reward:B").aprAt(myE), 0);
    const notes = (o.meta as { rewardNotes: Record<string, string[]> }).rewardNotes;
    assert.deepEqual(Object.keys(notes).sort(), ["borrow_reward:B", "supply_reward:A"]);
    assert.deepEqual(notes["borrow_reward:B"], ["net_basis_negative"]);
    for (const r of [
      { token: "X", apr: 0.05, perUserCapUsd: NaN },
      { token: "X", apr: 0.05, perUserCapUsd: -1 },
      { token: "X", apr: 0.05, maxHealthFactor: NaN },
      { token: "X", apr: 0.05, netOf: "USDT" as unknown as string[] },
    ]) {
      assert.equal(loopPairOpportunity(withRewards([r], []), sctx(), "s"), null, JSON.stringify(r, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)));
      assert.equal(loopPairOpportunity(withRewards([], [r]), sctx(), "s"), null);
    }
    // a non-finite cap is rejected like any other non-finite input (omit the field for "no cap")
    const inf = loopPairOpportunity(withRewards([{ token: "I", apr: 0.05, perUserCapUsd: Infinity }], []), sctx(), "s");
    assert.equal(inf, null, "non-finite cap is rejected; omit the field for no cap");
  });
});
