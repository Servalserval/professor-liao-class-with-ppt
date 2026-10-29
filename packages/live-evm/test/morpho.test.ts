/**
 * Offline tests for the Morpho Blue adapter. The RPC is a small in-memory
 * Morpho Blue simulator (FakeChain) behind a mocked viem PublicClient /
 * WalletClient; addresses below are synthetic test values, except the Morpho
 * singleton / AdaptiveCurveIrm which come from the SDK registry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getChainAddresses, MarketUtils, SharesMath } from "@morpho-org/blue-sdk";
import { decodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { Mutex, viemChainFor, type EvmEnv } from "@incentive-router/live-evm-base";
import type { AssetRef, LiveContext, RewardRateQuery, SwapAdapter, SwapQuote } from "@incentive-router/live-common";
import {
  MorphoBlueAdapter,
  accrueInterest,
  adaptiveCurveFactor,
  adaptiveCurveIrmModel,
  apyToApr,
  aprToApyContinuous,
  borrowAssetsToSharesDown,
  borrowAssetsToSharesUp,
  borrowSharesToAssetsUp,
  collateralValue,
  healthFactor,
  listaMoolahAbi,
  oracleLtv,
  planLoopSteps,
  planUnwindSteps,
  ratePerSecondToApr,
  resolveUnwindTarget,
  supplyAprFromBorrow,
  toWad,
  type LoopPlan,
  type LoopState,
  type MorphoPairConfig,
} from "../src/morpho/index.js";
import { blueAbi } from "../src/morpho/abis.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const YEAR = 31_536_000n;
const BASE = getChainAddresses(8453);
const ACCOUNT = "0xa11ce00000000000000000000000000000000001" as Address;
const COLL = "0xc011a7e8a10000000000000000000000000000c1" as Address;
const LOAN = "0x10a2000000000000000000000000000000000002" as Address;
const ORACLE = "0x0bac1e0000000000000000000000000000000003" as Address;
const LISTA_MOOLAH = "0x1157a00000000000000000000000000000000004" as Address;
const LISTA_IRM = "0x1157a00000000000000000000000000000000005" as Address;
// 1 collateral (18 dec) = 1.2 loan (6 dec): price = 1.2 * 1e36 * 1e6 / 1e18
const PRICE = 12n * 10n ** 23n;
const LLTV = 915n * 10n ** 15n; // 0.915
const RATE = (E18 / 10n) / YEAR; // 10% APR per second

const collAsset: AssetRef = { chain: "base", symbol: "sUSDe", address: COLL, decimals: 18 };
const loanAsset: AssetRef = { chain: "base", symbol: "USDC", address: LOAN, decimals: 6 };

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

test("shares <-> assets follow SharesMath rounding", () => {
  const m = { totalBorrowAssets: 9_000_000n * E6, totalBorrowShares: 9_000_000n * E6 * 1_000_000n - 12345n };
  const a = 123_456_789n;
  const sUp = borrowAssetsToSharesUp(a, m);
  const sDown = borrowAssetsToSharesDown(a, m);
  assert.ok(sUp >= sDown && sUp - sDown <= 1n);
  assert.ok(borrowSharesToAssetsUp(sUp, m) >= a);
  assert.equal(borrowSharesToAssetsUp(sUp, m), SharesMath.toAssets(sUp, m.totalBorrowAssets, m.totalBorrowShares, "Up"));
});

test("rate / APR / APY conversions", () => {
  assert.ok(Math.abs(ratePerSecondToApr(RATE) - 0.1) < 1e-8);
  assert.ok(Math.abs(aprToApyContinuous(0.1) - (Math.exp(0.1) - 1)) < 1e-15);
  assert.ok(Math.abs(apyToApr(0.1) - 365 * (Math.pow(1.1, 1 / 365) - 1)) < 1e-15);
  assert.ok(Math.abs(supplyAprFromBorrow(0.1, 0.9, 0.1) - 0.081) < 1e-15);
});

test("adaptive curve factor and IRM model points", () => {
  assert.ok(Math.abs(adaptiveCurveFactor(0) - 0.25) < 1e-12);
  assert.ok(Math.abs(adaptiveCurveFactor(0.45) - 0.625) < 1e-12);
  assert.ok(Math.abs(adaptiveCurveFactor(0.9) - 1) < 1e-12);
  assert.ok(Math.abs(adaptiveCurveFactor(0.95) - 2.5) < 1e-12);
  assert.ok(Math.abs(adaptiveCurveFactor(1) - 4) < 1e-12);
  const irm = adaptiveCurveIrmModel(0.08, 0.1);
  assert.deepEqual(irm.points, [[0, 0.02], [0.9, 0.08], [1, 0.32]]);
  assert.equal(irm.reserveFactor, 0.1);
});

test("accrueInterest compounds borrow and supply", () => {
  const m = { totalSupplyAssets: 1000n * E6, totalSupplyShares: 1000n * E6 * E6, totalBorrowAssets: 900n * E6, totalBorrowShares: 900n * E6 * E6, lastUpdate: 1000n, fee: 0n };
  const a = accrueInterest(m, RATE, 1000n + YEAR / 12n);
  const interest = Number(a.totalBorrowAssets - m.totalBorrowAssets) / 1e6;
  assert.ok(Math.abs(interest - 900 * (Math.exp(0.1 / 12) - 1)) < 0.01, `interest ${interest}`);
  assert.equal(a.totalSupplyAssets - m.totalSupplyAssets, a.totalBorrowAssets - m.totalBorrowAssets);
  assert.deepEqual(accrueInterest(m, RATE, 1000n), m);
});

test("oracle LTV and health factor", () => {
  const c = 1000n * E18; // worth 1200 loan
  assert.equal(collateralValue(c, PRICE), 1200n * E6);
  assert.ok(Math.abs(oracleLtv(c, 600n * E6, PRICE) - 0.5) < 1e-12);
  assert.equal(oracleLtv(c, 0n, PRICE), 0);
  assert.ok(Math.abs(healthFactor(c, 600n * E6, PRICE, LLTV)! - 1.83) < 1e-12);
  assert.equal(healthFactor(c, 0n, PRICE, LLTV), undefined);
});

/** Replays a plan and checks every intermediate LTV stays under the cap. */
function replay(start: LoopState, plan: LoopPlan, cap: number): LoopState {
  let { collateral: C, debt: D } = start;
  for (const s of plan.steps) {
    if (s.kind === "supplyCollateral") C += s.assets;
    if (s.kind === "borrow") D += s.assets;
    if (s.kind === "withdrawCollateral") C -= s.assets;
    if (s.kind === "repay") D -= s.assets;
    if (s.kind === "borrow" || s.kind === "withdrawCollateral") assert.ok(oracleLtv(C, D, PRICE) <= cap + 1e-9, `LTV ${oracleLtv(C, D, PRICE)} > cap ${cap} after ${s.kind}`);
  }
  assert.equal(C, plan.final.collateral);
  assert.equal(D, plan.final.debt);
  return { collateral: C, debt: D };
}

const CAP = 0.915 * 0.95;

test("planLoopSteps reaches the target LTV without breaching the step cap", () => {
  const start = { collateral: 0n, debt: 0n };
  const plan = planLoopSteps(start, 1000n * E18, 0.8, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0.001, maxIterations: 20 });
  assert.equal(plan.reachedTarget, true);
  assert.ok(Math.abs(plan.finalLtv - 0.8) < 1e-6, `final ${plan.finalLtv}`);
  assert.ok(plan.iterations >= 5 && plan.iterations <= 9, `iterations ${plan.iterations}`);
  assert.equal(plan.steps[0]!.kind, "supplyCollateral");
  replay(start, plan, CAP);
  // Dt = tV/(1 - t(1-c)) with V = 1200 USDC
  assert.ok(Math.abs(Number(plan.targetDebt) / 1e6 - (0.8 * 1200) / (1 - 0.8 * 0.999)) < 0.01);

  const short = planLoopSteps(start, 1000n * E18, 0.8, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0.001, maxIterations: 3 });
  assert.equal(short.reachedTarget, false);
  assert.equal(short.iterations, 3);
  assert.ok(short.finalLtv < 0.8 && short.finalLtv > 0.6);
});

test("planLoopSteps respects liquidity, min debt and existing debt", () => {
  const liq = planLoopSteps({ collateral: 0n, debt: 0n }, 1000n * E18, 0.8, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0, maxIterations: 20, borrowLiquidity: 500n * E6 });
  assert.equal(liq.final.debt, 500n * E6);
  assert.equal(liq.reachedTarget, false);
  const md = planLoopSteps({ collateral: 0n, debt: 0n }, 1n * E18, 0.5, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0, maxIterations: 20, minDebt: 10n * E6 });
  assert.equal(md.iterations, 0);
  const already = planLoopSteps({ collateral: 1000n * E18, debt: 1000n * E6 }, 0n, 0.8, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0, maxIterations: 20 });
  assert.equal(already.steps.length, 0); // LTV 0.833 > target: nothing to borrow
});

const levered = (): LoopState => {
  const p = planLoopSteps({ collateral: 0n, debt: 0n }, 1000n * E18, 0.8, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0, maxIterations: 30 });
  return p.final;
};

test("planUnwindSteps full close repays everything and withdraws all collateral", () => {
  const st = levered();
  const plan = planUnwindSteps(st, { kind: "fraction", fraction: 1 }, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0.001, maxIterations: 20, sellBufferBps: 20 });
  assert.equal(plan.reachedTarget, true);
  assert.equal(plan.final.debt, 0n);
  assert.equal(plan.final.collateral, 0n);
  replay(st, plan, CAP);
  assert.ok(plan.leftoverLoan > 0n, "full repay oversells by the buffer");
  const last = plan.steps.filter((s) => s.kind === "repay").at(-1);
  assert.ok(last && last.kind === "repay" && last.all);
  const tight = planUnwindSteps(st, { kind: "fraction", fraction: 1 }, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0.001, maxIterations: 3, sellBufferBps: 20 });
  assert.equal(tight.reachedTarget, false);
  assert.ok(tight.final.debt > 0n);
});

test("planUnwindSteps deleverage and partial close", () => {
  const st = levered();
  const d = planUnwindSteps(st, { kind: "ltv", ltv: 0.6 }, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0.002, maxIterations: 20 });
  assert.equal(d.reachedTarget, true);
  assert.ok(d.finalLtv <= 0.6 + 1e-6 && d.finalLtv > 0.599, `ltv ${d.finalLtv}`);
  replay(st, d, CAP);

  const half = planUnwindSteps(st, { kind: "fraction", fraction: 0.5 }, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0.001, maxIterations: 20 });
  assert.equal(half.reachedTarget, true);
  replay(st, half, CAP);
  assert.ok(Math.abs(Number(half.final.debt) / Number(st.debt) - 0.5) < 1e-5);
  assert.ok(Math.abs(Number(half.final.collateral) / Number(st.collateral) - 0.5) < 1e-5);
  assert.ok(Math.abs(half.finalLtv - oracleLtv(st.collateral, st.debt, PRICE)) < 1e-5);

  assert.deepEqual(resolveUnwindTarget(st, { kind: "ltv", ltv: 0.85 }, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0, maxIterations: 1 }), { repay: 0n });
  // Lista min loan: a partial close that would leave dust debt becomes a full repay
  const r = resolveUnwindTarget(st, { kind: "fraction", fraction: 0.999 }, { price: PRICE, stepLtvCap: CAP, swapCostFrac: 0, maxIterations: 1, minDebt: 100n * E6 });
  assert.equal(r.repay, "all");
});

test("toWad keeps 1e-12 resolution", () => {
  assert.equal(toWad(0.915), LLTV);
  assert.throws(() => toWad(Number.NaN));
});

// ---------------------------------------------------------------------------
// In-memory Morpho Blue
// ---------------------------------------------------------------------------

interface ChainState {
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
  market: { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint };
  pos: { supplyShares: bigint; borrowShares: bigint; collateral: bigint };
}

const k = (a: string, b: string) => `${a.toLowerCase()}:${b.toLowerCase()}`;
const lc = (a: string) => a.toLowerCase();

class FakeChain {
  now = 1_700_000_000n;
  morpho: Address;
  irm: Address;
  flavor: "morpho" | "lista";
  price = PRICE;
  rate = RATE;
  rateAtTargetFails = false;
  simulateCallsUnsupported = false;
  failBundleStep?: number;
  whitelisted = true;
  broker: Address = "0x0000000000000000000000000000000000000000";
  s: ChainState;
  params: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };
  marketId: Hex;
  sent: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  simulated: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  bundles: number[] = [];

  constructor(o: { flavor?: "morpho" | "lista"; supply?: bigint; borrow?: bigint } = {}) {
    this.flavor = o.flavor ?? "morpho";
    this.morpho = this.flavor === "lista" ? LISTA_MOOLAH : BASE.blue;
    this.irm = this.flavor === "lista" ? LISTA_IRM : BASE.adaptiveCurveIrm;
    this.params = { loanToken: LOAN, collateralToken: COLL, oracle: ORACLE, irm: this.irm, lltv: LLTV };
    this.marketId = MarketUtils.getMarketId(this.params);
    const supply = o.supply ?? 10_000_000n * E6;
    const borrow = o.borrow ?? 9_000_000n * E6;
    this.s = {
      balances: new Map([
        [k(COLL, ACCOUNT), 1000n * E18],
        [k(COLL, this.morpho), 5_000_000n * E18],
        [k(LOAN, this.morpho), supply - borrow],
      ]),
      allowances: new Map(),
      market: { totalSupplyAssets: supply, totalSupplyShares: supply * 1_000_000n, totalBorrowAssets: borrow, totalBorrowShares: borrow * 1_000_000n, lastUpdate: this.now - 60n, fee: E18 / 10n },
      pos: { supplyShares: 0n, borrowShares: 0n, collateral: 0n },
    };
  }

  bal(token: string, who: string, st = this.s) {
    return st.balances.get(k(token, who)) ?? 0n;
  }

  private move(st: ChainState, token: string, from: string, to: string, amt: bigint) {
    const fb = this.bal(token, from, st);
    if (fb < amt) throw new Error(`transfer amount exceeds balance (${token})`);
    st.balances.set(k(token, from), fb - amt);
    st.balances.set(k(token, to), this.bal(token, to, st) + amt);
  }

  private pull(st: ChainState, token: string, owner: string, amt: bigint) {
    const a = st.allowances.get(k(token, owner) + ":" + lc(this.morpho)) ?? 0n;
    if (a < amt) throw new Error(`insufficient allowance (${token})`);
    st.allowances.set(k(token, owner) + ":" + lc(this.morpho), a - amt);
    this.move(st, token, owner, this.morpho, amt);
  }

  private healthy(st: ChainState) {
    if (st.pos.borrowShares === 0n) return true;
    const debt = SharesMath.toAssets(st.pos.borrowShares, st.market.totalBorrowAssets, st.market.totalBorrowShares, "Up");
    return debt * E18 <= collateralValue(st.pos.collateral, this.price) * LLTV;
  }

  clone(): ChainState {
    return { balances: new Map(this.s.balances), allowances: new Map(this.s.allowances), market: { ...this.s.market }, pos: { ...this.s.pos } };
  }

  /** Apply a tx from ACCOUNT to `st` (throws like a revert). */
  apply(st: ChainState, to: Address, data: Hex): { fn: string; args: readonly unknown[] } {
    if (lc(to) === lc(this.morpho)) {
      const { functionName, args } = decodeFunctionData({ abi: blueAbi, data });
      const a = args as readonly unknown[];
      const m = st.market;
      switch (functionName) {
        case "supplyCollateral": {
          const assets = a[1] as bigint;
          this.pull(st, COLL, ACCOUNT, assets);
          st.pos.collateral += assets;
          break;
        }
        case "borrow": {
          const assets = a[1] as bigint;
          const shares = SharesMath.toShares(assets, m.totalBorrowAssets, m.totalBorrowShares, "Up");
          st.pos.borrowShares += shares;
          m.totalBorrowShares += shares;
          m.totalBorrowAssets += assets;
          if (!this.healthy(st)) throw new Error("insufficient collateral");
          if (m.totalBorrowAssets > m.totalSupplyAssets) throw new Error("insufficient liquidity");
          this.move(st, LOAN, this.morpho, ACCOUNT, assets);
          break;
        }
        case "repay": {
          let assets = a[1] as bigint;
          let shares = a[2] as bigint;
          if (assets > 0n) shares = SharesMath.toShares(assets, m.totalBorrowAssets, m.totalBorrowShares, "Down");
          else assets = SharesMath.toAssets(shares, m.totalBorrowAssets, m.totalBorrowShares, "Up");
          if (shares > st.pos.borrowShares) throw new Error("arithmetic underflow");
          st.pos.borrowShares -= shares;
          m.totalBorrowShares -= shares;
          m.totalBorrowAssets = m.totalBorrowAssets > assets ? m.totalBorrowAssets - assets : 0n;
          this.pull(st, LOAN, ACCOUNT, assets);
          break;
        }
        case "withdrawCollateral": {
          const assets = a[1] as bigint;
          if (assets > st.pos.collateral) throw new Error("arithmetic underflow");
          st.pos.collateral -= assets;
          if (!this.healthy(st)) throw new Error("insufficient collateral");
          this.move(st, COLL, this.morpho, ACCOUNT, assets);
          break;
        }
        default:
          throw new Error(`unexpected morpho call ${functionName}`);
      }
      return { fn: functionName, args: a };
    }
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    if (functionName !== "approve") throw new Error(`unexpected token call ${functionName}`);
    const [spender, amount] = args as readonly [Address, bigint];
    st.allowances.set(k(to, ACCOUNT) + ":" + lc(spender), amount);
    return { fn: functionName, args: args as readonly unknown[] };
  }

  readContract = async (r: { address: Address; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
    const m = this.s.market;
    switch (r.functionName) {
      case "idToMarketParams":
        if (lc(r.args![0] as string) !== lc(this.marketId)) return ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n];
        return [this.params.loanToken, this.params.collateralToken, this.params.oracle, this.params.irm, this.params.lltv];
      case "market":
        return [m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee];
      case "position":
        return [this.s.pos.supplyShares, this.s.pos.borrowShares, this.s.pos.collateral];
      case "borrowRateView":
        return this.rate;
      case "rateAtTarget":
        if (this.rateAtTargetFails) throw new Error("execution reverted");
        return this.rate;
      case "price":
        if (this.flavor === "lista") throw new Error("lista oracle has no price()");
        return this.price;
      case "getPrice":
        return this.price;
      case "minLoan":
        return 1n * E6;
      case "isWhiteList":
        return this.whitelisted;
      case "brokers":
        return this.broker;
      case "providers":
        return "0x0000000000000000000000000000000000000000";
      case "paused":
        return false;
      case "balanceOf":
        return this.bal(r.address, r.args![0] as string);
      case "allowance":
        return this.s.allowances.get(k(r.address, r.args![0] as string) + ":" + lc(r.args![1] as string)) ?? 0n;
      case "symbol":
        return lc(r.address) === lc(COLL) ? "sUSDe" : "USDC";
      case "decimals":
        return lc(r.address) === lc(COLL) ? 18 : 6;
      default:
        throw new Error(`unmocked readContract ${r.functionName}`);
    }
  };

  publicClient(): PublicClient {
    const self = this;
    return {
      readContract: this.readContract,
      getBlock: async () => ({ timestamp: self.now, number: 1n }),
      getCode: async () => "0x6080",
      getChainId: async () => 8453,
      getGasPrice: async () => 1_000_000_000n,
      estimateGas: async () => 150_000n,
      call: async ({ to, data }: { to: Address; data: Hex }) => {
        const r = self.apply(self.clone(), to, data);
        self.simulated.push({ to, ...r });
        return { data: "0x" };
      },
      simulateCalls: async ({ calls }: { calls: { to: Address; data: Hex }[] }) => {
        if (self.simulateCallsUnsupported) throw new Error("the method eth_simulateV1 does not exist/is not available");
        self.bundles.push(calls.length);
        const st = self.clone();
        const results = calls.map((c, i) => {
          try {
            if (self.failBundleStep === i + 1) throw new Error("execution reverted: insufficient collateral");
            const r = self.apply(st, c.to, c.data);
            self.simulated.push({ to: c.to, ...r });
            return { status: "success", gasUsed: 120_000n, data: "0x", result: undefined };
          } catch (e) {
            return { status: "failure", gasUsed: 0n, data: "0x", error: e as Error };
          }
        });
        return { results, assetChanges: [], block: {} };
      },
      waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 150_000n, effectiveGasPrice: 1_000_000_000n }),
    } as unknown as PublicClient;
  }

  walletClient(): WalletClient {
    const self = this;
    let n = 0;
    return {
      account: { address: ACCOUNT },
      sendTransaction: async ({ to, data }: { to: Address; data: Hex }) => {
        const r = self.apply(self.s, to, data);
        self.sent.push({ to, ...r });
        return `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
      },
    } as unknown as WalletClient;
  }

  env(): EvmEnv {
    return { chain: "base", viemChain: viemChainFor("base", "http://127.0.0.1:1"), publicClient: this.publicClient(), walletClient: this.walletClient(), account: ACCOUNT, lock: new Mutex() };
  }

  /** A swapper that trades at the oracle price minus a size-dependent cost. */
  swapper(costBps: (usd: number) => number = (usd) => 5 + usd / 10_000): SwapAdapter & { quotes: { from: string; amountIn: bigint }[] } {
    const self = this;
    const quotes: { from: string; amountIn: bigint }[] = [];
    return {
      id: "fake-swap",
      chain: "base",
      quotes,
      async quote(from: AssetRef, to: AssetRef, amountIn: bigint): Promise<SwapQuote> {
        quotes.push({ from: from.symbol, amountIn });
        const toLoan = lc(from.address) === lc(COLL);
        const fair = toLoan ? collateralValue(amountIn, self.price) : (amountIn * 10n ** 36n) / self.price;
        const usd = toLoan ? Number(fair) / 1e6 : Number(amountIn) / 1e6;
        const c = costBps(usd);
        const amountOut = (fair * BigInt(Math.round((1 - c / 1e4) * 1e9))) / 1_000_000_000n;
        return { amountIn, amountOut, costBps: c, route: "fake", validUntilMs: Date.now() + 60_000 };
      },
      async swap(q: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext) {
        if (ctx.dryRun) return { ok: true, txs: [{ chain: "base", description: "swap", simulated: true }] };
        const fb = self.bal(from.address, ACCOUNT);
        if (fb < q.amountIn) return { ok: false, txs: [], detail: "insufficient balance" };
        self.s.balances.set(k(from.address, ACCOUNT), fb - q.amountIn);
        self.s.balances.set(k(to.address, ACCOUNT), self.bal(to.address, ACCOUNT) + q.amountOut);
        return { ok: true, txs: [{ chain: "base", id: "0xswap", description: `swap ${from.symbol}->${to.symbol}`, simulated: false }] };
      },
    };
  }
}

const logs: string[] = [];
function ctx(over: Partial<LiveContext> = {}): LiveContext {
  return {
    dryRun: true,
    log: (lvl, m) => logs.push(`${lvl} ${m}`),
    limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 15, maxLoopIterations: 10 },
    priceUsd: async (a) => (a.symbol === "sUSDe" ? 1.2 : 1),
    nativePriceUsd: async () => 3000,
    ...over,
  };
}

function adapter(fc: FakeChain, extra: Partial<ConstructorParameters<typeof MorphoBlueAdapter>[0]> = {}, pairOver: Partial<MorphoPairConfig> = {}) {
  return new MorphoBlueAdapter({
    env: fc.env(),
    markets: [{ pairId: "sUSDe/USDC", marketId: fc.marketId, collateral: collAsset, debt: loanAsset, lltv: 0.915, ...pairOver }],
    priceUsd: async (a) => (a.symbol === "sUSDe" ? 1.2 : 1),
    swapper: fc.swapper(),
    ...(fc.flavor === "lista" ? { flavor: "lista" as const, morpho: LISTA_MOOLAH } : {}),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

test("constructor: registry default, lista needs an explicit address, structural checks", () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  assert.equal(a.id, "morpho:base");
  assert.equal(a.morpho, BASE.blue);
  assert.throws(() => new MorphoBlueAdapter({ env: fc.env(), markets: [], priceUsd: async () => 1, flavor: "lista" }), /explicit `morpho`/);
  assert.throws(() => adapter(fc, {}, { debt: { ...loanAsset, symbol: "sUSDe" } }), /symbols are equal/);
  assert.throws(() => adapter(fc, { maxLtvFactor: 0.96 }), /maxLtvFactor/);
});

test("markets(): debt leg carries Morpho rates + IRM, collateral leg intrinsic yield, swap depth from probes", async () => {
  const fc = new FakeChain();
  const queries: RewardRateQuery[] = [];
  const a = adapter(fc, {
    intrinsicApr: async () => 0.07,
    extraRewards: async (q) => {
      queries.push(q);
      return q.side === "borrow" ? [{ token: "MORPHO", apr: 0.02 }] : [];
    },
  });
  const [p] = await a.markets();
  assert.ok(p);
  assert.equal(p.protocol, "morpho:base");
  assert.equal(p.liqLtv, 0.915);
  assert.ok(Math.abs(p.maxLtv - 0.915 * 0.9) < 1e-12);
  assert.ok(Math.abs(p.debt.borrowAprBase - 0.1) < 1e-8);
  assert.ok(Math.abs(p.debt.supplyAprBase - 0.1 * 0.9 * 0.9) < 1e-8);
  assert.deepEqual(p.debt.borrowRewards, [{ token: "MORPHO", apr: 0.02 }]);
  assert.equal(p.collateral.supplyAprBase, 0.07);
  assert.equal(p.collateral.totalBorrowUsd, 0);
  assert.equal(p.collateral.borrowAprBase, 0);
  assert.ok(Math.abs(p.collateral.totalSupplyUsd - 5_000_000 * 1.2) < 1e-6);
  // 10M + 60 s of 10% interest on 9M borrowed (accrued to the block)
  assert.ok(Math.abs(p.debt.totalSupplyUsd - (10_000_000 + (9_000_000 * 0.1 * 60) / 31_536_000)) < 1e-3, `${p.debt.totalSupplyUsd}`);
  assert.ok(Math.abs(p.debt.borrowCapRemainingUsd! - 1_000_000) < 1);
  // SDK path (registry AdaptiveCurveIrm): u = 90% -> r unchanged
  const pts = p.debt.irm!.points;
  assert.ok(Math.abs(pts[1]![1] - 0.1) < 1e-8 && Math.abs(pts[0]![1] - 0.025) < 1e-8 && Math.abs(pts[2]![1] - 0.4) < 1e-8);
  assert.equal(p.debt.irm!.reserveFactor, 0.1);
  // probes: cost 5 + usd/1e4 bps -> $100k = 15bps ok, $1M = 105bps > 30
  assert.equal(p.swapDepthUsd, 100_000);
  assert.ok(Math.abs(p.swapCostFrac - 5.1e-4) < 1e-9);
  assert.equal(p.myLtv, undefined);
  assert.equal(p.paused, false);
  assert.deepEqual(new Set(queries.map((q) => q.side)), new Set(["collateral", "supply", "borrow"]));
  assert.ok(queries.every((q) => q.marketId === fc.marketId && q.protocol === "morpho" && q.chain === "base"));
});

test("markets(): no swapper -> zero depth; static override; token mismatch throws", async () => {
  const fc = new FakeChain();
  const [p] = await adapter(fc, { swapper: undefined }).markets();
  assert.equal(p!.swapDepthUsd, 0);
  const [q] = await adapter(fc, { swapper: undefined }, { swapCostFrac: 0.0001, swapDepthUsd: 5e6 }).markets();
  assert.equal(q!.swapDepthUsd, 5e6);
  assert.equal(q!.swapCostFrac, 0.0001);
  await assert.rejects(adapter(fc, {}, { collateral: { ...collAsset, address: "0x0000000000000000000000000000000000000bad" } }).markets(), /collateralToken/);
});

test("markets(): unknown IRM shape -> no IrmModel; fork IRM -> fitted through observed rate", async () => {
  const fc = new FakeChain({ flavor: "lista", supply: 10_000_000n * E6, borrow: 4_500_000n * E6 });
  const [p] = await adapter(fc).markets();
  assert.equal(p!.protocol, "lista:base");
  // u = 45% -> factor 0.625 -> r = 0.1 / 0.625
  assert.ok(Math.abs(p!.debt.irm!.points[1]![1] - 0.16) < 1e-8);
  fc.rateAtTargetFails = true;
  const [q] = await adapter(fc).markets();
  assert.equal(q!.debt.irm, undefined);
});

test("position(): null without position; LTV / HF from oracle with accrued debt", async () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  assert.equal(await a.position("sUSDe/USDC"), null);
  fc.s.pos = { supplyShares: 0n, borrowShares: 800n * E6 * 1_000_000n, collateral: 1000n * E18 };
  const v = (await a.position("sUSDe/USDC"))!;
  const debt = 800 * (1 + 0.1 * 60 / 31_536_000); // 60 s of accrual at 10%
  assert.ok(Math.abs(v.debtUsd - debt) < 1e-3, `debt ${v.debtUsd}`);
  assert.ok(Math.abs(v.collateralUsd - 1200) < 1e-9);
  assert.ok(Math.abs(v.ltv - debt / 1200) < 1e-6);
  assert.ok(Math.abs(v.healthFactor! - (0.915 * 1200) / debt) < 1e-6);
  assert.ok(Math.abs(v.equityUsd - (1200 - debt)) < 1e-3);
  assert.equal(v.asOfMs, Number(fc.now) * 1000);
  const [p] = await a.markets();
  assert.ok(Math.abs(p!.myLtv! - v.ltv) < 1e-9);
});

test("open() dry-run: approve -> supplyCollateral -> borrow simulated as one bundle", async () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  const r = await a.open("sUSDe/USDC", 1000n * E18, 0.8, ctx());
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(fc.bundles, [3]);
  assert.deepEqual(fc.simulated.map((s) => s.fn), ["approve", "supplyCollateral", "borrow"]);
  assert.equal(fc.simulated[1]!.args[1], 1000n * E18);
  const borrowed = fc.simulated[2]!.args[1] as bigint;
  // first borrow = step cap (LLTV*0.95) x 1200 USDC
  assert.ok(Math.abs(Number(borrowed) / 1e6 - 0.915 * 0.95 * 1200) < 0.01, `borrow ${borrowed}`);
  assert.equal(r.txs.length, 3);
  assert.ok(r.txs.every((t) => t.simulated && t.gasUsd! > 0));
  assert.ok(Math.abs(r.amountUsd! - 1200) < 1e-9);
  assert.match(r.detail!, /projected LTV 80\.00%/);
  assert.equal(fc.sent.length, 0, "dry-run must not broadcast");
});

test("open(): refuses above maxLtv, without balance; bundle revert -> not ok; no eth_simulateV1 -> step 1 only", async () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  const hi = await a.open("sUSDe/USDC", 1000n * E18, 0.85, ctx());
  assert.equal(hi.ok, false);
  assert.match(hi.detail!, /exceeds maxLtv/);
  const poor = await a.open("sUSDe/USDC", 2000n * E18, 0.5, ctx());
  assert.equal(poor.ok, false);
  assert.match(poor.detail!, /wallet has/);

  fc.failBundleStep = 3;
  const bad = await a.open("sUSDe/USDC", 1000n * E18, 0.8, ctx());
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /bundle step 3\/3 reverted/);
  fc.failBundleStep = undefined;

  fc.simulateCallsUnsupported = true;
  fc.simulated = [];
  const fb = await a.open("sUSDe/USDC", 1000n * E18, 0.8, ctx());
  assert.equal(fb.ok, true, fb.detail);
  assert.deepEqual(fc.simulated.map((s) => s.fn), ["approve"]);
  assert.match(fb.detail!, /simulated step 1\/3 only/);
});

test("open() live then close() live on the in-memory Morpho", async () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  const live = ctx({ dryRun: false });
  const r = await a.open("sUSDe/USDC", 1000n * E18, 0.8, live);
  assert.equal(r.ok, true, r.detail);
  const v = (await a.position("sUSDe/USDC"))!;
  assert.ok(Math.abs(v.ltv - 0.8) < 2e-4, `ltv ${v.ltv} (${r.detail})`);
  assert.equal(fc.bal(COLL, ACCOUNT), 0n);
  assert.ok(fc.bal(LOAN, ACCOUNT) < 10n, "borrowed USDC must all be swapped");
  assert.ok(r.txs.every((t) => !t.simulated && t.id));
  const fns = fc.sent.map((s) => s.fn);
  assert.equal(fns[0], "approve");
  assert.equal(fns[1], "supplyCollateral");
  assert.ok(fns.filter((f) => f === "borrow").length >= 5);

  // simulateClose on the levered position
  assert.equal(await a.simulateClose("sUSDe/USDC", ctx()), true);
  assert.equal(await a.simulateClose("sUSDe/USDC", ctx({ limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 15, maxLoopIterations: 2 } })), false);

  // deleverage first, then close fully
  const d = await a.deleverage("sUSDe/USDC", 0.6, live);
  assert.equal(d.ok, true, d.detail);
  assert.ok((await a.position("sUSDe/USDC"))!.ltv <= 0.6 + 1e-6);

  const c = await a.close("sUSDe/USDC", 1, live);
  assert.equal(c.ok, true, c.detail);
  assert.equal(await a.position("sUSDe/USDC"), null);
  assert.equal(fc.s.pos.borrowShares, 0n);
  const back = Number(fc.bal(COLL, ACCOUNT)) / 1e18;
  // ~1000 minus round-trip swap costs (a few bps per swap on ~4x notional)
  assert.ok(back > 985 && back < 1000, `returned ${back}`);
  // the full-close oversell (buffer) is swapped back; only rounding dust (< 1 cent) remains
  assert.match(c.detail!, /swapped leftover \d+ USDC back/);
  assert.ok(fc.bal(LOAN, ACCOUNT) < 10_000n, `leftover USDC ${fc.bal(LOAN, ACCOUNT)}`);
  assert.ok(fc.sent.some((s) => s.fn === "repay" && (s.args[2] as bigint) > 0n), "final repay by shares");
  assert.ok(c.amountUsd! > 985 * 1.2);
});

test("close() partial fraction and dry-run close simulate only the first withdraw", async () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  await a.open("sUSDe/USDC", 1000n * E18, 0.75, ctx({ dryRun: false }));
  const before = fc.clone();
  fc.simulated = [];
  const dry = await a.close("sUSDe/USDC", 1, ctx());
  assert.equal(dry.ok, true, dry.detail);
  assert.deepEqual(fc.simulated.map((s) => s.fn), ["withdrawCollateral"]);
  assert.deepEqual(fc.s.pos, before.pos);

  const half = await a.close("sUSDe/USDC", 0.5, ctx({ dryRun: false }));
  assert.equal(half.ok, true, half.detail);
  assert.ok(Math.abs(Number(fc.s.pos.collateral) / Number(before.pos.collateral) - 0.5) < 2e-3);
  assert.ok(Math.abs(Number(fc.s.pos.borrowShares) / Number(before.pos.borrowShares) - 0.5) < 2e-3);
});

test("claimRewards is a no-op; walletBalance reads ERC20", async () => {
  const fc = new FakeChain();
  const a = adapter(fc);
  const r = await a.claimRewards(ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.claimed, []);
  assert.match(r.detail!, /Merkl/);
  assert.equal(await a.walletBalance(collAsset), 1000n * E18);
});

test("verifyConfig: clean config passes; wrong LLTV / chain / lista whitelist + broker are reported", async () => {
  const fc = new FakeChain();
  assert.deepEqual(await adapter(fc).verifyConfig(), []);
  const issues = await adapter(fc, {}, { lltv: 0.86, debt: { ...loanAsset, chain: "arbitrum" } }).verifyConfig();
  assert.ok(issues.some((i) => /LLTV 0.915 != configured 0.86/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /USDC is on arbitrum/.test(i)), issues.join("\n"));
  const noSwap = await adapter(fc, { swapper: undefined }).verifyConfig();
  assert.ok(noSwap.some((i) => /no swapper/.test(i)));

  const lf = new FakeChain({ flavor: "lista" });
  assert.deepEqual(await adapter(lf).verifyConfig(), []);
  lf.whitelisted = false;
  lf.broker = "0x00000000000000000000000000000000000b0b0b";
  const li = await adapter(lf).verifyConfig();
  assert.ok(li.some((i) => /not whitelisted/.test(i)));
  assert.ok(li.some((i) => /broker/.test(i)));
  assert.ok(listaMoolahAbi.some((f) => f.type === "function" && f.name === "getPrice"));
});

test("lista flavor prices through Moolah.getPrice and enforces minLoan in plans", async () => {
  const fc = new FakeChain({ flavor: "lista" });
  const a = adapter(fc);
  fc.s.pos = { supplyShares: 0n, borrowShares: 600n * E6 * 1_000_000n, collateral: 1000n * E18 };
  const v = (await a.position("sUSDe/USDC"))!;
  assert.ok(Math.abs(v.ltv - 0.5) < 1e-6);
  // fresh position worth $0.60 at 50% LTV needs ~0.6 USDC of debt < minLoan (1 USDC): supply only, no borrow
  fc.s.pos = { supplyShares: 0n, borrowShares: 0n, collateral: 0n };
  fc.simulated = [];
  const r = await a.open("sUSDe/USDC", E18 / 2n, 0.5, ctx());
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(fc.simulated.map((s) => s.fn), ["approve", "supplyCollateral"]);
  assert.match(r.detail!, /0 borrow->swap->supply iteration\(s\).*not reached/);
});
