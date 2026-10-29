/**
 * Offline tests for the Aave v3 family adapter. No RPC: a stateful mock Pool
 * (supply / borrow / repay / repayWithATokens / withdraw / e-mode with LTV and
 * HF checks) stands behind a fake viem PublicClient + WalletClient, so the
 * live loop and unwind paths run end to end against it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import * as AddressBook from "@bgd-labs/aave-address-book";
import { IUiPoolDataProvider_ABI } from "@bgd-labs/aave-address-book/abis";
import type { RewardRate } from "@incentive-router/core";
import type { AssetRef, LiveContext, RewardRateQuery, SwapAdapter, SwapQuote } from "@incentive-router/live-common";
import { Mutex, viemChainFor, type EvmEnv } from "@incentive-router/live-evm-base";
import {
  AAVE_ORACLE_ABI,
  AAVE_TOKEN_ABI,
  ADDRESSES_PROVIDER_ABI,
  POOL_ABI,
  REWARDS_CONTROLLER_ABI,
} from "../src/aave/abi.js";
import { AaveV3Adapter } from "../src/aave/adapter.js";
import { aaveAdapterId, aaveAssetFromAddressBook, aaveMarketFromAddressBook, listAaveAddressBookMarkets, type AaveMarketConfig, type AavePairConfig } from "../src/aave/config.js";
import { decodeUiReservesData, detectUiReservesData, UI_LAYOUT_FIELDS, uiLayoutAbi, type UiLayout } from "../src/aave/layouts.js";
import {
  MAX_UINT256,
  RAY,
  irmFromRay,
  pairModeIn,
  planLoopSteps,
  planPairUnwind,
  planSameAssetClose,
  planSameAssetDeleverage,
  rayToApr,
  refPriceToUsd,
  rewardAprFromEmission,
  selectEMode,
  toHuman,
  unwindStep,
  wadToHealthFactor,
  type EModeCategoryInfo,
  type ReserveModeInfo,
} from "../src/aave/math.js";

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe("aave math: units / IRM / prices", () => {
  it("ray APR -> fraction", () => {
    assert.equal(rayToApr(5n * 10n ** 25n), 0.05);
    assert.equal(rayToApr(0n), 0);
    assert.ok(Math.abs(rayToApr(123456789012345678901234567n) - 0.123456789012345678) < 1e-15);
  });

  it("IRM points from ray params", () => {
    const irm = irmFromRay(
      { baseVariableBorrowRate: 0n, variableRateSlope1: 4n * 10n ** 25n, variableRateSlope2: 6n * 10n ** 26n, optimalUsageRatio: 9n * 10n ** 26n },
      1000
    )!;
    assert.deepEqual(irm.points, [
      [0, 0],
      [0.9, 0.04],
      [1, 0.64],
    ]);
    assert.equal(irm.reserveFactor, 0.1);
    assert.equal(irmFromRay({ baseVariableBorrowRate: 0n, variableRateSlope1: 0n, variableRateSlope2: 0n, optimalUsageRatio: 0n }, 1000), undefined);
  });

  it("reference-currency price -> USD", () => {
    assert.equal(refPriceToUsd(100_000_000n, 100_000_000n, 100_000_000n), 1);
    assert.equal(refPriceToUsd(99_950_000n, 100_000_000n, 100_000_000n), 0.9995);
    // 18-decimal USD base (fork): ref == unit -> USD directly
    assert.equal(refPriceToUsd(2n * 10n ** 18n, 10n ** 18n, 10n ** 18n), 2);
    // ETH-based market: 0.5 ETH at 3000 USD/ETH (8-dec feed)
    assert.equal(refPriceToUsd(5n * 10n ** 17n, 10n ** 18n, 3000n * 10n ** 8n), 1500);
  });

  it("health factor and reward APR", () => {
    assert.equal(wadToHealthFactor(MAX_UINT256), Infinity);
    assert.equal(wadToHealthFactor(1_050_000_000_000_000_000n), 1.05);
    // 1 token/s at $0.5 on a $10M pool
    const apr = rewardAprFromEmission(10n ** 18n, 18, 0.5, 10_000_000);
    assert.ok(Math.abs(apr - (31_536_000 * 0.5) / 10_000_000) < 1e-12);
    assert.equal(rewardAprFromEmission(10n ** 18n, 18, 0.5, 0), 0);
  });
});

describe("aave e-mode selection", () => {
  const C: ReserveModeInfo = { id: 1, baseLtv: 0, liquidationThreshold: 7500 };
  const D: ReserveModeInfo = { id: 0, baseLtv: 7500, liquidationThreshold: 7800 };
  const cats: EModeCategoryInfo[] = [
    { id: 1, ltv: 9000, liquidationThreshold: 9300, label: "USDe/USDT0", collateralBitmap: 0b10n, borrowableBitmap: 0b01n },
    { id: 2, ltv: 9100, liquidationThreshold: 9300, label: "USDe/USDT0,USDe", collateralBitmap: 0b10n, borrowableBitmap: 0b11n },
    { id: 3, ltv: 9500, liquidationThreshold: 9700, label: "ltv0", collateralBitmap: 0b10n, borrowableBitmap: 0b01n, ltvzeroBitmap: 0b10n },
    { id: 4, ltv: 9800, liquidationThreshold: 9900, label: "other debt", collateralBitmap: 0b10n, borrowableBitmap: 0b100n },
    { id: 5, ltv: 9900, liquidationThreshold: 9950, label: "isolated, USDe not collateral", collateralBitmap: 0b100n, borrowableBitmap: 0b01n, isolated: true },
  ];

  it("picks the highest-LTV e-mode containing both assets; skips LTV0 / non-borrowable / isolated", () => {
    const { chosen, candidates } = selectEMode(C, D, cats, false);
    assert.equal(chosen.categoryId, 2);
    assert.equal(chosen.ltv, 0.91);
    assert.equal(chosen.liqLtv, 0.93);
    assert.ok(!candidates.some((c) => c.categoryId === 4));
    assert.equal(candidates.find((c) => c.categoryId === 3)!.ltv, 0);
    assert.equal(candidates.find((c) => c.categoryId === 5)!.ltv, 0);
    assert.equal(selectEMode(C, D, cats, false, "none").chosen.categoryId, 0);
    assert.equal(selectEMode(C, D, cats, false, 1).chosen.ltv, 0.9);
    assert.throws(() => selectEMode(C, D, cats, false, 4), /does not allow/);
  });

  it("normal mode wins ties and when no e-mode helps", () => {
    const usdc: ReserveModeInfo = { id: 7, baseLtv: 7500, liquidationThreshold: 7800 };
    assert.equal(selectEMode(usdc, usdc, cats, false).chosen.categoryId, 0);
  });

  it("legacy (3.0/3.1): both reserves must share the category", () => {
    const legacyCats: EModeCategoryInfo[] = [{ id: 1, ltv: 9300, liquidationThreshold: 9500, label: "stables" }];
    const a: ReserveModeInfo = { id: 0, baseLtv: 7500, liquidationThreshold: 8000, legacyEModeCategory: 1 };
    const b: ReserveModeInfo = { id: 1, baseLtv: 7700, liquidationThreshold: 8000, legacyEModeCategory: 1 };
    const c: ReserveModeInfo = { id: 2, baseLtv: 7000, liquidationThreshold: 7500, legacyEModeCategory: 0 };
    assert.equal(selectEMode(a, b, legacyCats, true).chosen.ltv, 0.93);
    assert.equal(selectEMode(c, b, legacyCats, true).chosen.categoryId, 0);
    assert.equal(pairModeIn(1, a, c, legacyCats, true), null);
  });

  it("real address-book data: Plasma USDe -> USDT0 picks e-mode 13 (91% LTV)", () => {
    const m = (AddressBook as unknown as Record<string, { ASSETS: Record<string, { id: number }>; E_MODES: Record<string, Record<string, unknown>> }>).AaveV3Plasma!;
    const book: EModeCategoryInfo[] = Object.entries(m.E_MODES).map(([id, e]) => ({
      id: Number(id),
      ltv: Number(e.ltv),
      liquidationThreshold: Number(e.liquidationThreshold),
      label: String(e.label),
      collateralBitmap: BigInt(String(e.collateralBitmap)),
      borrowableBitmap: BigInt(String(e.borrowableBitmap)),
      ltvzeroBitmap: BigInt(String(e.ltvzeroBitmap ?? "0")),
    }));
    const usde: ReserveModeInfo = { id: m.ASSETS.USDe!.id, baseLtv: 0, liquidationThreshold: 0 };
    const usdt0: ReserveModeInfo = { id: m.ASSETS.USDT0!.id, baseLtv: 0, liquidationThreshold: 0 };
    const { chosen } = selectEMode(usde, usdt0, book, false);
    assert.equal(chosen.categoryId, 13);
    assert.equal(chosen.ltv, 0.91);
    assert.equal(chosen.liqLtv, 0.93);
  });
});

/** Replays plan steps and returns the max LTV seen after every state change. */
function replayMaxLtv(steps: ReturnType<typeof planLoopSteps>["steps"], r: number, dc: number, dd: number, S0 = 0n, D0 = 0n): number {
  let S = S0;
  let D = D0;
  let max = 0;
  const ltv = () => (S > 0n ? toHuman(D, dd) / (toHuman(S, dc) * r) : 0);
  for (const s of steps) {
    if (s.kind === "supply") S += s.amount;
    if (s.kind === "borrow") D += s.amount;
    max = Math.max(max, ltv());
  }
  return max;
}

describe("aave loop planner", () => {
  it("same asset: converges to target, never exceeds it", () => {
    const E = 1_000_000_000n; // 1000 USDC
    const t = 0.855;
    const plan = planLoopSteps(E, t, 0.9, 1, 200, { collateralDecimals: 6, debtDecimals: 6, sameAsset: true });
    assert.ok(plan.reachedTarget);
    const expected = (t / (1 - t)) * 1000;
    assert.ok(Math.abs(toHuman(plan.finalDebt, 6) - expected) < 0.01 * expected);
    assert.ok(replayMaxLtv(plan.steps, 1, 6, 6) <= t + 1e-12);
    assert.ok(plan.finalLtv <= t);
    assert.equal(plan.steps[0]!.kind, "supply");
    assert.equal(plan.totalSupplied, plan.finalCollateral);
  });

  it("few iterations: stops below target (geometric), still <= target", () => {
    const plan = planLoopSteps(1_000_000_000n, 0.855, 0.9, 1, 4, { collateralDecimals: 6, debtDecimals: 6, sameAsset: true });
    assert.equal(plan.iterations, 4);
    assert.equal(plan.reachedTarget, false);
    assert.ok(plan.finalLtv < 0.855);
  });

  it("refuses targetLtv > 0.95 x max LTV", () => {
    assert.throws(() => planLoopSteps(1n, 0.9, 0.93, 1, 8, { collateralDecimals: 6, debtDecimals: 6, sameAsset: true }), /exceeds 0.95/);
    assert.doesNotThrow(() => planLoopSteps(1n, 0.8835, 0.93, 1, 8, { collateralDecimals: 6, debtDecimals: 6, sameAsset: true }));
  });

  it("two assets with decimals 18 -> 6, swap cost and an existing position", () => {
    const E = 10_000n * 10n ** 18n; // 10k USDe
    const r = 0.9995; // USDe / USDT0
    const t = 0.86;
    const S0 = 5_000n * 10n ** 18n;
    const D0 = 3_000n * 10n ** 6n;
    const plan = planLoopSteps(E, t, 0.91, r, 100, { collateralDecimals: 18, debtDecimals: 6, swapCostFrac: 0.0005, existingCollateral: S0, existingDebt: D0 });
    assert.ok(plan.reachedTarget);
    assert.ok(replayMaxLtv(plan.steps, r, 18, 6, S0, D0) <= t + 1e-12);
    assert.ok(Math.abs(plan.finalLtv - t) < 1e-4);
    const swaps = plan.steps.filter((s) => s.kind === "swap");
    assert.ok(swaps.length > 0);
    for (const s of swaps) if (s.kind === "swap") assert.ok(s.expectedOut < (s.amount * 10n ** 12n * 10_000n) / 9995n); // cost applied
  });

  it("existing LTV above target: only supplies", () => {
    const plan = planLoopSteps(100n, 0.5, 0.9, 1, 8, { collateralDecimals: 0, debtDecimals: 0, sameAsset: true, existingCollateral: 1000n, existingDebt: 800n });
    assert.deepEqual(plan.steps, [{ kind: "supply", amount: 100n }]);
  });
});

describe("aave close planners", () => {
  it("same asset full close uses uint256.max for both txs", () => {
    assert.deepEqual(planSameAssetClose(1000n, 800n, 1), { repayWithATokens: MAX_UINT256, withdraw: MAX_UINT256, full: true });
    assert.deepEqual(planSameAssetClose(1000n, 0n, 1), { repayWithATokens: 0n, withdraw: MAX_UINT256, full: true });
  });

  it("same asset partial close keeps LTV", () => {
    const p = planSameAssetClose(10_000n, 8_000n, 0.25);
    assert.equal(p.repayWithATokens, 2_000n);
    assert.equal(p.withdraw, 500n);
    const S = 10_000n - p.repayWithATokens - p.withdraw;
    const D = 8_000n - p.repayWithATokens;
    assert.equal(Number(D) / Number(S), 0.8);
    assert.throws(() => planSameAssetClose(10n, 11n, 0.5), /underwater/);
  });

  it("same asset deleverage lands at or just below target", () => {
    const S = 10_000_000_000n;
    const D = 8_500_000_000n;
    const x = planSameAssetDeleverage(S, D, 0.6);
    const ltv = Number(D - x) / Number(S - x);
    assert.ok(ltv <= 0.6 && ltv > 0.5999);
    assert.equal(planSameAssetDeleverage(S, D, 0.9), 0n);
  });

  const P = { priceRatio: 0.9995, collateralDecimals: 18, debtDecimals: 6, swapCostFrac: 0.0003, ceilingLtv: 0.93 / 1.04 };

  it("pair full close: every post-withdraw LTV <= ceiling, debt reaches 0", () => {
    const S = 70_000n * 10n ** 18n;
    const D = 60_000n * 10n ** 6n; // LTV ~0.8576
    const plan = planPairUnwind(S, D, { fraction: 1 }, P, 100);
    assert.ok(plan.complete);
    assert.equal(plan.finalDebt, 0n);
    assert.deepEqual(plan.steps.at(-1), { kind: "withdraw", amount: MAX_UINT256 });
    let s = S;
    let d = D;
    for (const st of plan.steps) {
      if (st.kind === "withdraw" && st.amount !== MAX_UINT256) {
        s -= st.amount;
        assert.ok(toHuman(d, 6) / (toHuman(s, 18) * P.priceRatio) <= P.ceilingLtv + 1e-9);
      }
      if (st.kind === "repay") d = st.amount === MAX_UINT256 ? 0n : d - st.amount;
    }
  });

  it("pair partial close keeps LTV; deleverage reaches target", () => {
    const S = 70_000n * 10n ** 18n;
    const D = 60_000n * 10n ** 6n;
    const ltv0 = toHuman(D, 6) / (toHuman(S, 18) * P.priceRatio);
    const half = planPairUnwind(S, D, { fraction: 0.5 }, P, 100);
    assert.ok(half.complete);
    assert.ok(Math.abs(half.finalLtv - ltv0) < 1e-4);
    assert.ok(half.finalDebt <= D / 2n + 1n);
    const dl = planPairUnwind(S, D, { targetLtv: 0.5 }, P, 100);
    assert.ok(dl.complete && dl.finalLtv <= 0.5);
  });

  it("unwind step is stuck when LTV is already above the ceiling", () => {
    const st = unwindStep(100n * 10n ** 18n, 92n * 10n ** 6n, { targetDebt: 0n }, { ...P, priceRatio: 1 });
    assert.equal(st.stuck, true);
    assert.equal(st.withdraw, 0n);
  });
});

// ---------------------------------------------------------------------------
// ABIs and data-provider layouts
// ---------------------------------------------------------------------------

async function bookAbi(file: string, exportName: string): Promise<Abi> {
  const url = new URL(`../../../node_modules/@bgd-labs/aave-address-book/dist/abis/${file}.mjs`, import.meta.url);
  const mod = (await import(url.href)) as Record<string, Abi>;
  return mod[exportName]!;
}

function sameSelectors(mine: Abi, theirs: Abi, label: string) {
  const sel = (abi: Abi) => new Map(abi.filter((x): x is AbiFunction => x.type === "function").map((f) => [f.name, toFunctionSelector(f)]));
  const t = sel(theirs);
  for (const [name, s] of sel(mine)) {
    // functions newer than the address-book ABI snapshot are allowed to be missing there
    if (!t.has(name)) continue;
    assert.equal(s, t.get(name), `${label}.${name} selector differs from address book`);
  }
}

describe("aave ABIs", () => {
  it("selectors match the address-book ABIs", async () => {
    sameSelectors(POOL_ABI as unknown as Abi, await bookAbi("IPool", "IPool_ABI"), "Pool");
    sameSelectors(REWARDS_CONTROLLER_ABI as unknown as Abi, await bookAbi("IRewardsController", "IRewardsController_ABI"), "RewardsController");
    sameSelectors(AAVE_ORACLE_ABI as unknown as Abi, await bookAbi("IAaveOracle", "IAaveOracle_ABI"), "AaveOracle");
    sameSelectors(ADDRESSES_PROVIDER_ABI as unknown as Abi, await bookAbi("IPoolAddressesProvider", "IPoolAddressesProvider_ABI"), "PoolAddressesProvider");
    sameSelectors(AAVE_TOKEN_ABI as unknown as Abi, await bookAbi("IAToken", "IAToken_ABI"), "AToken");
    // the functions we call must exist in the address-book Pool ABI
    const pool = await bookAbi("IPool", "IPool_ABI");
    for (const fn of ["supply", "borrow", "repay", "repayWithATokens", "withdraw", "setUserEMode", "getUserAccountData", "getReserveData", "getEModeCategoryCollateralConfig", "getEModeCategoryLtvzeroBitmap"])
      assert.ok(pool.some((x) => x.type === "function" && x.name === fn), `address-book IPool has ${fn}`);
  });

  it("encode / decode round trips", () => {
    const asset = getAddress("0x00000000000000000000000000000000000000aa");
    const me = getAddress("0x00000000000000000000000000000000000000bb");
    const cases: { functionName: string; args: readonly unknown[] }[] = [
      { functionName: "supply", args: [asset, 123n, me, 0] },
      { functionName: "borrow", args: [asset, 5n, 2n, 0, me] },
      { functionName: "repay", args: [asset, MAX_UINT256, 2n, me] },
      { functionName: "repayWithATokens", args: [asset, MAX_UINT256, 2n] },
      { functionName: "withdraw", args: [asset, 7n, me] },
      { functionName: "setUserEMode", args: [13] },
      { functionName: "setUserUseReserveAsCollateral", args: [asset, true] },
    ];
    for (const c of cases) {
      const data = encodeFunctionData({ abi: POOL_ABI, functionName: c.functionName, args: c.args } as Parameters<typeof encodeFunctionData>[0]);
      const back = decodeFunctionData({ abi: POOL_ABI, data });
      assert.equal(back.functionName, c.functionName);
      assert.deepEqual(back.args, c.args);
    }
    const claim = encodeFunctionData({ abi: REWARDS_CONTROLLER_ABI, functionName: "claimAllRewardsToSelf", args: [[asset, me]] });
    assert.deepEqual(decodeFunctionData({ abi: REWARDS_CONTROLLER_ABI, data: claim }).args, [[asset, me]]);
  });

  it("v3.0.1 layout equals the address-book IUiPoolDataProvider struct", () => {
    const fn = (IUiPoolDataProvider_ABI as unknown as Abi).find((x) => x.type === "function" && x.name === "getReservesData") as AbiFunction;
    const comps = (fn.outputs[0] as unknown as { components: readonly { name: string; type: string }[] }).components.map((c) => [c.name, c.type]);
    assert.deepEqual(comps, UI_LAYOUT_FIELDS["v3.0.1"].map(([n, t]) => [n, t]));
  });
});

// ---------------------------------------------------------------------------
// Stateful mock Aave market
// ---------------------------------------------------------------------------

const A = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const POOL = A(0x1001);
const PROVIDER = A(0x1002);
const UI = A(0x1003);
const ORACLE = A(0x1004);
const RC = A(0x1005);
const AGG = A(0x1006);
const REWARD = A(0x1007);
const ME = A(0xbeef);
const lc = (a: string) => a.toLowerCase();

interface MockReserve {
  asset: Address;
  symbol: string;
  decimals: number;
  id: number;
  aToken: Address;
  vToken: Address;
  price: bigint; // 8 decimals
  baseLtv: number;
  lt: number;
  borrowing: boolean;
  frozen: boolean;
  paused: boolean;
  otherSupply: bigint;
  otherDebt: bigint;
  eModeCategoryId: number; // legacy layouts
}

interface MockEMode {
  id: number;
  ltv: number;
  lt: number;
  label: string;
  coll: bigint;
  borrow: bigint;
  ltvzero: bigint;
}

class MockAave {
  reserves: MockReserve[] = [];
  emodes: MockEMode[] = [];
  wallet = new Map<string, bigint>();
  allowance = new Map<string, bigint>();
  aBal = new Map<string, bigint>();
  vBal = new Map<string, bigint>();
  coll = new Set<number>();
  emode = 0;
  pendingReward = 0n;
  ltvTrace: { op: string; ltv: number }[] = [];
  providerPool: Address = POOL;
  layout: UiLayout = "v3.4";

  clone(): MockAave {
    const c = new MockAave();
    c.reserves = this.reserves.map((r) => ({ ...r }));
    c.emodes = this.emodes;
    c.wallet = new Map(this.wallet);
    c.allowance = new Map(this.allowance);
    c.aBal = new Map(this.aBal);
    c.vBal = new Map(this.vBal);
    c.coll = new Set(this.coll);
    c.emode = this.emode;
    c.pendingReward = this.pendingReward;
    c.providerPool = this.providerPool;
    c.layout = this.layout;
    return c;
  }
  res(asset: string): MockReserve {
    const r = this.reserves.find((x) => lc(x.asset) === lc(asset));
    if (!r) throw new Error(`not a reserve ${asset}`);
    return r;
  }
  bal(m: Map<string, bigint>, k: string) {
    return m.get(lc(k)) ?? 0n;
  }
  add(m: Map<string, bigint>, k: string, d: bigint) {
    const v = this.bal(m, k) + d;
    if (v < 0n) throw new Error(`balance underflow ${k}`);
    m.set(lc(k), v);
  }
  base(r: MockReserve, amt: bigint) {
    return (amt * r.price) / 10n ** BigInt(r.decimals);
  }
  params(r: MockReserve): { ltv: number; lt: number } {
    const e = this.emodes.find((x) => x.id === this.emode);
    if (e && ((e.coll >> BigInt(r.id)) & 1n) === 1n) return { ltv: ((e.ltvzero >> BigInt(r.id)) & 1n) === 1n ? 0 : e.ltv, lt: e.lt };
    return { ltv: r.baseLtv, lt: r.lt };
  }
  account() {
    let coll = 0n;
    let debt = 0n;
    let ltvW = 0n;
    let ltW = 0n;
    for (const r of this.reserves) {
      const a = this.base(r, this.bal(this.aBal, r.asset));
      if (this.coll.has(r.id) && a > 0n) {
        const p = this.params(r);
        coll += a;
        ltvW += a * BigInt(p.ltv);
        ltW += a * BigInt(p.lt);
      }
      debt += this.base(r, this.bal(this.vBal, r.asset));
    }
    const lt = coll > 0n ? ltW / coll : 0n;
    const ltv = coll > 0n ? ltvW / coll : 0n;
    const hf = debt === 0n ? MAX_UINT256 : (coll * lt * 10n ** 18n) / 10_000n / debt;
    return { coll, debt, lt, ltv, hf, maxBorrow: ltvW / 10_000n };
  }
  trace(op: string) {
    const a = this.account();
    if (a.coll > 0n) this.ltvTrace.push({ op, ltv: Number(a.debt) / Number(a.coll) });
  }
  userConfig(): bigint {
    let d = 0n;
    for (const r of this.reserves) {
      if (this.coll.has(r.id)) d |= 1n << BigInt(r.id * 2 + 1);
      if (this.bal(this.vBal, r.asset) > 0n) d |= 1n << BigInt(r.id * 2);
    }
    return d;
  }

  apply(to: Address, data: Hex) {
    if (lc(to) === lc(POOL)) {
      const { functionName, args } = decodeFunctionData({ abi: POOL_ABI, data });
      const a = args as readonly unknown[];
      switch (functionName) {
        case "supply": {
          const r = this.res(a[0] as string);
          const amt = a[1] as bigint;
          if (r.frozen || r.paused) throw new Error("RESERVE_FROZEN");
          if (this.bal(this.allowance, r.asset) < amt) throw new Error("ERC20: insufficient allowance");
          this.add(this.wallet, r.asset, -amt);
          this.add(this.allowance, r.asset, -amt);
          const first = this.bal(this.aBal, r.asset) === 0n;
          this.add(this.aBal, r.asset, amt);
          if (first && this.params(r).ltv > 0) this.coll.add(r.id);
          this.trace("supply");
          return;
        }
        case "setUserUseReserveAsCollateral": {
          const r = this.res(a[0] as string);
          if (this.bal(this.aBal, r.asset) === 0n) throw new Error("UNDERLYING_BALANCE_ZERO");
          if (a[1] && this.params(r).ltv === 0) throw new Error("LTV_VALIDATION_FAILED");
          if (a[1]) this.coll.add(r.id);
          else this.coll.delete(r.id);
          return;
        }
        case "borrow": {
          const r = this.res(a[0] as string);
          const amt = a[1] as bigint;
          if (!r.borrowing || r.frozen || r.paused) throw new Error("BORROWING_NOT_ENABLED");
          const e = this.emodes.find((x) => x.id === this.emode);
          if (e && ((e.borrow >> BigInt(r.id)) & 1n) !== 1n) throw new Error("NOT_BORROWABLE_IN_EMODE");
          this.add(this.vBal, r.asset, amt);
          this.add(this.wallet, r.asset, amt);
          const acct = this.account();
          if (acct.debt > acct.maxBorrow) throw new Error("COLLATERAL_CANNOT_COVER_NEW_BORROW");
          this.trace("borrow");
          return;
        }
        case "repay": {
          const r = this.res(a[0] as string);
          const debt = this.bal(this.vBal, r.asset);
          const amt = (a[1] as bigint) === MAX_UINT256 ? debt : (a[1] as bigint) < debt ? (a[1] as bigint) : debt;
          if (this.bal(this.allowance, r.asset) < amt) throw new Error("ERC20: insufficient allowance");
          this.add(this.wallet, r.asset, -amt);
          this.add(this.allowance, r.asset, -amt);
          this.add(this.vBal, r.asset, -amt);
          this.trace("repay");
          return;
        }
        case "repayWithATokens": {
          const r = this.res(a[0] as string);
          const debt = this.bal(this.vBal, r.asset);
          const aB = this.bal(this.aBal, r.asset);
          let amt = (a[1] as bigint) === MAX_UINT256 ? aB : (a[1] as bigint);
          if (amt > debt) amt = debt;
          this.add(this.aBal, r.asset, -amt);
          this.add(this.vBal, r.asset, -amt);
          this.trace("repayWithATokens");
          return;
        }
        case "withdraw": {
          const r = this.res(a[0] as string);
          if (r.paused) throw new Error("RESERVE_PAUSED");
          const aB = this.bal(this.aBal, r.asset);
          const amt = (a[1] as bigint) === MAX_UINT256 ? aB : (a[1] as bigint);
          this.add(this.aBal, r.asset, -amt);
          this.add(this.wallet, r.asset, amt);
          const acct = this.account();
          if (acct.debt > 0n && acct.hf < 10n ** 18n) throw new Error("HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD");
          this.trace("withdraw");
          return;
        }
        case "setUserEMode": {
          const id = Number(a[0]);
          for (const r of this.reserves) {
            if (this.bal(this.vBal, r.asset) === 0n || id === 0) continue;
            const e = this.emodes.find((x) => x.id === id)!;
            if (((e.borrow >> BigInt(r.id)) & 1n) !== 1n) throw new Error("NOT_BORROWABLE_IN_EMODE");
          }
          this.emode = id;
          for (const r of this.reserves) if (this.bal(this.aBal, r.asset) > 0n && this.params(r).ltv > 0 && !this.coll.has(r.id)) void 0;
          return;
        }
        default:
          throw new Error(`mock pool: ${functionName} not supported`);
      }
    }
    if (lc(to) === lc(RC)) {
      const { functionName } = decodeFunctionData({ abi: REWARDS_CONTROLLER_ABI, data });
      if (functionName !== "claimAllRewardsToSelf") throw new Error("mock rc");
      this.add(this.wallet, REWARD, this.pendingReward);
      this.pendingReward = 0n;
      return;
    }
    const r = this.reserves.find((x) => lc(x.asset) === lc(to));
    if (r) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
      if (functionName !== "approve") throw new Error(`mock erc20 ${functionName}`);
      const [spender, amt] = args as readonly [Address, bigint];
      if (lc(spender) !== lc(POOL)) throw new Error("approve to unexpected spender");
      this.allowance.set(lc(r.asset), amt);
      return;
    }
    throw new Error(`mock: unknown target ${to}`);
  }

  uiData(): Hex {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.reserves.map((r) => {
      const supply = r.otherSupply + this.bal(this.aBal, r.asset);
      const debt = r.otherDebt + this.bal(this.vBal, r.asset);
      const e = this.emodes.find((x) => x.id === r.eModeCategoryId);
      return {
        underlyingAsset: r.asset,
        name: r.symbol,
        symbol: r.symbol,
        decimals: BigInt(r.decimals),
        baseLTVasCollateral: BigInt(r.baseLtv),
        reserveLiquidationThreshold: BigInt(r.lt),
        reserveLiquidationBonus: 10_100n,
        reserveFactor: 1000n,
        usageAsCollateralEnabled: r.baseLtv > 0,
        borrowingEnabled: r.borrowing,
        stableBorrowRateEnabled: false,
        isActive: true,
        isFrozen: r.frozen,
        liquidityIndex: RAY,
        variableBorrowIndex: RAY,
        liquidityRate: 4n * 10n ** 25n,
        variableBorrowRate: 6n * 10n ** 25n,
        stableBorrowRate: 0n,
        lastUpdateTimestamp: now,
        aTokenAddress: r.aToken,
        stableDebtTokenAddress: zeroAddress,
        variableDebtTokenAddress: r.vToken,
        interestRateStrategyAddress: A(0x4000 + r.id),
        availableLiquidity: supply - debt,
        totalPrincipalStableDebt: 0n,
        averageStableRate: 0n,
        stableDebtLastUpdateTimestamp: 0n,
        totalScaledVariableDebt: debt,
        priceInMarketReferenceCurrency: r.price,
        priceOracle: A(0x5000 + r.id),
        variableRateSlope1: 4n * 10n ** 25n,
        variableRateSlope2: 6n * 10n ** 26n,
        stableRateSlope1: 0n,
        stableRateSlope2: 0n,
        baseStableBorrowRate: 0n,
        baseVariableBorrowRate: 0n,
        optimalUsageRatio: 9n * 10n ** 26n,
        isPaused: r.paused,
        isSiloedBorrowing: false,
        accruedToTreasury: 0n,
        unbacked: 0n,
        isolationModeTotalDebt: 0n,
        flashLoanEnabled: true,
        debtCeiling: 0n,
        debtCeilingDecimals: 2n,
        eModeCategoryId: r.eModeCategoryId,
        borrowCap: 0n,
        supplyCap: 100_000_000n,
        eModeLtv: e?.ltv ?? 0,
        eModeLiquidationThreshold: e?.lt ?? 0,
        eModeLiquidationBonus: e ? 10_100 : 0,
        eModePriceSource: zeroAddress,
        eModeLabel: e?.label ?? "",
        borrowableInIsolation: false,
        virtualAccActive: true,
        virtualUnderlyingBalance: supply - debt,
        deficit: 0n,
      };
    });
    const base = { marketReferenceCurrencyUnit: 10n ** 8n, marketReferenceCurrencyPriceInUsd: 10n ** 8n, networkBaseTokenPriceInUsd: 10n ** 8n, networkBaseTokenPriceDecimals: 8 };
    return encodeFunctionResult({ abi: uiLayoutAbi(this.layout), functionName: "getReservesData", result: [rows, base] } as Parameters<typeof encodeFunctionResult>[0]);
  }

  read(address: Address, fn: string, args: readonly unknown[] = []): unknown {
    const to = lc(address);
    if (to === lc(POOL)) {
      switch (fn) {
        case "getReservesList":
          return this.reserves.map((r) => r.asset);
        case "ADDRESSES_PROVIDER":
          return PROVIDER;
        case "getReserveData": {
          const r = this.reserves.find((x) => lc(x.asset) === lc(args[0] as string));
          return {
            configuration: { data: 0n },
            liquidityIndex: RAY,
            currentLiquidityRate: 0n,
            variableBorrowIndex: RAY,
            currentVariableBorrowRate: 0n,
            currentStableBorrowRate: 0n,
            lastUpdateTimestamp: 0,
            id: r?.id ?? 0,
            aTokenAddress: r?.aToken ?? zeroAddress,
            stableDebtTokenAddress: zeroAddress,
            variableDebtTokenAddress: r?.vToken ?? zeroAddress,
            interestRateStrategyAddress: zeroAddress,
            accruedToTreasury: 0n,
            unbacked: 0n,
            isolationModeTotalDebt: 0n,
          };
        }
        case "getUserAccountData": {
          const a = this.account();
          return [a.coll, a.debt, a.maxBorrow > a.debt ? a.maxBorrow - a.debt : 0n, a.lt, a.ltv, a.hf] as const;
        }
        case "getUserEMode":
          return BigInt(this.emode);
        case "getUserConfiguration":
          return { data: this.userConfig() };
      }
      if (fn.startsWith("getEModeCategory") || fn === "getIsEModeCategoryIsolated") {
        if (this.layout !== "v3.4") throw new Error("legacy pool: no bitmap getters");
        const e = this.emodes.find((x) => x.id === Number(args[0]));
        switch (fn) {
          case "getEModeCategoryCollateralConfig":
            return { ltv: e?.ltv ?? 0, liquidationThreshold: e?.lt ?? 0, liquidationBonus: e ? 10_100 : 0 };
          case "getEModeCategoryCollateralBitmap":
            return e?.coll ?? 0n;
          case "getEModeCategoryBorrowableBitmap":
            return e?.borrow ?? 0n;
          case "getEModeCategoryLtvzeroBitmap":
            return e?.ltvzero ?? 0n;
          case "getIsEModeCategoryIsolated":
            return false;
          case "getEModeCategoryLabel":
            return e?.label ?? "";
        }
      }
      throw new Error(`mock pool read ${fn}`);
    }
    if (to === lc(PROVIDER)) {
      if (fn === "getPool") return this.providerPool;
      if (fn === "getPriceOracle") return ORACLE;
      throw new Error(`mock provider ${fn}`);
    }
    if (to === lc(ORACLE)) {
      if (fn === "BASE_CURRENCY") return zeroAddress;
      if (fn === "BASE_CURRENCY_UNIT") return 10n ** 8n;
      if (fn === "getAssetsPrices") return (args[0] as Address[]).map((x) => this.res(x).price);
      throw new Error(`mock oracle ${fn}`);
    }
    if (to === lc(RC)) {
      if (fn === "getRewardsByAsset") return lc(args[0] as string) === lc(this.reserves[1]!.aToken) ? [REWARD] : [];
      if (fn === "getRewardsData") return [0n, 10n ** 17n, 0n, BigInt(Math.floor(Date.now() / 1000) + 86_400)] as const;
      if (fn === "getRewardOracle") return AGG;
      if (fn === "getAllUserRewards") return [[REWARD], [this.pendingReward]] as const;
      throw new Error(`mock rc ${fn}`);
    }
    if (to === lc(AGG)) {
      if (fn === "latestAnswer") return 50_000_000n;
      if (fn === "decimals") return 8;
    }
    if (to === lc(REWARD)) {
      if (fn === "symbol") return "XPL";
      if (fn === "decimals") return 18;
      if (fn === "balanceOf") return this.bal(this.wallet, REWARD);
    }
    for (const r of this.reserves) {
      if (to === lc(r.aToken) || to === lc(r.vToken)) {
        const isA = to === lc(r.aToken);
        if (fn === "balanceOf") return lc(args[0] as string) === lc(ME) ? this.bal(isA ? this.aBal : this.vBal, r.asset) : 0n;
        if (fn === "totalSupply") return isA ? r.otherSupply + this.bal(this.aBal, r.asset) : r.otherDebt + this.bal(this.vBal, r.asset);
        if (fn === "getIncentivesController") return RC;
        if (fn === "UNDERLYING_ASSET_ADDRESS") return r.asset;
      }
      if (to === lc(r.asset)) {
        if (fn === "balanceOf") return this.bal(this.wallet, r.asset);
        if (fn === "allowance") return this.bal(this.allowance, r.asset);
        if (fn === "decimals") return r.decimals;
        if (fn === "symbol") return r.symbol;
      }
    }
    throw new Error(`mock read ${address}.${fn}`);
  }
}

const USDT0 = A(0x2001);
const USDE = A(0x2002);

function makeMarket(): MockAave {
  const m = new MockAave();
  m.reserves = [
    { asset: USDT0, symbol: "USDT0", decimals: 6, id: 0, aToken: A(0x3001), vToken: A(0x3002), price: 100_000_000n, baseLtv: 7500, lt: 7800, borrowing: true, frozen: false, paused: false, otherSupply: 50_000_000n * 10n ** 6n, otherDebt: 30_000_000n * 10n ** 6n, eModeCategoryId: 1 },
    { asset: USDE, symbol: "USDe", decimals: 18, id: 1, aToken: A(0x3003), vToken: A(0x3004), price: 99_950_000n, baseLtv: 0, lt: 7500, borrowing: true, frozen: false, paused: false, otherSupply: 20_000_000n * 10n ** 18n, otherDebt: 1_000_000n * 10n ** 18n, eModeCategoryId: 1 },
  ];
  m.emodes = [
    { id: 1, ltv: 9000, lt: 9300, label: "USDe / USDT0", coll: 0b10n, borrow: 0b01n, ltvzero: 0n },
    { id: 2, ltv: 9100, lt: 9300, label: "USDe / USDT0,USDe", coll: 0b10n, borrow: 0b11n, ltvzero: 0n },
    { id: 3, ltv: 9500, lt: 9700, label: "ltv0", coll: 0b10n, borrow: 0b01n, ltvzero: 0b10n },
  ];
  m.wallet.set(lc(USDT0), 100_000n * 10n ** 6n);
  m.wallet.set(lc(USDE), 100_000n * 10n ** 18n);
  return m;
}

function makeClient(state: { m: MockAave }, opts: { simulateCalls: boolean }) {
  const client: Record<string, unknown> = {
    readContract: async (a: { address: Address; functionName: string; args?: readonly unknown[] }) => state.m.read(a.address, a.functionName, a.args),
    multicall: async (a: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) =>
      a.contracts.map((c) => {
        try {
          return { status: "success", result: state.m.read(c.address, c.functionName, c.args) };
        } catch (e) {
          return { status: "failure", error: e as Error };
        }
      }),
    call: async (a: { to: Address; data: Hex }) => {
      if (lc(a.to) === lc(UI)) return { data: state.m.uiData() };
      state.m.clone().apply(a.to, a.data);
      return { data: "0x" };
    },
    estimateGas: async () => 200_000n,
    getGasPrice: async () => 1_000_000_000n,
    getChainId: async () => 9745,
    getCode: async () => "0x6080",
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 200_000n, effectiveGasPrice: 1_000_000_000n }),
  };
  if (opts.simulateCalls)
    client.simulateCalls = async (a: { calls: { to: Address; data: Hex }[] }) => {
      const s = state.m.clone();
      return {
        results: a.calls.map((c) => {
          try {
            s.apply(c.to, c.data);
            return { status: "success", gasUsed: 150_000n };
          } catch (e) {
            return { status: "failure", gasUsed: 0n, error: e as Error };
          }
        }),
      };
    };
  return client as unknown as PublicClient;
}

class MockSwapper implements SwapAdapter {
  readonly id = "mock-swap";
  readonly chain = "plasma";
  costBps = 2;
  fail = false;
  swaps = 0;
  constructor(private readonly state: { m: MockAave }) {}
  async quote(from: AssetRef, to: AssetRef, amountIn: bigint): Promise<SwapQuote> {
    const pf = this.state.m.res(from.address).price;
    const pt = this.state.m.res(to.address).price;
    const out = (amountIn * pf * 10n ** BigInt(to.decimals) * BigInt(10_000 - this.costBps)) / (pt * 10n ** BigInt(from.decimals) * 10_000n);
    return { amountIn, amountOut: out, costBps: this.costBps, route: "mock", validUntilMs: Date.now() + 30_000 };
  }
  async swap(q: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext) {
    if (ctx.dryRun) return { ok: true, txs: [{ chain: "plasma", description: "swap", simulated: true }] };
    if (this.fail) return { ok: false, txs: [], detail: "mock swap failure" };
    this.state.m.add(this.state.m.wallet, from.address, -q.amountIn);
    this.state.m.add(this.state.m.wallet, to.address, q.amountOut);
    this.swaps++;
    return { ok: true, txs: [{ chain: "plasma", id: "0xswap", description: "swap", simulated: false }] };
  }
}

const usdt0: AssetRef = { chain: "plasma", symbol: "USDT0", address: USDT0, decimals: 6 };
const usde: AssetRef = { chain: "plasma", symbol: "USDe", address: USDE, decimals: 18 };
const market: AaveMarketConfig = { protocol: "aave-v3", chain: "plasma", pool: POOL, poolAddressesProvider: PROVIDER, uiPoolDataProvider: UI };
const pairs: AavePairConfig[] = [
  { pairId: "USDT0/USDT0", collateral: usdt0, debt: usdt0 },
  { pairId: "USDe/USDT0", collateral: usde, debt: usdt0 },
];
const ctx = (dryRun: boolean): LiveContext => ({
  dryRun,
  log: () => {},
  limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 30, maxLoopIterations: 8 },
  priceUsd: async () => 1,
  nativePriceUsd: async () => 1,
});

function setup(opts: { simulateCalls?: boolean; extra?: boolean; layout?: UiLayout } = {}) {
  const state = { m: makeMarket() };
  if (opts.layout) state.m.layout = opts.layout;
  const publicClient = makeClient(state, { simulateCalls: opts.simulateCalls ?? true });
  const walletClient = {
    account: { address: ME },
    sendTransaction: async (a: { to: Address; data: Hex }) => {
      state.m.apply(a.to, a.data);
      return "0xabc" as Hex;
    },
  } as unknown as WalletClient;
  const env: EvmEnv = { chain: "plasma", viemChain: viemChainFor("plasma", "http://127.0.0.1:1"), publicClient, walletClient, account: ME, lock: new Mutex() };
  const swapper = new MockSwapper(state);
  const merkl: RewardRate = { token: "USDe-merkl", apr: 0.05, maxHealthFactor: 2 };
  const queries: RewardRateQuery[] = [];
  const logs: { level: string; msg: string }[] = [];
  const adapter = new AaveV3Adapter({
    env,
    market,
    pairs,
    swapper,
    log: (level, msg) => logs.push({ level, msg }),
    // Merkl-style provider: matches only by receipt token (aToken / variableDebtToken), like rewards/merklRates.ts
    extraRewards:
      opts.extra === false
        ? undefined
        : async (q) => {
            queries.push(q);
            return q.side === "supply" && lc(q.marketId ?? "") === lc(state.m.res(USDE).aToken) ? [merkl] : [];
          },
  });
  return { state, adapter, swapper, queries, logs };
}

const maxTrace = (m: MockAave) => Math.max(0, ...m.ltvTrace.map((t) => t.ltv));

describe("AaveV3Adapter (mock chain)", () => {
  it("rejects a two-asset pair without a swapper and a wrong-chain env", () => {
    const { adapter } = setup();
    assert.equal(adapter.id, "aave-v3:plasma");
    const env = { chain: "plasma" } as EvmEnv;
    assert.throws(() => new AaveV3Adapter({ env, market, pairs }), /needs a swapper/);
    assert.throws(() => new AaveV3Adapter({ env: { chain: "base" } as EvmEnv, market, pairs: [pairs[0]!] }), /env chain/);
  });

  it("markets(): e-mode choice, rates, IRM, rewards, swap metrics, flags", async () => {
    const { state, adapter } = setup();
    const out = await adapter.markets();
    assert.equal(out.length, 2);
    const same = out.find((p) => p.pairId === "USDT0/USDT0")!;
    const pair = out.find((p) => p.pairId === "USDe/USDT0")!;
    assert.equal(same.maxLtv, 0.75);
    assert.equal(same.collateral, same.debt);
    assert.equal(same.swapCostFrac, 0);
    assert.equal(same.swapDepthUsd, Infinity);
    assert.equal(pair.maxLtv, 0.91);
    assert.equal(pair.liqLtv, 0.93);
    assert.equal(adapter.diagnostics("USDe/USDT0")!.eMode.categoryId, 2);
    assert.equal(adapter.diagnostics("USDe/USDT0")!.layout, "v3.4");
    assert.equal(pair.collateral.supplyAprBase, 0.04);
    assert.equal(pair.debt.borrowAprBase, 0.06);
    assert.deepEqual(pair.debt.irm!.points, [
      [0, 0],
      [0.9, 0.04],
      [1, 0.64],
    ]);
    assert.ok(Math.abs(pair.collateral.priceUsd - 0.9995) < 1e-12);
    assert.ok(Math.abs(pair.collateral.totalSupplyUsd - 20_000_000 * 0.9995) < 1e-3);
    assert.ok(Math.abs(pair.debt.totalBorrowUsd - 30_000_000) < 1e-6);
    // native XPL stream: 0.1 XPL/s at $0.5 on the USDe supply pool, plus the Merkl stream
    const xpl = pair.collateral.supplyRewards.find((r) => r.token === "XPL")!;
    assert.ok(Math.abs(xpl.apr - (0.1 * 31_536_000 * 0.5) / (20_000_000 * 0.9995)) < 1e-9);
    assert.ok(xpl.endsAtMs! > Date.now());
    assert.ok(pair.collateral.supplyRewards.some((r) => r.token === "USDe-merkl" && r.maxHealthFactor === 2));
    assert.equal(pair.swapCostFrac, 0.0002);
    assert.equal(pair.swapDepthUsd, 1_000_000);
    assert.equal(pair.paused, false);
    assert.ok(Math.abs(pair.collateral.supplyCapRemainingUsd! - 80_000_000 * 0.9995) < 1e-3);
    assert.ok(pair.debt.borrowCapRemainingUsd! > 0);

    state.m.reserves[1]!.frozen = true;
    const frozen = (await adapter.markets()).find((p) => p.pairId === "USDe/USDT0")!;
    assert.equal(frozen.paused, true);
    assert.ok(adapter.diagnostics("USDe/USDT0")!.pausedReasons.some((r) => r.includes("frozen")));
  });

  it("markets(): legacy 3.0.1 data provider -> per-reserve e-modes", async () => {
    const { adapter } = setup({ layout: "v3.0.1" });
    const pair = (await adapter.markets()).find((p) => p.pairId === "USDe/USDT0")!;
    assert.equal(adapter.diagnostics("USDe/USDT0")!.layout, "v3.0.1");
    assert.equal(pair.maxLtv, 0.9);
    assert.equal(adapter.diagnostics("USDe/USDT0")!.eMode.categoryId, 1);
  });

  it("layout detection round trip for every layout", () => {
    const m = makeMarket();
    for (const l of ["v3.4", "v3.3", "v3.2", "v3.1", "v3.0.1", "v3.0.0-silo", "v3.0.0"] as UiLayout[]) {
      m.layout = l;
      const d = detectUiReservesData(m.uiData(), m.reserves.map((r) => r.asset));
      assert.equal(d.layout, l);
      assert.equal(d.reserves[1]!.symbol, "USDe");
      assert.equal(d.reserves[1]!.decimals, 18);
      assert.equal(decodeUiReservesData(m.uiData(), l).reserves.length, 2);
    }
    assert.throws(() => detectUiReservesData(m.uiData(), [USDE]), /no known layout/);
  });

  it("open dry-run: whole same-asset loop simulated in one eth_simulateV1 batch; state untouched", async () => {
    const { state, adapter } = setup();
    const before = state.m.bal(state.m.wallet, USDT0);
    const r = await adapter.open("USDT0/USDT0", 1_000n * 10n ** 6n, 0.7, ctx(true));
    assert.equal(r.ok, true, r.detail);
    assert.ok(r.txs.length > 10);
    assert.ok(r.txs.every((t) => t.simulated));
    assert.match(r.detail!, /eth_simulateV1/);
    assert.equal(state.m.bal(state.m.wallet, USDT0), before);
    assert.equal(state.m.bal(state.m.aBal, USDT0), 0n);
  });

  it("open dry-run without eth_simulateV1: only step 1, plan in detail", async () => {
    const { adapter } = setup({ simulateCalls: false });
    const r = await adapter.open("USDe/USDT0", 1_000n * 10n ** 18n, 0.86, ctx(true));
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.txs.length, 1);
    assert.match(r.detail!, /only step 1 simulated/);
    assert.match(r.detail!, /first swap quoted/);
    assert.match(r.detail!, /e-mode 2/);
  });

  it("open refuses targetLtv > 0.95 x LTV and frozen markets", async () => {
    const { state, adapter } = setup();
    const r = await adapter.open("USDT0/USDT0", 1_000n * 10n ** 6n, 0.72, ctx(true));
    assert.equal(r.ok, false);
    assert.match(r.detail!, /0.95 x LTV 0.75/);
    state.m.reserves[1]!.frozen = true;
    const f = await adapter.open("USDe/USDT0", 1_000n * 10n ** 18n, 0.8, ctx(true));
    assert.equal(f.ok, false);
    assert.match(f.detail!, /frozen/);
  });

  it("extraRewards queries carry the receipt token as marketId (aToken supply, variableDebtToken borrow)", async () => {
    const { state, adapter, queries } = setup();
    const out = await adapter.markets();
    const q = (sym: string, side: string) => queries.filter((x) => x.asset.symbol === sym && x.side === side);
    const usdeSupply = q("USDe", "supply");
    assert.equal(usdeSupply.length, 1);
    assert.deepEqual(usdeSupply[0], { protocol: "aave-v3", chain: "plasma", asset: usde, side: "supply", marketId: state.m.res(USDE).aToken });
    // borrow side of USDT0 (pair debt leg and same-asset loop) -> variableDebtToken
    const usdtBorrow = q("USDT0", "borrow");
    assert.ok(usdtBorrow.length >= 1);
    for (const x of usdtBorrow) assert.equal(x.marketId, state.m.res(USDT0).vToken);
    // same-asset loop supply side -> USDT0 aToken
    assert.deepEqual(q("USDT0", "supply").map((x) => x.marketId), [state.m.res(USDT0).aToken]);
    for (const x of queries) assert.ok(x.marketId, "every query has a marketId");
    // the receipt-matched campaign reaches the collateral leg
    const pair = out.find((p) => p.pairId === "USDe/USDT0")!;
    assert.ok(pair.collateral.supplyRewards.some((r) => r.token === "USDe-merkl"));
  });

  it("live same-asset loop: LTV never above target; close x1 = repayWithATokens(max) + withdraw(max)", async () => {
    const { state, adapter, logs } = setup();
    const t = 0.7;
    const r = await adapter.open("USDT0/USDT0", 1_000n * 10n ** 6n, t, ctx(false));
    assert.equal(r.ok, true, r.detail);
    // 8 iterations capped at the target cannot reach 0.7 (geometric): shortfall is reported
    assert.match(r.detail!, /BELOW TARGET \(iteration cap 8\): achieved LTV 0\.6\d+ \/ leverage 3\.\d+x vs target LTV 0\.7 \/ 3\.33x/);
    assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("BELOW TARGET")));
    assert.ok(maxTrace(state.m) <= t + 1e-9, `max ltv ${maxTrace(state.m)}`);
    const pos = (await adapter.position("USDT0/USDT0"))!;
    assert.ok(pos.ltv > 0.6 && pos.ltv <= t);
    assert.ok(Math.abs(pos.equityUsd - 1000) < 1e-6);
    assert.ok(pos.healthFactor! > 1);

    const dl = await adapter.deleverage("USDT0/USDT0", 0.3, ctx(false));
    assert.equal(dl.ok, true, dl.detail);
    assert.equal(dl.txs.length, 1);
    assert.ok((await adapter.position("USDT0/USDT0"))!.ltv <= 0.3);

    const c = await adapter.close("USDT0/USDT0", 1, ctx(false));
    assert.equal(c.ok, true, c.detail);
    assert.equal(c.txs.length, 2);
    assert.equal(await adapter.position("USDT0/USDT0"), null);
    assert.equal(state.m.bal(state.m.wallet, USDT0), 100_000n * 10n ** 6n);
  });

  it("live USDe -> USDT0 loop and full unwind through the swapper", async () => {
    const { state, adapter, swapper } = setup();
    const t = 0.86;
    const r = await adapter.open("USDe/USDT0", 10_000n * 10n ** 18n, t, ctx(false));
    assert.equal(r.ok, true, r.detail);
    assert.equal(state.m.emode, 2);
    assert.ok(state.m.coll.has(1));
    assert.ok(maxTrace(state.m) <= t + 1e-9, `max ltv ${maxTrace(state.m)}`);
    const pos = (await adapter.position("USDe/USDT0"))!;
    assert.ok(pos.ltv > 0.7 && pos.ltv <= t, `ltv ${pos.ltv}`);
    assert.ok(pos.collateralUsd > 40_000);
    assert.ok(swapper.swaps >= 8);
    assert.equal(await adapter.simulateClose("USDe/USDT0", ctx(false)), true);

    // half close keeps the LTV
    const half = await adapter.close("USDe/USDT0", 0.5, ctx(false));
    assert.equal(half.ok, true, half.detail);
    const pos2 = (await adapter.position("USDe/USDT0"))!;
    assert.ok(Math.abs(pos2.ltv - pos.ltv) < 0.002, `${pos2.ltv} vs ${pos.ltv}`);
    assert.ok(pos2.debtUsd < pos.debtUsd * 0.51);

    state.m.ltvTrace = [];
    const c = await adapter.close("USDe/USDT0", 1, ctx(false));
    assert.equal(c.ok, true, c.detail);
    assert.equal(state.m.bal(state.m.aBal, USDE), 0n);
    assert.equal(state.m.bal(state.m.vBal, USDT0), 0n);
    const ceiling = 0.93 / 1.04;
    for (const tr of state.m.ltvTrace.filter((x) => x.op === "withdraw")) assert.ok(tr.ltv <= ceiling + 1e-6, `withdraw ltv ${tr.ltv}`);
    // equity back minus swap costs (2 bps per swap on the looped part) and the 0.9995 price
    const got = toHuman(state.m.bal(state.m.wallet, USDE), 18) - 90_000;
    assert.ok(got > 9_950 && got <= 10_000, `got ${got}`);
    // repay buffer sold back: no meaningful USDT0 left over
    assert.ok(state.m.bal(state.m.wallet, USDT0) - 100_000n * 10n ** 6n < 1_000_000n);
  });

  it("swap failure during open rolls the borrow back", async () => {
    const { state, adapter, swapper } = setup();
    swapper.fail = true;
    const r = await adapter.open("USDe/USDT0", 1_000n * 10n ** 18n, 0.8, ctx(false));
    assert.equal(r.ok, false);
    assert.match(r.detail!, /rolled back/);
    assert.equal(state.m.bal(state.m.vBal, USDT0), 0n);
    assert.equal(state.m.bal(state.m.aBal, USDE), 1_000n * 10n ** 18n);
  });

  it("pair deleverage reaches the target LTV", async () => {
    const { adapter } = setup();
    assert.equal((await adapter.open("USDe/USDT0", 10_000n * 10n ** 18n, 0.86, ctx(false))).ok, true);
    const d = await adapter.deleverage("USDe/USDT0", 0.5, ctx(false));
    assert.equal(d.ok, true, d.detail);
    const pos = (await adapter.position("USDe/USDT0"))!;
    assert.ok(pos.ltv <= 0.5 && pos.ltv > 0.45, `ltv ${pos.ltv}`);
  });

  it("markets() reports the account's e-mode while debt is open; incompatible e-mode pauses the pair", async () => {
    const { state, adapter } = setup();
    assert.equal((await adapter.open("USDe/USDT0", 1_000n * 10n ** 18n, 0.8, ctx(false))).ok, true);
    state.m.emode = 1; // e.g. set by another tool: 90% instead of the best 91%
    let pair = (await adapter.markets()).find((p) => p.pairId === "USDe/USDT0")!;
    assert.equal(pair.maxLtv, 0.9);
    assert.equal(pair.paused, false);
    assert.ok(pair.myLtv! > 0.7 && pair.myLtv! <= 0.8);
    state.m.emode = 3; // USDe is LTV0 there
    pair = (await adapter.markets()).find((p) => p.pairId === "USDe/USDT0")!;
    assert.equal(pair.paused, true);
    assert.ok(adapter.diagnostics("USDe/USDT0")!.pausedReasons.some((r) => r.includes("account is in e-mode 3")));
    const r = await adapter.open("USDe/USDT0", 100n * 10n ** 18n, 0.8, ctx(true));
    assert.equal(r.ok, false);
  });

  it("simulateClose: false when a reserve is paused; dry-run close batches both steps", async () => {
    const { state, adapter } = setup();
    assert.equal((await adapter.open("USDT0/USDT0", 1_000n * 10n ** 6n, 0.7, ctx(false))).ok, true);
    const dry = await adapter.close("USDT0/USDT0", 1, ctx(true));
    assert.equal(dry.ok, true, dry.detail);
    assert.equal(dry.txs.length, 2);
    assert.ok(state.m.bal(state.m.aBal, USDT0) > 0n);
    assert.equal(await adapter.simulateClose("USDT0/USDT0", ctx(false)), true);
    state.m.reserves[0]!.paused = true;
    assert.equal(await adapter.simulateClose("USDT0/USDT0", ctx(false)), false);
  });

  it("claimRewards claims through the RewardsController", async () => {
    const { state, adapter } = setup();
    assert.equal((await adapter.open("USDe/USDT0", 1_000n * 10n ** 18n, 0.5, ctx(false))).ok, true);
    state.m.pendingReward = 3n * 10n ** 18n;
    const pos = (await adapter.position("USDe/USDT0"))!;
    assert.deepEqual(pos.rewardsUnclaimed, [{ token: "XPL", amount: 3n * 10n ** 18n, decimals: 18, usd: 1.5 }]);
    const r = await adapter.claimRewards(ctx(false), "USDe/USDT0");
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(r.claimed, [{ token: "XPL", amount: 3n * 10n ** 18n, decimals: 18 }]);
    assert.equal(state.m.bal(state.m.wallet, REWARD), 3n * 10n ** 18n);
    const again = await adapter.claimRewards(ctx(false));
    assert.equal(again.txs.length, 0);
  });

  it("verifyConfig reads the relationships back", async () => {
    const { state, adapter } = setup();
    assert.deepEqual(await adapter.verifyConfig(), []);
    state.m.providerPool = A(0xdead);
    const issues = await adapter.verifyConfig();
    assert.ok(issues.some((i) => i.includes("provider.getPool()")), issues.join("\n"));
    const bad = new AaveV3Adapter({
      env: (adapter as unknown as { env: EvmEnv }).env,
      market: { ...market, evmChainId: 1 },
      pairs: [{ pairId: "X/X", collateral: { chain: "plasma", symbol: "X", address: A(0x9999), decimals: 6 }, debt: { chain: "plasma", symbol: "X", address: A(0x9999), decimals: 6 } }],
    });
    state.m.providerPool = POOL;
    const issues2 = await bad.verifyConfig();
    assert.ok(issues2.some((i) => i.includes("evmChainId 1")));
    assert.ok(issues2.some((i) => i.includes("not a reserve")), issues2.join("\n"));
  });
});

describe("aave address book helpers", () => {
  it("lists markets and builds configs from the book", () => {
    const all = listAaveAddressBookMarkets();
    for (const n of ["AaveV3Ethereum", "AaveV3EthereumLido", "AaveV3Arbitrum", "AaveV3Base", "AaveV3Plasma", "AaveV3Mantle", "AaveV3Sonic"])
      assert.ok(all.some((m) => m.name === n), n);
    const plasma = aaveMarketFromAddressBook("AaveV3Plasma");
    assert.equal(plasma.chain, "plasma");
    assert.equal(plasma.evmChainId, 9745);
    assert.equal(aaveAdapterId(plasma), "aave-v3:plasma");
    const lido = aaveMarketFromAddressBook("AaveV3EthereumLido");
    assert.equal(aaveAdapterId(lido), "aave-v3:ethereum:lido");
    assert.equal(aaveAdapterId(aaveMarketFromAddressBook("AaveV3Ethereum")), "aave-v3:ethereum");
    assert.equal(aaveAdapterId(aaveMarketFromAddressBook("AaveV3BNB")), "aave-v3:bsc");
    assert.throws(() => aaveMarketFromAddressBook("AaveV3Monad"), /no market/);
    assert.throws(() => aaveMarketFromAddressBook("AaveV3Celo"), /not in live-common CHAINS/);
    const u = aaveAssetFromAddressBook("AaveV3Plasma", "USDe");
    assert.equal(u.decimals, 18);
    assert.equal(u.chain, "plasma");
  });
});
