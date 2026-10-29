/**
 * Offline tests for the Suilend adapter: pure planners / math, plus the
 * adapter driven through fake SDK client, fake swapper and a mocked gRPC
 * simulate (dry-run). The SDK's own simulate.* functions run for real on the
 * fake raw reserves / obligation, so the field mapping is exercised too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { AssetRef, LiveContext } from "@incentive-router/live-common";
import { Mutex, type PtbSwapper, type SuiEnv, type Transaction } from "../src/common.js";
import { SuilendAdapter, planSuilendLoopSteps, suilendPure } from "../src/suilend/index.js";
import {
  buildLoopPair,
  ctokensFor,
  pairLtvLimits,
  pairRewardIneligibility,
  planLoopSteps,
  planUnwindSteps,
  poolRewardApr,
  probeSwap,
  rateLimiterRemainingUsd,
  rewardIneligibility,
  rewardsEligible,
  sideRewardRates,
  irmFromConfig,
  borrowCapRemainingUsd,
  depositCapRemainingUsd,
  type LoopPlanInput,
  type UnwindPlanInput,
} from "../src/suilend/pure.js";
import type { RawObligation, RawReserve, ReserveSnapshot, SuilendClientLike } from "../src/suilend/types.js";
import { compoundReserves, reserveSnapshot } from "../src/suilend/sdk.js";

test("index re-exports the pure planner under collision-free names", () => {
  assert.equal(planSuilendLoopSteps, planLoopSteps);
  assert.equal(suilendPure.planUnwindSteps, planUnwindSteps);
});

const WAD = 10n ** 18n;
const NOW = 1_790_000_000_000; // fixed clock (ms)
const NOW_S = Math.floor(NOW / 1000);
const DAY = 86_400_000;

// fixture coin types (raw on-chain TypeName form, no 0x)
const USDC_RAW = "dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const USDSUI_RAW = "44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI";
const SUI_RAW = "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const PTS_RAW = "1111111111111111111111111111111111111111111111111111111111111111::pts::PTS";
const USDC = normalizeStructTag(USDC_RAW);
const USDSUI = normalizeStructTag(USDSUI_RAW);
const SUI = normalizeStructTag(SUI_RAW);
const PTS = normalizeStructTag(PTS_RAW);
const STABLES = new Set([USDC, USDSUI]);

const A_USDC: AssetRef = { chain: "sui", symbol: "USDC", address: USDC, decimals: 6 };
const A_USDSUI: AssetRef = { chain: "sui", symbol: "USDsui", address: USDSUI, decimals: 6 };
const A_SUI: AssetRef = { chain: "sui", symbol: "SUI", address: SUI, decimals: 9 };

const MARKET = "0x" + "84".repeat(32);
const MARKET_TYPE = "0x" + "f9".repeat(32) + "::suilend::MAIN_POOL";
const OBL = "0x" + "0b".repeat(32);
const CAP = "0x" + "ca".repeat(32);
const ADDR = "0x" + "aa".repeat(32);

const wadOf = (x: number) => ({ value: BigInt(Math.round(x * 1e9)) * 10n ** 9n });
const tok = (x: number, dec: number) => BigInt(Math.round(x * 10 ** dec));

interface ResOpts {
  raw: string;
  index: number;
  dec: number;
  price: number;
  smoothed?: number;
  available: number;
  borrowed: number;
  openLtvPct: number;
  closeLtvPct: number;
  bwBps?: number;
  borrowFeeBps?: number;
  spreadFeeBps?: number;
  ratio?: number;
  cbr?: number;
  depositShares?: number; // tokens
  borrowShares?: number; // tokens
  depositRewards?: { raw: string; total: bigint; start: number; end: number; cum?: bigint }[];
  borrowRewards?: { raw: string; total: bigint; start: number; end: number; cum?: bigint }[];
  lastUpdateS?: number;
  isolated?: boolean;
}

function rawReserve(o: ResOpts): RawReserve {
  const ratio = o.ratio ?? 1.02;
  const cbr = o.cbr ?? 1.01;
  const total = o.available + o.borrowed;
  const prm = (id: string, shares: number, rs: ResOpts["depositRewards"] = []) => ({
    id,
    totalShares: tok(shares, o.dec),
    lastUpdateTimeMs: BigInt(NOW),
    poolRewards: rs.map((r, i) => ({
      id: "0x" + (i + 1).toString(16).padStart(64, "0"),
      poolRewardManagerId: id,
      coinType: r.raw,
      startTimeMs: BigInt(r.start),
      endTimeMs: BigInt(r.end),
      totalRewards: r.total,
      allocatedRewards: { value: 0n },
      cumulativeRewardsPerShare: { value: r.cum ?? 0n },
      numUserRewardManagers: 1n,
    })),
  });
  return {
    id: "0x" + (100 + o.index).toString(16).padStart(64, "0"),
    arrayIndex: BigInt(o.index),
    coinType: o.raw,
    config: {
      element: {
        openLtvPct: o.openLtvPct,
        closeLtvPct: o.closeLtvPct,
        maxCloseLtvPct: o.closeLtvPct,
        borrowWeightBps: BigInt(o.bwBps ?? 10_000),
        depositLimit: tok(1e9, o.dec),
        borrowLimit: tok(1e9, o.dec),
        depositLimitUsd: 1_000_000_000n,
        borrowLimitUsd: 1_000_000_000n,
        interestRateUtils: [0, 80, 100],
        interestRateAprs: [0n, 1000n, 5000n],
        borrowFeeBps: BigInt(o.borrowFeeBps ?? 0),
        spreadFeeBps: BigInt(o.spreadFeeBps ?? 2000),
        isolated: o.isolated ?? false,
        additionalFields: { id: "0x" + "bb".repeat(32), size: 0n },
      },
    },
    mintDecimals: o.dec,
    priceIdentifier: { bytes: new Array(32).fill(o.index + 1) },
    price: wadOf(o.price),
    smoothedPrice: wadOf(o.smoothed ?? o.price),
    priceLastUpdateTimestampS: BigInt(NOW_S - 30),
    availableAmount: tok(o.available, o.dec),
    ctokenSupply: tok(total / ratio, o.dec),
    borrowedAmount: { value: tok(o.borrowed, o.dec) * WAD },
    cumulativeBorrowRate: wadOf(cbr),
    interestLastUpdateTimestampS: BigInt(o.lastUpdateS ?? NOW_S),
    unclaimedSpreadFees: { value: 0n },
    depositsPoolRewardManager: prm("0x" + (200 + o.index).toString(16).padStart(64, "0"), o.depositShares ?? 0, o.depositRewards),
    borrowsPoolRewardManager: prm("0x" + (300 + o.index).toString(16).padStart(64, "0"), o.borrowShares ?? 0, o.borrowRewards),
  } as RawReserve;
}

function reservesFixture(): RawReserve[] {
  return [
    rawReserve({
      raw: USDC_RAW,
      index: 0,
      dec: 6,
      price: 1.0,
      smoothed: 0.9995,
      available: 50_000_000,
      borrowed: 40_000_000,
      openLtvPct: 77,
      closeLtvPct: 80,
      depositShares: 80_000_000 / 1.02,
      depositRewards: [{ raw: SUI_RAW, total: 1_000_000n * 10n ** 9n, start: NOW - 10 * DAY, end: NOW + 20 * DAY }],
    }),
    rawReserve({
      raw: USDSUI_RAW,
      index: 1,
      dec: 6,
      price: 1.0002,
      smoothed: 1.0,
      available: 5_000_000,
      borrowed: 4_000_000,
      openLtvPct: 70,
      closeLtvPct: 75,
      bwBps: 12_500,
      borrowFeeBps: 30,
      borrowShares: 4_000_000 / 1.01,
      borrowRewards: [{ raw: PTS_RAW, total: 1_000_000_000n * 10n ** 6n, start: NOW - DAY, end: NOW + 29 * DAY }],
    }),
    rawReserve({
      raw: SUI_RAW,
      index: 2,
      dec: 9,
      price: 3.0,
      available: 20_000_000,
      borrowed: 10_000_000,
      openLtvPct: 70,
      closeLtvPct: 75,
      borrowFeeBps: 1,
    }),
  ];
}

function obligationFixture(opts: { depositUsdc?: number; borrowUsdsui?: number; zeroShares?: boolean } = {}): RawObligation {
  const dep = opts.depositUsdc ?? 100_000;
  const bor = opts.borrowUsdsui ?? 40_000;
  const ctokens = tok(dep / 1.02, 6);
  const liab = tok(bor, 6);
  return {
    id: OBL,
    lendingMarketId: MARKET,
    deposits: [
      { coinType: USDC_RAW, reserveArrayIndex: 0n, depositedCtokenAmount: ctokens, userRewardManagerIndex: 0n, marketValue: { value: 0n }, attributedBorrowValue: { value: 0n } },
    ],
    borrows: [
      { coinType: USDSUI_RAW, reserveArrayIndex: 1n, borrowedAmount: { value: liab * WAD }, cumulativeBorrowRate: { value: WAD }, userRewardManagerIndex: 1n, marketValue: { value: 0n } },
    ],
    userRewardManagers: [
      {
        poolRewardManagerId: "0x" + (200).toString(16).padStart(64, "0"),
        share: opts.zeroShares ? 0n : ctokens,
        lastUpdateTimeMs: BigInt(NOW),
        rewards: [{ poolRewardId: "0x" + "1".padStart(64, "0"), earnedRewards: { value: 5n * 10n ** 9n * WAD }, cumulativeRewardsPerShare: { value: 0n } }],
      },
      {
        poolRewardManagerId: "0x" + (301).toString(16).padStart(64, "0"),
        share: opts.zeroShares ? 0n : liab,
        lastUpdateTimeMs: BigInt(NOW),
        rewards: [{ poolRewardId: "0x" + "1".padStart(64, "0"), earnedRewards: { value: 100n * 10n ** 6n * WAD }, cumulativeRewardsPerShare: { value: 0n } }],
      },
    ],
  } as unknown as RawObligation;
}

const snap = (o: Partial<ResOpts> & Pick<ResOpts, "raw" | "index" | "dec" | "price" | "available" | "borrowed" | "openLtvPct" | "closeLtvPct">): ReserveSnapshot =>
  reserveSnapshot(rawReserve(o as ResOpts));

// ---------------------------------------------------------------------------
// pure: planners
// ---------------------------------------------------------------------------

const loopBase: LoopPlanInput = {
  collPrice: 1,
  debtPrice: 1.0002,
  collPriceLow: 0.9995,
  debtPriceHigh: 1.0002,
  collateralTokens: 10_000,
  debtTokens: 0,
  openLtv: 0.77,
  borrowWeight: 1.25,
  borrowFeeFrac: 0.003,
  conversionRate: 0.996,
  targetLtv: 0.55,
  maxIterations: 20,
  stepSafety: 0.97,
  collDecimals: 6,
  debtDecimals: 6,
};

/** Replays a loop plan and checks the per-step health + target invariants. */
function checkLoopPlan(i: LoopPlanInput, plan: ReturnType<typeof planLoopSteps>) {
  let C = i.collateralTokens;
  let D = i.debtTokens;
  for (const s of plan.steps) {
    const a = Number(s.borrow) / 10 ** i.debtDecimals;
    const fee = Math.ceil(Number(s.borrow) * i.borrowFeeFrac) / 10 ** i.debtDecimals;
    const Dafter = D + a + fee;
    // open-LTV check (with borrow weight + bounds) at borrow time, before the step's deposit
    const allowed = (C * i.collPriceLow * i.openLtv + (i.otherAllowedUsd ?? 0)) * i.stepSafety;
    const weighted = Dafter * i.debtPriceHigh * i.borrowWeight + (i.otherWeightedBorrowUsd ?? 0);
    assert.ok(weighted <= allowed * (1 + 1e-9), `step health ${weighted} > ${allowed}`);
    assert.equal(s.minCollateralOut, BigInt(Math.floor(a * i.conversionRate * 10 ** i.collDecimals)));
    C += Number(s.minCollateralOut) / 10 ** i.collDecimals;
    D = Dafter;
    assert.ok((D * i.debtPrice) / (C * i.collPrice) <= i.targetLtv * (1 + 1e-9), "never exceeds targetLtv");
  }
}

test("planLoopSteps: two-asset pair with borrow weight reaches target, health respected every step", () => {
  const plan = planLoopSteps(loopBase);
  checkLoopPlan(loopBase, plan);
  assert.equal(plan.limitedBy, "target");
  assert.ok(plan.reachedTarget);
  assert.ok(plan.finalLtv <= 0.55 && plan.finalLtv > 0.549, `finalLtv ${plan.finalLtv}`);
  assert.ok(plan.steps.length > 1, "needs several iterations without a flash loan");
});

test("planLoopSteps: same asset, iteration cap and borrow cap", () => {
  const same: LoopPlanInput = { ...loopBase, debtPrice: 1, debtPriceHigh: 1, collPriceLow: 1, borrowWeight: 1, borrowFeeFrac: 0, conversionRate: 1, openLtv: 0.8, targetLtv: 0.75 };
  const full = planLoopSteps(same);
  checkLoopPlan(same, full);
  assert.ok(full.reachedTarget);
  for (const s of full.steps) assert.equal(s.minCollateralOut, s.borrow, "same asset deposits exactly what it borrows");

  const capped = planLoopSteps({ ...same, maxIterations: 2 });
  checkLoopPlan({ ...same, maxIterations: 2 }, capped);
  assert.equal(capped.steps.length, 2);
  assert.equal(capped.limitedBy, "iterations");
  assert.ok(!capped.reachedTarget && capped.finalLtv < 0.75);

  const bc = planLoopSteps({ ...loopBase, maxTotalBorrowTokens: 3000 });
  checkLoopPlan({ ...loopBase, maxTotalBorrowTokens: 3000 }, bc);
  assert.equal(bc.limitedBy, "borrowCap");
  assert.ok(bc.finalDebtTokens <= 3000 + 1e-6);
});

test("planLoopSteps: already above target / zero target only deposits", () => {
  const p0 = planLoopSteps({ ...loopBase, targetLtv: 0 });
  assert.equal(p0.steps.length, 0);
  const p1 = planLoopSteps({ ...loopBase, debtTokens: 6000, targetLtv: 0.5 });
  assert.equal(p1.steps.length, 0);
  assert.equal(p1.limitedBy, "target");
  assert.throws(() => planLoopSteps({ ...loopBase, targetLtv: 1 }));
});

const unwindBase: UnwindPlanInput = {
  collPrice: 1,
  debtPrice: 1.0002,
  collPriceLow: 0.9995,
  debtPriceHigh: 1.0002,
  collateralTokens: 22_000,
  debtTokens: 12_000,
  openLtv: 0.77,
  borrowWeight: 1.25,
  conversionRate: 0.995,
  goal: { kind: "debt", targetDebtTokens: 0 },
  interestBufferFrac: 0.001,
  maxIterations: 20,
  stepSafety: 0.97,
  collDecimals: 6,
  debtDecimals: 6,
};

function checkUnwind(i: UnwindPlanInput, plan: ReturnType<typeof planUnwindSteps>) {
  let C = i.collateralTokens;
  let D = i.debtTokens;
  for (const s of plan.steps) {
    const w = Number(s.withdraw) / 10 ** i.collDecimals;
    const Cafter = C - w;
    // withdraw happens before the repay: must stay under the open-LTV limit
    const allowed = Cafter * i.collPriceLow * i.openLtv * i.stepSafety;
    const weighted = D * i.debtPriceHigh * i.borrowWeight;
    if (D > 0) assert.ok(weighted <= allowed * (1 + 1e-9), `withdraw breaks health ${weighted} > ${allowed}`);
    assert.equal(s.minDebtOut, BigInt(Math.floor(w * i.conversionRate * 10 ** i.debtDecimals)));
    C = Cafter;
    D = Math.max(0, D - Number(s.minDebtOut) / 10 ** i.debtDecimals);
  }
  return { C, D };
}

test("planUnwindSteps: full close repays all debt (with interest buffer) inside the health limit", () => {
  const plan = planUnwindSteps(unwindBase);
  assert.ok(plan.feasible, plan.reason);
  const { C, D } = checkUnwind(unwindBase, plan);
  assert.equal(D, 0);
  assert.ok(C > 9_000 && C < 10_000, `remaining collateral ${C}`);
  assert.ok(plan.steps.length >= 2);
  const repaid = plan.steps.reduce((s, x) => s + Number(x.minDebtOut), 0) / 1e6;
  assert.ok(repaid >= 12_000 * 1.001 - 1e-5, `buffer on the whole debt covers accrued interest (${repaid})`);
  assert.ok(repaid < 12_000 * 1.001 + 0.01, "no large over-withdrawal");
});

test("planUnwindSteps: deleverage to LTV, fractional debt goal, infeasible cases", () => {
  const lev = { ...unwindBase, goal: { kind: "ltv" as const, targetLtv: 0.3 } };
  const p = planUnwindSteps(lev);
  assert.ok(p.feasible, p.reason);
  checkUnwind(lev, p);
  assert.ok(p.finalLtv <= 0.3 && p.finalLtv > 0.299, `finalLtv ${p.finalLtv}`);
  assert.ok(p.steps.length <= 4, `steps ${p.steps.length}`);

  const half = planUnwindSteps({ ...unwindBase, goal: { kind: "debt", targetDebtTokens: 6000 } });
  assert.ok(half.feasible);
  assert.ok(Math.abs(half.finalDebtTokens - 6000) < 1);

  // above the open-LTV limit: no withdraw headroom, no flash loan => infeasible
  const stuck = planUnwindSteps({ ...unwindBase, debtTokens: 14_000 });
  assert.ok(!stuck.feasible);
  assert.match(stuck.reason!, /headroom/);

  const it = planUnwindSteps({ ...unwindBase, maxIterations: 1 });
  assert.ok(!it.feasible);
  assert.match(it.reason!, /iterations/);

  const rl = planUnwindSteps({ ...unwindBase, maxTotalWithdrawUsd: 5000 });
  assert.ok(!rl.feasible);
  assert.match(rl.reason!, /outflow/);
});

// ---------------------------------------------------------------------------
// pure: reserve math, rate limiter, rewards, eligibility, pair building
// ---------------------------------------------------------------------------

test("rateLimiterRemainingUsd mirrors rate_limiter.move windows", () => {
  const rl = (ws: number, prev: number, cur: number) => ({
    config: { windowDuration: 3600n, maxOutflow: 5_000_000n },
    windowStart: BigInt(ws),
    prevQty: wadOf(prev),
    curQty: wadOf(cur),
  });
  // same window: prev weighted by remaining share of the window
  const r1 = rateLimiterRemainingUsd(rl(NOW_S - 1800, 1_000_000, 500_000), NOW_S);
  assert.ok(Math.abs(r1 - (5_000_000 - (1_000_000 * (3600 - 1801)) / 3600 - 500_000)) < 1e-3);
  // next window: cur becomes prev
  const r2 = rateLimiterRemainingUsd(rl(NOW_S - 3600 - 100, 0, 2_000_000), NOW_S);
  assert.ok(Math.abs(r2 - (5_000_000 - (2_000_000 * (3600 - 101)) / 3600)) < 1e-3);
  // two windows later: empty
  assert.equal(rateLimiterRemainingUsd(rl(NOW_S - 7300, 9e6, 9e6), NOW_S), 5_000_000);
  // exhausted
  assert.equal(rateLimiterRemainingUsd(rl(NOW_S - 10, 0, 6_000_000), NOW_S), 0);
});

test("reserveSnapshot (via SDK simulate): APR from the curve, price bounds, IRM points, caps", () => {
  const s = snap({ raw: USDC_RAW, index: 0, dec: 6, price: 1, smoothed: 0.9995, available: 50_000_000, borrowed: 40_000_000, openLtvPct: 77, closeLtvPct: 80 });
  assert.ok(Math.abs(s.utilization - 40 / 90) < 1e-9);
  const borrowApr = (40 / 90 / 0.8) * 0.1; // linear between (0,0) and (80%, 10%)
  assert.ok(Math.abs(s.borrowApr - borrowApr) < 1e-9);
  assert.ok(Math.abs(s.supplyApr - (40 / 90) * borrowApr * 0.8) < 1e-9);
  assert.equal(s.priceLow, 0.9995);
  assert.equal(s.priceHigh, 1);
  assert.deepEqual(s.irmPoints, [[0, 0], [0.8, 0.1], [1, 0.5]]);
  assert.ok(Math.abs(s.ctokenRatio - 1.02) < 1e-6);
  assert.equal(s.openLtv, 0.77);
  assert.ok(depositCapRemainingUsd(s) > 0);
  // borrow cap is bounded by the rate limiter
  assert.ok(Math.abs(borrowCapRemainingUsd(s, 1_000) - 1_000) < 1e-6);
  // compounding (SDK compoundReserveInterest): an hour of interest at the curve APR raises debt
  const stale = rawReserve({ raw: USDC_RAW, index: 0, dec: 6, price: 1, available: 50_000_000, borrowed: 40_000_000, openLtvPct: 77, closeLtvPct: 80, lastUpdateS: NOW_S - 3600 });
  const [compounded] = compoundReserves([stale], NOW);
  const grown = reserveSnapshot(compounded!).borrowedTokens / 40_000_000 - 1;
  assert.ok(Math.abs(grown - borrowApr / 8765.82) < 2e-7, `hourly growth ${grown}`);
  assert.deepEqual(irmFromConfig([0, 100], [0n], 0), undefined);
});

test("pairLtvLimits folds borrow weight and price bounds into unweighted LTVs", () => {
  const coll = snap({ raw: USDC_RAW, index: 0, dec: 6, price: 1, smoothed: 0.9995, available: 1, borrowed: 0, openLtvPct: 77, closeLtvPct: 80 });
  const debt = snap({ raw: USDSUI_RAW, index: 1, dec: 6, price: 1.0002, smoothed: 1.0, available: 1, borrowed: 0, openLtvPct: 70, closeLtvPct: 75, bwBps: 12_500 });
  const { maxLtv, liqLtv } = pairLtvLimits(coll, debt);
  assert.ok(Math.abs(maxLtv - (0.77 / 1.25) * 0.9995) < 1e-12);
  assert.ok(Math.abs(liqLtv - 0.8 / 1.25) < 1e-12);
});

test("poolRewardApr / sideRewardRates use the SDK formula, skip inactive + unpriced, merge per token", () => {
  const s = snap({
    raw: USDC_RAW,
    index: 0,
    dec: 6,
    price: 1,
    available: 50_000_000,
    borrowed: 40_000_000,
    openLtvPct: 77,
    closeLtvPct: 80,
    depositShares: 80_000_000 / 1.02,
    depositRewards: [
      { raw: SUI_RAW, total: 1_000_000n * 10n ** 9n, start: NOW - 10 * DAY, end: NOW + 20 * DAY },
      { raw: SUI_RAW, total: 500_000n * 10n ** 9n, start: NOW - 10 * DAY, end: NOW + 5 * DAY },
      { raw: SUI_RAW, total: 9n * 10n ** 18n, start: NOW + DAY, end: NOW + 2 * DAY }, // not started
      { raw: PTS_RAW, total: 10n ** 12n, start: NOW - DAY, end: NOW + DAY }, // unpriced
    ],
  });
  const sui = { symbol: "SUI", decimals: 9, priceUsd: 3 };
  const apr = poolRewardApr(s, "deposit", s.depositRewards[0]!, sui, NOW)!;
  const expected = (1_000_000 * 3 * (31_556_952_000 / (30 * DAY))) / (80_000_000 * 1.0);
  assert.ok(Math.abs(apr / expected - 1) < 1e-6, `${apr} vs ${expected}`);
  const { rates, unpriced } = sideRewardRates(s, "deposit", (t) => (t === SUI ? sui : { symbol: "PTS", decimals: 6 }), NOW);
  assert.equal(rates.length, 1);
  assert.equal(rates[0]!.token, "SUI");
  assert.equal(rates[0]!.endsAtMs, NOW + 5 * DAY, "merged reward ends at the earliest end");
  assert.ok(rates[0]!.apr > apr);
  assert.deepEqual(unpriced, [PTS]);
});

test("reward eligibility: same-asset (on-chain) and stable/stable (docs) loops are ineligible", () => {
  assert.match(rewardIneligibility([SUI], [SUI], STABLES)!, /same-asset/);
  assert.match(rewardIneligibility([USDC], [USDSUI], STABLES)!, /stablecoin/);
  assert.equal(rewardIneligibility([USDC], [SUI], STABLES), null);
  assert.equal(rewardIneligibility([SUI], [USDC], STABLES), null);
  // holdings are unioned with the pair
  assert.match(pairRewardIneligibility({ collateral: USDC, debt: SUI }, { deposits: [], borrows: [USDSUI] }, STABLES)!, /stablecoin/);
  // observed: zeroed shares
  const o = {
    deposits: [{ coinType: SUI, reserveArrayIndex: 2n, tokens: 1, usd: 3, ctokens: 10n, rewardShare: 0n }],
    borrows: [{ coinType: USDC, reserveArrayIndex: 0n, tokens: 1, usd: 1, ctokens: 0n, rewardShare: 5n }],
  };
  const e = rewardsEligible(o, STABLES);
  assert.equal(e.reason, null);
  assert.equal(e.eligible, false);
  assert.deepEqual(e.zeroedOnChain, [`deposit:${SUI}`]);
});

test("buildLoopPair: rewards emptied when ineligible unless assumeEligible; same-asset shares one leg", () => {
  const coll = snap({ raw: USDC_RAW, index: 0, dec: 6, price: 1, available: 50, borrowed: 40, openLtvPct: 77, closeLtvPct: 80 });
  const debt = snap({ raw: USDSUI_RAW, index: 1, dec: 6, price: 1, available: 50, borrowed: 40, openLtvPct: 70, closeLtvPct: 75, borrowFeeBps: 30 });
  const r = { token: "SUI", apr: 0.1 };
  const args = {
    pair: { pairId: "USDC/USDsui", collateral: A_USDC, debt: A_USDSUI },
    coll,
    debt,
    rewards: { collSupply: [r], collBorrow: [], debtSupply: [], debtBorrow: [r] },
    ineligibleReason: "stable/stable",
    assumeEligible: false,
    swapCostFrac: 0.001,
    swapDepthUsd: 1e9,
    rateLimiterRemainingUsd: 4e6,
    dataAsOfMs: NOW,
  };
  const p = buildLoopPair(args);
  assert.deepEqual(p.collateral.supplyRewards, []);
  assert.deepEqual(p.debt.borrowRewards, []);
  assert.equal(p.swapDepthUsd, 4e6, "outflow limit caps swap depth");
  assert.equal(p.debt.borrowFeeFrac, 0.003);
  assert.equal(p.protocol, "suilend");
  const kept = buildLoopPair({ ...args, assumeEligible: true });
  assert.equal(kept.collateral.supplyRewards.length, 1);
  const same = buildLoopPair({ ...args, debt: coll, pair: { pairId: "USDC/USDC", collateral: A_USDC, debt: A_USDC } });
  assert.equal(same.collateral, same.debt);
  assert.equal(same.swapDepthUsd, Infinity);
  assert.equal(same.swapCostFrac, 0);
});

test("probeSwap / ctokensFor", async () => {
  const swapper = {
    quote: async (_f: string, _t: string, amountIn: bigint) => {
      const usd = Number(amountIn) / 1e6;
      const costBps = 1 + usd / 50_000; // 1 bps + 1 bps per $50k
      return { amountIn, amountOut: (amountIn * BigInt(Math.round((1 - costBps / 1e4) * 1e6))) / 1_000_000n, costBps, routeData: null };
    },
  };
  const pr = await probeSwap(swapper, A_USDC, A_USDSUI, 1, { probeUsd: 10_000, maxUsd: 2_560_000, budgetBps: 20 });
  assert.ok(Math.abs(pr.costBpsAtProbe - 1.2) < 1e-9);
  assert.equal(pr.depthUsd, 640_000); // 640k -> 13.8 bps ok, 2.56M -> 52 bps > 20
  assert.equal(ctokensFor(1_000_000n, 1.02), BigInt(Math.ceil(1_000_000 / 1.02)) + 1n);
  assert.equal(ctokensFor(1_000_000n, 1.02, 5n), 5n);
});

// ---------------------------------------------------------------------------
// adapter with fakes
// ---------------------------------------------------------------------------

interface Rec {
  calls: string[];
  swaps: { fromType: string; toType: string; minOut: bigint }[];
  claimed?: unknown[];
}

function fakeClient(rec: Rec, obligation: RawObligation | null): SuilendClientLike {
  const res = (tx: Transaction, name: string, args: unknown[] = []) =>
    tx.moveCall({ target: `0x2::fake::${name}`, arguments: args as never });
  return {
    lendingMarket: {
      id: MARKET,
      version: 8n,
      reserves: reservesFixture(),
      rateLimiter: { config: { windowDuration: 3600n, maxOutflow: 5_000_000n }, windowStart: BigInt(NOW_S - 1800), prevQty: wadOf(1_000_000), curQty: wadOf(500_000) },
      $typeArgs: [MARKET_TYPE],
    },
    pythConnection: undefined,
    findReserveArrayIndex: (t) => BigInt([USDC, USDSUI, SUI].indexOf(normalizeStructTag(t))),
    createObligation: (tx) => {
      rec.calls.push("createObligation");
      return res(tx, "create_obligation");
    },
    refreshAll: async (_tx, o, types) => {
      rec.calls.push(`refreshAll(${o ? "obl" : "none"};${(types ?? []).length})`);
    },
    deposit: (_coin, t) => rec.calls.push(`deposit(${short(t)})`),
    depositIntoObligation: async (_o, t, v) => {
      rec.calls.push(`depositIntoObligation(${short(t)},${v})`);
    },
    borrow: async (_c, _id, t, v, tx, refresh) => {
      rec.calls.push(`borrow(${short(t)},${v},${refresh})`);
      return res(tx, "borrow");
    },
    withdraw: async (_c, _id, t, v, tx, refresh) => {
      rec.calls.push(`withdraw(${short(t)},${v === "18446744073709551615" ? "MAX" : v},${refresh})`);
      return res(tx, "withdraw");
    },
    repay: (_id, t) => rec.calls.push(`repay(${short(t)})`),
    claimRewardsAndSendToUser: (_o, cap, rewards) => {
      rec.calls.push(`claim(${String(cap).slice(0, 6)},${rewards.length})`);
      rec.claimed = rewards;
    },
    getObligation: async () => {
      if (!obligation) throw new Error("no obligation");
      return obligation;
    },
  };
}

const short = (t: string) => t.split("::").pop()!;

function fakeSwapper(rec: Rec): PtbSwapper {
  return {
    quote: async (from, to, amountIn) => {
      const rate = from === USDSUI && to === USDC ? 0.999 : 0.9988;
      return { amountIn, amountOut: BigInt(Math.floor(Number(amountIn) * rate)), costBps: 10, routeData: { from, to } };
    },
    appendSwap: async (tx, a) => {
      rec.swaps.push({ fromType: a.fromType, toType: a.toType, minOut: a.minOut });
      rec.calls.push(`swap(${short(a.fromType)}->${short(a.toType)})`);
      return tx.moveCall({ target: "0x2::fake::swap", arguments: [a.coinIn] })[0]!;
    },
  };
}

function fakeEnv(simOk = true): SuiEnv {
  return {
    network: "mainnet",
    address: ADDR,
    lock: new Mutex(),
    jsonRpc: {} as never,
    grpc: {
      core: {
        simulateTransaction: async () =>
          simOk
            ? { $kind: "Transaction", Transaction: { effects: { gasUsed: { computationCost: "2000000", storageCost: "1000000", storageRebate: "500000" } } } }
            : { $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: "MoveAbort" } } },
        getBalance: async () => ({ balance: { balance: "1000000000000" } }),
      },
    } as never,
  };
}

function makeAdapter(opts: { obligation?: RawObligation | null; assume?: boolean; pairs?: "stable" | "sui"; meta?: Record<string, { decimals: number; symbol: string }> } = {}) {
  const rec: Rec = { calls: [], swaps: [] };
  const obligation = opts.obligation === undefined ? obligationFixture() : opts.obligation;
  const pairs =
    opts.pairs === "sui"
      ? [{ pairId: "USDC/SUI", collateral: A_USDC, debt: A_SUI }]
      : [{ pairId: "USDC/USDsui", collateral: A_USDC, debt: A_USDSUI }];
  const adapter = new SuilendAdapter({
    env: fakeEnv(),
    lendingMarket: MARKET,
    lendingMarketType: MARKET_TYPE,
    pairs,
    swapper: fakeSwapper(rec),
    assumeRewardsEligible: opts.assume,
    stablecoinCoinTypes: [...STABLES],
    rewardPriceUsd: async (t) => (t === PTS ? 0.5 : undefined),
    deps: {
      loadClient: async () => fakeClient(rec, obligation),
      resolveMarketType: async () => MARKET_TYPE,
      listObligationCaps: async () => (obligation ? [{ id: CAP, obligationId: OBL }] : []),
      coinMetadata: async (_e, t) => (opts.meta ?? { [USDC]: { decimals: 6, symbol: "USDC" }, [USDSUI]: { decimals: 6, symbol: "USDSUI" }, [SUI]: { decimals: 9, symbol: "SUI" }, [PTS]: { decimals: 6, symbol: "PTS" } })[t] ?? null,
      reserveConfidence: async () => undefined,
      nowMs: () => NOW,
    },
  });
  return { adapter, rec };
}

function ctx(logs: string[] = []): LiveContext {
  return {
    dryRun: true,
    log: (l, m) => logs.push(`${l}: ${m}`),
    limits: { maxGasUsd: { sui: 5 }, maxSlippageBps: 30, maxLoopIterations: 12 },
    priceUsd: async (a) => (a.symbol === "SUI" ? 3 : 1),
    nativePriceUsd: async () => 3,
  };
}

test("adapter.markets: stable pair => rewards dropped by default, kept with assumeRewardsEligible", async () => {
  const { adapter } = makeAdapter();
  const [p] = await adapter.markets();
  assert.ok(p);
  assert.equal(p.pairId, "USDC/USDsui");
  assert.deepEqual(p.collateral.supplyRewards, []);
  assert.deepEqual(p.debt.borrowRewards, []);
  assert.ok(Math.abs(p.maxLtv - (0.77 / 1.25) * 0.9995) < 1e-9);
  assert.ok(Math.abs(p.liqLtv - 0.64) < 1e-12);
  assert.equal(p.swapCostFrac, 0.001);
  assert.ok(p.swapDepthUsd > 0 && p.swapDepthUsd <= 5_000_000);
  assert.equal(p.debt.borrowFeeFrac, 0.003);
  assert.equal(p.dataAsOfMs, NOW);
  assert.ok(p.collateral.irm && p.collateral.irm.points.length === 3);
  assert.ok(p.myLtv !== undefined && p.myLtv > 0.4 && p.myLtv < 0.42, `myLtv ${p.myLtv}`);
  const [d] = await adapter.marketDiagnostics();
  assert.match(d!.rewardsIneligibleReason!, /stablecoin/);
  assert.ok(Math.abs(d!.rateLimiterRemainingUsd - (5_000_000 - (1_000_000 * 1799) / 3600 - 500_000)) < 1e-3);

  const { adapter: a2 } = makeAdapter({ assume: true });
  const [k] = await a2.markets();
  assert.equal(k!.collateral.supplyRewards[0]!.token, "SUI");
  assert.ok(k!.collateral.supplyRewards[0]!.apr > 0.4 && k!.collateral.supplyRewards[0]!.apr < 0.5);
  assert.equal(k!.collateral.supplyRewards[0]!.endsAtMs, NOW + 20 * DAY);
  assert.equal(k!.debt.borrowRewards[0]!.token, "PTS");
});

test("adapter.markets: USDC collateral / SUI debt keeps rewards (no obligation)", async () => {
  const { adapter } = makeAdapter({ pairs: "sui", obligation: null });
  const [p] = await adapter.markets();
  assert.equal(p!.collateral.supplyRewards.length, 1);
  assert.equal(p!.myLtv, undefined);
});

test("adapter.position: amounts, Suilend-weighted LTV, health, eligibility, unclaimed rewards", async () => {
  const { adapter } = makeAdapter();
  const v = await adapter.position("USDC/USDsui");
  assert.ok(v);
  assert.ok(Math.abs(v.collateralUsd - 100_000) < 1);
  assert.ok(Math.abs(v.debtUsd - 40_000 * 1.01 * 1.0002) < 1, `debt ${v.debtUsd}`);
  assert.ok(Math.abs(v.weightedLtv - (v.debtUsd * 1.25) / v.collateralUsd) < 1e-9);
  assert.ok(Math.abs(v.ltv - v.debtUsd / v.collateralUsd) < 1e-9);
  assert.ok(Math.abs(v.healthFactor! - (100_000 * 0.8) / (v.debtUsd * 1.25)) < 1e-6);
  assert.equal(v.rewardsEligible, false);
  assert.match(v.rewardsIneligibleReason!, /stablecoin/);
  const sui = v.rewardsUnclaimed.find((r) => r.token === "SUI")!;
  // SDK computeObligationRefresh round-trips earned rewards through a JS number: allow 1 base unit
  assert.ok(sui.amount <= 5n * 10n ** 9n && sui.amount >= 5n * 10n ** 9n - 1n, `${sui.amount}`);
  assert.ok(Math.abs(sui.usd - 15) < 1e-6);
  assert.ok(v.rewardsUnclaimed.find((r) => r.token === "PTS")!.amount >= 100n * 10n ** 6n - 1n);

  const { adapter: z } = makeAdapter({ obligation: obligationFixture({ zeroShares: true }), pairs: "sui" });
  assert.equal(await z.position("USDC/SUI").then((x) => x?.debtUsd), 0);
  const { adapter: z2 } = makeAdapter({ obligation: obligationFixture({ zeroShares: true }) });
  const zv = await z2.position("USDC/USDsui");
  assert.equal(zv!.rewardsZeroedOnChain.length, 2);
  const { adapter: none } = makeAdapter({ obligation: null });
  assert.equal(await none.position("USDC/USDsui"), null);
});

test("adapter.open (dry-run, new obligation): one PTB, refresh before borrows, borrow->swap->deposit loop", async () => {
  const { adapter, rec } = makeAdapter({ obligation: null });
  const logs: string[] = [];
  const r = await adapter.open("USDC/USDsui", 10_000_000_000n, 0.55, ctx(logs));
  assert.ok(r.ok, r.detail);
  assert.equal(r.txs.length, 1);
  assert.equal(r.txs[0]!.simulated, true);
  assert.equal(r.txs[0]!.id, undefined);
  assert.equal(r.amountUsd, 10_000);
  const c = rec.calls;
  assert.equal(c[0], "createObligation");
  assert.equal(c[1], "refreshAll(none;2)");
  assert.equal(c[2], "depositIntoObligation(USDC,10000000000)");
  const borrows = c.filter((x) => x.startsWith("borrow("));
  assert.ok(borrows.length > 1 && borrows.length <= 12);
  assert.ok(borrows.every((b) => b.endsWith(",false)")), "refresh is done once, not per borrow");
  // pattern borrow, swap, deposit repeated
  for (let i = 3; i < c.length; i += 3) {
    assert.match(c[i]!, /^borrow\(USDSUI/);
    assert.equal(c[i + 1], "swap(USDSUI->USDC)");
    assert.equal(c[i + 2], "deposit(USDC)");
  }
  assert.ok(logs.some((l) => l.startsWith("warn") && /NO liquidity-mining rewards/.test(l)));
  assert.match(r.detail!, /planned LTV 0\.5[45]/);
});

test("adapter.open refuses targetLtv above the pair maxLtv and on simulation failure", async () => {
  const { adapter } = makeAdapter({ obligation: null });
  const r = await adapter.open("USDC/USDsui", 1_000_000n, 0.7, ctx());
  assert.equal(r.ok, false);
  assert.match(r.detail!, /maxLtv/);
  const bad = makeAdapter({ obligation: null });
  (bad.adapter as unknown as { env: SuiEnv }).env = fakeEnv(false);
  const r2 = await bad.adapter.open("USDC/USDsui", 1_000_000_000n, 0.3, ctx());
  assert.equal(r2.ok, false);
  assert.match(r2.detail!, /simulation failed/);
});

test("adapter.close(1): withdraw->swap->repay steps then withdraw U64_MAX; deleverage stops early", async () => {
  const { adapter, rec } = makeAdapter();
  const r = await adapter.close("USDC/USDsui", 1, ctx());
  assert.ok(r.ok, r.detail);
  const c = rec.calls;
  assert.equal(c[0], "refreshAll(obl;2)");
  assert.equal(c.at(-1), "withdraw(USDC,MAX,false)");
  const steps = c.slice(1, -1);
  assert.equal(steps.length % 3, 0);
  for (let i = 0; i < steps.length; i += 3) {
    assert.match(steps[i]!, /^withdraw\(USDC,\d+,false\)$/);
    assert.equal(steps[i + 1], "swap(USDC->USDSUI)");
    assert.equal(steps[i + 2], "repay(USDSUI)");
  }
  const repaidMin = rec.swaps.reduce((s, x) => s + Number(x.minOut), 0) / 1e6;
  assert.ok(repaidMin >= 40_000 * 1.01 * 1.001 - 1, `min repay ${repaidMin} covers debt + buffer`);

  const d = makeAdapter();
  const r2 = await d.adapter.deleverage("USDC/USDsui", 0.2, ctx());
  assert.ok(r2.ok, r2.detail);
  assert.ok(!d.rec.calls.some((x) => x.includes("MAX")));
  assert.ok(d.rec.calls.some((x) => x.startsWith("repay(")));
  const noop = await makeAdapter().adapter.deleverage("USDC/USDsui", 0.6, ctx());
  assert.ok(noop.ok && noop.txs.length === 0);

  assert.equal(await makeAdapter().adapter.simulateClose("USDC/USDsui", ctx()), true);
  const partial = makeAdapter();
  const r3 = await partial.adapter.close("USDC/USDsui", 0.5, ctx());
  assert.ok(r3.ok, r3.detail);
  assert.ok(!partial.rec.calls.some((x) => x.includes("MAX")));
});

test("adapter.claimRewards claims every claimable pool reward of the obligation", async () => {
  const { adapter, rec } = makeAdapter();
  const r = await adapter.claimRewards(ctx(), "USDC/USDsui");
  assert.ok(r.ok, r.detail);
  assert.equal(r.txs.length, 1);
  assert.equal((rec.claimed as unknown[]).length, 2);
  const byToken = new Map(r.claimed.map((x) => [x.token, x.amount]));
  assert.equal(byToken.size, 2);
  assert.ok(byToken.get("PTS")! >= 100n * 10n ** 6n - 1n && byToken.get("PTS")! <= 100n * 10n ** 6n);
  assert.ok(byToken.get("SUI")! >= 5n * 10n ** 9n - 1n && byToken.get("SUI")! <= 5n * 10n ** 9n);
  const none = await makeAdapter({ obligation: null }).adapter.claimRewards(ctx());
  assert.ok(none.ok && none.claimed.length === 0 && none.txs.length === 0);
});

test("adapter.verifyConfig reports decimals mismatch, missing metadata and missing price source", async () => {
  const ok = await makeAdapter().adapter.verifyConfig();
  assert.deepEqual(ok.filter((p) => !p.startsWith("WARN")), []);
  assert.ok(ok.some((p) => p.startsWith("WARN: no priceUpdateSource")));
  const bad = await makeAdapter({ meta: { [USDC]: { decimals: 8, symbol: "USDC" } } }).adapter.verifyConfig();
  assert.ok(bad.some((p) => /USDC: decimals 6 in config, 8 on-chain/.test(p)));
  assert.ok(bad.some((p) => /USDsui: coin type .* has no CoinMetadata/.test(p)));
});

test("adapter constructor validates pairs", () => {
  assert.throws(
    () =>
      new SuilendAdapter({
        env: fakeEnv(),
        pairs: [
          { pairId: "x", collateral: A_USDC, debt: A_USDC },
          { pairId: "x", collateral: A_USDC, debt: A_USDC },
        ],
      }),
    /duplicate/
  );
  assert.throws(() => new SuilendAdapter({ env: fakeEnv(), pairs: [{ pairId: "y", collateral: { ...A_USDC, chain: "base" }, debt: A_USDC }] }), /not sui/);
});
