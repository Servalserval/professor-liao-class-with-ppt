/**
 * Offline tests for the Navi adapter: pure math + adapter flows against a
 * mocked @naviprotocol/lending surface and a mocked Sui gRPC core client.
 * No network: every SDK function the adapter uses is replaced.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { interpIrm } from "@incentive-router/core";
import { BroadcastUnconfirmedError, type AssetRef, type LiveContext } from "@incentive-router/live-common";
import { Mutex, Transaction, normalizeStructTag, normalizeSuiAddress, type PtbSwapper, type SuiEnv } from "../src/common.js";
import {
  NaviAdapter,
  apyToApr,
  buildIrmModel,
  capsRemaining,
  chooseEmode,
  debtWithBuffer,
  decimalStringToUnits,
  flashRepayAmount,
  healthFactor,
  ltvOf,
  naviBorrowRateAt,
  naviNormalToBase,
  planLoopSteps,
  planUnwindSteps,
  poolAmounts,
  priceRatioOf,
  rayToFrac,
  solveDeleverage,
  solveFlashOpen,
  splitRewardApr,
  swapDepthFromProbes,
  type NaviSdk,
} from "../src/navi/index.js";

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

// Values from the @naviprotocol/lending docs getPool example (SUI pool, main market).
const SUI_DOC = {
  currentBorrowRate: "80174690906201458142810077",
  currentSupplyRate: "34282565663493028210648694",
  totalSupplyAmount: "39071087342301702",
  borrowedAmount: "20883415846590559",
  validBorrowAmount: "31256869873841361.6",
  supplyCapCeiling: "5.5e+34",
  borrowCapCeiling: "800000000000000000000000000",
  factors: {
    baseRate: "0",
    multiplier: "150000000000000000000000000",
    jumpRateMultiplier: "3000000000000000000000000000",
    optimalUtilization: "700000000000000000000000000",
    reserveFactor: "200000000000000000000000000",
  },
};

describe("navi math: units and rates", () => {
  test("rayToFrac / pct / apy", () => {
    close(rayToFrac(SUI_DOC.currentBorrowRate), 0.0801747, 1e-6);
    close(rayToFrac("5.5e+34"), 5.5e7, 1e-3);
    close(apyToApr(0.05), 365 * (Math.pow(1.05, 1 / 365) - 1), 1e-12);
    assert.ok(apyToApr(0.05) < 0.05);
    assert.equal(apyToApr(0), 0);
  });

  test("decimalStringToUnits handles plain, fractional and exponent strings (floor)", () => {
    assert.equal(decimalStringToUnits("1.5", 6), 1_500_000n);
    assert.equal(decimalStringToUnits("1e-9", 9), 1n);
    assert.equal(decimalStringToUnits("1.2e+3", 2), 120_000n);
    assert.equal(decimalStringToUnits("0.0000001", 6), 0n);
    assert.equal(decimalStringToUnits("31256869873841361.6", 0), 31256869873841361n);
    assert.throws(() => decimalStringToUnits("-1", 6));
  });

  test("naviNormalToBase converts Navi 9-decimal balances to token units", () => {
    assert.equal(naviNormalToBase("1000000000", 6), 1_000_000n);
    assert.equal(naviNormalToBase("1000000000", 8), 100_000_000n);
    assert.equal(naviNormalToBase("1000000000", 9), 1_000_000_000n);
    assert.equal(naviNormalToBase("1000000000", 12), 1_000_000_000_000n);
    assert.equal(naviNormalToBase("1999", 6), 1n);
  });

  test("buildIrmModel reproduces Navi's on-chain rates (docs SUI pool)", () => {
    const irm = buildIrmModel(SUI_DOC.factors)!;
    assert.deepEqual(
      irm.points.map(([u, r]) => [Number(u.toFixed(6)), Number(r.toFixed(6))]),
      [
        [0, 0],
        [0.7, 0.105],
        [1, 0.105 + 0.3 * 3],
      ]
    );
    close(irm.reserveFactor, 0.2);
    const u = Number(SUI_DOC.borrowedAmount) / Number(SUI_DOC.totalSupplyAmount);
    close(interpIrm(irm, u), rayToFrac(SUI_DOC.currentBorrowRate), 2e-4);
    close(naviBorrowRateAt(SUI_DOC.factors, u), rayToFrac(SUI_DOC.currentBorrowRate), 2e-4);
    // supply = borrow * u * (1 - rf)
    close(interpIrm(irm, u) * u * (1 - irm.reserveFactor), rayToFrac(SUI_DOC.currentSupplyRate), 2e-4);
    close(interpIrm(irm, 0.9), naviBorrowRateAt(SUI_DOC.factors, 0.9), 1e-12);
    assert.equal(buildIrmModel(undefined), undefined);
  });

  test("poolAmounts / capsRemaining match the SDK-derived numbers", () => {
    const a = poolAmounts(SUI_DOC);
    close(a.supply, 39071087.342301702, 1e-6);
    close(a.supplyCap, 55_000_000, 1e-3);
    const caps = capsRemaining(SUI_DOC);
    close(caps.supply!, 15928912.657698298, 1e-3); // docs leftSupply "15928912.657698296"
    close(caps.borrow!, (31256869873841361.6 - 20883415846590559) / 1e9, 1e-3);
  });

  test("chooseEmode", () => {
    const emodes = [
      { emodeId: 1, marketId: 0, isActive: true, assets: [{ assetId: 10, ltv: 0.85, lt: 0.9, isCollateral: true, isDebt: true }, { assetId: 11, ltv: 0.85, lt: 0.9, isCollateral: true, isDebt: true }] },
      { emodeId: 2, marketId: 0, isActive: true, assets: [{ assetId: 10, ltv: 0.93, lt: 0.95, isCollateral: true, isDebt: true }, { assetId: 11, ltv: 0, lt: 0, isCollateral: false, isDebt: true }] },
      { emodeId: 3, marketId: 0, isActive: false, assets: [{ assetId: 10, ltv: 0.97, lt: 0.98, isCollateral: true, isDebt: true }, { assetId: 11, ltv: 0.97, lt: 0.98, isCollateral: true, isDebt: true }] },
    ];
    assert.equal(chooseEmode(emodes, 10, 11, "auto", 0.8)?.emodeId, 2);
    assert.equal(chooseEmode(emodes, 11, 10, "auto", 0.8)?.emodeId, 1); // 11 is not collateral in e-mode 2
    assert.equal(chooseEmode(emodes, 10, 11, "auto", 0.95), null); // pool LTV better
    assert.equal(chooseEmode(emodes, 10, 11, "off", 0.5), null);
    assert.equal(chooseEmode(emodes, 10, 11, 1, 0.99)?.emodeId, 1);
    assert.equal(chooseEmode(emodes, 10, 11, 3, 0.5), null); // inactive
  });

  test("rewards split, health factor, buffers, depth", () => {
    assert.deepEqual(splitRewardApr(0.04, ["vSUI", "NAVX"]), [
      { token: "vSUI", apr: 0.02, endsAtMs: null },
      { token: "NAVX", apr: 0.02, endsAtMs: null },
    ]);
    assert.deepEqual(splitRewardApr(0, ["x"]), []);
    assert.equal(splitRewardApr(0.01, [])[0]!.token, "navi:reward");
    close(healthFactor([{ collateralUsd: 1000, liqThreshold: 0.93, debtUsd: 800 }]), 1.1625);
    assert.equal(healthFactor([{ collateralUsd: 1, liqThreshold: 0.9, debtUsd: 0 }]), Infinity);
    const d = 1_000_000_000n;
    assert.ok(debtWithBuffer(d, 0.05, 60) >= d + d / 5000n); // >= 2 bp
    assert.equal(debtWithBuffer(0n, 0.05, 60), 0n);
    assert.equal(flashRepayAmount(1_000_000n, 0.0006), 1_000_600n);
    assert.equal(flashRepayAmount(999n, 0.0006), 1000n); // ceil
    assert.equal(swapDepthFromProbes([{ usd: 1e4, costBps: 1 }, { usd: 1e5, costBps: 5 }, { usd: 1e6, costBps: 50 }], 30), 1e5);
    assert.equal(swapDepthFromProbes([{ usd: 1e4, costBps: 40 }], 30), 0);
    close(priceRatioOf(3.6, 9, 1, 6), 0.0036, 1e-12);
  });
});

describe("navi math: loop planning", () => {
  test("solveFlashOpen same-asset hits the target LTV including fees", () => {
    const p = solveFlashOpen({ equity: 1_000_000_000n, targetLtv: 0.8, flashFeeFrac: 0.0006, borrowFeeFrac: 0.003, swapCostFrac: 0, priceRatio: 1 });
    close(p.expectedLtv, 0.8, 1e-6);
    assert.ok(p.flash > 3_000_000_000n && p.flash < 4_000_000_000n); // ~ (L-1)E with L=5, minus fees
    assert.equal(p.borrow, p.flashRepay); // same asset: borrow exactly the flash repayment
    assert.equal(p.flashRepay, flashRepayAmount(p.flash, 0.0006));
    assert.equal(p.collateralAfter, 1_000_000_000n + p.flash);
  });

  test("solveFlashOpen with an existing position and with a swap", () => {
    const ex = solveFlashOpen({
      equity: 100n * 10n ** 6n,
      targetLtv: 0.8,
      flashFeeFrac: 0,
      borrowFeeFrac: 0,
      swapCostFrac: 0,
      priceRatio: 1,
      existingCollateral: 1000n * 10n ** 6n,
      existingDebt: 700n * 10n ** 6n,
    });
    close(ex.expectedLtv, 0.8, 1e-6);
    const above = solveFlashOpen({ equity: 10n, targetLtv: 0.5, flashFeeFrac: 0, borrowFeeFrac: 0, swapCostFrac: 0, priceRatio: 1, existingCollateral: 100n, existingDebt: 80n });
    assert.equal(above.flash, 0n);
    // USDC collateral, USDT debt, 0.2% swap cost (incl. slippage)
    const sw = solveFlashOpen({ equity: 10_000_000_000n, targetLtv: 0.85, flashFeeFrac: 0, borrowFeeFrac: 0.003, swapCostFrac: 0.002, priceRatio: 1 });
    close(sw.expectedLtv, 0.85, 1e-6);
    assert.ok((sw.borrow * 998n) / 1000n >= sw.flashRepay - 1n, "borrowed debt after swap cost covers the flash repayment");
  });

  test("planLoopSteps converges to target and never exceeds maxLtv per step", () => {
    const E = 1_000_000_000n;
    const plan = planLoopSteps(E, 0.8, 0.9, 1, 30, { borrowFeeFrac: 0.003 });
    assert.ok(plan.targetReached);
    close(plan.achievedLtv, 0.8, 2e-3);
    let C = E;
    let D = 0n;
    for (const s of plan.steps) {
      D += s.borrow + (s.borrow * 3n) / 1000n;
      assert.ok(Number(D) / Number(C) <= 0.9 * 0.99 + 1e-9, "borrow stays under maxLtv*safety on current collateral");
      C += s.expectedDeposit;
    }
    const short = planLoopSteps(E, 0.8, 0.9, 1, 2);
    assert.equal(short.steps.length, 2);
    assert.ok(!short.targetReached && short.achievedLtv < 0.8);
    // SUI (9 dec, $3.6) collateral, USDC (6 dec, $1) debt, 0.3% swap
    const pr = priceRatioOf(3.6, 9, 1, 6);
    const sp = planLoopSteps(100n * 10n ** 9n, 0.6, 0.75, pr, 20, { swapCostFrac: 0.003 });
    assert.ok(sp.targetReached);
    close(ltvOf(sp.collateralAfter, sp.debtAfter, pr), 0.6, 2e-3);
    assert.ok(sp.steps[0]!.borrow > 0n && sp.steps[0]!.borrow < 360n * 10n ** 6n);
  });

  test("planUnwindSteps: full close reaches zero debt; respects HF after each withdraw", () => {
    const C = 1000n * 10n ** 6n;
    const D = 700n * 10n ** 6n;
    const target = debtWithBuffer(D, 0.05, 60);
    const p = planUnwindSteps({ collateral: C, debt: D, repayTarget: target, liqLtv: 0.85, priceRatio: 1, maxIterations: 50 });
    assert.ok(p.reached);
    assert.ok(p.repaid >= target);
    let c = C;
    let d = D;
    for (const s of p.steps) {
      c -= s.withdraw;
      assert.ok(d === 0n || (Number(c) * 0.85) / Number(d) >= 1 / 0.97 - 1e-9, "HF >= 1/safety after withdraw");
      d = d > s.minRepay ? d - s.minRepay : 0n;
    }
    const few = planUnwindSteps({ collateral: C, debt: D, repayTarget: target, liqLtv: 0.85, priceRatio: 1, maxIterations: 2 });
    assert.ok(!few.reached);
  });

  test("solveDeleverage reaches the target LTV", () => {
    const C = 1000n * 10n ** 6n;
    const D = 850n * 10n ** 6n;
    const s = solveDeleverage({ collateral: C, debt: D, targetLtv: 0.7, priceRatio: 1, swapCostFrac: 0, flashFeeFrac: 0.0006 })!;
    close(Number(D - s.repay) / Number(C - s.withdraw), 0.7, 1e-6);
    assert.ok(s.withdraw >= flashRepayAmount(s.repay, 0.0006) - 1n);
    assert.deepEqual(solveDeleverage({ collateral: C, debt: D, targetLtv: 0.9, priceRatio: 1, swapCostFrac: 0, flashFeeFrac: 0 }), { repay: 0n, withdraw: 0n });
    const sw = solveDeleverage({ collateral: C, debt: D, targetLtv: 0.7, priceRatio: 1, swapCostFrac: 0.003, flashFeeFrac: 0 })!;
    close(Number(D - sw.repay) / Number(C - sw.withdraw), 0.7, 1e-6);
  });
});

// ---------------------------------------------------------------------------
// Adapter against mocks
// ---------------------------------------------------------------------------

const ADDR = normalizeSuiAddress("0x" + "ab".repeat(32));
const CAP_ID = normalizeSuiAddress("0x" + "cd".repeat(32));
const USDC_T = normalizeStructTag(`0x${"a".repeat(64)}::usdc::USDC`);
const USDT_T = normalizeStructTag(`0x${"b".repeat(64)}::usdt::USDT`);
const NAVX_T = normalizeStructTag(`0x${"c".repeat(64)}::navx::NAVX`);
const USDC: AssetRef = { chain: "sui", symbol: "USDC", address: USDC_T, decimals: 6 };
const USDT: AssetRef = { chain: "sui", symbol: "USDT", address: USDT_T, decimals: 6 };

const EMODE_STABLE = {
  emodeId: 2,
  marketId: 0,
  isActive: true,
  uniqueId: "main-2",
  assets: [
    { assetId: 10, ltv: 0.9, lt: 0.93, bonus: 0.01, isCollateral: true, isDebt: true },
    { assetId: 19, ltv: 0.9, lt: 0.93, bonus: 0.01, isCollateral: true, isDebt: true },
  ],
};

function mkPool(o: { id: number; symbol: string; type: string; decimals: number; price: number; supply: number; borrow: number; ltv?: number; lt?: number; emodes?: unknown[]; boosted?: string; rewardCoin?: string[] }) {
  const ray = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 18n;
  const u = o.borrow / o.supply;
  const borrowRate = 0.02 + u * 0.05;
  return {
    id: o.id,
    uniqueId: `main-${o.id}`,
    market: "main",
    coinType: o.type.slice(2),
    suiCoinType: o.type,
    token: { coinType: o.type, decimals: o.decimals, symbol: o.symbol, logoUri: "", price: o.price },
    oracle: { decimal: 8, value: "0", price: String(o.price), oracleId: o.id, valid: true },
    ltv: ray(o.ltv ?? 0.8).toString(),
    ltvValue: o.ltv ?? 0.8,
    liquidationFactor: { bonus: "0.05", ratio: "0.35", threshold: String(o.lt ?? 0.85) },
    currentBorrowRate: ray(borrowRate).toString(),
    currentSupplyRate: ray(borrowRate * u * 0.9).toString(),
    borrowRateFactors: {
      fields: {
        baseRate: ray(0.02).toString(),
        multiplier: ray(0.05).toString(),
        jumpRateMultiplier: ray(1).toString(),
        optimalUtilization: ray(0.8).toString(),
        reserveFactor: ray(0.1).toString(),
      },
    },
    supplyIncentiveApyInfo: { vaultApr: "0", boostedApr: o.boosted ?? "0", rewardCoin: o.rewardCoin ?? [], apy: "0", voloApy: "0", stakingYieldApy: "0", treasuryApy: "0", underlyingApy: "0" },
    borrowIncentiveApyInfo: { vaultApr: "0", boostedApr: "0", rewardCoin: [], apy: "0", voloApy: "0", stakingYieldApy: "0", treasuryApy: "0", underlyingApy: "0" },
    totalSupplyAmount: String(o.supply * 1e9),
    borrowedAmount: String(o.borrow * 1e9),
    validBorrowAmount: String(o.supply * 0.9 * 1e9),
    supplyCapCeiling: (BigInt(o.supply * 3) * 10n ** 27n).toString(),
    borrowCapCeiling: ray(0.9).toString(),
    poolSupplyAmount: String(o.supply),
    poolBorrowAmount: String(o.borrow),
    poolSupplyCapAmount: String(o.supply * 3),
    poolBorrowCapAmount: String(o.supply * 0.9),
    lastUpdateTimestamp: String(Date.now() - 60_000),
    contract: { reserveId: "0x1", pool: normalizeSuiAddress("0x" + o.id.toString(16).padStart(64, "e")) },
    emodes: o.emodes ?? [],
    status: "active",
    isDeprecated: false,
  };
}

const POOLS = [
  mkPool({ id: 10, symbol: "USDC", type: USDC_T, decimals: 6, price: 1, supply: 50_000_000, borrow: 30_000_000, ltv: 0.8, lt: 0.85, emodes: [EMODE_STABLE], boosted: "4", rewardCoin: [NAVX_T] }),
  mkPool({ id: 19, symbol: "USDT", type: USDT_T, decimals: 6, price: 1, supply: 20_000_000, borrow: 12_000_000, ltv: 0.8, lt: 0.85, emodes: [EMODE_STABLE] }),
  mkPool({ id: 7, symbol: "NAVX", type: NAVX_T, decimals: 9, price: 0.05, supply: 1_000_000, borrow: 0 }),
];

interface Call {
  fn: string;
  args: unknown[];
}

function mkHarness(
  opts: { caps?: { marketId: number; emodeId: number; accountCap: string }[]; state?: Record<string, { coll: number; debt: number }>; flashCoins?: string[]; pools?: typeof POOLS } = {}
) {
  const pools = opts.pools ?? POOLS;
  const calls: Call[] = [];
  const rec = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const fake = (tx: Transaction, name: string) => tx.moveCall({ target: `0x1::mock::${name}` });
  const state = opts.state ?? {};
  const sdk: Partial<NaviSdk> = {
    getPools: (async () => pools) as unknown as NaviSdk["getPools"],
    getConfig: (async () => ({ storage: normalizeSuiAddress("0x5707") })) as unknown as NaviSdk["getConfig"],
    getAllFlashLoanAssets: (async () =>
      (opts.flashCoins ?? [USDC_T, USDT_T]).map((t, i) => ({ coinType: t.slice(2), flashloanFee: 0.0006, supplierFee: 0.8, assetId: i, poolId: "0x1", max: "100000000000000", min: "0" }))) as unknown as NaviSdk["getAllFlashLoanAssets"],
    getPriceFeeds: (async () => []) as unknown as NaviSdk["getPriceFeeds"],
    getBorrowFee: (async () => 0.3) as unknown as NaviSdk["getBorrowFee"], // percent
    getUserEModeCaps: (async () => opts.caps ?? []) as unknown as NaviSdk["getUserEModeCaps"],
    getLendingState: (async (addr: string) => {
      const s = state[normalizeSuiAddress(addr)];
      if (!s) return [];
      return [
        { assetId: 10, supplyBalance: String(Math.round(s.coll * 1e9)), borrowBalance: "0", market: "main", pool: pools[0] },
        { assetId: 19, supplyBalance: "0", borrowBalance: String(Math.round(s.debt * 1e9)), market: "main", pool: pools[1] },
      ];
    }) as unknown as NaviSdk["getLendingState"],
    getLendingPositions: (async () => []) as unknown as NaviSdk["getLendingPositions"],
    getUserAvailableLendingRewards: (async () => [
      { assetId: 10, assetCoinType: USDC_T, rewardCoinType: NAVX_T, option: 1, userClaimableReward: 12.5, ruleIds: ["0x1"], market: "main", owner: ADDR, address: CAP_ID },
      { assetId: 10, assetCoinType: USDC_T, rewardCoinType: NAVX_T, option: 1, userClaimableReward: 1, ruleIds: ["0x2"], market: "main", owner: ADDR, address: ADDR },
    ]) as unknown as NaviSdk["getUserAvailableLendingRewards"],
    filterPriceFeeds: ((feeds: unknown[]) => feeds) as unknown as NaviSdk["filterPriceFeeds"],
    updateOraclePricesPTB: (async (tx: Transaction) => {
      rec("updateOraclePricesPTB");
      return tx;
    }) as unknown as NaviSdk["updateOraclePricesPTB"],
    depositCoinPTB: (async (tx: Transaction, pool: { id: number }, _c: unknown, o: { accountCap?: unknown }) => {
      rec("deposit", pool.id, o?.accountCap);
      return tx;
    }) as unknown as NaviSdk["depositCoinPTB"],
    withdrawCoinPTB: (async (tx: Transaction, pool: { id: number }, amount: { Input: number }, o: { accountCap?: unknown }) => {
      rec("withdraw", pool.id, tx.getData().inputs[amount.Input], o?.accountCap);
      return fake(tx, "withdraw");
    }) as unknown as NaviSdk["withdrawCoinPTB"],
    borrowCoinPTB: (async (tx: Transaction, pool: { id: number }, amount: { Input: number }, o: { accountCap?: unknown }) => {
      rec("borrow", pool.id, tx.getData().inputs[amount.Input], o?.accountCap);
      return fake(tx, "borrow");
    }) as unknown as NaviSdk["borrowCoinPTB"],
    repayCoinPTB: (async (tx: Transaction, pool: { id: number }, _c: unknown, o: { accountCap?: unknown }) => {
      rec("repay", pool.id, o?.accountCap);
      return o?.accountCap ? fake(tx, "repay_excess") : tx;
    }) as unknown as NaviSdk["repayCoinPTB"],
    flashloanPTB: (async (tx: Transaction, pool: { id: number }, amount: { Input: number }) => {
      rec("flash", pool.id, tx.getData().inputs[amount.Input]);
      const r = fake(tx, "flash");
      return [r[0], r[1]];
    }) as unknown as NaviSdk["flashloanPTB"],
    repayFlashLoanPTB: (async (tx: Transaction, pool: { id: number }) => {
      rec("flashRepay", pool.id);
      const r = fake(tx, "flash_repay");
      return [r[0]];
    }) as unknown as NaviSdk["repayFlashLoanPTB"],
    createEModeCapPTB: (async (tx: Transaction, emodeId: number) => {
      rec("createEModeCap", emodeId);
      return fake(tx, "emode_cap");
    }) as unknown as NaviSdk["createEModeCapPTB"],
    claimLendingRewardsPTB: (async (_tx: Transaction, rewards: unknown[], o: unknown) => {
      rec("claim", rewards.length, o);
      return [];
    }) as unknown as NaviSdk["claimLendingRewardsPTB"],
  };
  let simulations = 0;
  /**
   * sim: "ok" | "abort" | an Error to throw (a thrown BroadcastUnconfirmedError stands in for
   * executePtb's post-sign failure: it propagates out of executePtb unchanged).
   * wait: what core.waitForTransaction does when the adapter re-checks a digest.
   */
  const control: { sim: "ok" | "abort" | Error; wait: "landed" | "failed" | "timeout"; waited: string[] } = { sim: "ok", wait: "timeout", waited: [] };
  const env = {
    network: "mainnet",
    address: ADDR,
    lock: new Mutex(),
    jsonRpc: {},
    grpc: {
      core: {
        simulateTransaction: async () => {
          simulations++;
          if (control.sim instanceof Error) throw control.sim;
          if (control.sim === "abort") return { $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: "MoveAbort(1503)" } } };
          return { $kind: "Transaction", Transaction: { effects: { gasUsed: { computationCost: "1000000", storageCost: "2000000", storageRebate: "1000000" } } } };
        },
        waitForTransaction: async ({ digest }: { digest: string }) => {
          control.waited.push(digest);
          if (control.wait === "timeout") throw new Error("timeout waiting for transaction");
          return control.wait === "landed"
            ? { $kind: "Transaction", Transaction: { digest } }
            : { $kind: "FailedTransaction", FailedTransaction: { digest, status: { success: false, error: "MoveAbort" } } };
        },
        getBalance: async () => ({ balance: { balance: "1000000000000000" } }),
        getCoinMetadata: async ({ coinType }: { coinType: string }) => {
          const p = pools.find((x) => x.suiCoinType === normalizeStructTag(coinType));
          return { coinMetadata: p ? { decimals: p.token.decimals, symbol: p.token.symbol, name: p.token.symbol, description: "", id: null, iconUrl: null } : null };
        },
        getObject: async ({ objectId }: { objectId: string }) => {
          const p = pools.find((x) => x.contract.pool === objectId);
          if (p) return { object: { objectId, type: `0x${"9".repeat(64)}::pool::Pool<${p.suiCoinType}>` } };
          return { object: { objectId, type: `0x${"9".repeat(64)}::storage::Storage` } };
        },
      },
    },
  } as unknown as SuiEnv;
  const ctx: LiveContext = {
    dryRun: true,
    log: () => {},
    limits: { maxGasUsd: { sui: 5 }, maxSlippageBps: 30, maxLoopIterations: 8 },
    priceUsd: async () => 1,
    nativePriceUsd: async () => 3,
  };
  const swapCalls: { quotes: number; appends: { fromType: string; toType: string; minOut: bigint; amountIn: bigint }[] } = { quotes: 0, appends: [] };
  const swapper: PtbSwapper = {
    quote: async (_f, _t, amountIn) => {
      swapCalls.quotes++;
      const usd = Number(amountIn) / 1e6;
      const costBps = usd <= 20_000 ? 1 : usd <= 200_000 ? 5 : 50;
      return { amountIn, amountOut: (amountIn * BigInt(10_000 - costBps)) / 10_000n, costBps, routeData: null };
    },
    appendSwap: async (tx, a) => {
      swapCalls.appends.push({ fromType: a.fromType, toType: a.toType, minOut: a.minOut, amountIn: a.quote.amountIn });
      return tx.moveCall({ target: "0x1::mock::swap" });
    },
  };
  return { sdk, env, ctx, calls, swapper, swapCalls, control, sims: () => simulations };
}

function u64Input(x: unknown): bigint {
  // tx.getData().inputs[i] for a pure u64 = { Pure: { bytes: base64 } } (little-endian u64)
  const b64 = (x as { Pure: { bytes: string } }).Pure.bytes;
  const buf = Buffer.from(b64, "base64");
  return buf.readBigUInt64LE(0);
}

describe("NaviAdapter", () => {
  test("constructor requires a swapper for different-asset pairs", () => {
    const h = mkHarness();
    assert.throws(() => new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk }), /swapper/);
  });

  test("markets(): same-asset pair uses the stable e-mode, fees and rewards from the SDK", async () => {
    const h = mkHarness();
    const extra = async (q: { side: string }) => (q.side === "supply" ? [{ token: "MERKL", apr: 0.01 }] : []);
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], sdk: h.sdk, extraRewards: extra });
    const [p] = await a.markets();
    assert.ok(p);
    assert.equal(p.protocol, "navi");
    assert.equal(p.chain, "sui");
    assert.equal(p.maxLtv, 0.9); // e-mode 2 beats pool 0.8
    assert.equal(p.liqLtv, 0.93);
    assert.equal(a.pairInfo("USDC/USDC")?.emodeId, 2);
    assert.equal(p.collateral, p.debt, "same-asset pair shares one leg object");
    assert.equal(p.swapCostFrac, 0);
    assert.equal(p.swapDepthUsd, Infinity);
    assert.equal(p.flashloanFeeFrac, 0.0006);
    assert.equal(p.collateral.borrowFeeFrac, 0.003); // 0.3 % -> fraction
    close(p.collateral.totalSupplyUsd, 50_000_000);
    close(p.collateral.totalBorrowUsd, 30_000_000);
    close(p.collateral.borrowAprBase, 0.02 + 0.6 * 0.05, 1e-9);
    assert.deepEqual(p.collateral.supplyRewards, [
      { token: "NAVX", apr: 0.04, endsAtMs: null },
      { token: "MERKL", apr: 0.01 },
    ]);
    assert.ok(p.collateral.irm && p.collateral.irm.points.length === 3);
    close(p.collateral.supplyCapRemainingUsd!, 100_000_000);
    assert.ok(typeof p.dataAsOfMs === "number" && p.dataAsOfMs > 0);
    assert.equal(p.myLtv, undefined);
  });

  test("markets(): stable pair probes the swapper for cost and depth", async () => {
    const h = mkHarness();
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk, swapper: h.swapper });
    const [p] = await a.markets();
    assert.ok(p);
    close(p.swapCostFrac, 0.0001);
    assert.equal(p.swapDepthUsd, 100_000);
    assert.notEqual(p.collateral, p.debt);
    assert.equal(p.debt.borrowFeeFrac, 0.003);
    assert.equal(p.collateral.borrowFeeFrac, undefined);
  });

  test("markets(): failed swap probe reports depth NaN (unknown), never 0; cost falls back to last known", async () => {
    const h = mkHarness();
    let mode: "ok" | "fail" | "expensive" | "partial" = "fail";
    const swapper: PtbSwapper = {
      quote: async (_f, _t, amountIn) => {
        const usd = Number(amountIn) / 1e6;
        if (mode === "fail") throw new Error("aggregator down");
        if (mode === "partial" && usd > 20_000) throw new Error("timeout");
        const costBps = mode === "expensive" ? 80 : usd <= 20_000 ? 2 : usd <= 200_000 ? 5 : 50;
        return { amountIn, amountOut: amountIn, costBps, routeData: null };
      },
      appendSwap: async (tx) => tx.moveCall({ target: "0x1::mock::swap" }),
    };
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk, swapper });
    // 1) no successful probe yet: depth unknown, cost = budget fallback (30 bp)
    let [p] = await a.markets();
    assert.ok(p && Number.isNaN(p.swapDepthUsd), `depth ${p?.swapDepthUsd}`);
    close(p.swapCostFrac, 0.003);
    // 2) success records the last known cost
    mode = "ok";
    [p] = await a.markets();
    assert.equal(p!.swapDepthUsd, 100_000);
    close(p!.swapCostFrac, 0.0002);
    // 3) failure again: depth NaN, cost = last known
    mode = "fail";
    [p] = await a.markets();
    assert.ok(Number.isNaN(p!.swapDepthUsd));
    close(p!.swapCostFrac, 0.0002);
    // 4) probes succeed but nothing fits the budget: a real 0
    mode = "expensive";
    [p] = await a.markets();
    assert.equal(p!.swapDepthUsd, 0);
    close(p!.swapCostFrac, 0.008);
    // 5) smallest probe ok, larger one fails: depth reported as the measured lower bound
    mode = "partial";
    [p] = await a.markets();
    assert.equal(p!.swapDepthUsd, 10_000);
  });

  test("position(): reads the e-mode cap account, USD at oracle prices, HF and rewards", async () => {
    const h = mkHarness({ caps: [{ marketId: 0, emodeId: 2, accountCap: CAP_ID }], state: { [CAP_ID]: { coll: 1000, debt: 0 } } });
    // same-asset view: put the debt on USDC too
    const sdk = {
      ...h.sdk,
      getLendingState: (async () => [{ assetId: 10, supplyBalance: String(1000e9), borrowBalance: String(800e9), market: "main", pool: { ...POOLS[0], emodes: [EMODE_STABLE] } }]) as unknown as NaviSdk["getLendingState"],
    };
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], sdk });
    const v = await a.position("USDC/USDC");
    assert.ok(v);
    close(v.collateralUsd, 1000);
    close(v.debtUsd, 800);
    close(v.ltv, 0.8);
    close(v.equityUsd, 200);
    close(v.healthFactor!, (1000 * 0.93) / 800); // e-mode LT
    assert.deepEqual(v.rewardsUnclaimed, [{ token: "NAVX", amount: 12_500_000_000n, decimals: 9, usd: 12.5 * 0.05 }]);
  });

  test("open(): refuses targetLtv above 0.95 x maxLtv", async () => {
    const h = mkHarness();
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], sdk: h.sdk });
    const r = await a.open("USDC/USDC", 1_000_000_000n, 0.86, h.ctx); // 0.95 * 0.9 = 0.855
    assert.equal(r.ok, false);
    assert.match(r.detail!, /0\.95 x maxLtv/);
    assert.equal(h.sims(), 0);
  });

  test("open(): flash-loan PTB in a new e-mode cap, dry-run simulated", async () => {
    const h = mkHarness();
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], sdk: h.sdk });
    const E = 1_000_000_000n;
    const r = await a.open("USDC/USDC", E, 0.8, h.ctx);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.txs.length, 1);
    assert.equal(r.txs[0]!.simulated, true);
    assert.equal(h.sims(), 1);
    const seq = h.calls.map((c) => c.fn);
    assert.deepEqual(seq, ["updateOraclePricesPTB", "createEModeCap", "flash", "deposit", "borrow", "flashRepay"]);
    const plan = solveFlashOpen({ equity: E, targetLtv: 0.8, flashFeeFrac: 0.0006, borrowFeeFrac: 0.003, swapCostFrac: 0, priceRatio: 1 });
    assert.equal(u64Input(h.calls.find((c) => c.fn === "flash")!.args[1]), plan.flash);
    assert.equal(u64Input(h.calls.find((c) => c.fn === "borrow")!.args[1]), plan.borrow);
    assert.ok(h.calls.find((c) => c.fn === "deposit")!.args[1], "deposit uses the new e-mode cap");
  });

  test("open(): falls back to the iterative loop when the asset is not flash-loanable", async () => {
    const h = mkHarness({ flashCoins: [] });
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC, emode: "off" }], sdk: h.sdk });
    const r = await a.open("USDC/USDC", 1_000_000_000n, 0.7, h.ctx);
    assert.equal(r.ok, true, r.detail);
    const plan = planLoopSteps(1_000_000_000n, 0.7, 0.8, 1, 8, { borrowFeeFrac: 0.003 });
    assert.equal(h.calls.filter((c) => c.fn === "borrow").length, plan.steps.length);
    assert.equal(h.calls.filter((c) => c.fn === "deposit").length, plan.steps.length + 1);
    assert.equal(h.calls.filter((c) => c.fn === "flash").length, 0);
    assert.equal(h.calls.filter((c) => c.fn === "createEModeCap").length, 0);
  });

  test("open(): stable pair swaps debt -> collateral with min-out covering the flash repayment", async () => {
    const h = mkHarness();
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk, swapper: h.swapper });
    const r = await a.open("USDC/USDT", 10_000_000_000n, 0.8, h.ctx);
    assert.equal(r.ok, true, r.detail);
    const flashAmt = u64Input(h.calls.find((c) => c.fn === "flash")!.args[1]);
    const sw = h.swapCalls.appends[0]!;
    assert.equal(sw.fromType, USDT_T);
    assert.equal(sw.toType, USDC_T);
    assert.ok(sw.minOut >= flashRepayAmount(flashAmt, 0.0006), "min-out >= flash repayment");
    assert.equal(sw.amountIn, u64Input(h.calls.find((c) => c.fn === "borrow")!.args[1]));
  });

  test("close(1): flash repays all debt (+buffer) from the cap account and withdraws everything", async () => {
    const h = mkHarness({ caps: [{ marketId: 0, emodeId: 2, accountCap: CAP_ID }], state: { [CAP_ID]: { coll: 1000, debt: 800 } } });
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk, swapper: h.swapper });
    const r = await a.close("USDC/USDT", 1, h.ctx);
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(
      h.calls.map((c) => c.fn),
      ["updateOraclePricesPTB", "flash", "repay", "withdraw", "flashRepay"]
    );
    const flashAmt = u64Input(h.calls.find((c) => c.fn === "flash")!.args[1]);
    const debt = 800_000_000n;
    assert.ok(flashAmt >= debt + debt / 5000n, "repays debt + >= 2bp buffer so close(1) leaves zero debt");
    assert.equal(h.calls.find((c) => c.fn === "repay")!.args[1], CAP_ID);
    assert.ok(u64Input(h.calls.find((c) => c.fn === "withdraw")!.args[1]) >= 1_000_000_000n);
    const sw = h.swapCalls.appends[0]!;
    assert.equal(sw.fromType, USDC_T);
    assert.ok(sw.minOut >= flashRepayAmount(flashAmt, 0.0006));
  });

  test("deleverage(): no-op below target, flash deleverage above it", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 1000, debt: 800 } } });
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT, emode: "off" }], sdk: h.sdk, swapper: h.swapper });
    const noop = await a.deleverage("USDC/USDT", 0.85, h.ctx);
    assert.equal(noop.ok, true);
    assert.equal(noop.txs.length, 0);
    const r = await a.deleverage("USDC/USDT", 0.7, h.ctx);
    assert.equal(r.ok, true, r.detail);
    const repaid = u64Input(h.calls.find((c) => c.fn === "flash")!.args[1]);
    const withdrawn = u64Input(h.calls.find((c) => c.fn === "withdraw")!.args[1]);
    const ltvAfter = Number(800_000_000n - repaid) / Number(1_000_000_000n - withdrawn);
    close(ltvAfter, 0.7, 1e-4);
    assert.equal(h.calls.find((c) => c.fn === "repay")!.args[1], undefined, "address account: no cap");
  });

  test("close(1) without flash loans unwinds iteratively; simulateClose succeeds", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 1000, debt: 300 } }, flashCoins: [] });
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT, emode: "off" }], sdk: h.sdk, swapper: h.swapper });
    assert.equal(await a.simulateClose("USDC/USDT", h.ctx), true);
    h.calls.length = 0;
    const r = await a.close("USDC/USDT", 1, h.ctx);
    assert.equal(r.ok, true, r.detail);
    const seq = h.calls.map((c) => c.fn);
    assert.ok(seq.filter((x) => x === "repay").length >= 1);
    assert.equal(seq[seq.length - 1], "withdraw", "final withdraw-all");
  });

  test("claimRewards(): claims via the SDK into the wallet, filtered by pair account", async () => {
    const h = mkHarness({ caps: [{ marketId: 0, emodeId: 2, accountCap: CAP_ID }], state: { [CAP_ID]: { coll: 1000, debt: 800 } } });
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk, swapper: h.swapper });
    const r = await a.claimRewards(h.ctx, "USDC/USDT");
    assert.equal(r.ok, true, r.detail);
    const claim = h.calls.find((c) => c.fn === "claim")!;
    assert.equal(claim.args[0], 1, "only the cap account's reward entry");
    assert.deepEqual(claim.args[1], { customCoinReceive: { type: "transfer", transfer: ADDR } });
    assert.deepEqual(r.claimed, [{ token: "NAVX", amount: 12_500_000_000n, decimals: 9, coinType: NAVX_T }]);
    const all = await a.claimRewards(h.ctx);
    assert.equal(all.claimed[0]!.amount, 13_500_000_000n);
  });

  test("walletBalance + verifyConfig", async () => {
    const h = mkHarness();
    const ok = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDT", collateral: USDC, debt: USDT }], sdk: h.sdk, swapper: h.swapper });
    assert.equal(await ok.walletBalance(USDC), 1_000_000_000_000_000n);
    assert.deepEqual(await ok.verifyConfig(), []);
    const badDec = { ...USDT, decimals: 9 };
    const missing: AssetRef = { chain: "sui", symbol: "FOO", address: `0x${"f".repeat(64)}::foo::FOO`, decimals: 6 };
    const bad = new NaviAdapter({
      env: h.env,
      pairs: [
        { pairId: "USDC/USDT9", collateral: USDC, debt: badDec },
        { pairId: "FOO/FOO", collateral: missing, debt: missing },
        { pairId: "USDC/USDC", collateral: USDC, debt: USDC, emode: "off" },
        { pairId: "USDC/USDC-2", collateral: USDC, debt: USDC, emode: "off" },
      ],
      sdk: h.sdk,
      swapper: h.swapper,
    });
    const issues = await bad.verifyConfig();
    assert.ok(issues.some((i) => /USDC\/USDT9: debt USDT decimals 9 != on-chain 6/.test(i)), issues.join("\n"));
    assert.ok(issues.some((i) => /FOO\/FOO: no Navi pool for collateral FOO/.test(i)));
    assert.ok(issues.some((i) => /FOO\/FOO: collateral FOO coin type .* has no on-chain metadata/.test(i)));
    assert.ok(issues.some((i) => /USDC\/USDC-2: shares Navi account/.test(i)));
  });
});

// ---------------------------------------------------------------------------
// SupplyAdapter (plain deposits) + broadcast honesty
// ---------------------------------------------------------------------------

const NO_EMODE_POOLS = POOLS.map((p) => ({ ...p, emodes: [] as unknown[] })) as typeof POOLS;
const SUPPLY_USDC = { asset: USDC };

describe("NaviAdapter as SupplyAdapter", () => {
  test("config: pairs optional; supply shares no account with an emode-'off' loop; ids unique", () => {
    const h = mkHarness();
    assert.doesNotThrow(() => new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk }));
    assert.throws(
      () => new NaviAdapter({ env: h.env, pairs: [{ pairId: "L", collateral: USDC, debt: USDC, emode: "off" }], supply: [SUPPLY_USDC], sdk: h.sdk }),
      /share the wallet's Navi account in market main: both hold USDC \(positions conflated\) and the deposit would collateralize the loop/
    );
    // even without a shared asset the account would be shared
    assert.throws(
      () => new NaviAdapter({ env: h.env, pairs: [{ pairId: "L", collateral: USDT, debt: USDT, emode: "off" }], supply: [SUPPLY_USDC], sdk: h.sdk }),
      /would collateralize the loop/
    );
    // other market, or an e-mode-capable pair: fine
    assert.doesNotThrow(
      () => new NaviAdapter({ env: h.env, pairs: [{ pairId: "L", collateral: USDC, debt: USDC, emode: "off", market: "sui-usdc" }], supply: [SUPPLY_USDC], sdk: h.sdk })
    );
    assert.doesNotThrow(() => new NaviAdapter({ env: h.env, pairs: [{ pairId: "L", collateral: USDC, debt: USDC }], supply: [SUPPLY_USDC], sdk: h.sdk }));
    assert.throws(() => new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC, { asset: USDC, marketId: "x" }], sdk: h.sdk }), /configured twice/);
    assert.throws(() => new NaviAdapter({ env: h.env, pairs: [{ pairId: "main:USDC", collateral: USDC, debt: USDC }], supply: [SUPPLY_USDC], sdk: h.sdk }), /not unique/);
  });

  test("supplyMarkets(): base APR, incentives, IRM, totals, cash, caps, my deposit", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const extra = async () => [{ token: "MERKL", apr: 0.01 }];
    const a = new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk, extraRewards: extra });
    const [m] = await a.supplyMarkets();
    assert.ok(m);
    assert.equal(m.protocol, "navi");
    assert.equal(m.chain, "sui");
    assert.equal(m.marketId, "main:USDC");
    assert.deepEqual(m.asset, { symbol: "USDC", assetId: USDC_T, priceUsd: 1 });
    close(m.totalSupplyUsd, 50_000_000);
    close(m.totalBorrowUsd, 30_000_000);
    close(m.supplyAprBase, (0.02 + 0.6 * 0.05) * 0.6 * 0.9, 1e-9);
    assert.deepEqual(m.rewards, [
      { token: "NAVX", apr: 0.04, endsAtMs: null },
      { token: "MERKL", apr: 0.01 },
    ]);
    assert.ok(m.irm && m.irm.points.length === 3);
    close(m.withdrawableUsd!, 20_000_000);
    close(m.supplyCapRemainingUsd!, 100_000_000);
    assert.equal(m.paused, false);
    close(m.myDepositUsd!, 500);
    assert.ok(m.dataAsOfMs! > 0);
  });

  test("supplyPosition(): wallet-account deposit + its own rewards only", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const a = new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk });
    const v = await a.supplyPosition("main:USDC");
    assert.ok(v);
    assert.equal(v.units, 500_000_000n);
    close(v.depositUsd, 500);
    assert.deepEqual(v.rewardsUnclaimed, [{ token: "NAVX", amount: 1_000_000_000n, decimals: 9, usd: 0.05 }]);
    const none = new NaviAdapter({ env: mkHarness().env, supply: [SUPPLY_USDC], sdk: mkHarness().sdk });
    assert.equal(await none.supplyPosition("main:USDC"), null);
  });

  test("deposit(): one PTB, no oracle refresh, refuses a wallet account with debt", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const a = new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk });
    const r = await a.deposit("main:USDC", 100_000_000n, h.ctx);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.txs[0]!.simulated, true);
    assert.deepEqual(
      h.calls.map((c) => [c.fn, c.args[0], c.args[1]]),
      [["deposit", 10, undefined]]
    );
    close(r.amountUsd!, 100);
    const hd = mkHarness({ state: { [ADDR]: { coll: 500, debt: 100 } } });
    const b = new NaviAdapter({ env: hd.env, supply: [SUPPLY_USDC], sdk: hd.sdk });
    const rd = await b.deposit("main:USDC", 100_000_000n, hd.ctx);
    assert.equal(rd.ok, false);
    assert.match(rd.detail!, /debt-free account/);
    assert.equal(hd.sims(), 0);
  });

  test("withdraw(): fraction 1 requests >= balance (max semantics), fraction < 1 exact; oracle first", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const a = new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk });
    const all = await a.withdraw("main:USDC", 1, h.ctx);
    assert.equal(all.ok, true, all.detail);
    assert.deepEqual(
      h.calls.map((c) => c.fn),
      ["updateOraclePricesPTB", "withdraw"]
    );
    const req = u64Input(h.calls[1]!.args[1]);
    assert.ok(req > 500_000_000n && req < 500_500_000n, `request ${req}`);
    h.calls.length = 0;
    await a.withdraw("main:USDC", 0.25, h.ctx);
    assert.equal(u64Input(h.calls.find((c) => c.fn === "withdraw")!.args[1]), 125_000_000n);
    const none = mkHarness();
    const r0 = await new NaviAdapter({ env: none.env, supply: [SUPPLY_USDC], sdk: none.sdk }).withdraw("main:USDC", 1, none.ctx);
    assert.equal(r0.ok, true);
    assert.equal(r0.txs.length, 0);
  });

  test("simulateWithdraw(): true / false on abort / throws on read errors", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const a = new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk });
    assert.equal(await a.simulateWithdraw("main:USDC", h.ctx), true);
    h.control.sim = "abort";
    assert.equal(await a.simulateWithdraw("main:USDC", h.ctx), false);
    h.control.sim = new Error("grpc unavailable");
    await assert.rejects(a.simulateWithdraw("main:USDC", h.ctx), /grpc unavailable/);
    h.control.sim = "ok";
    const broken = new NaviAdapter({
      env: h.env,
      supply: [SUPPLY_USDC],
      sdk: { ...h.sdk, getLendingState: (async () => { throw new Error("devInspect failed"); }) as unknown as NaviSdk["getLendingState"] },
    });
    await assert.rejects(broken.simulateWithdraw("main:USDC", h.ctx), /devInspect failed/);
    const posFail = new NaviAdapter({
      env: h.env,
      supply: [SUPPLY_USDC],
      sdk: { ...h.sdk, getLendingPositions: (async () => { throw new Error("positions read failed"); }) as unknown as NaviSdk["getLendingPositions"] },
    });
    await assert.rejects(posFail.simulateWithdraw("main:USDC", h.ctx), /positions read failed/);
  });

  test("broadcast unconfirmed: landed -> ok; unknown -> ok:false + unconfirmed digest; failed -> ok:false", async () => {
    const h = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const a = new NaviAdapter({ env: h.env, supply: [SUPPLY_USDC], sdk: h.sdk });
    const live = { ...h.ctx, dryRun: false };
    h.control.sim = new BroadcastUnconfirmedError("sui", "DIGEST1", "navi: deposit", "execute error: 504");
    h.control.wait = "landed";
    const landed = await a.deposit("main:USDC", 1_000_000n, live);
    assert.equal(landed.ok, true, landed.detail);
    assert.deepEqual(landed.txs, [{ chain: "sui", id: "DIGEST1", description: "navi: deposit 1000000 USDC (main:USDC)", simulated: false }]);
    h.control.wait = "timeout";
    const unknown = await a.withdraw("main:USDC", 1, live);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.txs[0]!.id, "DIGEST1");
    assert.equal(unknown.txs[0]!.unconfirmed, true);
    assert.equal(unknown.txs[0]!.simulated, false);
    assert.match(unknown.detail!, /MAY HAVE LANDED/);
    h.control.wait = "failed";
    const failed = await a.deposit("main:USDC", 1_000_000n, live);
    assert.equal(failed.ok, false);
    assert.equal(failed.txs[0]!.unconfirmed, false);
    assert.match(failed.detail!, /failed on-chain/);
    // loop writes and claims report the same way (never "nothing happened")
    const hl = mkHarness();
    hl.control.sim = new BroadcastUnconfirmedError("sui", "DIGEST2", "x", "timeout");
    const loop = new NaviAdapter({ env: hl.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], sdk: hl.sdk });
    const o = await loop.open("USDC/USDC", 1_000_000_000n, 0.8, { ...hl.ctx, dryRun: false });
    assert.equal(o.ok, false);
    assert.equal(o.txs[0]!.id, "DIGEST2");
    assert.equal(o.txs[0]!.unconfirmed, true);
    assert.deepEqual(hl.control.waited, ["DIGEST2"]);
  });

  test("loop/supply separation at runtime and claimRewards by supply marketId", async () => {
    // "auto" pair with no covering e-mode would land in the wallet account holding supply deposits
    const h = mkHarness({ pools: NO_EMODE_POOLS });
    const a = new NaviAdapter({ env: h.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], supply: [SUPPLY_USDC], sdk: h.sdk });
    const r = await a.open("USDC/USDC", 1_000_000_000n, 0.7, h.ctx);
    assert.equal(r.ok, false);
    assert.match(r.detail!, /holds plain supply deposits/);
    const issues = await a.verifyConfig();
    assert.ok(issues.some((i) => /main:USDC: loop pair USDC\/USDC has no covering e-mode/.test(i)), issues.join("\n"));
    // the supply deposit in the wallet account is not reported as a loop position
    const h2 = mkHarness({ state: { [ADDR]: { coll: 500, debt: 0 } } });
    const b = new NaviAdapter({ env: h2.env, pairs: [{ pairId: "USDC/USDC", collateral: USDC, debt: USDC }], supply: [SUPPLY_USDC], sdk: h2.sdk });
    assert.equal(await b.position("USDC/USDC"), null);
    assert.equal((await b.supplyPosition("main:USDC"))!.units, 500_000_000n);
    assert.deepEqual(await b.verifyConfig(), []);
    const c = await b.claimRewards(h2.ctx, "main:USDC");
    assert.equal(c.ok, true, c.detail);
    assert.equal(h2.calls.find((x) => x.fn === "claim")!.args[0], 1, "only the wallet-account USDC entry");
    assert.deepEqual(c.claimed, [{ token: "NAVX", amount: 1_000_000_000n, decimals: 9, coinType: NAVX_T }]);
  });
});
