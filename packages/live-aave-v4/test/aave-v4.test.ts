import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import { bigDecimal, RewardAccrualBasis, type ExecutionPlan } from "@aave/client";
import { DEFAULT_CONFIG, loopPairOpportunity, validateOpportunity } from "@incentive-router/core";
import {
  apyToApr,
  borrowAprWithRiskPremium,
  capRemaining,
  checkExecutionPlan,
  checkTx,
  hubSupplyApr,
  irmFromRateData,
  mapLoopPair,
  parseHealthFactorCriterion,
  planLoopSteps,
  planUnwind,
  rewardsFromApiReserve,
  SPOKE_ABI,
  unwindStep,
  type ReserveMarketData,
  type TxGuardPolicy,
} from "../src/index.js";
import { MAX_SPOKE_CAP, MAX_UINT256, RAY } from "../src/math.js";

const ME = getAddress("0x1111111111111111111111111111111111111111");
const SPOKE = getAddress("0x2222222222222222222222222222222222222222");
const USDE = getAddress("0x3333333333333333333333333333333333333333");
const USDT = getAddress("0x4444444444444444444444444444444444444444");
const EVIL = getAddress("0x6666666666666666666666666666666666666666");
const PM = getAddress("0x7777777777777777777777777777777777777777");

const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------
describe("rates", () => {
  it("APY -> APR (daily compounding) is below the APY and inverts compounding", () => {
    const apr = apyToApr(0.1);
    close(apr, 365 * (Math.pow(1.1, 1 / 365) - 1), 1e-15);
    assert.ok(apr < 0.1 && apr > Math.log(1.1));
    close(Math.pow(1 + apr / 365, 365) - 1, 0.1, 1e-12);
    assert.equal(apyToApr(0), 0);
    assert.throws(() => apyToApr(Number.NaN));
  });

  it("risk premium multiplies the drawn rate", () => {
    close(borrowAprWithRiskPremium(0.04, 0.25), 0.05);
    close(borrowAprWithRiskPremium(0.04, 0), 0.04);
    assert.throws(() => borrowAprWithRiskPremium(0.04, -0.1));
  });

  it("hub supply APR = drawnRate * owed * (1 - fee) / added", () => {
    const drawnRateRay = (5n * RAY) / 100n;
    close(hubSupplyApr({ drawnRateRay, drawn: 800n, premium: 0n, addedAssets: 1000n, liquidityFeeBps: 1000 }), 0.036, 1e-12);
    close(hubSupplyApr({ drawnRateRay, drawn: 800n, premium: 100n, addedAssets: 1000n, liquidityFeeBps: 0 }), 0.045, 1e-12);
    assert.equal(hubSupplyApr({ drawnRateRay, drawn: 1n, premium: 0n, addedAssets: 0n, liquidityFeeBps: 0 }), 0);
  });

  it("IRM points from on-chain rate data (BPS), scaled by 1 + risk premium", () => {
    const irm = irmFromRateData({ optimalUsageRatio: 9000, baseDrawnRate: 0, rateGrowthBeforeOptimal: 400, rateGrowthAfterOptimal: 6000 }, 1000, 1.25)!;
    assert.deepEqual(irm.points.map(([u]) => u), [0, 0.9, 1]);
    close(irm.points[1]![1], 0.05);
    close(irm.points[2]![1], 0.8);
    close(irm.reserveFactor, 0.1);
    assert.equal(irmFromRateData({ optimalUsageRatio: 0, baseDrawnRate: 0, rateGrowthBeforeOptimal: 0, rateGrowthAfterOptimal: 0 }, 0), undefined);
  });

  it("caps in whole tokens; MAX = uncapped", () => {
    assert.equal(capRemaining(MAX_SPOKE_CAP, 6, 123n), null);
    assert.equal(capRemaining(1000n, 6, 400_000_000n), 600_000_000n);
    assert.equal(capRemaining(1000n, 6, 2_000_000_000n), 0n);
  });
});

// ---------------------------------------------------------------------------
describe("loop planner", () => {
  const opts = { collateralDecimals: 18, debtDecimals: 6, swapCostFrac: 0.001, minBorrow: 1_000_000n };
  const E = 10_000n * 10n ** 18n;

  it("never exceeds the target LTV and converges toward t*C/(1-t*(1-s))", () => {
    const t = 0.75;
    const p = planLoopSteps(E, t, 0.93, 1, 40, opts);
    assert.ok(p.maxLtvSeen <= t, `max ${p.maxLtvSeen}`);
    for (const s of p.steps) if (s.kind === "borrow") assert.ok(s.ltvAfter <= t);
    assert.ok(p.finalLtv < t && p.finalLtv > 0.74);
    const Dt = (t * 10_000) / (1 - t * (1 - 0.001));
    const D = Number(p.finalDebt) / 1e6;
    assert.ok(D <= Dt && D > Dt * 0.99, `${D} vs ${Dt}`);
    assert.equal(p.steps[0]!.kind, "supply");
  });

  it("respects maxIterations and minBorrow", () => {
    const p = planLoopSteps(E, 0.75, 0.93, 1, 3, opts);
    assert.equal(p.iterations, 3);
    const tiny = planLoopSteps(1n * 10n ** 18n, 0.75, 0.93, 1, 10, opts); // $1 equity, minBorrow $1
    assert.equal(tiny.iterations, 0);
  });

  it("refuses targetLtv above 0.95 x collateral factor", () => {
    assert.throws(() => planLoopSteps(E, 0.9, 0.93, 1, 5, opts), /exceeds 0.95/);
    assert.doesNotThrow(() => planLoopSteps(E, 0.8835, 0.93, 1, 5, opts));
  });

  it("price ratio: a debt asset worth more than the collateral borrows fewer units", () => {
    const a = planLoopSteps(E, 0.5, 0.9, 1, 1, opts);
    const b = planLoopSteps(E, 0.5, 0.9, 0.5, 1, opts); // collateral worth half a debt unit
    const borrowA = (a.steps.find((s) => s.kind === "borrow") as { amount: bigint }).amount;
    const borrowB = (b.steps.find((s) => s.kind === "borrow") as { amount: bigint }).amount;
    assert.ok(borrowB < borrowA && borrowB > (borrowA * 49n) / 100n);
  });

  it("existing debt above target -> no borrow", () => {
    const p = planLoopSteps(0n, 0.5, 0.9, 1, 5, { ...opts, existingCollateral: E, existingDebt: 6_000n * 10n ** 6n });
    assert.equal(p.iterations, 0);
  });
});

// ---------------------------------------------------------------------------
describe("unwind planner", () => {
  const params = { collateralDecimals: 18, debtDecimals: 6, priceRatio: 1, liqLtv: 0.93, minHealthFactor: 1.04, swapCostFrac: 0.001 };
  const C = 40_000n * 10n ** 18n;
  const D = 30_000n * 10n ** 6n;

  it("full close: debt to 0 then withdraw max, HF >= floor at every step", () => {
    const p = planUnwind(C, D, { kind: "close" }, params, 100);
    assert.ok(p.feasible, p.reason);
    assert.equal(p.finalDebt, 0n);
    const last = p.steps[p.steps.length - 1]!;
    assert.deepEqual(last.kind === "withdraw" && last.withdraw, "max");
    assert.ok(p.minHealthFactorSeen >= 1.04 - 1e-9, `min HF ${p.minHealthFactorSeen}`);
    for (const s of p.steps) if (s.kind === "withdraw-repay") assert.ok(0.93 / s.ltvAfterWithdraw >= 1.04 - 1e-9);
  });

  it("never withdraws 'max' while 1 wei of debt remains", () => {
    const s = unwindStep(C, 1n, { kind: "close" }, params);
    assert.equal(s.kind, "withdraw-repay");
  });

  it("fraction: removes ~f of debt and collateral, keeps LTV <= start", () => {
    const p = planUnwind(C, D, { kind: "fraction", fraction: 0.5, startCollateral: C, startDebt: D }, params, 100);
    assert.ok(p.feasible, p.reason);
    assert.ok(p.finalDebt <= D / 2n);
    const ltv = Number(p.finalDebt) / 1e6 / (Number(p.finalCollateral) / 1e18);
    assert.ok(ltv <= 0.75 + 1e-9, `ltv ${ltv}`);
    assert.ok(Number(p.finalCollateral) / 1e18 <= 20_000 + 1e-6);
  });

  it("ltv goal: stops at the target", () => {
    const p = planUnwind(C, D, { kind: "ltv", targetLtv: 0.6 }, params, 100);
    assert.ok(p.feasible);
    const ltv = Number(p.finalDebt) / 1e6 / (Number(p.finalCollateral) / 1e18);
    assert.ok(ltv <= 0.6 + 1e-6 && ltv > 0.55, `ltv ${ltv}`);
    assert.equal(unwindStep(C, D, { kind: "ltv", targetLtv: 0.8 }, params).kind, "done");
  });

  it("stuck when LTV is already above CF / minHF (needs an external repay)", () => {
    const s = unwindStep(C, 36_000n * 10n ** 6n, { kind: "close" }, params); // LTV 0.9 > 0.93/1.04
    assert.equal(s.kind, "stuck");
  });

  it("emergency floor: still unwinds above CF / minHF, never below the emergency HF, and the LTV falls", () => {
    const D9 = 36_000n * 10n ** 6n; // LTV 0.9
    const p = { ...params, emergencyMinHealthFactor: 1.01 };
    const s = unwindStep(C, D9, { kind: "close" }, p);
    assert.equal(s.kind, "withdraw-repay");
    assert.ok(s.kind === "withdraw-repay" && s.emergency && 0.93 / s.ltvAfterWithdraw >= 1.01 - 1e-9 && s.ltvAfterRepay < 0.9);
    const plan = planUnwind(C, D9, { kind: "close" }, p, 400);
    assert.ok(plan.feasible, plan.reason);
    assert.equal(plan.finalDebt, 0n);
    assert.ok(plan.minHealthFactorSeen >= 1.01 - 1e-9);
    // above CF / emergency floor nothing can be withdrawn
    assert.equal(unwindStep(C, 37_000n * 10n ** 6n, { kind: "close" }, p).kind, "stuck");
  });
});

// ---------------------------------------------------------------------------
describe("tx guard", () => {
  const policy: TxGuardPolicy = { chainId: 43114, account: ME, spokes: [SPOKE], positionManagers: [PM], tokens: [USDE, USDT] };
  const enc = (fn: "supply" | "borrow" | "repay" | "withdraw", id: bigint, amt: bigint, who: Address = ME) =>
    encodeFunctionData({ abi: SPOKE_ABI, functionName: fn, args: [id, amt, who] });
  const approve = (spender: Address, amt: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amt] });

  it("accepts exactly what we asked for", () => {
    assert.deepEqual(checkTx({ to: USDE, data: approve(SPOKE, 5n) }, { kind: "approve", token: USDE, spender: SPOKE, amount: 5n }, policy), []);
    assert.deepEqual(checkTx({ to: SPOKE, data: enc("supply", 1n, 5n) }, { kind: "spoke", spoke: SPOKE, calls: [{ fn: "supply", reserveId: 1n, amount: 5n }] }, policy), []);
    const mc = encodeFunctionData({
      abi: SPOKE_ABI,
      functionName: "multicall",
      args: [[enc("supply", 1n, 5n), encodeFunctionData({ abi: SPOKE_ABI, functionName: "setUsingAsCollateral", args: [1n, true, ME] }), enc("borrow", 2n, 3n)]],
    });
    assert.deepEqual(
      checkTx({ to: SPOKE, data: mc, from: ME, chainId: 43114, value: 0n }, {
        kind: "spoke",
        spoke: SPOKE,
        calls: [
          { fn: "supply", reserveId: 1n, amount: 5n },
          { fn: "setUsingAsCollateral", reserveId: 1n, enabled: true },
          { fn: "borrow", reserveId: 2n, amount: 3n },
        ],
      }, policy),
      []
    );
  });

  it("rejects a wrong target", () => {
    const p = checkTx({ to: EVIL, data: enc("supply", 1n, 5n) }, { kind: "spoke", spoke: SPOKE, calls: [{ fn: "supply", reserveId: 1n, amount: 5n }] }, policy);
    assert.ok(p.some((x) => x.includes("not allowlisted")));
  });

  it("rejects a wrong spender, an unlimited approval, a different amount and non-approve ERC20 calls", () => {
    const want = { kind: "approve" as const, token: USDE, spender: SPOKE, amount: 5n };
    assert.ok(checkTx({ to: USDE, data: approve(EVIL, 5n) }, want, policy).some((x) => x.includes("spender")));
    assert.ok(checkTx({ to: USDE, data: approve(SPOKE, MAX_UINT256) }, { ...want, amount: MAX_UINT256 }, policy).some((x) => x.includes("unlimited")));
    assert.ok(checkTx({ to: USDE, data: approve(SPOKE, 6n) }, want, policy).some((x) => x.includes("!= requested")));
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [EVIL, 5n] });
    assert.ok(checkTx({ to: USDE, data: transfer }, want, policy).some((x) => x.includes("only approve")));
    assert.ok(checkTx({ to: USDT, data: approve(SPOKE, 5n) }, want, policy).some((x) => x.includes("expected token")));
  });

  it("rejects a wrong onBehalfOf, reserve, amount or function", () => {
    const want = { kind: "spoke" as const, spoke: SPOKE, calls: [{ fn: "borrow" as const, reserveId: 2n, amount: 3n }] };
    assert.ok(checkTx({ to: SPOKE, data: enc("borrow", 2n, 3n, EVIL) }, want, policy).some((x) => x.includes("onBehalfOf")));
    assert.ok(checkTx({ to: SPOKE, data: enc("borrow", 9n, 3n) }, want, policy).some((x) => x.includes("reserveId")));
    assert.ok(checkTx({ to: SPOKE, data: enc("borrow", 2n, 4n) }, want, policy).some((x) => x.includes("amount")));
    assert.ok(checkTx({ to: SPOKE, data: enc("withdraw", 2n, 3n) }, want, policy).some((x) => x.includes("function withdraw")));
  });

  it("rejects trailing calldata, native value, foreign from/chain, nested multicall and undecodable targets", () => {
    const want = { kind: "spoke" as const, spoke: SPOKE, calls: [{ fn: "supply" as const, reserveId: 1n, amount: 5n }] };
    assert.ok(checkTx({ to: SPOKE, data: (enc("supply", 1n, 5n) + "deadbeef") as Hex }, want, policy).some((x) => x.includes("non-canonical")));
    assert.ok(checkTx({ to: SPOKE, data: enc("supply", 1n, 5n), value: 1n }, want, policy).some((x) => x.includes("native value")));
    assert.ok(checkTx({ to: SPOKE, data: enc("supply", 1n, 5n), from: EVIL }, want, policy).some((x) => x.includes("from")));
    assert.ok(checkTx({ to: SPOKE, data: enc("supply", 1n, 5n), chainId: 1 }, want, policy).some((x) => x.includes("chainId")));
    const inner = encodeFunctionData({ abi: SPOKE_ABI, functionName: "multicall", args: [[enc("supply", 1n, 5n)]] });
    const nested = encodeFunctionData({ abi: SPOKE_ABI, functionName: "multicall", args: [[inner]] });
    assert.ok(checkTx({ to: SPOKE, data: nested }, want, policy).some((x) => x.includes("nested multicall")));
    assert.ok(checkTx({ to: PM, data: "0x12345678" }, { kind: "opaque", to: PM }, policy).some((x) => x.includes("allowUndecoded")));
    assert.deepEqual(checkTx({ to: PM, data: "0x12345678" }, { kind: "opaque", to: PM }, { ...policy, allowUndecoded: [PM] }), []);
  });

  it("validates AaveKit execution plans (approval + original transaction)", () => {
    const tx = (to: Address, data: Hex) => ({ __typename: "TransactionRequest" as const, to, from: ME, data, value: 0n, chainId: 43114, operations: null });
    const plan = {
      __typename: "Erc20ApprovalRequired",
      approvals: [{ __typename: "Erc20Approval", byTransaction: tx(USDE, approve(SPOKE, 5n)), bySignature: null }],
      reason: "allowance",
      originalTransaction: tx(SPOKE, enc("supply", 1n, 5n)),
    } as unknown as ExecutionPlan;
    const expected = { main: { kind: "spoke" as const, spoke: SPOKE, calls: [{ fn: "supply" as const, reserveId: 1n, amount: 5n }] }, approval: { token: USDE, spender: SPOKE, amount: 5n } };
    assert.deepEqual(checkExecutionPlan(plan, expected, policy), []);
    const evil = { ...(plan as object), approvals: [{ __typename: "Erc20Approval", byTransaction: tx(USDE, approve(EVIL, MAX_UINT256)), bySignature: null }] } as unknown as ExecutionPlan;
    const probs = checkExecutionPlan(evil, expected, policy);
    assert.ok(probs.some((p) => p.includes("unlimited")) && probs.some((p) => p.includes("spender")));
    const redirected = { ...(plan as object), originalTransaction: tx(SPOKE, enc("supply", 1n, 5n, EVIL)) } as unknown as ExecutionPlan;
    assert.ok(checkExecutionPlan(redirected, expected, policy).some((p) => p.includes("onBehalfOf")));
    const insufficient = { __typename: "InsufficientBalanceError", required: { value: bigDecimal("5") }, available: { value: bigDecimal("1") } } as unknown as ExecutionPlan;
    assert.ok(checkExecutionPlan(insufficient, expected, policy)[0]!.includes("insufficient"));
  });
});

// ---------------------------------------------------------------------------
describe("AaveKit reward mapping", () => {
  const NOW = Date.UTC(2026, 9, 29);
  const tok = (symbol: string) => ({ info: { symbol } });
  const reserve = {
    summary: {
      rewards: [
        {
          __typename: "MerklSupplyReward",
          id: "r1",
          endDate: new Date(NOW + 7 * 86_400_000),
          extraApy: { value: bigDecimal("0.0575") },
          accrualBasis: RewardAccrualBasis.Gross,
          nettedBy: [],
          payoutToken: tok("USDe"),
          criteria: [{ text: "Health factor must be at most 2" }],
        },
        {
          __typename: "MerklSupplyReward",
          id: "r2",
          endDate: new Date(NOW + 86_400_000),
          extraApy: { value: bigDecimal("0.06") },
          accrualBasis: RewardAccrualBasis.Net,
          nettedBy: [tok("USDC"), tok("USDT")],
          payoutToken: tok("aUSDC"),
          criteria: [],
        },
        { __typename: "MerklSupplyReward", id: "old", endDate: new Date(NOW - 1), extraApy: { value: bigDecimal("0.5") }, payoutToken: tok("X"), criteria: [] },
        { __typename: "SupplyPointsReward", id: "pts", criteria: null },
        { __typename: "MerklBorrowReward", id: "b1", endDate: new Date(NOW + 86_400_000), discountApy: { value: bigDecimal("0.01") }, payoutToken: tok("AAVE"), criteria: [] },
        { __typename: "MerklSupplyReward", id: "r3", endDate: new Date(NOW + 86_400_000), extraApy: { value: bigDecimal("0.02") }, payoutToken: tok("Y"), criteria: [{ text: "HF above 1.5 required" }] },
      ],
    },
  };

  it("maps supply rewards: APY->APR, NET -> netOf, HF criterion -> maxHealthFactor, ended / points / lower-bound HF dropped", () => {
    const m = rewardsFromApiReserve(reserve, "supply", NOW);
    assert.equal(m.rewards.length, 2);
    const [a, b] = m.rewards;
    assert.equal(a!.token, "USDe");
    close(a!.apr, apyToApr(0.0575), 1e-12);
    assert.equal(a!.maxHealthFactor, 2);
    assert.equal(a!.netOf, undefined);
    assert.deepEqual(b!.netOf, ["USDC", "USDT"]);
    assert.deepEqual(m.skipped.map((s) => s.id).sort(), ["old", "r3"]);
    const br = rewardsFromApiReserve(reserve, "borrow", NOW);
    assert.equal(br.rewards.length, 1);
    assert.equal(br.rewards[0]!.token, "AAVE");
  });

  it("parses health-factor criteria conservatively", () => {
    assert.deepEqual(parseHealthFactorCriterion("HF <= 2"), { max: 2 });
    assert.deepEqual(parseHealthFactorCriterion("Keep your health factor below 1.8"), { max: 1.8 });
    assert.deepEqual(parseHealthFactorCriterion("health factor ≤ 2.0 to stay eligible"), { max: 2 });
    assert.equal(parseHealthFactorCriterion("HF of at least 1.5"), "unsupported");
    assert.equal(parseHealthFactorCriterion("health factor matters"), "unsupported");
    assert.equal(parseHealthFactorCriterion("Supply at least $100"), null);
  });
});

// ---------------------------------------------------------------------------
describe("LoopPair mapping", () => {
  const base = (over: Partial<ReserveMarketData>): ReserveMarketData => ({
    reserveId: 0n,
    symbol: "X",
    address: USDE,
    decimals: 6,
    priceUsd: 1,
    oraclePriceUsd: 1,
    reserveSupplied: 0n,
    reserveDrawn: 0n,
    reservePremium: 0n,
    collateralFactorBps: 0,
    collateralRiskBps: 0,
    paused: false,
    frozen: false,
    borrowable: true,
    hubLiquidity: 0n,
    hubSwept: 0n,
    hubDrawn: 0n,
    hubPremium: 0n,
    hubAdded: 0n,
    liquidityFeeBps: 1000,
    drawnRateRay: 0n,
    spokeActive: true,
    spokeHalted: false,
    addCap: MAX_SPOKE_CAP,
    drawCap: MAX_SPOKE_CAP,
    spokeAdded: 0n,
    spokeDrawn: 0n,
    spokePremium: 0n,
    spokeDeficit: 0n,
    ...over,
  });
  const M = 10n ** 6n;
  const E18 = 10n ** 18n;
  const coll = base({
    reserveId: 1n,
    symbol: "USDe",
    address: USDE,
    decimals: 18,
    priceUsd: 0.999,
    reserveSupplied: 20_000_000n * E18,
    hubLiquidity: 5_000_000n * E18,
    hubDrawn: 1_000_000n * E18,
    hubAdded: 50_000_000n * E18,
    drawnRateRay: (3n * RAY) / 100n,
    collateralFactorBps: 9300,
    collateralRiskBps: 2500,
    addCap: 30_000_000n,
    spokeAdded: 20_000_000n * E18,
  });
  const debt = base({
    reserveId: 2n,
    symbol: "USDt",
    address: USDT,
    decimals: 6,
    reserveSupplied: 0n,
    hubLiquidity: 3_500_000n * M,
    hubDrawn: 10_000_000n * M,
    hubPremium: 100_000n * M,
    hubAdded: 13_600_000n * M,
    drawnRateRay: (4n * RAY) / 100n,
    irm: { optimalUsageRatio: 9000, baseDrawnRate: 0, rateGrowthBeforeOptimal: 500, rateGrowthAfterOptimal: 6000 },
    drawCap: 12_000_000n,
    spokeDrawn: 2_000_000n * M,
  });
  const input = {
    protocol: "aave-v4",
    chain: "avalanche",
    pairId: "USDe/USDt",
    coll,
    debt,
    sameAsset: false,
    riskPremiumFrac: 0.25,
    supplyRewards: [{ token: "USDe", apr: 0.056, maxHealthFactor: 2 }],
    borrowRewards: [],
    swapCostFrac: 0.0005,
    swapDepthUsd: 1_000_000,
    dataAsOfMs: Date.UTC(2026, 9, 29),
  };

  it("maps legs, includes the risk premium in borrowAprBase and IRM, CF -> maxLtv = liqLtv", () => {
    const { pair, status } = mapLoopPair(input);
    assert.equal(pair.maxLtv, 0.93);
    assert.equal(pair.liqLtv, 0.93);
    close(pair.debt.borrowAprBase, 0.04 * 1.25, 1e-12);
    close(status.borrowApr, 0.05, 1e-12);
    close(pair.debt.irm!.points[1]![1], 0.05 * 1.25, 1e-12);
    // collateral leg: spoke-level supply, effective borrow = S - min(S - spokeDebt, hubLiquidity)
    close(pair.collateral.totalSupplyUsd, 20_000_000 * 0.999, 1e-3);
    close(pair.collateral.totalBorrowUsd, 15_000_000 * 0.999, 1e-3);
    assert.equal(pair.collateral.irm, undefined);
    close(pair.collateral.supplyCapRemainingUsd!, 10_000_000 * 0.999, 1e-3);
    // debt leg: hub-level
    close(pair.debt.totalSupplyUsd, 13_500_000, 1e-6);
    close(pair.debt.totalBorrowUsd, 10_000_000, 1e-6);
    close(pair.debt.borrowCapRemainingUsd!, 10_000_000, 1e-6);
    assert.equal(pair.paused, false);
    assert.equal(pair.collateral.priceUsd, 0.999);
    assert.equal(status.canOpen, true);
    // the core accepts it
    const o = loopPairOpportunity(pair, { cfg: DEFAULT_CONFIG, nowMs: input.dataAsOfMs, myEquityByOpp: {} }, "aave-v4:avalanche:core-ethena");
    assert.ok(o, "core produced no opportunity");
    assert.deepEqual(validateOpportunity(o!, DEFAULT_CONFIG, input.dataAsOfMs), []);
    // borrow stream uses the premium-inclusive rate
    assert.ok(o!.streams.find((s) => s.label === "borrow_base")!.aprAt(0) < 0);
  });

  it("entry blockers zero the caps instead of flagging an exit; paused reserves flag an exit", () => {
    const notBorrowable = mapLoopPair({ ...input, debt: { ...debt, borrowable: false } });
    assert.equal(notBorrowable.status.canOpen, false);
    assert.ok(notBorrowable.status.reasons.some((r) => r.includes("not borrowable")));
    assert.equal(notBorrowable.pair.debt.borrowCapRemainingUsd, 0);
    assert.equal(notBorrowable.pair.collateral.supplyCapRemainingUsd, 0);
    assert.equal(notBorrowable.pair.paused, false);
    const noCap = mapLoopPair({ ...input, debt: { ...debt, drawCap: 0n } });
    assert.ok(noCap.status.reasons.some((r) => r.includes("drawCap is 0")));
    const cf0 = mapLoopPair({ ...input, coll: { ...coll, collateralFactorBps: 0 } });
    assert.ok(cf0.status.reasons.some((r) => r.includes("collateral factor is 0")));
    const paused = mapLoopPair({ ...input, coll: { ...coll, paused: true } });
    assert.equal(paused.pair.paused, true);
    assert.equal(paused.status.canExit, false);
    const halted = mapLoopPair({ ...input, debt: { ...debt, spokeHalted: true } });
    assert.equal(halted.pair.paused, true);
  });
});
