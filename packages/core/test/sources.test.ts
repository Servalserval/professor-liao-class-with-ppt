import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { apyPctToApr, joinLendBorrow, llamaPoolToOpportunities } from "../src/sources/defillama.js";
import { fromLoopFarmMarket, interpIrm, loopLeverage, loopOpportunity, type LoopMarket } from "../src/sources/loopLending.js";
import { lpIncentiveOpportunity } from "../src/sources/lpIncentive.js";
import { checkMerklShape, merklToOpportunity, toMs } from "../src/sources/merkl.js";
import { perpHedgeOpportunity, type PerpVenueQuote } from "../src/sources/perpHedge.js";
import { valueAt } from "../src/valuation.js";
import { cfgWith, close, dctx, sctx } from "./helpers.js";

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

describe("lending loop source", () => {
  it("prices APR on equity with leverage L = 1/(1-ltv)", () => {
    const o = loopOpportunity(market(), sctx(), "s")!;
    const L = loopLeverage(0.7);
    // no IRM: E=0 -> current rates
    assert.ok(close(o.streams.reduce((a, s) => a + s.aprAt(0), 0), L * 0.06 - (L - 1) * 0.08));
    assert.equal(o.liquidity.exitCapacityUsd, 10e6);
    assert.ok(close(o.liquidity.footprintPerEquity, L)); // gross footprint by default
  });
  it("caps LTV at max_ltv_frac_of_open x open LTV", () => {
    const o = loopOpportunity(market({ openLtv: 0.6 }), sctx(), "s")!;
    assert.ok(close((o.meta as { ltv: number }).ltv, 0.6 * 0.85));
  });
  it("ramps borrow APR with size when no IRM is known", () => {
    const o = loopOpportunity(market(), sctx(), "s")!;
    const borrow = o.streams.find((s) => s.label === "borrow_base")!;
    const L = loopLeverage(0.7);
    const atCap = (0.1 * 10e6) / L; // footprint = 10% of available
    assert.ok(close(borrow.aprAt(atCap), -(L - 1) * 0.08 * 1.3));
    assert.ok(borrow.aprAt(atCap / 2) > borrow.aprAt(atCap));
  });
  it("uses the IRM for post-entry rates and projected utilization", () => {
    const irm = { points: [[0, 0.0], [0.8, 0.08], [1, 0.5]] as [number, number][], reserveFactor: 0.1 };
    assert.ok(close(interpIrm(irm, 0.9), 0.29));
    const o = loopOpportunity(market({ irm }), sctx(), "s")!;
    // A 70%-LTV loop adds borrow/supply at ratio (L-1)/L = 0.7 < current 0.8,
    // so my size pulls utilization DOWN: (40 + 2.33*5) / (50 + 3.33*5) = 0.775
    const u = o.projectedSignals!(5e6)[0]!;
    assert.ok(close(u.value, 0.775, 1e-3), `u=${u.value}`);
    const borrow = o.streams.find((s) => s.label === "borrow_base")!;
    assert.ok(close(borrow.aprAt(0), -(loopLeverage(0.7) - 1) * 0.08));
    assert.ok(borrow.aprAt(5e6) > borrow.aprAt(0), "lower utilization -> cheaper borrow");
    // ...and a loop at 90% LTV pushes it UP toward 0.9
    const hot = loopOpportunity(market({ irm }), sctx(cfgWith({ sources: { lending_loop: { target_ltv: 0.9, max_ltv_frac_of_open: 1, deleverage_at_ltv: 0.92 } } })), "s")!;
    assert.ok(hot.projectedSignals!(5e6)[0]!.value > 0.8);
  });
  it("derives max equity from supply / borrow caps", () => {
    const o = loopOpportunity(market({ supplyCapRemainingUsd: 1e6, borrowCapRemainingUsd: 1e6 }), sctx(), "s")!;
    const L = loopLeverage(0.7);
    assert.ok(close(o.maxEquityUsd!, Math.min(1e6 / L, 1e6 / (L - 1))));
  });
  it("flags a paused market as exit and reports health only when open", () => {
    const o = loopOpportunity(market({ paused: true, myLtv: 0.72 }), sctx(cfgWith(), { "s:suilend:USDC": 1000 }), "s")!;
    assert.equal(o.flags[0]!.severity, "exit");
    assert.equal(o.health!.metric, "ltv");
    assert.equal(loopOpportunity(market({ myLtv: 0.72 }), sctx(), "s")!.health, undefined);
  });
  it("converts loop-farm MarketState (bigint base units)", () => {
    const m = fromLoopFarmMarket(
      {
        protocol: "navi",
        symbol: "USDC",
        decimals: 6,
        priceUsd: 1,
        totalSupply: 50_000_000n * 1_000_000n,
        totalBorrow: 40_000_000n * 1_000_000n,
        supplyAprBase: 0.05,
        borrowAprBase: 0.07,
        supplyAprReward: 0.04,
        borrowAprReward: 0,
        openLtv: 0.8,
        closeLtv: 0.85,
        borrowFee: 0.001,
        supplyCapRemaining: null,
        borrowCapRemaining: 1_000_000n * 1_000_000n,
        irm: { points: [{ u: 0, apr: 0.01 }, { u: 0.8, apr: 0.07 }, { u: 1, apr: 0.6 }], supplySpreadFee: 0.2 },
        supplyRewardEndsAtMs: null,
      },
      "sui",
      "NAVX"
    );
    assert.equal(m.totalSupplyUsd, 50e6);
    assert.equal(m.borrowCapRemainingUsd, 1e6);
    assert.equal(m.irm!.points.length, 3);
    assert.equal(m.supplyRewards[0]!.token, "NAVX");
  });
});

const q = (venue: string, over: Partial<PerpVenueQuote> = {}): PerpVenueQuote => ({
  venue,
  chain: "offchain",
  fundingApr: 0.1,
  depthUsd: 2e6,
  takerFee: 0.0005,
  makerFee: 0.0001,
  markPrice: 100_000,
  ...over,
});

describe("perp hedge source", () => {
  it("refuses same-venue hedges (self-matching)", () => {
    assert.throws(() => perpHedgeOpportunity({ asset: "BTC", long: q("hl"), short: q("hl"), leverage: 3 }, sctx(), "p"));
  });
  it("earns the funding difference on notional = leverage/2 per equity", () => {
    const o = perpHedgeOpportunity(
      { asset: "BTC", long: q("deribit", { fundingApr: 0.03 }), short: q("kraken", { fundingApr: 0.17 }), leverage: 4, turnoverPerYear: 10 },
      sctx(),
      "p"
    );
    assert.ok(close(o.streams[0]!.aprAt(0), (0.17 - 0.03) * 2));
    assert.ok(close(o.costs.entryFrac, 2 * 0.001));
    assert.ok(close(o.costs.ongoingApr, 10 * 2 * 0.001));
    assert.equal(o.liquidity.footprintPerEquity, 2);
    assert.equal(o.legs.length, 2);
  });
  it("prices points only when a point value is given and marks speculative", () => {
    const o = perpHedgeOpportunity(
      { asset: "BTC", long: q("a", { pointsPerUsdVolume: 1e-3 }), short: q("b"), leverage: 2, turnoverPerYear: 50, farmPoints: true },
      sctx(),
      "p"
    );
    assert.equal(o.speculative, true);
    assert.equal(o.streams.find((s) => s.kind === "points")!.aprAt(0), 0);
  });
  it("reports a venue basis signal", () => {
    const o = perpHedgeOpportunity({ asset: "BTC", long: q("a", { markPrice: 100_000 }), short: q("b", { markPrice: 101_500 }), leverage: 2 }, sctx(), "p");
    assert.ok(o.signals[0]!.value > 100);
  });
});

describe("LP incentive source", () => {
  it("charges LVR = sigma^2/8 x concentration and shares rewards pro-rata", () => {
    const o = lpIncentiveOpportunity(
      {
        venue: "aqua",
        chain: "ethereum",
        pool: "1inch-usdc",
        tokenA: "1INCH",
        tokenB: "USDC",
        tvlUsd: 2e6,
        feeApr: 0.1,
        rewards: [{ token: "1INCH", dailyUsd: 1000 }],
        pairVol: 0.8,
        concentration: 2,
        exitCapacityUsd: 500_000,
      },
      sctx(),
      "lp"
    );
    assert.ok(close(o.costs.ongoingApr, (0.8 * 0.8) / 8 * 2));
    const r = o.streams.find((s) => s.kind === "reward")!;
    assert.ok(close(r.aprAt(0), ((1000 * 365) / 2e6) * 2));
    assert.ok(r.aprAt(1e6) < r.aprAt(0));
  });
});

describe("discovery sources", () => {
  const merkl = JSON.parse(readFileSync("examples/fixtures/merkl-opportunities.json", "utf8")) as unknown[];
  const llama = JSON.parse(readFileSync("examples/fixtures/defillama-pools.json", "utf8")) as { data: Record<string, unknown>[] };
  const lendBorrow = JSON.parse(readFileSync("examples/fixtures/defillama-lendborrow.json", "utf8")) as unknown;

  it("maps Merkl LIVE opportunities, drops PAST, reads campaign end in seconds", () => {
    assert.deepEqual(checkMerklShape(merkl), []);
    const ops = merkl.map((m) => merklToOpportunity(m, sctx(), "merkl")).filter(Boolean);
    assert.equal(ops.length, 2);
    const o = ops[0]!;
    assert.equal(o.discoveryOnly, true);
    assert.equal(o.chain, "base");
    assert.equal(o.primaryVenue, "uniswap");
    assert.ok(close(o.streams[0]!.aprAt(0), (4000 * 365) / 4.2e6));
    assert.equal(o.streams[0]!.endsAtMs, 1793900000 * 1000);
    assert.equal(toMs(1793900000123), 1793900000123);
  });
  it("converts APY% to APR", () => {
    assert.ok(close(apyPctToApr(0), 0));
    assert.ok(close(apyPctToApr(10.516), 0.1, 1e-4)); // e^0.1 - 1 = 10.517%
    assert.ok(apyPctToApr(300) < 3);
  });
  it("without /lendBorrow there are no loop candidates", () => {
    const ops = llama.data.flatMap((p) => llamaPoolToOpportunities(p, sctx(), "llama"));
    assert.ok(!ops.some((o) => o.kind === "lending_loop"));
  });
  it("turns DefiLlama lending pools into loop candidates and reward pools into deposits", () => {
    const ops = joinLendBorrow(llama.data, lendBorrow).flatMap((p) => llamaPoolToOpportunities(p, sctx(), "llama"));
    const kinds = ops.map((o) => `${o.kind}:${o.primaryVenue}`);
    assert.ok(kinds.includes("lending_loop:suilend"));
    assert.ok(kinds.includes("lending_loop:aave-v3"));
    assert.ok(kinds.includes("deposit:example-dex"));
    assert.ok(!kinds.some((k) => k.includes("tiny-farm")), "below min TVL");
    const loop = ops.find((o) => o.kind === "lending_loop" && o.primaryVenue === "suilend")!;
    assert.equal(loop.liquidity.exitCapacityUsd, 12e6);
    assert.ok(valueAt(loop, 10_000, dctx()).netApr > 0.05);
  });
});
