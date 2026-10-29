import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { POOL_ADDRESSES, ScallopBuilder, TEST_ADDRESSES, WHITELIST, type PoolAddress } from "@scallop-io/sui-scallop-sdk";
import type { AssetRef, LiveContext, RewardRateQuery } from "@incentive-router/live-common";
import { DEFAULT_CONFIG, loopPairOpportunity } from "@incentive-router/core";
import { Mutex, type PtbSwapper, type SuiEnv } from "../src/common.js";
import {
  borrowIncentiveRates,
  buildScallopLoopPair,
  flashFee,
  grossBorrowFor,
  irmFromPool,
  ltvOf,
  nextSwapIn,
  openAmounts,
  planClose,
  planDeleverage,
  planOpenFlash,
  positionFromAccount,
  ScallopAdapter,
  summarizeSwapProbe,
  verifyScallopConfig,
  type ScallopSdkLike,
} from "../src/scallop/index.js";
import type { CollateralLike, IncentivePoolLike, ObligationAccountLike, PoolLike } from "../src/scallop/math.js";

// ---------------------------------------------------------------------------
// fixtures (fake coin types; nothing here is a real address)
// ---------------------------------------------------------------------------

const SUI_T = normalizeStructTag("0x2::sui::SUI");
const USDC_T = normalizeStructTag("0xa11ce::usdc::USDC");
const SSCA_T = normalizeStructTag("0xb0b::scallop_sca::SCALLOP_SCA");
const ME = "0x" + "ab".repeat(32);
const OB_ID = "0x" + "0b".repeat(32);
const KEY_ID = "0x" + "0c".repeat(32);

const SUI: AssetRef = { chain: "sui", symbol: "SUI", address: SUI_T, decimals: 9 };
const USDC: AssetRef = { chain: "sui", symbol: "USDC", address: USDC_T, decimals: 6 };
const PX: Record<string, number> = { SUI: 3, USDC: 1 };

const prices = { collPriceUsd: 3, debtPriceUsd: 1, collDecimals: 9, debtDecimals: 6 };
/** collateral (SUI) units per debt (USDC) unit, and back, minus `bps`. */
const rateDC = (bps = 0) => (1e-6 / 3e-9) * (1 - bps / 1e4);
const rateCD = (bps = 0) => (3e-9 / 1e-6) * (1 - bps / 1e4);

const pool = (over: Partial<PoolLike> = {}): PoolLike => ({
  coinName: "usdc",
  coinPrice: 1,
  coinDecimal: 6,
  supplyCoin: 5_000_000,
  borrowCoin: 2_000_000,
  supplyAmount: 5e12,
  borrowAmount: 2e12,
  utilizationRate: 0.4,
  supplyApr: 0.03,
  borrowApr: 0.08,
  baseBorrowApr: 0.02,
  borrowAprOnMidKink: 0.1,
  borrowAprOnHighKink: 0.3,
  maxBorrowApr: 2,
  midKink: 0.8,
  highKink: 0.9,
  reserveFactor: 0.2,
  borrowWeight: 1,
  borrowFee: 0.003,
  minBorrowAmount: 10_000,
  maxSupplyCoin: 10_000_000,
  maxBorrowCoin: 4_000_000,
  isIsolated: false,
  ...over,
});

const collMarket = (over: Partial<CollateralLike> = {}): CollateralLike => ({
  coinName: "sui",
  coinPrice: 3,
  coinDecimal: 9,
  collateralFactor: 0.85,
  liquidationFactor: 0.9,
  depositCoin: 1_000_000,
  maxDepositCoin: 100_000_000,
  isIsolated: false,
  ...over,
});

const NOW = 1_800_000_000_000;

const incentive = (over: Partial<IncentivePoolLike["points"][string]> = {}): IncentivePoolLike => ({
  coinName: "usdc",
  points: {
    ssca: {
      symbol: "sSCA",
      coinName: "ssca",
      coinType: SSCA_T,
      points: 1e12,
      accumulatedPoints: 0,
      distributedPointPerSec: 1e5,
      baseWeight: 2.5e11, // scale 0.25 -> max boost 4
      rewardApr: 0.12,
      ...over,
    },
  },
});

const account = (collUnits: number, debtUnits: number): ObligationAccountLike => {
  const cUsd = (collUnits / 1e9) * 3;
  const dUsd = debtUnits / 1e6;
  const reward = { coinName: "ssca", symbol: "sSCA", coinDecimal: 9, coinPrice: 0.2, availableClaimAmount: 5e9, availableClaimCoin: 5, boostValue: 1 };
  return {
    totalRequiredCollateralValue: cUsd * 0.9,
    totalBorrowedValueWithWeight: dUsd,
    collaterals: { sui: { depositedAmount: collUnits, depositedValue: cUsd } },
    debts: { usdc: { borrowedAmount: debtUnits, borrowedValue: dUsd, rewards: debtUnits > 0 ? [reward] : [] } },
    borrowIncentives: { usdc: { rewards: debtUnits > 0 ? [reward] : [] } },
  };
};

// ---------------------------------------------------------------------------
// pure planning
// ---------------------------------------------------------------------------

describe("scallop math: fees", () => {
  it("flash fee matches the contract (floor(a*r)+1) rounded up, zero rate -> zero", () => {
    assert.equal(flashFee(1_000_000n, 0), 0n);
    assert.equal(flashFee(1_000_000n, 0.0005), 501n);
    assert.equal(flashFee(0n, 0.0005), 0n);
  });
  it("gross borrow nets at least the need after the floor()ed borrow fee", () => {
    for (const need of [1n, 999n, 1_000_000n, 123_456_789_012n]) {
      for (const bf of [0, 0.003, 0.01]) {
        const B = grossBorrowFor(need, bf);
        const fee = (B * BigInt(Math.round(bf * 1e9))) / 1_000_000_000n;
        assert.ok(B - fee >= need, `need ${need} bf ${bf}`);
        assert.ok(B - fee <= need + 3n);
      }
    }
  });
});

describe("scallop math: open plan", () => {
  const base = { ...prices, equity: 1_000n * 10n ** 9n, collateralNow: 0n, debtNow: 0n, targetLtv: 0.6, borrowFeeFrac: 0.003, flashFeeFrac: 0.0005 };
  it("lands on the target LTV with the worst-case swap output and repays the flash loan", () => {
    const r = rateDC(40);
    const F = planOpenFlash({ ...base, swapRateMin: r });
    const minOut = BigInt(Math.floor(Number(F) * r));
    const a = openAmounts({ ...base, swapRateMin: r }, F, minOut);
    assert.ok(Math.abs(a.ltvAfterWorst - 0.6) < 1e-6, `ltv ${a.ltvAfterWorst}`);
    assert.ok(a.borrowAmount - (a.borrowAmount * 3_000_000n) / 1_000_000_000n >= a.flashRepay);
    // ~ L-1 = 1.5x equity of debt: 1000 SUI * $3 * 1.5 = $4500 (+fees)
    assert.ok(Number(a.debtAfter) / 1e6 > 4400 && Number(a.debtAfter) / 1e6 < 4700, `${a.debtAfter}`);
  });
  it("adds to an existing position and returns 0 (deposit only) when already above target", () => {
    const r = rateDC(40);
    const F = planOpenFlash({ ...base, collateralNow: 2_000n * 10n ** 9n, debtNow: 3_000n * 10n ** 6n, swapRateMin: r });
    const a = openAmounts({ ...base, collateralNow: 2_000n * 10n ** 9n, debtNow: 3_000n * 10n ** 6n, swapRateMin: r }, F, BigInt(Math.floor(Number(F) * r)));
    assert.ok(Math.abs(a.ltvAfterWorst - 0.6) < 1e-6);
    assert.equal(planOpenFlash({ ...base, collateralNow: 0n, debtNow: 2_000n * 10n ** 6n, swapRateMin: r }), 0n);
  });
  it("hits the target across random inputs", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let k = 0; k < 200; k++) {
      const t = 0.1 + rnd() * 0.7;
      const r = rateDC(rnd() * 100);
      const i = { ...base, equity: BigInt(Math.floor(1e9 + rnd() * 1e14)), targetLtv: t, borrowFeeFrac: rnd() * 0.01, flashFeeFrac: rnd() * 0.001, swapRateMin: r };
      const F = planOpenFlash(i);
      const a = openAmounts(i, F, BigInt(Math.floor(Number(F) * r)));
      assert.ok(a.ltvAfterWorst <= t + 1e-6 && a.ltvAfterWorst > t - 1e-3, `t=${t} ltv=${a.ltvAfterWorst}`);
    }
  });
  it("rejects nonsense", () => {
    assert.throws(() => planOpenFlash({ ...base, targetLtv: 1, swapRateMin: 1 }));
    assert.throws(() => planOpenFlash({ ...base, swapRateMin: 0 }));
    assert.throws(() => planOpenFlash({ ...base, collPriceUsd: 0, swapRateMin: 1 }));
  });
});

describe("scallop math: unwind plans", () => {
  const C0 = 2_500n * 10n ** 9n; // 2500 SUI = $7500
  const D0 = 4_500n * 10n ** 6n; // $4500 -> LTV 0.6
  const common = { ...prices, collateralNow: C0, debtNow: D0, flashFeeFrac: 0.0005, swapRateMin: rateCD(40) };

  it("deleverage reaches the target and the swap covers the flash repayment", () => {
    const p = planDeleverage({ ...common, targetLtv: 0.4 });
    assert.ok(Math.abs(p.ltvAfterWorst - 0.4) < 1e-4, `${p.ltvAfterWorst}`);
    assert.ok(BigInt(Math.floor(Number(p.swapIn) * common.swapRateMin)) >= p.flashRepay);
    assert.equal(p.withdrawAmount, p.swapIn);
    assert.equal(p.collateralToWallet, 0n);
    assert.ok(p.repayAmount < D0);
  });
  it("full close over-repays by the buffer, withdraws everything, returns the rest", () => {
    const p = planClose({ ...common, fraction: 1, maxLtv: 0.85, debtBufferBps: 5 });
    assert.ok(p.repayAmount > D0 && p.repayAmount <= D0 + D0 / 1000n);
    assert.equal(p.withdrawAmount, C0);
    assert.equal(p.debtAfter, 0n);
    assert.equal(p.collateralToWallet, C0 - p.swapIn);
    assert.ok(BigInt(Math.floor(Number(p.swapIn) * common.swapRateMin)) >= p.flashRepay);
    assert.equal(p.ltvAfterWorst, 0);
  });
  it("partial close never raises LTV above min(now, 0.99*maxLtv)", () => {
    const p = planClose({ ...common, fraction: 0.5, maxLtv: 0.85, debtBufferBps: 5 });
    assert.equal(p.repayAmount, D0 / 2n);
    assert.ok(p.ltvAfterWorst <= 0.6 + 1e-6);
    const hot = planClose({ ...common, debtNow: 6_300n * 10n ** 6n, fraction: 0.3, maxLtv: 0.85, debtBufferBps: 5 }); // LTV 0.84
    assert.ok(hot.ltvAfterWorst <= 0.85 * 0.99 + 1e-6, `${hot.ltvAfterWorst}`);
  });
  it("debt-free close just withdraws", () => {
    const p = planClose({ ...common, debtNow: 0n, fraction: 1, maxLtv: 0.85, debtBufferBps: 5 });
    assert.equal(p.repayAmount, 0n);
    assert.equal(p.swapIn, 0n);
    assert.equal(p.collateralToWallet, C0);
  });
  it("refuses an underwater close", () => {
    assert.throws(() => planClose({ ...common, debtNow: 7_600n * 10n ** 6n, fraction: 1, maxLtv: 0.85, debtBufferBps: 5 }), /cannot cover/);
  });
  it("nextSwapIn scales the input to reach the needed output", () => {
    assert.equal(nextSwapIn(100n, 1000n, 150n), 1000n);
    const n = nextSwapIn(1_000_000n, 1_000n, 900_000n);
    assert.ok(n > 1_111n && n < 1_115n, `${n}`);
  });
});

// ---------------------------------------------------------------------------
// market / position mapping
// ---------------------------------------------------------------------------

describe("scallop mapping", () => {
  it("IRM: 3 kinks as points, invalid -> undefined", () => {
    const irm = irmFromPool(pool())!;
    assert.deepEqual(irm.points, [[0, 0.02], [0.8, 0.1], [0.9, 0.3], [1, 2]]);
    assert.equal(irm.reserveFactor, 0.2);
    assert.equal(irmFromPool(pool({ midKink: 0 })), undefined);
    assert.equal(irmFromPool(pool({ maxBorrowApr: NaN })), undefined);
  });

  it("borrow incentives: unboosted by default, boost capped at max, Infinity / exhausted dropped, end time", () => {
    const [r] = borrowIncentiveRates(incentive(), NOW, 1);
    assert.equal(r!.token, "sSCA");
    assert.equal(r!.apr, 0.12);
    assert.equal(r!.endsAtMs, NOW + 1e7 * 1000);
    assert.equal(borrowIncentiveRates(incentive(), NOW, 2.5)[0]!.apr, 0.3);
    assert.equal(borrowIncentiveRates(incentive(), NOW, 10)[0]!.apr, 0.48); // capped at 4x
    assert.equal(borrowIncentiveRates(incentive({ rewardApr: Infinity }), NOW, 1).length, 0);
    assert.equal(borrowIncentiveRates(incentive({ points: 0 }), NOW, 1).length, 0);
    assert.equal(borrowIncentiveRates(incentive(), NOW, 1, new Set(["ssca"])).length, 0);
  });

  it("LoopPair: collateral earns nothing and is not lent; debt carries rates, IRM, rewards, caps", () => {
    const pr = buildScallopLoopPair({
      pairId: "SUI/USDC",
      collateral: SUI,
      debt: USDC,
      collateralMarket: collMarket(),
      debtPool: pool({ borrowWeight: 1.25 }),
      incentive: incentive(),
      flashFeeFrac: 0.0005,
      swap: { costFrac: 0.001, depthUsd: 100_000 },
      boost: 1,
      extra: { collateral: [{ token: "X", apr: 0.01 }], borrow: [{ token: "Y", apr: 0.02 }] },
      myLtv: 0.6,
      nowMs: NOW,
    });
    assert.equal(pr.protocol, "scallop");
    assert.equal(pr.collateral.supplyAprBase, 0);
    assert.equal(pr.collateral.irm, undefined);
    assert.equal(pr.collateral.totalBorrowUsd, 0);
    assert.equal(pr.collateral.totalSupplyUsd, 3_000_000);
    assert.deepEqual(pr.collateral.supplyRewards, [{ token: "X", apr: 0.01 }]);
    assert.equal(pr.collateral.supplyCapRemainingUsd, 99_000_000 * 3);
    assert.equal(pr.debt.borrowAprBase, 0.08);
    assert.equal(pr.debt.borrowFeeFrac, 0.003);
    assert.deepEqual(pr.debt.borrowRewards.map((r) => r.token), ["sSCA", "Y"]);
    assert.equal(pr.debt.borrowCapRemainingUsd, 1_500_000); // min(limit headroom 2M, cash 3M / 2 for the flash route)
    assert.ok(pr.debt.irm);
    assert.ok(Math.abs(pr.maxLtv - 0.68) < 1e-12); // CF / borrowWeight
    assert.ok(Math.abs(pr.liqLtv - 0.72) < 1e-12);
    assert.equal(pr.flashloanFeeFrac, 0.0005);
    assert.equal(pr.myLtv, 0.6);
    assert.equal(pr.dataAsOfMs, NOW);
    assert.throws(() => buildScallopLoopPair({ pairId: "x", collateral: SUI, debt: USDC, collateralMarket: collMarket({ coinPrice: 0 }), debtPool: pool(), swap: { costFrac: 0, depthUsd: 0 }, boost: 1, extra: { collateral: [], borrow: [] }, nowMs: NOW }));
  });

  it("swapDepthUsd is capped by the debt pool's free cash (the unwind flash loan draws it)", () => {
    const mk = (supplyCoin: number) =>
      buildScallopLoopPair({
        pairId: "SUI/USDC",
        collateral: SUI,
        debt: USDC,
        collateralMarket: collMarket(),
        debtPool: pool({ supplyCoin }),
        swap: { costFrac: 0.001, depthUsd: 100_000 },
        boost: 1,
        extra: { collateral: [], borrow: [] },
        nowMs: NOW,
      });
    assert.equal(mk(5_000_000).swapDepthUsd, 100_000); // cash 3M: swap depth binds
    const tight = mk(2_050_000); // cash 50k: flash-loan cash binds
    assert.equal(tight.swapDepthUsd, 50_000);
    assert.equal(mk(2_000_000).swapDepthUsd, 0);
    const unknown = (supplyCoin: number) =>
      buildScallopLoopPair({
        pairId: "SUI/USDC",
        collateral: SUI,
        debt: USDC,
        collateralMarket: collMarket(),
        debtPool: pool({ supplyCoin }),
        swap: { costFrac: NaN, depthUsd: NaN },
        boost: 1,
        extra: { collateral: [], borrow: [] },
        nowMs: NOW,
      }).swapDepthUsd;
    assert.ok(Number.isNaN(unknown(5_000_000)), "failed probe stays NaN through the cash cap");
    assert.equal(unknown(2_000_000), 0); // ...unless the cash limit is a known 0
    const o = loopPairOpportunity(tight, { cfg: DEFAULT_CONFIG, nowMs: NOW, myEquityByOpp: {} }, "test")!;
    const L = o.meta!.leverage as number;
    const ll = DEFAULT_CONFIG.sources.lending_loop;
    const want = ll.footprint === "gross" ? (50_000 * L) / (L - 1) : 50_000 / (L - 1);
    assert.ok(Math.abs(o.liquidity.exitCapacityUsd - want) < 1e-6, `${o.liquidity.exitCapacityUsd} vs ${want}`);
  });

  it("the core accepts the pair and values the loop as borrow-incentive carry only (no supply yield)", () => {
    const pr = buildScallopLoopPair({
      pairId: "SUI/USDC",
      collateral: SUI,
      debt: USDC,
      collateralMarket: collMarket(),
      debtPool: pool(),
      incentive: incentive(),
      flashFeeFrac: 0.0005,
      swap: { costFrac: 0.001, depthUsd: 100_000 },
      boost: 1,
      extra: { collateral: [], borrow: [] },
      nowMs: NOW,
    });
    const o = loopPairOpportunity(pr, { cfg: DEFAULT_CONFIG, nowMs: NOW, myEquityByOpp: {} }, "test");
    assert.ok(o, "core rejected the Scallop pair");
    const at = (label: string) => o.streams.find((x) => x.label === label)!.aprAt(1_000);
    assert.equal(at("supply_base"), 0);
    assert.ok(at("borrow_base") < 0);
    assert.ok(at("borrow_reward:sSCA") > 0);
    assert.ok(o.costs.entryFrac > 0); // borrow fee + swap
  });

  it("position view from an obligation account", () => {
    const v = positionFromAccount(account(2.5e12, 4.5e9), "SUI/USDC", "sui", "usdc", NOW)!;
    assert.equal(v.collateralUsd, 7500);
    assert.equal(v.debtUsd, 4500);
    assert.equal(v.ltv, 0.6);
    assert.equal(v.healthFactor, 1.5);
    assert.equal(v.equityUsd, 3000);
    assert.deepEqual(v.rewardsUnclaimed, [{ token: "sSCA", amount: 5_000_000_000n, decimals: 9, usd: 1 }]);
    assert.equal(positionFromAccount(account(0, 0), "SUI/USDC", "sui", "usdc", NOW), null);
  });

  it("swap probe summary", () => {
    assert.deepEqual(summarizeSwapProbe([{ sizeUsd: 1e4, costBps: 12 }, { sizeUsd: 1e3, costBps: 5 }, { sizeUsd: 1e5, costBps: 80 }], 30), { costFrac: 0.0005, depthUsd: 1e4 });
    const failed = summarizeSwapProbe([{ sizeUsd: 1e3, costBps: null }, { sizeUsd: 1e4, costBps: null }], 30);
    assert.ok(Number.isNaN(failed.costFrac) && Number.isNaN(failed.depthUsd), "all probes failed -> unknown (NaN)");
    // a failed size is skipped, not treated as zero depth
    assert.deepEqual(summarizeSwapProbe([{ sizeUsd: 1e3, costBps: null }, { sizeUsd: 1e4, costBps: 12 }, { sizeUsd: 1e5, costBps: 80 }], 30), { costFrac: 0.0012, depthUsd: 1e4 });
    // probes succeeded but nothing within budget -> a KNOWN 0
    assert.deepEqual(summarizeSwapProbe([{ sizeUsd: 1e3, costBps: 50 }], 30), { costFrac: 0.005, depthUsd: 0 });
  });
});

// ---------------------------------------------------------------------------
// adapter with a fake SDK / swapper / chain
// ---------------------------------------------------------------------------

interface Call {
  m: string;
  args: unknown[];
}

interface FakeState {
  obligations: { id: string; keyId: string; locked: boolean }[];
  coll: number;
  debt: number;
  bound: boolean;
  simFail: boolean;
  balance: bigint;
}

function fakeWorld(over: Partial<FakeState> = {}) {
  const st: FakeState = { obligations: [], coll: 0, debt: 0, bound: false, simFail: false, balance: 10n ** 15n, ...over };
  const calls: Call[] = [];
  const lastTx: { tx?: Transaction } = {};
  const typeToName: Record<string, string> = { [SUI_T]: "sui", [USDC_T]: "usdc", [SSCA_T]: "ssca" };
  const sdk = {
    utils: {
      parseCoinNameFromType: (t: string) => typeToName[normalizeStructTag(t)] ?? "unknown",
      parseSCoinName: (n: string) => `s${n}`,
    },
    constants: {
      coinTypes: { sui: SUI_T, usdc: USDC_T, ssca: SSCA_T },
      coinDecimals: { sui: 9, usdc: 6, ssca: 9 },
      protocolObjectId: "0x" + "ee".repeat(32),
      whitelist: {
        lending: new Set(["sui", "usdc"]),
        collateral: new Set(["sui", "usdc"]),
        borrowing: new Set(["sui", "usdc"]),
        spool: new Set(["ssui"]),
        deprecated: new Set<string>(),
        rewardsAsPoint: new Set<string>(),
      },
      get: (path: string) => `0x${(path.length % 16).toString(16).repeat(64)}`,
    },
    query: {
      getMarketPools: async () => ({ pools: { usdc: pool(), sui: pool({ coinName: "sui", coinPrice: 3, coinDecimal: 9 }) }, collaterals: { sui: collMarket() } }),
      getFlashLoanFees: async () => ({ usdc: 0.0005, sui: 0.0005 }),
      getBorrowIncentivePools: async () => ({ usdc: incentive() }),
      getObligations: async () => st.obligations,
      queryObligation: async () => ({
        collaterals: st.coll > 0 ? [{ type: SUI_T, amount: String(st.coll) }] : [],
        debts: st.debt > 0 ? [{ type: USDC_T, amount: String(st.debt), borrowIndex: "1" }] : [],
      }),
      getObligationAccountById: async () => account(st.coll, st.debt),
      getBindedVeScaKey: async () => (st.bound ? "0xveSCA" : null),
      getAllStakeAccounts: async () => ({}),
    },
    createPtb: () => {
      const tx = new Transaction();
      const mc = (m: string, args: unknown[], ret = true) => {
        calls.push({ m, args });
        const r = tx.moveCall({ target: `0x1::fake::${m}` });
        return ret ? r : undefined;
      };
      const stx = {
        updateAssetPricesQuick: async (names: string[]) => void mc("updateAssetPrices", [names]),
        openObligation: () => {
          const r = mc("openObligation", [])!;
          return [r[0], r[1], r[2]];
        },
        returnObligation: (...a: unknown[]) => void mc("returnObligation", a),
        depositCollateral: (...a: unknown[]) => void mc("depositCollateral", a),
        takeCollateral: (...a: unknown[]) => mc("takeCollateral", a),
        borrow: (...a: unknown[]) => mc("borrow", a),
        repay: (...a: unknown[]) => void mc("repay", a),
        borrowFlashLoan: (...a: unknown[]) => mc("borrowFlashLoan", a),
        repayFlashLoan: (...a: unknown[]) => void mc("repayFlashLoan", a),
        stakeObligation: (...a: unknown[]) => void mc("stakeObligation", a),
        stakeObligationWithVeScaQuick: async (...a: unknown[]) => void mc("stakeObligationWithVeScaQuick", a),
        unstakeObligationQuick: async (...a: unknown[]) => void mc("unstakeObligationQuick", a),
        claimBorrowIncentive: (...a: unknown[]) => mc("claimBorrowIncentive", a),
        claimQuick: async (...a: unknown[]) => [mc("claimQuick", a)],
      };
      lastTx.tx = tx;
      return { tx, stx };
    },
  } as unknown as ScallopSdkLike;

  const rates: Record<string, number> = { [`${USDC_T}|${SUI_T}`]: rateDC(10), [`${SUI_T}|${USDC_T}`]: rateCD(10) };
  const swapper: PtbSwapper = {
    quote: async (from, to, amountIn) => ({
      amountIn,
      amountOut: BigInt(Math.floor(Number(amountIn) * rates[`${normalizeStructTag(from)}|${normalizeStructTag(to)}`]!)),
      costBps: 10,
      routeData: null,
    }),
    appendSwap: async (tx, a) => {
      calls.push({ m: "swap", args: [a.fromType, a.toType, a.quote.amountIn, a.minOut] });
      return tx.moveCall({ target: "0x1::fake::swap", arguments: [a.coinIn] })[0]! as TransactionObjectArgument;
    },
  };

  const gas = { computationCost: "1000000", storageCost: "0", storageRebate: "0" };
  const env = {
    network: "mainnet",
    address: ME,
    lock: new Mutex(),
    jsonRpc: {},
    grpc: {
      core: {
        simulateTransaction: async () =>
          st.simFail
            ? { $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: { message: "abort" } } } }
            : { $kind: "Transaction", Transaction: { effects: { gasUsed: gas } } },
        getBalance: async () => ({ balance: { balance: String(st.balance) } }),
        getObjects: async ({ objectIds }: { objectIds: string[] }) => ({
          objects: objectIds.map((id, i) => ({
            objectId: id,
            type: i === 0 ? "package" : [
              `${"0x" + "ee".repeat(32)}::market::Market`,
              "0x9::version::Version",
              "0x9::coin_decimals_registry::CoinDecimalsRegistry",
              "0x9::x_oracle::XOracle",
              "0x9::obligation_access::ObligationAccessStore",
              "0x9::bi::Config",
              "0x9::bi::Pools",
              "0x9::bi::Accounts",
            ][i - 1],
          })),
        }),
        getCoinMetadata: async ({ coinType }: { coinType: string }) => ({ coinMetadata: { decimals: normalizeStructTag(coinType) === SUI_T ? 9 : 6 } }),
      },
    },
  } as unknown as SuiEnv;

  const logs: string[] = [];
  const ctx: LiveContext = {
    dryRun: true,
    log: (lvl, msg) => void logs.push(`${lvl}: ${msg}`),
    limits: { maxGasUsd: { sui: 5 }, maxSlippageBps: 30, maxLoopIterations: 5 },
    priceUsd: async (a) => PX[a.symbol]!,
    nativePriceUsd: async () => 3,
  };
  return { st, calls, sdk, swapper, env, ctx, logs, lastTx };
}

const order = (calls: Call[]) => calls.map((c) => c.m);

describe("ScallopAdapter", () => {
  const PAIR = { pairId: "SUI/USDC", collateral: SUI, debt: USDC };

  it("rejects same-asset pairs (protocol forbids collateral == debt) and ambiguous obligation pins", () => {
    const w = fakeWorld();
    assert.throws(() => new ScallopAdapter({ env: w.env, sdk: w.sdk, pairs: [{ pairId: "SUI/SUI", collateral: SUI, debt: SUI }] }), /same-asset/);
    assert.throws(
      () => new ScallopAdapter({ env: w.env, sdk: w.sdk, obligationId: OB_ID, pairs: [PAIR, { pairId: "USDC/SUI", collateral: USDC, debt: SUI }] }),
      /only allowed with one pair/
    );
    assert.throws(() => new ScallopAdapter({ env: w.env, sdk: w.sdk, pairs: [PAIR], veScaBoost: 5 }), /veScaBoost/);
  });

  it("markets(): truthful pair with probe, incentives, extra rewards by side, my LTV", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9 });
    const sides: RewardRateQuery["side"][] = [];
    const a = new ScallopAdapter({
      env: w.env,
      sdk: w.sdk,
      swapper: w.swapper,
      pairs: [PAIR],
      now: () => NOW,
      extraRewards: async (q) => {
        sides.push(q.side);
        assert.equal(q.protocol, "scallop");
        return [];
      },
    });
    const [p] = await a.markets();
    assert.equal(p!.pairId, "SUI/USDC");
    assert.equal(p!.collateral.supplyAprBase, 0);
    assert.equal(p!.debt.borrowRewards[0]!.apr, 0.12);
    assert.equal(p!.swapCostFrac, 0.001);
    assert.equal(p!.swapDepthUsd, 100_000);
    assert.equal(p!.myLtv, 0.6);
    assert.ok(Math.abs(p!.maxLtv - 0.85) < 1e-12);
    assert.deepEqual(sides.sort(), ["borrow", "collateral"]); // never "supply": collateral is not in the lending pool
  });

  it("markets(): a failing pair is skipped with a warning; all pairs failing throws", async () => {
    const w = fakeWorld();
    const warnings: string[] = [];
    const pairs = [PAIR, { pairId: "USDC/SUI", collateral: USDC, debt: SUI }]; // fake market has no USDC collateral risk model
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs, now: () => NOW, log: (lvl, msg) => void warnings.push(`${lvl}:${msg}`) });
    const got = await a.markets();
    assert.deepEqual(got.map((p) => p.pairId), ["SUI/USDC"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^warn:.*USDC\/SUI.*no collateral risk model/);
    (w.sdk.query as { getMarketPools: unknown }).getMarketPools = async () => ({ pools: { usdc: pool(), sui: pool() }, collaterals: {} });
    await assert.rejects(a.markets(), /failed for every pair/);
  });

  it("markets(): quote API down -> swapDepthUsd NaN (unknown), not 0", async () => {
    const w = fakeWorld();
    const down: PtbSwapper = { ...w.swapper, quote: async () => Promise.reject(new Error("aggregator 503")) };
    const [p] = await new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: down, pairs: [PAIR], now: () => NOW }).markets();
    assert.ok(Number.isNaN(p!.swapDepthUsd));
    assert.ok(Number.isNaN(p!.swapCostFrac));
    const [none] = await new ScallopAdapter({ env: w.env, sdk: w.sdk, pairs: [PAIR], now: () => NOW }).markets();
    assert.equal(none!.swapDepthUsd, 0); // no swapper configured: known inability, not unknown
  });

  it("markets(): veSCA boost only when the obligation is bound", async () => {
    const mk = (bound: boolean) => {
      const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9, bound });
      // measured boost of 1 in the fake account -> bound but unboosted account still reports 1
      return new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], veScaBoost: 3, now: () => NOW });
    };
    assert.equal((await mk(false).markets())[0]!.debt.borrowRewards[0]!.apr, 0.12);
    assert.equal((await mk(true).markets())[0]!.debt.borrowRewards[0]!.apr, 0.12); // measured boostValue 1 wins over config
    const w = fakeWorld({ bound: true }); // no position: nothing to measure, but also no obligation -> unboosted
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], veScaBoost: 3, now: () => NOW });
    assert.equal((await a.markets())[0]!.debt.borrowRewards[0]!.apr, 0.12);
    // bound obligation whose incentive account has no reward entries yet -> trust config (capped at max boost 4)
    const v = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9, bound: true });
    const acct = account(2.5e12, 4.5e9);
    acct.debts.usdc!.rewards = [];
    acct.borrowIncentives.usdc!.rewards = [];
    (v.sdk.query as { getObligationAccountById: unknown }).getObligationAccountById = async () => acct;
    const b = new ScallopAdapter({ env: v.env, sdk: v.sdk, swapper: v.swapper, pairs: [PAIR], veScaBoost: 3, now: () => NOW });
    assert.ok(Math.abs((await b.markets())[0]!.debt.borrowRewards[0]!.apr - 0.36) < 1e-12);
  });

  it("open(): new obligation, one flash-loan PTB in the right order, dry-run only", async () => {
    const w = fakeWorld();
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], now: () => NOW });
    const res = await a.open("SUI/USDC", 1_000n * 10n ** 9n, 0.6, w.ctx);
    assert.ok(res.ok, res.detail);
    assert.equal(res.txs.length, 1);
    assert.equal(res.txs[0]!.simulated, true);
    assert.equal(res.txs[0]!.id, undefined);
    assert.deepEqual(order(w.calls), [
      "openObligation",
      "borrowFlashLoan",
      "swap",
      "depositCollateral",
      "updateAssetPrices",
      "borrow",
      "repayFlashLoan",
      "stakeObligation",
      "returnObligation",
    ]);
    const swap = w.calls.find((c) => c.m === "swap")!;
    assert.equal(swap.args[0], USDC_T);
    assert.equal(swap.args[1], SUI_T);
    const borrowAmt = BigInt(w.calls.find((c) => c.m === "borrow")!.args[2] as number);
    const F = swap.args[2] as bigint;
    assert.ok(borrowAmt - (borrowAmt * 3n) / 1000n >= F + flashFee(F, 0.0005), "borrow nets the flash repayment");
    assert.deepEqual(w.calls.find((c) => c.m === "updateAssetPrices")!.args[0], ["sui", "usdc"]);
    assert.ok(Math.abs((res.amountUsd ?? 0) - 3000) < 1e-6);
  });

  it("open(): existing staked obligation is unstaked first and re-staked last", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 1e12, debt: 1e9 });
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], now: () => NOW });
    const res = await a.open("SUI/USDC", 500n * 10n ** 9n, 0.5, w.ctx);
    assert.ok(res.ok, res.detail);
    const o = order(w.calls);
    assert.equal(o[0], "unstakeObligationQuick");
    assert.equal(o[o.length - 1], "stakeObligationWithVeScaQuick");
    assert.ok(!o.includes("openObligation"));
  });

  it("open(): refuses above maxLtv, without swapper, with short wallet, on price deviation", async () => {
    const w = fakeWorld();
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], now: () => NOW });
    assert.equal((await a.open("SUI/USDC", 10n ** 12n, 0.85, w.ctx)).ok, false);
    const noSwap = new ScallopAdapter({ env: w.env, sdk: w.sdk, pairs: [PAIR] });
    assert.match((await noSwap.open("SUI/USDC", 10n ** 12n, 0.5, w.ctx)).detail!, /swapper/);
    const poor = fakeWorld({ balance: 1n });
    const b = new ScallopAdapter({ env: poor.env, sdk: poor.sdk, swapper: poor.swapper, pairs: [PAIR] });
    assert.match((await b.open("SUI/USDC", 10n ** 12n, 0.5, poor.ctx)).detail!, /wallet/);
    const off = fakeWorld();
    const c = new ScallopAdapter({ env: off.env, sdk: off.sdk, swapper: off.swapper, pairs: [PAIR] });
    const res = await c.open("SUI/USDC", 10n ** 12n, 0.5, { ...off.ctx, priceUsd: async (x) => (x.symbol === "SUI" ? 3.3 : 1) });
    assert.match(res.detail!, /deviation/);
    assert.equal(w.calls.length + poor.calls.length + off.calls.length, 0, "nothing built when refusing");
  });

  it("close(1): flash -> repay -> oracles -> withdraw all -> swap part -> repay flash -> rest to wallet, no re-stake", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9 });
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], now: () => NOW });
    const res = await a.close("SUI/USDC", 1, w.ctx);
    assert.ok(res.ok, res.detail);
    assert.deepEqual(order(w.calls), ["unstakeObligationQuick", "borrowFlashLoan", "repay", "updateAssetPrices", "takeCollateral", "swap", "repayFlashLoan"]);
    assert.equal(w.calls.find((c) => c.m === "takeCollateral")!.args[2], 2.5e12);
    const swap = w.calls.find((c) => c.m === "swap")!;
    assert.equal(swap.args[0], SUI_T);
    assert.ok((swap.args[3] as bigint) >= 4_500_000_000n, "swap min-out covers the debt");
    const tx = res.txs[0]!;
    assert.equal(tx.simulated, true);
    assert.ok((res.amountUsd ?? 0) > 2900 && (res.amountUsd ?? 0) < 3000, `${res.amountUsd}`); // equity back in SUI
  });

  it("close(): refuses when the debt pool has no cash for the flash loan; no position -> noop", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: false }], coll: 2.5e12, debt: 4.5e9 });
    (w.sdk.query as { getMarketPools: unknown }).getMarketPools = async () => ({
      pools: { usdc: pool({ supplyAmount: 2e12, borrowAmount: 2e12 }) },
      collaterals: { sui: collMarket() },
    });
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR] });
    assert.match((await a.close("SUI/USDC", 1, w.ctx)).detail!, /pool cash/);
    const e = fakeWorld();
    const b = new ScallopAdapter({ env: e.env, sdk: e.sdk, swapper: e.swapper, pairs: [PAIR] });
    const r = await b.close("SUI/USDC", 1, e.ctx);
    assert.ok(r.ok);
    assert.equal(r.txs.length, 0);
  });

  it("deleverage(): no-op below target, otherwise swaps exactly the withdrawal and re-stakes", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: false }], coll: 2.5e12, debt: 4.5e9 });
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR] });
    const noop = await a.deleverage("SUI/USDC", 0.7, w.ctx);
    assert.ok(noop.ok);
    assert.equal(noop.txs.length, 0);
    const res = await a.deleverage("SUI/USDC", 0.4, w.ctx);
    assert.ok(res.ok, res.detail);
    assert.deepEqual(order(w.calls), ["borrowFlashLoan", "repay", "updateAssetPrices", "takeCollateral", "swap", "repayFlashLoan", "stakeObligationWithVeScaQuick"]);
    const withdrawn = w.calls.find((c) => c.m === "takeCollateral")!.args[2] as number;
    assert.equal(BigInt(withdrawn), w.calls.find((c) => c.m === "swap")!.args[2]);
    assert.match(res.detail!, /LTV after <= 0\.4/);
  });

  it("simulateClose(): true on a passing simulation, false on abort, true with no position", async () => {
    const ok = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9 });
    assert.equal(await new ScallopAdapter({ env: ok.env, sdk: ok.sdk, swapper: ok.swapper, pairs: [PAIR] }).simulateClose("SUI/USDC", ok.ctx), true);
    const bad = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9, simFail: true });
    assert.equal(await new ScallopAdapter({ env: bad.env, sdk: bad.sdk, swapper: bad.swapper, pairs: [PAIR] }).simulateClose("SUI/USDC", bad.ctx), false);
    const none = fakeWorld();
    assert.equal(await new ScallopAdapter({ env: none.env, sdk: none.sdk, swapper: none.swapper, pairs: [PAIR] }).simulateClose("SUI/USDC", none.ctx), true);
  });

  it("position(), claimRewards(), walletBalance()", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: true }], coll: 2.5e12, debt: 4.5e9, balance: 42n });
    const a = new ScallopAdapter({ env: w.env, sdk: w.sdk, swapper: w.swapper, pairs: [PAIR], now: () => NOW });
    const pos = (await a.position("SUI/USDC"))!;
    assert.equal(pos.ltv, 0.6);
    assert.equal(pos.asOfMs, NOW);
    const c = await a.claimRewards(w.ctx);
    assert.ok(c.ok, c.detail);
    assert.deepEqual(c.claimed, [{ token: "sSCA", amount: 5_000_000_000n, decimals: 9 }]);
    assert.deepEqual(order(w.calls), ["claimBorrowIncentive"]);
    assert.deepEqual(w.calls[0]!.args, [OB_ID, KEY_ID, "ssca"]);
    assert.equal(await a.walletBalance(SUI), 42n);
    const e = fakeWorld();
    const none = await new ScallopAdapter({ env: e.env, sdk: e.sdk, pairs: [PAIR] }).claimRewards(e.ctx);
    assert.ok(none.ok);
    assert.equal(none.txs.length, 0);
  });

  it("verifyConfig(): passes on consistent chain data, fails on decimals mismatch / unowned pinned obligation", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: false }] });
    const rep = await new ScallopAdapter({ env: w.env, sdk: w.sdk, pairs: [PAIR], obligationId: OB_ID }).verifyConfig();
    assert.ok(rep.ok, JSON.stringify(rep.checks.filter((c) => !c.ok)));
    const bad = await verifyScallopConfig(w.env, w.sdk, [{ pairId: "x", collateral: { ...SUI, decimals: 8 }, debt: USDC }], { obligationIds: { x: "0x" + "99".repeat(32) } });
    assert.equal(bad.ok, false);
    const failed = bad.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.ok(failed.includes("pair:x:collateral:decimals_registry"));
    assert.ok(failed.includes("pair:x:collateral:decimals_onchain"));
    assert.ok(failed.includes("obligation:x"));
  });

  it("ltvOf helper", () => {
    assert.equal(ltvOf(10n ** 9n, 0n, prices), 0);
    assert.equal(ltvOf(0n, 1n, prices), Infinity);
  });
});

// ---------------------------------------------------------------------------
// Real SDK tx builder, offline: the SDK's own bundled TEST_ADDRESSES /
// POOL_ADDRESSES / WHITELIST are forced so init() needs no network. Proves the
// adapter's commands and the SDK's Move calls compose into ONE Transaction
// with the argument shapes the real normal methods accept. Only the quick
// methods that need RPC/Pyth (oracle update) are stubbed.
// ---------------------------------------------------------------------------

describe("ScallopAdapter x real SDK tx builder (offline)", () => {
  const moveFns = (tx: Transaction) =>
    tx.getData().commands.map((c) => (c.MoveCall ? `${c.MoveCall.module}::${c.MoveCall.function}` : c.$kind));

  async function realPtbFactory() {
    const builder = new ScallopBuilder({
      addressId: "offline-test",
      network: "mainnet",
      walletAddress: ME,
      suiClient: new SuiGrpcClient({ network: "mainnet", baseUrl: "http://127.0.0.1:9" }),
      forceAddressesInterface: { mainnet: TEST_ADDRESSES },
      forcePoolAddressInterface: POOL_ADDRESSES as unknown as Record<string, PoolAddress>,
      forceWhitelistInterface: WHITELIST,
    });
    await builder.init();
    const txs: Transaction[] = [];
    return {
      builder,
      txs,
      createPtb: () => {
        const real = builder.createTxBlock();
        const tx = real.txBlock;
        txs.push(tx);
        const stub = async () => void tx.moveCall({ target: "0x1::stub::update_prices" });
        const stx = new Proxy(real, { get: (t, prop) => (prop === "updateAssetPricesQuick" ? stub : Reflect.get(t, prop)) });
        return { tx, stx };
      },
    };
  }

  it("the SDK copies a Transaction handed to it (why the port is createPtb())", async () => {
    const f = await realPtbFactory();
    const mine = new Transaction();
    assert.notEqual(f.builder.createTxBlock(mine).txBlock, mine);
    const { tx } = f.createPtb();
    assert.ok(tx instanceof Transaction);
  });

  it("open() on a new obligation -> one PTB: open, flash, swap, deposit, oracle, borrow, repay flash, stake, return", async () => {
    const w = fakeWorld();
    const f = await realPtbFactory();
    const sdk = { ...w.sdk, createPtb: f.createPtb } as ScallopSdkLike;
    const a = new ScallopAdapter({ env: w.env, sdk, swapper: w.swapper, pairs: [{ pairId: "SUI/USDC", collateral: SUI, debt: USDC }] });
    const res = await a.open("SUI/USDC", 1_000n * 10n ** 9n, 0.6, w.ctx);
    assert.ok(res.ok, res.detail);
    assert.equal(f.txs.length, 1);
    const fns = moveFns(f.txs[0]!).filter((x) => x.includes("::"));
    assert.deepEqual(fns, [
      "open_obligation::open_obligation",
      "flash_loan::borrow_flash_loan",
      "fake::swap",
      "deposit_collateral::deposit_collateral",
      "stub::update_prices",
      "borrow::borrow",
      "flash_loan::repay_flash_loan",
      "user::stake",
      "open_obligation::return_obligation",
    ]);
    const kinds = moveFns(f.txs[0]!);
    assert.ok(kinds.includes("MergeCoins") && kinds.includes("TransferObjects"));
  });

  it("close(1) on an existing (unstaked) obligation -> one PTB with the real repay / withdraw calls", async () => {
    const w = fakeWorld({ obligations: [{ id: OB_ID, keyId: KEY_ID, locked: false }], coll: 2.5e12, debt: 4.5e9 });
    const f = await realPtbFactory();
    const sdk = { ...w.sdk, createPtb: f.createPtb } as ScallopSdkLike;
    const a = new ScallopAdapter({ env: w.env, sdk, swapper: w.swapper, pairs: [{ pairId: "SUI/USDC", collateral: SUI, debt: USDC }] });
    const res = await a.close("SUI/USDC", 1, w.ctx);
    assert.ok(res.ok, res.detail);
    const fns = moveFns(f.txs[0]!).filter((x) => x.includes("::"));
    assert.deepEqual(fns, [
      "flash_loan::borrow_flash_loan",
      "repay::repay",
      "stub::update_prices",
      "withdraw_collateral::withdraw_collateral",
      "fake::swap",
      "flash_loan::repay_flash_loan",
    ]);
    const kinds = moveFns(f.txs[0]!);
    assert.ok(kinds.includes("SplitCoins") && kinds.includes("TransferObjects"), kinds.join(","));
  });
});
