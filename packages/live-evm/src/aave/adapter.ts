/**
 * AaveV3Adapter — LendingAdapter for any Aave v3 family deployment (official
 * Aave markets from the address book, or forks via explicit, on-chain
 * verified addresses).
 *
 * Reads
 *  - markets(): ONE UiPoolDataProvider.getReservesData call for every reserve
 *    (rates, flags, caps, IRM, oracle prices; layout auto-detected 3.0 .. 3.7),
 *    plus per pair asset: Pool.getReserveData (reserve id for e-mode bitmaps),
 *    aToken / variableDebtToken totalSupply, RewardsController emissions.
 *    E-mode categories are read from the Pool (bitmaps, 3.2+) or from the
 *    per-reserve e-mode fields (3.0/3.1) and cached.
 *  - position(): getUserAccountData + aToken / debt-token balances, AaveOracle prices.
 *
 * Writes (every tx through live-evm-base sendTx: simulate -> gas cap -> dry-run stop)
 *  - open: setUserEMode (if needed) -> exact approve -> supply -> [borrow -> (swap) -> supply]*.
 *    Every intermediate state keeps LTV <= targetLtv (see math.planLoopSteps).
 *  - close / deleverage, same asset: repayWithATokens -> withdraw (2 txs, no flash loan).
 *  - close / deleverage, two assets: [withdraw -> swap -> repay]* with HF >= minUnwindHealthFactor
 *    after every withdrawal, then withdraw the rest.
 *
 * Dry-run: step 1 goes through sendTx like every live tx. When the RPC supports
 * eth_simulateV1 (viem publicClient.simulateCalls) the whole Aave-only prefix
 * (all steps of a same-asset loop / close, up to the first swap for pairs) is
 * simulated in one batch on top of the current state; otherwise only step 1 is
 * simulated (later steps depend on state the earlier ones create) and the
 * planned steps are returned in `detail`. Swaps are opaque (SwapAdapter) and
 * can only be quoted, never batch-simulated.
 *
 * One Aave account per wallet per market: health factor and e-mode are
 * account-wide. Pairs of one market should share an e-mode (or use separate
 * wallets); open() refuses to switch e-mode while other debt is open.
 */
import {
  encodeFunctionData,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import type { LoopLeg, LoopPair, RewardRate } from "@incentive-router/core";
import type {
  AssetRef,
  LendingAdapter,
  LiveContext,
  LiveResult,
  Logger,
  LoopPositionView,
  RewardRateProvider,
  SwapAdapter,
  TxRecord,
} from "@incentive-router/live-common";
import {
  assertChainId,
  ensureAllowance,
  erc20Abi,
  erc20Balance,
  sendTx,
  verifyAsset,
  type EvmEnv,
  type TxRequest,
} from "@incentive-router/live-evm-base";
import {
  AAVE_ORACLE_ABI,
  AAVE_TOKEN_ABI,
  ADDRESSES_PROVIDER_ABI,
  AGGREGATOR_ABI,
  POOL_ABI,
  REFERRAL_CODE,
  REWARDS_CONTROLLER_ABI,
  UI_POOL_GET_RESERVES_DATA_INPUT_ABI,
  VARIABLE_RATE_MODE,
} from "./abi.js";
import { aaveAdapterId, type AaveMarketConfig, type AavePairConfig } from "./config.js";
import { detectUiReservesData, isLegacyLayout, type UiLayout, type UiReserve, type UiReservesData } from "./layouts.js";
import {
  MAX_TARGET_FRAC_OF_LTV,
  MAX_UINT256,
  capRemaining,
  fromHumanFloor,
  irmFromRay,
  mulFrac,
  nextLoopBorrow,
  pairModeIn,
  planLoopSteps,
  planPairUnwind,
  planSameAssetClose,
  planSameAssetDeleverage,
  rayMul,
  rayToApr,
  refPriceToUsd,
  rewardAprFromEmission,
  selectEMode,
  targetLoopDebt,
  toHuman,
  unwindStep,
  userConfigFlags,
  wadToHealthFactor,
  type EModeCategoryInfo,
  type ModeChoice,
  type ReserveModeInfo,
  type UnwindGoal,
  type UnwindParams,
} from "./math.js";

export interface AaveV3AdapterOptions {
  env: EvmEnv;
  market: AaveMarketConfig;
  pairs: AavePairConfig[];
  /** Required for pairs whose collateral and debt differ. */
  swapper?: SwapAdapter;
  /** Extra reward streams (Merkl campaigns ...) merged into each leg. */
  extraRewards?: RewardRateProvider;
  /** Context for swap quotes in markets() (no ctx is passed there). Default: read-only ctx priced by the Aave oracle. */
  readCtx?: LiveContext;
  log?: Logger;
  /** Override the venue id (default protocol:chain[:key]). */
  id?: string;
  /** Cache for e-mode categories (default 10 min) and swap probes (default 5 min). */
  eModeCacheMs?: number;
  swapCacheMs?: number;
  /** Use eth_simulateV1 (publicClient.simulateCalls) to simulate multi-step sequences. Default true. */
  multiCallSimulation?: boolean;
  /** Loop / unwind steps smaller than this (USD) are skipped. Default 1. */
  minStepUsd?: number;
}

/** Extra per-pair facts from the last markets() read (for monitoring / logs). */
export interface AavePairDiagnostics {
  pairId: string;
  layout: UiLayout;
  eMode: ModeChoice;
  eModeCandidates: ModeChoice[];
  pausedReasons: string[];
  utilizationCollateral: number;
  utilizationDebt: number;
  availableToBorrowUsd: number;
  swap?: { costFrac: number; depthUsd: number; asOfMs: number; error?: string };
}

interface ReserveStatic {
  id: number;
  aToken: Address;
  vToken: Address;
}

interface PairReserves {
  c: UiReserve;
  d: UiReserve;
  cs: ReserveStatic;
  ds: ReserveStatic;
}

interface Account {
  S: bigint;
  D: bigint;
  userEMode: number;
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liqThreshold: number;
  maxLtv: number;
  healthFactor: number;
  priceC: number;
  priceD: number;
  /** priceC / priceD */
  r: number;
  userConfig: bigint;
}

type ReadCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
type ReadResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Loose view of the viem PublicClient methods whose generics get in the way. */
interface LooseClient {
  multicall(a: { contracts: readonly ReadCall[]; allowFailure: true }): Promise<{ status: "success" | "failure"; result?: unknown; error?: Error }[]>;
  readContract(a: ReadCall): Promise<unknown>;
  simulateCalls?(a: {
    account: Address;
    calls: readonly { to: Address; data: Hex; value?: bigint }[];
  }): Promise<{ results: readonly { status: "success" | "failure"; gasUsed: bigint; error?: Error }[] }>;
}

interface BatchSim {
  supported: boolean;
  ok: boolean;
  records: TxRecord[];
  failedIndex?: number;
  error?: string;
}

const lc = (a: string) => a.toLowerCase();
const DEFAULT_PROBES_USD = [10_000, 100_000, 1_000_000];

export class AaveV3Adapter implements LendingAdapter {
  readonly id: string;
  readonly chain: string;
  private readonly env: EvmEnv;
  private readonly market: AaveMarketConfig;
  private readonly pairs = new Map<string, AavePairConfig>();
  private readonly swapper?: SwapAdapter;
  private readonly extraRewards?: RewardRateProvider;
  private readonly log: Logger;
  private readonly opts: AaveV3AdapterOptions;

  private layout?: UiLayout;
  private lastUi?: UiReservesData;
  private readonly statics = new Map<string, ReserveStatic>();
  private eModeCache?: { atMs: number; legacy: boolean; cats: EModeCategoryInfo[] };
  private readonly swapCache = new Map<string, { atMs: number; costFrac: number; depthUsd: number; error?: string }>();
  private readonly rewardMeta = new Map<string, { symbol: string; decimals: number; oracle?: Address }>();
  private priceOracleAddr?: Address;
  private controllerAddr?: Address | null;
  private readonly diag = new Map<string, AavePairDiagnostics>();

  constructor(o: AaveV3AdapterOptions) {
    this.opts = o;
    this.env = o.env;
    this.market = o.market;
    this.chain = o.market.chain;
    this.id = o.id ?? aaveAdapterId(o.market);
    this.swapper = o.swapper;
    this.extraRewards = o.extraRewards;
    this.log = o.log ?? (() => {});
    if (o.env.chain !== o.market.chain) throw new Error(`${this.id}: env chain ${o.env.chain} != market chain ${o.market.chain}`);
    for (const p of o.pairs) {
      if (this.pairs.has(p.pairId)) throw new Error(`${this.id}: duplicate pairId ${p.pairId}`);
      for (const a of [p.collateral, p.debt])
        if (a.chain !== this.chain) throw new Error(`${this.id}: pair ${p.pairId} asset ${a.symbol} is on ${a.chain}`);
      if (!this.isSame(p) && !o.swapper) throw new Error(`${this.id}: pair ${p.pairId} needs a swapper (collateral != debt)`);
      if (!this.isSame(p) && o.swapper && o.swapper.chain !== this.chain)
        throw new Error(`${this.id}: swapper ${o.swapper.id} is on ${o.swapper.chain}`);
      this.pairs.set(p.pairId, p);
    }
  }

  // -------------------------------------------------------------------------
  // LendingAdapter: reads
  // -------------------------------------------------------------------------

  async markets(): Promise<LoopPair[]> {
    const ui = await this.readUi();
    const pairs = [...this.pairs.values()];
    const assets = this.uniqueAssets(pairs);
    const statics = await this.reserveStatics(assets.map((a) => a.address as Address));
    const cats = await this.eModeCategories(ui);
    const rows = new Map(ui.reserves.map((r) => [lc(r.underlyingAsset), r]));

    // totals + my balances for every pair asset in one batch
    const calls: ReadCall[] = [];
    for (const a of assets) {
      const s = statics.get(lc(a.address))!;
      calls.push(
        { address: s.aToken, abi: AAVE_TOKEN_ABI, functionName: "totalSupply" },
        { address: s.vToken, abi: AAVE_TOKEN_ABI, functionName: "totalSupply" },
        { address: s.aToken, abi: AAVE_TOKEN_ABI, functionName: "balanceOf", args: [this.env.account] },
        { address: s.vToken, abi: AAVE_TOKEN_ABI, functionName: "balanceOf", args: [this.env.account] }
      );
    }
    const res = await this.readMany(calls);
    const totals = new Map<string, { supply: bigint; debt: bigint; myA: bigint; myV: bigint }>();
    assets.forEach((a, i) => {
      const r = rows.get(lc(a.address));
      if (!r) return;
      const varDebtFallback = rayMul(r.totalScaledVariableDebt, r.variableBorrowIndex);
      const v = (k: number, fb: bigint) => {
        const x = res[i * 4 + k]!;
        return x.ok ? (x.value as bigint) : fb;
      };
      const debt = v(1, varDebtFallback) + r.totalPrincipalStableDebt;
      totals.set(lc(a.address), {
        supply: v(0, r.availableLiquidity + varDebtFallback + r.totalPrincipalStableDebt),
        debt,
        myA: v(2, 0n),
        myV: v(3, 0n),
      });
    });

    // the account's e-mode applies to an open position (open() keeps it while debt exists)
    const anyDebt = [...totals.values()].some((t) => t.myV > 0n);
    let userEMode = 0;
    if (anyDebt) {
      try {
        userEMode = Number(await this.env.publicClient.readContract({ address: this.market.pool, abi: POOL_ABI, functionName: "getUserEMode", args: [this.env.account] }));
      } catch (e) {
        this.log("warn", `${this.id}: getUserEMode failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }

    const out: LoopPair[] = [];
    const now = Date.now();
    for (const p of pairs) {
      try {
        const pair = await this.pairMarket(p, ui, rows, statics, totals, cats, now, anyDebt ? userEMode : undefined);
        if (pair) out.push(pair);
      } catch (e) {
        this.log("error", `${this.id} ${p.pairId}: market read failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    return out;
  }

  private async pairMarket(
    p: AavePairConfig,
    ui: UiReservesData,
    rows: Map<string, UiReserve>,
    statics: Map<string, ReserveStatic>,
    totals: Map<string, { supply: bigint; debt: bigint; myA: bigint; myV: bigint }>,
    cats: EModeCategoryInfo[],
    now: number,
    /** Set when the account has open debt: its current e-mode. */
    userEMode?: number
  ): Promise<LoopPair | null> {
    {
      const c = rows.get(lc(p.collateral.address));
      const d = rows.get(lc(p.debt.address));
      if (!c || !d) {
        this.log("error", `${this.id} ${p.pairId}: asset is not a reserve of this pool`);
        return null;
      }
      const cs = statics.get(lc(p.collateral.address))!;
      const ds = statics.get(lc(p.debt.address))!;
      const sel = this.chooseMode(p, { c, d, cs, ds }, cats, ui.layout);
      const candidates = sel.candidates;
      let chosen = sel.chosen;
      let accountBlock: string | undefined;
      if (userEMode !== undefined && userEMode !== chosen.categoryId) {
        const cur = pairModeIn(userEMode, this.modeInfo(c, cs), this.modeInfo(d, ds), cats, isLegacyLayout(ui.layout));
        if (cur && cur.ltv > 0) chosen = cur;
        else accountBlock = `account is in e-mode ${userEMode} with open debt and cannot loop this pair (needs e-mode ${chosen.categoryId})`;
      }
      const reasons = this.pausedReasons({ c, d, cs, ds }, chosen);
      if (accountBlock) reasons.push(accountBlock);
      const pc = this.priceOf(c, ui);
      const pd = this.priceOf(d, ui);
      if (!(pc > 0 && pd > 0)) throw new Error(`invalid oracle prices ${pc} / ${pd}`);
      const tc = totals.get(lc(p.collateral.address))!;
      const td = totals.get(lc(p.debt.address))!;

      const legC = await this.leg(p.collateral, c, cs, tc, pc, "collateral");
      const legD = this.isSame(p) ? legC : await this.leg(p.debt, d, ds, td, pd, "debt");
      // borrow room: cap, liquidity and (pre-3.7) the collateral's isolation debt ceiling
      if (this.isSame(p)) {
        // one market carries both sides
        legC.borrowRewards = await this.legRewards(p.debt, ds, td, pd, "borrow");
        legC.borrowCapRemainingUsd = this.borrowRoomUsd(d, td, pd, c);
      } else {
        legD.borrowCapRemainingUsd = this.borrowRoomUsd(d, td, pd, c);
      }
      const swap = this.isSame(p) ? { costFrac: 0, depthUsd: Infinity, atMs: now } : await this.swapMetrics(p, pc, pd);

      const myCollUsd = toHuman(tc.myA, c.decimals) * pc;
      const myDebtUsd = toHuman(td.myV, d.decimals) * pd;
      const pair: LoopPair = {
        protocol: this.market.protocol,
        chain: this.chain,
        pairId: p.pairId,
        collateral: legC,
        debt: legD,
        maxLtv: chosen.ltv,
        liqLtv: chosen.liqLtv,
        swapCostFrac: swap.costFrac,
        swapDepthUsd: swap.depthUsd,
        paused: reasons.length > 0,
        dataAsOfMs: now,
      };
      if (myCollUsd > 0 || myDebtUsd > 0) pair.myLtv = myCollUsd > 0 ? myDebtUsd / myCollUsd : Infinity;

      const util = (t: { supply: bigint; debt: bigint }) => (t.supply > 0n ? Number((t.debt * 1_000_000n) / t.supply) / 1e6 : 0);
      this.diag.set(p.pairId, {
        pairId: p.pairId,
        layout: ui.layout,
        eMode: chosen,
        eModeCandidates: candidates,
        pausedReasons: reasons,
        utilizationCollateral: util(tc),
        utilizationDebt: util(td),
        availableToBorrowUsd: toHuman(this.availableToBorrow(d), d.decimals) * pd,
        swap: this.isSame(p) ? undefined : { costFrac: swap.costFrac, depthUsd: swap.depthUsd, asOfMs: swap.atMs, error: (swap as { error?: string }).error },
      });
      if (reasons.length) this.log("warn", `${this.id} ${p.pairId}: paused (${reasons.join("; ")})`);
      return pair;
    }
  }

  /** Facts from the last markets() call (chosen e-mode, pause reasons, utilizations). */
  diagnostics(pairId: string): AavePairDiagnostics | undefined {
    return this.diag.get(pairId);
  }

  async position(pairId: string): Promise<LoopPositionView | null> {
    const p = this.pair(pairId);
    const acct = await this.readAccount(p);
    if (acct.S === 0n && acct.D === 0n) return null;
    const collateralUsd = toHuman(acct.S, p.collateral.decimals) * acct.priceC;
    const debtUsd = toHuman(acct.D, p.debt.decimals) * acct.priceD;
    const statics = await this.reserveStatics([p.collateral.address as Address, p.debt.address as Address]);
    const tokens = [statics.get(lc(p.collateral.address))!.aToken, statics.get(lc(p.debt.address))!.vToken];
    let rewardsUnclaimed: LoopPositionView["rewardsUnclaimed"] = [];
    try {
      rewardsUnclaimed = await this.unclaimedRewards(tokens);
    } catch (e) {
      this.log("warn", `${this.id} ${pairId}: reading unclaimed rewards failed: ${(e as Error).message.split("\n")[0]}`);
    }
    return {
      pairId,
      collateralUsd,
      debtUsd,
      ltv: collateralUsd > 0 ? debtUsd / collateralUsd : debtUsd > 0 ? Infinity : 0,
      healthFactor: acct.healthFactor,
      equityUsd: collateralUsd - debtUsd,
      rewardsUnclaimed,
      asOfMs: Date.now(),
    };
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return erc20Balance(this.env, asset.address as Address);
  }

  // -------------------------------------------------------------------------
  // LendingAdapter: writes
  // -------------------------------------------------------------------------

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    const p = this.pair(pairId);
    const txs: TxRecord[] = [];
    const fail = (detail: string): LiveResult => ({ ok: false, txs, detail: `${this.id} open ${pairId}: ${detail}` });
    if (!(equity > 0n)) return fail("equity must be > 0");
    if (!(targetLtv > 0 && targetLtv < 1)) return fail(`targetLtv must be in (0,1), got ${targetLtv}`);
    try {
      const ui = await this.readUi();
      const R = await this.pairReserves(p, ui);
      const cats = await this.eModeCategories(ui);
      const legacy = isLegacyLayout(ui.layout);
      const { chosen } = this.chooseMode(p, R, cats, ui.layout);
      const reasons = this.pausedReasons(R, chosen);
      if (reasons.length) return fail(`market not open for new loops: ${reasons.join("; ")}`);
      const acct = await this.readAccount(p);

      // e-mode: switch only when the account has no debt; otherwise the current mode must work
      let mode = chosen;
      let setEMode = false;
      if (acct.userEMode !== chosen.categoryId) {
        if (acct.totalDebtBase > 0n) {
          const cur = pairModeIn(acct.userEMode, this.modeInfo(R.c, R.cs), this.modeInfo(R.d, R.ds), cats, legacy);
          if (!cur || !(cur.ltv > 0))
            return fail(`wallet is in e-mode ${acct.userEMode} with open debt and cannot borrow ${p.debt.symbol} there; close other positions of this market first`);
          this.log("warn", `${this.id} ${pairId}: keeping current e-mode ${acct.userEMode} (open debt) instead of ${chosen.categoryId}`);
          mode = cur;
        } else setEMode = true;
      }
      if (!(mode.ltv > 0)) return fail(`collateral ${p.collateral.symbol} has LTV 0 in e-mode ${mode.categoryId}`);
      if (targetLtv > mode.ltv * MAX_TARGET_FRAC_OF_LTV)
        return fail(`targetLtv ${targetLtv} > ${MAX_TARGET_FRAC_OF_LTV} x LTV ${mode.ltv} (e-mode ${mode.categoryId} "${mode.label}")`);
      if (R.d.isSiloedBorrowing) {
        const others = this.borrowingOtherThan(acct.userConfig, R.ds.id);
        if (others) return fail(`${p.debt.symbol} is siloed and the wallet already borrows other assets in this market`);
      }

      const have = await this.walletBalance(p.collateral);
      if (have < equity) return fail(`wallet has ${have} ${p.collateral.symbol} base units, need ${equity}`);

      const same = this.isSame(p);
      const minBorrow = this.minUnits(acct.priceD, p.debt.decimals);
      // swap cost estimate for the plan (pairs): quote the expected total borrow once
      let swapCost = 0;
      if (!same) {
        const rough = planLoopSteps(equity, targetLtv, mode.ltv, acct.r, ctx.limits.maxLoopIterations, {
          collateralDecimals: p.collateral.decimals,
          debtDecimals: p.debt.decimals,
          existingCollateral: acct.S,
          existingDebt: acct.D,
          minBorrow,
        });
        if (rough.totalBorrowed > 0n) {
          const q = await this.swapper!.quote(p.debt, p.collateral, rough.totalBorrowed, ctx);
          swapCost = Math.max(0, q.costBps / 1e4);
          const maxBps = p.maxEntrySwapCostBps ?? 50;
          if (q.costBps > maxBps) return fail(`swap ${p.debt.symbol}->${p.collateral.symbol} costs ${q.costBps.toFixed(1)} bps > ${maxBps} bps`);
        }
      }
      const plan = planLoopSteps(equity, targetLtv, mode.ltv, acct.r, ctx.limits.maxLoopIterations, {
        collateralDecimals: p.collateral.decimals,
        debtDecimals: p.debt.decimals,
        sameAsset: same,
        swapCostFrac: swapCost,
        existingCollateral: acct.S,
        existingDebt: acct.D,
        minBorrow,
      });

      // caps / liquidity
      const tot = await this.totals(R);
      const supplyRoom = capRemaining(R.c.supplyCap, R.c.decimals, tot.cSupply + rayMul(R.c.accruedToTreasury, R.c.liquidityIndex));
      if (supplyRoom !== null && supplyRoom < plan.totalSupplied)
        return fail(`supply cap: room ${supplyRoom} < planned supply ${plan.totalSupplied} ${p.collateral.symbol} units`);
      const borrowRoom = capRemaining(R.d.borrowCap, R.d.decimals, tot.dDebt);
      if (borrowRoom !== null && borrowRoom < plan.totalBorrowed)
        return fail(`borrow cap: room ${borrowRoom} < planned borrow ${plan.totalBorrowed} ${p.debt.symbol} units`);
      if (this.availableToBorrow(R.d) < plan.totalBorrowed) return fail(`not enough ${p.debt.symbol} liquidity for planned borrow ${plan.totalBorrowed}`);

      // ---- the Aave-only prefix (same asset: everything; pairs: up to the first swap)
      const pool = this.market.pool;
      const prefix: TxRequest[] = [];
      const approveNeed = same ? plan.totalSupplied : equity;
      prefix.push(...(await this.approveRequests(p.collateral.address as Address, approveNeed)));
      if (setEMode) prefix.push(this.req("setUserEMode", [mode.categoryId], `setUserEMode(${mode.categoryId} "${mode.label}")`));
      prefix.push(this.req("supply", [p.collateral.address, equity, this.env.account, REFERRAL_CODE], `supply ${equity} ${p.collateral.symbol}`));
      if (!userConfigFlags(acct.userConfig, R.cs.id).collateral)
        prefix.push(this.req("setUserUseReserveAsCollateral", [p.collateral.address, true], `enable ${p.collateral.symbol} as collateral (if not auto-enabled)`));
      const loopSteps = plan.steps.slice(1);
      for (const s of loopSteps) {
        if (s.kind === "borrow")
          prefix.push(this.req("borrow", [p.debt.address, s.amount, VARIABLE_RATE_MODE, REFERRAL_CODE, this.env.account], `borrow ${s.amount} ${p.debt.symbol}`));
        else if (s.kind === "supply" && same)
          prefix.push(this.req("supply", [p.collateral.address, s.amount, this.env.account, REFERRAL_CODE], `supply ${s.amount} ${p.collateral.symbol}`));
        if (!same && s.kind === "borrow") break; // swap next: opaque, cannot be batch-simulated
      }
      const summary = this.loopSummary(plan, mode, p, targetLtv);
      if (!plan.reachedTarget && ctx.dryRun)
        this.log("warn", `${this.id} open ${pairId}: plan ends below target LTV ${targetLtv} (final ${plan.finalLtv.toFixed(4)}) at the iteration cap ${ctx.limits.maxLoopIterations}`);

      const batch = await this.simulateBatch(prefix, ctx);
      if (batch.supported && !batch.ok) return fail(`pre-simulation failed at step ${(batch.failedIndex ?? 0) + 1} "${prefix[batch.failedIndex ?? 0]?.description}": ${batch.error}`);

      if (ctx.dryRun) {
        txs.push(await sendTx(this.env, ctx, prefix[0]!));
        if (batch.supported) txs.push(...batch.records.slice(1));
        let swapNote = "";
        const firstBorrow = plan.steps.find((s) => s.kind === "borrow");
        if (!same && firstBorrow) {
          const q = await this.swapper!.quote(p.debt, p.collateral, firstBorrow.amount, ctx);
          swapNote = ` | first swap quoted: ${firstBorrow.amount} ${p.debt.symbol} -> ${q.amountOut} ${p.collateral.symbol} (${q.costBps.toFixed(1)} bps via ${q.route})`;
        }
        const simNote = batch.supported
          ? `simulated ${prefix.length} Aave step(s) in one eth_simulateV1 batch${same ? "" : " (up to the first swap)"}`
          : `only step 1 simulated (no eth_simulateV1 on this RPC: later steps depend on state the earlier ones create)`;
        return { ok: true, txs, detail: `dry-run: ${simNote}${swapNote} | plan: ${summary}`, amountUsd: toHuman(equity, p.collateral.decimals) * acct.priceC };
      }

      // ---- live, sequential
      txs.push(...(await ensureAllowance(this.env, ctx, p.collateral.address as Address, pool, approveNeed)));
      if (setEMode) txs.push(await sendTx(this.env, ctx, this.req("setUserEMode", [mode.categoryId], `setUserEMode(${mode.categoryId})`)));
      txs.push(await sendTx(this.env, ctx, this.req("supply", [p.collateral.address, equity, this.env.account, REFERRAL_CODE], `supply ${equity} ${p.collateral.symbol}`)));
      const cfgAfter = await this.env.publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: "getUserConfiguration", args: [this.env.account] });
      if (!userConfigFlags(cfgAfter.data, R.cs.id).collateral)
        txs.push(await sendTx(this.env, ctx, this.req("setUserUseReserveAsCollateral", [p.collateral.address, true], `enable ${p.collateral.symbol} as collateral`)));

      let a = await this.readAccount(p);
      const Dt = targetLoopDebt(toHuman(a.S, p.collateral.decimals), toHuman(a.D, p.debt.decimals), targetLtv, a.r, swapCost);
      let iterations = 0;
      for (let i = 0; i < ctx.limits.maxLoopIterations; i++) {
        const S = toHuman(a.S, p.collateral.decimals);
        const D = toHuman(a.D, p.debt.decimals);
        const b = fromHumanFloor(nextLoopBorrow(S, D, targetLtv, a.r, Dt - D) * (1 - 1e-9), p.debt.decimals);
        if (b < minBorrow || b <= 0n) break;
        txs.push(await sendTx(this.env, ctx, this.req("borrow", [p.debt.address, b, VARIABLE_RATE_MODE, REFERRAL_CODE, this.env.account], `borrow ${b} ${p.debt.symbol}`)));
        let supplyAmt = b;
        if (!same) {
          const got = await this.swapMeasured(p.debt, p.collateral, b, ctx, p.maxEntrySwapCostBps ?? 50, txs);
          if (got.error) {
            // put the borrowed funds back so no debt sits idle in the wallet
            const back = await this.walletBalance(p.debt);
            const amt = back < b ? back : b;
            if (amt > 0n) {
              txs.push(...(await ensureAllowance(this.env, ctx, p.debt.address as Address, pool, amt)));
              txs.push(await sendTx(this.env, ctx, this.req("repay", [p.debt.address, amt, VARIABLE_RATE_MODE, this.env.account], `rollback: repay ${amt} ${p.debt.symbol}`)));
            }
            return fail(`swap failed after ${iterations} iteration(s), borrow rolled back: ${got.error}`);
          }
          supplyAmt = got.received;
        }
        txs.push(...(await ensureAllowance(this.env, ctx, p.collateral.address as Address, pool, supplyAmt)));
        txs.push(await sendTx(this.env, ctx, this.req("supply", [p.collateral.address, supplyAmt, this.env.account, REFERRAL_CODE], `supply ${supplyAmt} ${p.collateral.symbol}`)));
        iterations++;
        a = await this.readAccount(p);
      }
      const Sv = toHuman(a.S, p.collateral.decimals) * a.r;
      const Dv = toHuman(a.D, p.debt.decimals);
      const ltv = Dv / Math.max(1e-18, Sv);
      const lev = Sv > Dv ? Sv / (Sv - Dv) : Infinity;
      const reached = Dt - Dv <= Math.max(toHuman(minBorrow, p.debt.decimals), Dt * 1e-6);
      let shortfall = "";
      if (!reached) {
        shortfall = ` BELOW TARGET (iteration cap ${ctx.limits.maxLoopIterations}): achieved LTV ${ltv.toFixed(4)} / leverage ${lev.toFixed(2)}x vs target LTV ${targetLtv} / ${(1 / (1 - targetLtv)).toFixed(2)}x;`;
        this.log("warn", `${this.id} open ${pairId}:${shortfall} raise limits.maxLoopIterations or accept the lower leverage`);
      }
      return {
        ok: true,
        txs,
        detail: `opened: ${iterations} loop iteration(s), LTV ${ltv.toFixed(4)} (target ${targetLtv}), leverage ${lev.toFixed(2)}x,${shortfall} HF ${a.healthFactor.toFixed(3)}, e-mode ${mode.categoryId}`,
        amountUsd: toHuman(equity, p.collateral.decimals) * acct.priceC,
      };
    } catch (e) {
      return fail((e as Error).message.split("\n")[0]!);
    }
  }

  async close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    const p = this.pair(pairId);
    if (!(fraction > 0 && fraction <= 1)) return { ok: false, txs: [], detail: `fraction must be in (0,1], got ${fraction}` };
    try {
      const acct = await this.readAccount(p);
      if (acct.S === 0n && acct.D === 0n) return { ok: true, txs: [], detail: "no position" };
      const paused = await this.pausedForExit(p);
      if (paused) return { ok: false, txs: [], detail: `${this.id} close ${pairId}: ${paused}` };
      if (this.isSame(p)) {
        const plan = planSameAssetClose(acct.S, acct.D, fraction);
        const reqs: TxRequest[] = [];
        if (plan.repayWithATokens > 0n)
          reqs.push(this.req("repayWithATokens", [p.debt.address, plan.repayWithATokens, VARIABLE_RATE_MODE], `repayWithATokens ${this.amt(plan.repayWithATokens)} ${p.debt.symbol}`));
        reqs.push(this.req("withdraw", [p.collateral.address, plan.withdraw, this.env.account], `withdraw ${this.amt(plan.withdraw)} ${p.collateral.symbol}`));
        return this.executeSequence(reqs, ctx, `close ${pairId} x${fraction}`);
      }
      return this.unwindPair(p, acct, { fraction }, ctx);
    } catch (e) {
      return { ok: false, txs: [], detail: `${this.id} close ${pairId}: ${(e as Error).message.split("\n")[0]}` };
    }
  }

  async deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    const p = this.pair(pairId);
    if (!(targetLtv >= 0 && targetLtv < 1)) return { ok: false, txs: [], detail: `targetLtv must be in [0,1), got ${targetLtv}` };
    try {
      const acct = await this.readAccount(p);
      if (acct.D === 0n) return { ok: true, txs: [], detail: "no debt" };
      const paused = await this.pausedForExit(p);
      if (paused) return { ok: false, txs: [], detail: `${this.id} deleverage ${pairId}: ${paused}` };
      if (this.isSame(p)) {
        const x = planSameAssetDeleverage(acct.S, acct.D, targetLtv);
        if (x === 0n) return { ok: true, txs: [], detail: `LTV already <= ${targetLtv}` };
        return this.executeSequence(
          [this.req("repayWithATokens", [p.debt.address, x, VARIABLE_RATE_MODE], `repayWithATokens ${x} ${p.debt.symbol}`)],
          ctx,
          `deleverage ${pairId} -> ${targetLtv}`
        );
      }
      return this.unwindPair(p, acct, { targetLtv }, ctx);
    } catch (e) {
      return { ok: false, txs: [], detail: `${this.id} deleverage ${pairId}: ${(e as Error).message.split("\n")[0]}` };
    }
  }

  async simulateClose(pairId: string, ctx: LiveContext): Promise<boolean> {
    const p = this.pair(pairId);
    const dctx: LiveContext = { ...ctx, dryRun: true };
    try {
      const acct = await this.readAccount(p);
      if (acct.S === 0n && acct.D === 0n) return true;
      if (await this.pausedForExit(p)) return false;
      if (this.isSame(p)) {
        const reqs: TxRequest[] = [];
        if (acct.D > 0n) reqs.push(this.req("repayWithATokens", [p.debt.address, MAX_UINT256, VARIABLE_RATE_MODE], "repayWithATokens(max)"));
        reqs.push(this.req("withdraw", [p.collateral.address, MAX_UINT256, this.env.account], "withdraw(max)"));
        const r = await this.executeSequence(reqs, dctx, `simulateClose ${pairId}`);
        return r.ok;
      }
      const params = await this.unwindParams(p, acct, dctx);
      const st = unwindStep(acct.S, acct.D, { targetDebt: 0n }, params);
      if (st.done) return true;
      if (st.stuck) return false;
      await sendTx(this.env, dctx, this.req("withdraw", [p.collateral.address, st.withdraw, this.env.account], `withdraw ${st.withdraw} ${p.collateral.symbol}`));
      const q = await this.swapper!.quote(p.collateral, p.debt, st.withdraw, dctx);
      return q.costBps <= (p.maxExitSwapCostBps ?? 200) && q.amountOut > 0n;
    } catch (e) {
      this.log("warn", `${this.id} simulateClose ${pairId}: ${(e as Error).message.split("\n")[0]}`);
      return false;
    }
  }

  async claimRewards(ctx: LiveContext, pairId?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }> {
    const pairs = pairId ? [this.pair(pairId)] : [...this.pairs.values()];
    const statics = await this.reserveStatics(this.uniqueAssets(pairs).map((a) => a.address as Address));
    const tokenSet = new Set<string>();
    for (const p of pairs) {
      tokenSet.add(statics.get(lc(p.collateral.address))!.aToken);
      tokenSet.add(statics.get(lc(p.debt.address))!.vToken);
    }
    const all = [...tokenSet] as Address[];
    const bal = await this.readMany(all.map((t) => ({ address: t, abi: AAVE_TOKEN_ABI, functionName: "balanceOf", args: [this.env.account] })));
    const tokens = all.filter((_, i) => bal[i]!.ok && (bal[i] as { value: bigint }).value > 0n);
    const controller = await this.rewardsController();
    if (!controller) return { ok: true, txs: [], claimed: [], detail: "no RewardsController on this market (rewards come via Merkl)" };
    if (!tokens.length) return { ok: true, txs: [], claimed: [], detail: "no positions" };
    const [rewards, amounts] = await this.env.publicClient.readContract({
      address: controller,
      abi: REWARDS_CONTROLLER_ABI,
      functionName: "getAllUserRewards",
      args: [tokens, this.env.account],
    });
    const claimed: { token: string; amount: bigint; decimals: number }[] = [];
    for (let i = 0; i < rewards.length; i++) {
      if (!(amounts[i]! > 0n)) continue;
      const m = await this.rewardTokenMeta(rewards[i]!, controller);
      claimed.push({ token: m.symbol, amount: amounts[i]!, decimals: m.decimals });
    }
    if (!claimed.length) return { ok: true, txs: [], claimed, detail: "nothing to claim" };
    try {
      const rec = await sendTx(this.env, ctx, {
        to: controller,
        data: encodeFunctionData({ abi: REWARDS_CONTROLLER_ABI, functionName: "claimAllRewardsToSelf", args: [tokens] }),
        description: `claimAllRewardsToSelf(${tokens.length} tokens)`,
      });
      return { ok: true, txs: [rec], claimed, detail: claimed.map((c) => `${toHuman(c.amount, c.decimals)} ${c.token}`).join(", ") };
    } catch (e) {
      return { ok: false, txs: [], claimed: [], detail: `${this.id} claim: ${(e as Error).message.split("\n")[0]}` };
    }
  }

  // -------------------------------------------------------------------------
  // Config verification (on-chain read-back)
  // -------------------------------------------------------------------------

  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    const m = this.market;
    const pc = this.env.publicClient;
    const tryRead = async <T>(label: string, f: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await f();
      } catch (e) {
        issues.push(`${label}: ${(e as Error).message.split("\n")[0]}`);
        return undefined;
      }
    };
    await tryRead("chainId", () => assertChainId(this.env));
    if (m.evmChainId !== undefined && m.evmChainId !== this.env.viemChain.id)
      issues.push(`market evmChainId ${m.evmChainId} != env chain id ${this.env.viemChain.id}`);
    const named: [string, Address | undefined][] = [
      ["pool", m.pool],
      ["poolAddressesProvider", m.poolAddressesProvider],
      ["uiPoolDataProvider", m.uiPoolDataProvider],
      ["rewardsController", m.rewardsController],
      ["uiIncentiveDataProvider", m.uiIncentiveDataProvider],
    ];
    for (const [name, addr] of named) {
      if (!addr) continue;
      const code = await tryRead(`getCode ${name}`, () => pc.getCode({ address: addr }));
      if (code !== undefined && (!code || code === "0x")) issues.push(`${name} ${addr} has no code`);
    }
    const poolOf = await tryRead("provider.getPool()", () =>
      pc.readContract({ address: m.poolAddressesProvider, abi: ADDRESSES_PROVIDER_ABI, functionName: "getPool" })
    );
    if (poolOf && lc(poolOf) !== lc(m.pool)) issues.push(`provider.getPool() = ${poolOf} != configured pool ${m.pool}`);
    const providerOf = await tryRead("pool.ADDRESSES_PROVIDER()", () =>
      pc.readContract({ address: m.pool, abi: POOL_ABI, functionName: "ADDRESSES_PROVIDER" })
    );
    if (providerOf && lc(providerOf) !== lc(m.poolAddressesProvider))
      issues.push(`pool.ADDRESSES_PROVIDER() = ${providerOf} != configured provider ${m.poolAddressesProvider}`);
    const oracle = await tryRead("provider.getPriceOracle()", () => this.priceOracle());
    if (oracle) {
      const code = await tryRead("getCode oracle", () => pc.getCode({ address: oracle }));
      if (code !== undefined && (!code || code === "0x")) issues.push(`price oracle ${oracle} has no code`);
    }
    const ui = await tryRead("uiPoolDataProvider.getReservesData", () => this.readUi());
    if (ui && m.uiLayout && ui.layout !== m.uiLayout) issues.push(`uiLayout pinned ${m.uiLayout} but data decodes as ${ui.layout}`);
    const assets = this.uniqueAssets([...this.pairs.values()]);
    for (const a of assets) {
      issues.push(...((await tryRead(`verifyAsset ${a.symbol}`, () => verifyAsset(this.env, a))) ?? []));
      const row = ui?.reserves.find((r) => lc(r.underlyingAsset) === lc(a.address));
      if (ui && !row) {
        issues.push(`${a.symbol} ${a.address} is not a reserve of pool ${m.pool}`);
        continue;
      }
      if (row && row.decimals !== a.decimals) issues.push(`${a.symbol}: reserve decimals ${row.decimals} != config ${a.decimals}`);
      const st = await tryRead(`pool.getReserveData(${a.symbol})`, async () => (await this.reserveStatics([a.address as Address])).get(lc(a.address))!);
      if (!st) continue;
      if (row && lc(row.aTokenAddress) !== lc(st.aToken)) issues.push(`${a.symbol}: aToken mismatch pool ${st.aToken} vs data provider ${row.aTokenAddress}`);
      const under = await tryRead(`aToken(${a.symbol}).UNDERLYING_ASSET_ADDRESS`, () =>
        pc.readContract({ address: st.aToken, abi: AAVE_TOKEN_ABI, functionName: "UNDERLYING_ASSET_ADDRESS" })
      );
      if (under && lc(under) !== lc(a.address)) issues.push(`${a.symbol}: aToken underlying ${under} != ${a.address}`);
      if (m.rewardsController) {
        for (const [label, tok] of [
          ["aToken", st.aToken],
          ["vToken", st.vToken],
        ] as const) {
          const ic = await tryRead(`${label}(${a.symbol}).getIncentivesController`, () =>
            pc.readContract({ address: tok, abi: AAVE_TOKEN_ABI, functionName: "getIncentivesController" })
          );
          if (ic && ic !== zeroAddress && lc(ic) !== lc(m.rewardsController))
            issues.push(`${a.symbol} ${label} incentives controller ${ic} != configured rewardsController ${m.rewardsController}`);
        }
      }
    }
    if (ui) {
      const cats = await tryRead("e-mode categories", () => this.eModeCategories(ui, true));
      for (const p of this.pairs.values()) {
        if (lc(p.collateral.address) === lc(p.debt.address) && p.collateral.symbol !== p.debt.symbol)
          issues.push(`${p.pairId}: same address but different symbols (core treats it as a two-asset pair)`);
        if (!cats) continue;
        try {
          const R = await this.pairReserves(p, ui);
          const { chosen } = this.chooseMode(p, R, cats, ui.layout);
          if (!(chosen.ltv > 0)) issues.push(`${p.pairId}: collateral LTV is 0 in the selected mode ${chosen.categoryId}`);
        } catch (e) {
          issues.push(`${p.pairId}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    return issues;
  }

  // -------------------------------------------------------------------------
  // Internals: reads
  // -------------------------------------------------------------------------

  private pair(pairId: string): AavePairConfig {
    const p = this.pairs.get(pairId);
    if (!p) throw new Error(`${this.id}: unknown pair ${pairId}`);
    return p;
  }

  private isSame(p: AavePairConfig): boolean {
    return lc(p.collateral.address) === lc(p.debt.address);
  }

  private uniqueAssets(pairs: AavePairConfig[]): AssetRef[] {
    const m = new Map<string, AssetRef>();
    for (const p of pairs) for (const a of [p.collateral, p.debt]) m.set(lc(a.address), a);
    return [...m.values()];
  }

  private get loose(): LooseClient {
    return this.env.publicClient as unknown as LooseClient;
  }

  private async readMany(calls: ReadCall[]): Promise<ReadResult[]> {
    if (!calls.length) return [];
    try {
      const res = await this.loose.multicall({ contracts: calls, allowFailure: true });
      return res.map((r) => (r.status === "success" ? { ok: true, value: r.result } : { ok: false, error: r.error?.message ?? "failed" }));
    } catch {
      // no multicall3 on this chain (or RPC refused the batch): one call each
      return Promise.all(
        calls.map(async (c): Promise<ReadResult> => {
          try {
            return { ok: true, value: await this.loose.readContract(c) };
          } catch (e) {
            return { ok: false, error: (e as Error).message.split("\n")[0]! };
          }
        })
      );
    }
  }

  /** One UiPoolDataProvider.getReservesData call, layout auto-detected (cached after the first success). */
  private async readUi(): Promise<UiReservesData> {
    const pc = this.env.publicClient;
    const [list, raw] = await Promise.all([
      pc.readContract({ address: this.market.pool, abi: POOL_ABI, functionName: "getReservesList" }),
      pc.call({
        to: this.market.uiPoolDataProvider,
        data: encodeFunctionData({ abi: UI_POOL_GET_RESERVES_DATA_INPUT_ABI, functionName: "getReservesData", args: [this.market.poolAddressesProvider] }),
      }),
    ]);
    if (!raw.data || raw.data === "0x") throw new Error(`${this.id}: UiPoolDataProvider returned no data`);
    const ui = detectUiReservesData(raw.data, list, this.market.uiLayout ?? this.layout);
    if (this.layout !== ui.layout)
      this.log(ui.exact ? "info" : "warn", `${this.id}: UiPoolDataProvider layout ${ui.layout}${ui.exact ? "" : " (prefix match only: unknown layout, verify fields)"}`);
    this.layout = ui.layout;
    this.lastUi = ui;
    return ui;
  }

  /** Reserve id + token addresses (immutable per reserve; cached). */
  private async reserveStatics(assets: Address[]): Promise<Map<string, ReserveStatic>> {
    const missing = [...new Set(assets.map(lc))].filter((a) => !this.statics.has(a));
    if (missing.length) {
      const res = await this.readMany(missing.map((a) => ({ address: this.market.pool, abi: POOL_ABI, functionName: "getReserveData", args: [a] })));
      missing.forEach((a, i) => {
        const r = res[i]!;
        if (!r.ok) throw new Error(`${this.id}: pool.getReserveData(${a}) failed: ${r.error}`);
        const v = r.value as { id: number; aTokenAddress: Address; variableDebtTokenAddress: Address };
        if (v.aTokenAddress === zeroAddress) throw new Error(`${this.id}: ${a} is not a reserve of pool ${this.market.pool}`);
        this.statics.set(a, { id: Number(v.id), aToken: v.aTokenAddress, vToken: v.variableDebtTokenAddress });
      });
    }
    const out = new Map<string, ReserveStatic>();
    for (const a of assets) out.set(lc(a), this.statics.get(lc(a))!);
    return out;
  }

  private async pairReserves(p: AavePairConfig, ui: UiReservesData): Promise<PairReserves> {
    const c = ui.reserves.find((r) => lc(r.underlyingAsset) === lc(p.collateral.address));
    const d = ui.reserves.find((r) => lc(r.underlyingAsset) === lc(p.debt.address));
    if (!c) throw new Error(`${p.collateral.symbol} is not a reserve of this pool`);
    if (!d) throw new Error(`${p.debt.symbol} is not a reserve of this pool`);
    const st = await this.reserveStatics([p.collateral.address as Address, p.debt.address as Address]);
    return { c, d, cs: st.get(lc(p.collateral.address))!, ds: st.get(lc(p.debt.address))! };
  }

  /**
   * E-mode categories. 3.0/3.1: derived from the per-reserve e-mode fields of
   * the data provider. 3.2+: Pool getters (bitmaps), ids scanned upward until
   * three consecutive empty ids (the same rule UiPoolDataProviderV3.getEModes uses).
   */
  private async eModeCategories(ui: UiReservesData, fresh = false): Promise<EModeCategoryInfo[]> {
    const legacy = isLegacyLayout(ui.layout);
    const ttl = this.opts.eModeCacheMs ?? 600_000;
    if (!fresh && this.eModeCache && this.eModeCache.legacy === legacy && Date.now() - this.eModeCache.atMs < ttl) return this.eModeCache.cats;
    let cats: EModeCategoryInfo[];
    if (legacy) {
      const byId = new Map<number, EModeCategoryInfo>();
      for (const r of ui.reserves) {
        const id = r.eModeCategoryId ?? 0;
        if (id > 0 && !byId.has(id))
          byId.set(id, { id, ltv: r.eModeLtv ?? 0, liquidationThreshold: r.eModeLiquidationThreshold ?? 0, label: r.eModeLabel ?? "" });
      }
      cats = [...byId.values()];
    } else {
      cats = [];
      let misses = 0;
      const per = ["getEModeCategoryCollateralConfig", "getEModeCategoryCollateralBitmap", "getEModeCategoryBorrowableBitmap", "getEModeCategoryLtvzeroBitmap", "getIsEModeCategoryIsolated", "getEModeCategoryLabel"];
      for (let start = 1; start <= 255 && misses <= 2; start += 16) {
        const ids = Array.from({ length: Math.min(16, 256 - start) }, (_, i) => start + i);
        const res = await this.readMany(ids.flatMap((id) => per.map((fn) => ({ address: this.market.pool, abi: POOL_ABI, functionName: fn, args: [id] }))));
        for (let k = 0; k < ids.length && misses <= 2; k++) {
          const g = (j: number) => res[k * per.length + j]!;
          const cfg = g(0);
          if (!cfg.ok) {
            if (ids[k] === 1) this.log("warn", `${this.id}: pool has no e-mode bitmap getters (${cfg.error}); e-modes ignored`);
            misses = 3;
            break;
          }
          const c = cfg.value as { ltv: number; liquidationThreshold: number };
          if (!(Number(c.liquidationThreshold) > 0)) {
            misses++;
            continue;
          }
          misses = 0;
          const val = <T>(j: number, fb: T): T => (g(j).ok ? ((g(j) as { value: T }).value ?? fb) : fb);
          cats.push({
            id: ids[k]!,
            ltv: Number(c.ltv),
            liquidationThreshold: Number(c.liquidationThreshold),
            collateralBitmap: val<bigint>(1, 0n),
            borrowableBitmap: val<bigint>(2, 0n),
            ltvzeroBitmap: val<bigint>(3, 0n),
            isolated: val<boolean>(4, false),
            label: val<string>(5, ""),
          });
        }
      }
    }
    this.eModeCache = { atMs: Date.now(), legacy, cats };
    return cats;
  }

  private modeInfo(r: UiReserve, s: ReserveStatic): ReserveModeInfo {
    return { id: s.id, baseLtv: r.baseLTVasCollateral, liquidationThreshold: r.reserveLiquidationThreshold, legacyEModeCategory: r.eModeCategoryId };
  }

  private chooseMode(p: AavePairConfig, R: PairReserves, cats: EModeCategoryInfo[], layout: UiLayout) {
    return selectEMode(this.modeInfo(R.c, R.cs), this.modeInfo(R.d, R.ds), cats, isLegacyLayout(layout), p.eMode ?? "auto");
  }

  /** Reasons the pair cannot be entered right now (empty = open). */
  private pausedReasons(R: PairReserves, mode: ModeChoice): string[] {
    const out: string[] = [];
    const { c, d } = R;
    if (!c.isActive) out.push(`${c.symbol} reserve inactive`);
    if (!d.isActive && d !== c) out.push(`${d.symbol} reserve inactive`);
    if (c.isPaused) out.push(`${c.symbol} paused`);
    if (d.isPaused && d !== c) out.push(`${d.symbol} paused`);
    if (c.isFrozen) out.push(`${c.symbol} frozen`);
    if (d.isFrozen && d !== c) out.push(`${d.symbol} frozen`);
    if (!d.borrowingEnabled) out.push(`${d.symbol} borrowing disabled`);
    if (!(mode.ltv > 0)) out.push(`${c.symbol} LTV 0 in mode ${mode.categoryId}`);
    if (c.debtCeiling > 0n && !d.borrowableInIsolation) out.push(`${c.symbol} is isolated and ${d.symbol} is not borrowable in isolation`);
    return out;
  }

  /** Exit (repay / withdraw) is blocked only by pause / inactive; frozen reserves still allow it. */
  private async pausedForExit(p: AavePairConfig): Promise<string | null> {
    const ui = await this.readUi();
    const R = await this.pairReserves(p, ui);
    const out: string[] = [];
    for (const r of [R.c, R.d]) {
      if (r.isPaused) out.push(`${r.symbol} paused (repay/withdraw disabled)`);
      if (!r.isActive) out.push(`${r.symbol} inactive`);
    }
    return out.length ? [...new Set(out)].join("; ") : null;
  }

  private priceOf(r: UiReserve, ui: UiReservesData): number {
    return refPriceToUsd(r.priceInMarketReferenceCurrency, ui.base.marketReferenceCurrencyUnit, ui.base.marketReferenceCurrencyPriceInUsd);
  }

  private availableToBorrow(r: UiReserve): bigint {
    const virtual = r.virtualUnderlyingBalance !== undefined && (r.virtualAccActive ?? true);
    return virtual ? r.virtualUnderlyingBalance! : r.availableLiquidity;
  }

  private async totals(R: PairReserves): Promise<{ cSupply: bigint; dDebt: bigint }> {
    const pc = this.env.publicClient;
    const [cSupply, dDebt] = await Promise.all([
      pc.readContract({ address: R.cs.aToken, abi: AAVE_TOKEN_ABI, functionName: "totalSupply" }),
      pc.readContract({ address: R.ds.vToken, abi: AAVE_TOKEN_ABI, functionName: "totalSupply" }),
    ]);
    return { cSupply, dDebt: dDebt + R.d.totalPrincipalStableDebt };
  }

  /** Borrow room USD: min(borrow cap room, borrowable liquidity, isolation debt ceiling room of the collateral). */
  private borrowRoomUsd(d: UiReserve, td: { debt: bigint }, pd: number, c: UiReserve): number | null {
    const capRoom = capRemaining(d.borrowCap, d.decimals, td.debt);
    let usd = toHuman(this.availableToBorrow(d), d.decimals) * pd;
    if (capRoom !== null) usd = Math.min(usd, toHuman(capRoom, d.decimals) * pd);
    if (c.debtCeiling > 0n) {
      const room = c.debtCeiling > c.isolationModeTotalDebt ? c.debtCeiling - c.isolationModeTotalDebt : 0n;
      usd = Math.min(usd, toHuman(room, c.debtCeilingDecimals));
    }
    return Number.isFinite(usd) ? Math.max(0, usd) : null;
  }

  private async leg(
    asset: AssetRef,
    r: UiReserve,
    s: ReserveStatic,
    t: { supply: bigint; debt: bigint },
    price: number,
    role: "collateral" | "debt"
  ): Promise<LoopLeg> {
    const supplyRoom = capRemaining(r.supplyCap, r.decimals, t.supply + rayMul(r.accruedToTreasury, r.liquidityIndex));
    const leg: LoopLeg = {
      symbol: asset.symbol,
      assetId: asset.address,
      priceUsd: price,
      totalSupplyUsd: toHuman(t.supply, r.decimals) * price,
      totalBorrowUsd: toHuman(t.debt, r.decimals) * price,
      supplyAprBase: rayToApr(r.liquidityRate),
      borrowAprBase: rayToApr(r.variableBorrowRate),
      supplyRewards: role === "collateral" ? await this.legRewards(asset, s, t, price, "supply") : [],
      borrowRewards: role === "debt" ? await this.legRewards(asset, s, t, price, "borrow") : [],
      irm: irmFromRay(r, r.reserveFactor),
      supplyCapRemainingUsd: supplyRoom === null ? null : toHuman(supplyRoom, r.decimals) * price,
      borrowFeeFrac: 0,
    };
    return leg;
  }

  /** Native RewardsController streams + extraRewards (Merkl) for one side of one reserve. */
  private async legRewards(asset: AssetRef, s: ReserveStatic, t: { supply: bigint; debt: bigint }, price: number, side: "supply" | "borrow"): Promise<RewardRate[]> {
    const out: RewardRate[] = [];
    const token = side === "supply" ? s.aToken : s.vToken;
    const poolUsd = toHuman(side === "supply" ? t.supply : t.debt, asset.decimals) * price;
    try {
      out.push(...(await this.nativeRewards(token, poolUsd)));
    } catch (e) {
      this.log("warn", `${this.id}: native rewards for ${asset.symbol} ${side} failed: ${(e as Error).message.split("\n")[0]}`);
    }
    if (this.extraRewards) {
      try {
        // Merkl matches Aave v3 campaigns by receipt token: aToken (supply/collateral) or variableDebtToken (borrow)
        out.push(...(await this.extraRewards({ protocol: this.market.protocol, chain: this.chain, asset, side, marketId: token })));
      } catch (e) {
        this.log("warn", `${this.id}: extra rewards for ${asset.symbol} ${side} failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    return out;
  }

  private async rewardsController(): Promise<Address | null> {
    if (this.market.rewardsController) return this.market.rewardsController;
    if (this.controllerAddr !== undefined) return this.controllerAddr;
    const first = [...this.pairs.values()][0];
    if (!first) return null;
    const st = await this.reserveStatics([first.collateral.address as Address]);
    const ic = await this.env.publicClient.readContract({ address: st.get(lc(first.collateral.address))!.aToken, abi: AAVE_TOKEN_ABI, functionName: "getIncentivesController" });
    this.controllerAddr = ic === zeroAddress ? null : ic;
    return this.controllerAddr;
  }

  private async rewardTokenMeta(reward: Address, controller: Address): Promise<{ symbol: string; decimals: number; oracle?: Address }> {
    const k = lc(reward);
    const hit = this.rewardMeta.get(k);
    if (hit) return hit;
    const res = await this.readMany([
      { address: reward, abi: erc20Abi, functionName: "symbol" },
      { address: reward, abi: erc20Abi, functionName: "decimals" },
      { address: controller, abi: REWARDS_CONTROLLER_ABI, functionName: "getRewardOracle", args: [reward] },
    ]);
    if (!res[1]!.ok) throw new Error(`reward token ${reward}: decimals() failed`);
    const m = {
      symbol: res[0]!.ok ? String((res[0] as { value: unknown }).value) : reward,
      decimals: Number((res[1] as { value: unknown }).value),
      oracle: res[2]!.ok && (res[2] as { value: Address }).value !== zeroAddress ? (res[2] as { value: Address }).value : undefined,
    };
    this.rewardMeta.set(k, m);
    return m;
  }

  private async rewardPriceUsd(meta: { oracle?: Address }): Promise<number> {
    if (!meta.oracle) return NaN;
    const res = await this.readMany([
      { address: meta.oracle, abi: AGGREGATOR_ABI, functionName: "latestAnswer" },
      { address: meta.oracle, abi: AGGREGATOR_ABI, functionName: "decimals" },
    ]);
    if (!res[0]!.ok || !res[1]!.ok) return NaN;
    const ans = (res[0] as { value: bigint }).value;
    const dec = Number((res[1] as { value: unknown }).value);
    return ans > 0n ? toHuman(ans, dec) : NaN;
  }

  /** APR = emission/s * seconds/year * reward price / pool USD; ended / zero streams dropped. */
  private async nativeRewards(token: Address, poolUsd: number): Promise<RewardRate[]> {
    const controller = await this.rewardsController();
    if (!controller) return [];
    const rewards = await this.env.publicClient.readContract({ address: controller, abi: REWARDS_CONTROLLER_ABI, functionName: "getRewardsByAsset", args: [token] });
    if (!rewards.length) return [];
    const data = await this.readMany(rewards.map((rw) => ({ address: controller, abi: REWARDS_CONTROLLER_ABI, functionName: "getRewardsData", args: [token, rw] })));
    const nowSec = Math.floor(Date.now() / 1000);
    const out: RewardRate[] = [];
    for (let i = 0; i < rewards.length; i++) {
      const d = data[i]!;
      if (!d.ok) continue;
      const [, eps, , end] = d.value as readonly [bigint, bigint, bigint, bigint];
      if (eps === 0n || Number(end) <= nowSec) continue;
      const meta = await this.rewardTokenMeta(rewards[i]!, controller);
      const price = await this.rewardPriceUsd(meta);
      if (!(price > 0)) {
        this.log("warn", `${this.id}: no price for reward ${meta.symbol} (oracle ${meta.oracle ?? "none"}); stream ignored`);
        continue;
      }
      out.push({ token: meta.symbol, apr: rewardAprFromEmission(eps, meta.decimals, price, poolUsd), endsAtMs: Number(end) * 1000 });
    }
    return out;
  }

  private async unclaimedRewards(tokens: Address[]): Promise<LoopPositionView["rewardsUnclaimed"]> {
    const controller = await this.rewardsController();
    if (!controller) return [];
    const [rewards, amounts] = await this.env.publicClient.readContract({
      address: controller,
      abi: REWARDS_CONTROLLER_ABI,
      functionName: "getAllUserRewards",
      args: [tokens, this.env.account],
    });
    const out: LoopPositionView["rewardsUnclaimed"] = [];
    for (let i = 0; i < rewards.length; i++) {
      const amount = amounts[i]!;
      if (!(amount > 0n)) continue;
      const meta = await this.rewardTokenMeta(rewards[i]!, controller);
      const price = await this.rewardPriceUsd(meta);
      out.push({ token: meta.symbol, amount, decimals: meta.decimals, usd: price > 0 ? toHuman(amount, meta.decimals) * price : 0 });
    }
    return out;
  }

  private async priceOracle(): Promise<Address> {
    if (!this.priceOracleAddr)
      this.priceOracleAddr = await this.env.publicClient.readContract({ address: this.market.poolAddressesProvider, abi: ADDRESSES_PROVIDER_ABI, functionName: "getPriceOracle" });
    return this.priceOracleAddr;
  }

  /** USD prices from the AaveOracle (USD base only); otherwise from a fresh data-provider read. */
  private async oraclePrices(assets: Address[]): Promise<number[]> {
    try {
      const oracle = await this.priceOracle();
      const pc = this.env.publicClient;
      const [baseCur, unit, prices] = await Promise.all([
        pc.readContract({ address: oracle, abi: AAVE_ORACLE_ABI, functionName: "BASE_CURRENCY" }),
        pc.readContract({ address: oracle, abi: AAVE_ORACLE_ABI, functionName: "BASE_CURRENCY_UNIT" }),
        pc.readContract({ address: oracle, abi: AAVE_ORACLE_ABI, functionName: "getAssetsPrices", args: [assets] }),
      ]);
      if (baseCur === zeroAddress && unit > 0n) return prices.map((p) => refPriceToUsd(p, unit, unit));
    } catch (e) {
      this.log("debug", `${this.id}: oracle price path failed (${(e as Error).message.split("\n")[0]}); using data provider`);
    }
    const ui = await this.readUi();
    return assets.map((a) => {
      const r = ui.reserves.find((x) => lc(x.underlyingAsset) === lc(a));
      if (!r) throw new Error(`${a} is not a reserve`);
      return this.priceOf(r, ui);
    });
  }

  private async readAccount(p: AavePairConfig): Promise<Account> {
    const st = await this.reserveStatics([p.collateral.address as Address, p.debt.address as Address]);
    const cs = st.get(lc(p.collateral.address))!;
    const ds = st.get(lc(p.debt.address))!;
    const pc = this.env.publicClient;
    const user = this.env.account;
    const [S, D, acct, em, cfg, prices] = await Promise.all([
      pc.readContract({ address: cs.aToken, abi: AAVE_TOKEN_ABI, functionName: "balanceOf", args: [user] }),
      pc.readContract({ address: ds.vToken, abi: AAVE_TOKEN_ABI, functionName: "balanceOf", args: [user] }),
      pc.readContract({ address: this.market.pool, abi: POOL_ABI, functionName: "getUserAccountData", args: [user] }),
      pc.readContract({ address: this.market.pool, abi: POOL_ABI, functionName: "getUserEMode", args: [user] }),
      pc.readContract({ address: this.market.pool, abi: POOL_ABI, functionName: "getUserConfiguration", args: [user] }),
      this.oraclePrices([p.collateral.address as Address, p.debt.address as Address]),
    ]);
    const [totalCollateralBase, totalDebtBase, , liq, ltv, hf] = acct;
    const [priceC, priceD] = prices as [number, number];
    if (!(priceC > 0 && priceD > 0)) throw new Error(`invalid oracle prices ${priceC} / ${priceD}`);
    return {
      S,
      D,
      userEMode: Number(em),
      totalCollateralBase,
      totalDebtBase,
      liqThreshold: Number(liq) / 1e4,
      maxLtv: Number(ltv) / 1e4,
      healthFactor: wadToHealthFactor(hf),
      priceC,
      priceD,
      r: this.isSame(p) ? 1 : priceC / priceD,
      userConfig: cfg.data,
    };
  }

  private borrowingOtherThan(userConfig: bigint, id: number): boolean {
    for (let i = 0; i < 128; i++) if (i !== id && userConfigFlags(userConfig, i).borrowing) return true;
    return false;
  }

  private minUnits(priceUsd: number, decimals: number): bigint {
    const u = fromHumanFloor((this.opts.minStepUsd ?? 1) / priceUsd, decimals);
    return u > 0n ? u : 1n;
  }

  // -------------------------------------------------------------------------
  // Internals: swaps
  // -------------------------------------------------------------------------

  private readCtx(): LiveContext {
    if (this.opts.readCtx) return this.opts.readCtx;
    return {
      dryRun: true,
      log: this.log,
      limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 30, maxLoopIterations: 8 },
      priceUsd: async (a) => {
        const ui = this.lastUi;
        const r = ui?.reserves.find((x) => lc(x.underlyingAsset) === lc(a.address));
        if (!ui || !r) throw new Error(`no Aave oracle price for ${a.symbol}`);
        return this.priceOf(r, ui);
      },
      nativePriceUsd: async (chain) => {
        throw new Error(`no native price for ${chain} in read context`);
      },
    };
  }

  /**
   * swapCostFrac = worst cost of the smallest probe over both directions;
   * swapDepthUsd = largest probe whose cost stays within maxSlippageBps of the
   * smallest probe's cost and within the entry / exit cost budgets (both directions).
   */
  private async swapMetrics(p: AavePairConfig, pc: number, pd: number): Promise<{ costFrac: number; depthUsd: number; atMs: number; error?: string }> {
    const hit = this.swapCache.get(p.pairId);
    const ttl = this.opts.swapCacheMs ?? 300_000;
    if (hit && Date.now() - hit.atMs < ttl) return hit;
    const ctx = this.readCtx();
    const probes = [...(p.swapProbeUsd ?? DEFAULT_PROBES_USD)].sort((a, b) => a - b);
    try {
      const dir = async (from: AssetRef, to: AssetRef, priceIn: number, budgetBps: number) => {
        let base: number | undefined;
        let depth = 0;
        for (const usd of probes) {
          const amt = fromHumanFloor(usd / priceIn, from.decimals);
          let cost: number;
          try {
            const q = await this.swapper!.quote(from, to, amt, ctx);
            cost = Number.isFinite(q.costBps) ? q.costBps / 1e4 : NaN;
            if (!(q.amountOut > 0n)) cost = NaN;
          } catch (e) {
            if (base === undefined) throw e;
            break;
          }
          if (!Number.isFinite(cost)) break;
          if (base === undefined) base = Math.max(0, cost);
          if (cost * 1e4 > budgetBps || (cost - base) * 1e4 > ctx.limits.maxSlippageBps) break;
          depth = usd;
        }
        return { base: base ?? Infinity, depth };
      };
      const entry = await dir(p.debt, p.collateral, pd, p.maxEntrySwapCostBps ?? 50);
      const exit = await dir(p.collateral, p.debt, pc, p.maxExitSwapCostBps ?? 200);
      const v = { atMs: Date.now(), costFrac: Math.max(entry.base, exit.base), depthUsd: Math.min(entry.depth, exit.depth) };
      this.swapCache.set(p.pairId, v);
      return v;
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!;
      this.log("warn", `${this.id} ${p.pairId}: swap quote failed: ${msg}`);
      // Infinity cost makes the core skip the pair instead of assuming a free swap
      const v = { atMs: Date.now(), costFrac: Infinity, depthUsd: 0, error: msg };
      this.swapCache.set(p.pairId, v);
      return v;
    }
  }

  /** Quote + swap, returning the measured wallet delta of `to`. */
  private async swapMeasured(
    from: AssetRef,
    to: AssetRef,
    amount: bigint,
    ctx: LiveContext,
    maxCostBps: number,
    txs: TxRecord[]
  ): Promise<{ received: bigint; error?: string }> {
    const before = await this.walletBalance(to);
    const q = await this.swapper!.quote(from, to, amount, ctx);
    if (q.costBps > maxCostBps) return { received: 0n, error: `swap ${from.symbol}->${to.symbol} costs ${q.costBps.toFixed(1)} bps > ${maxCostBps}` };
    const r = await this.swapper!.swap(q, from, to, ctx);
    txs.push(...r.txs);
    if (!r.ok) return { received: 0n, error: r.detail ?? "swap failed" };
    const after = await this.walletBalance(to);
    const got = after - before;
    if (got <= 0n) return { received: 0n, error: `swap reported ok but ${to.symbol} balance did not increase` };
    return { received: got };
  }

  // -------------------------------------------------------------------------
  // Internals: two-asset unwind
  // -------------------------------------------------------------------------

  private async unwindParams(p: AavePairConfig, acct: Account, ctx: LiveContext, sizeHint?: bigint): Promise<UnwindParams> {
    const minHf = p.minUnwindHealthFactor ?? 1.04;
    // account-level liquidation threshold reflects the e-mode actually in use
    const liq = acct.liqThreshold > 0 ? acct.liqThreshold : 0;
    let ceiling = liq / minHf;
    const ltvNow = toHuman(acct.D, p.debt.decimals) / Math.max(1e-18, toHuman(acct.S, p.collateral.decimals) * acct.r);
    if (ltvNow >= ceiling) {
      ceiling = liq / 1.01;
      this.log("warn", `${this.id} ${p.pairId}: LTV ${ltvNow.toFixed(4)} above unwind ceiling (HF ${minHf}); using emergency ceiling HF 1.01`);
    }
    let swapCost = 0;
    const size = sizeHint ?? (acct.S / 10n > 0n ? acct.S / 10n : acct.S);
    if (size > 0n) {
      const q = await this.swapper!.quote(p.collateral, p.debt, size, ctx);
      swapCost = Math.max(0, q.costBps / 1e4);
    }
    return {
      priceRatio: acct.r,
      collateralDecimals: p.collateral.decimals,
      debtDecimals: p.debt.decimals,
      swapCostFrac: swapCost,
      ceilingLtv: ceiling,
      debtBufferFrac: 0.0005 + swapCost / 10,
      minWithdraw: this.minUnits(acct.priceC, p.collateral.decimals),
    };
  }

  private async unwindPair(p: AavePairConfig, acct0: Account, goal: { fraction: number } | { targetLtv: number }, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    const what = "fraction" in goal ? `close ${p.pairId} x${goal.fraction}` : `deleverage ${p.pairId} -> ${goal.targetLtv}`;
    const fail = (d: string): LiveResult => ({ ok: false, txs, detail: `${this.id} ${what}: ${d}` });
    const maxIter = p.maxUnwindIterations ?? Math.max(40, 3 * ctx.limits.maxLoopIterations);
    const maxExit = p.maxExitSwapCostBps ?? 200;
    const pool = this.market.pool;
    try {
      const params = await this.unwindParams(p, acct0, ctx);
      const full = "fraction" in goal && goal.fraction >= 1 - 1e-9;
      const g: UnwindGoal =
        "fraction" in goal ? { targetDebt: full ? 0n : acct0.D - mulFrac(acct0.D, goal.fraction) } : { targetLtv: goal.targetLtv };
      const plan = planPairUnwind(acct0.S, acct0.D, goal, params, maxIter);
      const summary = `${plan.iterations} withdraw->swap->repay iteration(s), final LTV ${plan.finalLtv.toFixed(4)}${plan.complete ? "" : " (INCOMPLETE: iteration cap / ceiling)"}`;

      if (ctx.dryRun) {
        const first = plan.steps[0];
        if (!first || first.kind !== "withdraw") return { ok: plan.complete, txs, detail: `dry-run: nothing to do (${summary})` };
        const req = this.req("withdraw", [p.collateral.address, first.amount, this.env.account], `withdraw ${this.amt(first.amount)} ${p.collateral.symbol}`);
        txs.push(await sendTx(this.env, ctx, req));
        let note = "";
        const swapStep = plan.steps[1];
        if (swapStep && swapStep.kind === "swap") {
          const q = await this.swapper!.quote(p.collateral, p.debt, swapStep.amount, ctx);
          if (q.costBps > maxExit) return fail(`exit swap costs ${q.costBps.toFixed(1)} bps > ${maxExit}`);
          note = ` | first swap quoted: ${swapStep.amount} ${p.collateral.symbol} -> ${q.amountOut} ${p.debt.symbol} (${q.costBps.toFixed(1)} bps)`;
        }
        return {
          ok: plan.complete,
          txs,
          detail: `dry-run: simulated step 1 only (later steps need the swap output)${note} | plan: ${summary}`,
        };
      }

      const startD = await this.walletBalance(p.debt);
      let carry = 0n;
      let a = acct0;
      let iterations = 0;
      for (let i = 0; i < maxIter; i++) {
        const prm = { ...params, priceRatio: a.r };
        let st = unwindStep(a.S, a.D, g, prm);
        if (st.done) break;
        if (st.stuck) {
          st = unwindStep(a.S, a.D, g, { ...prm, ceilingLtv: a.liqThreshold / 1.01 });
          if (st.stuck || st.withdraw === 0n) return fail(`no safe withdrawal possible at LTV ${(toHuman(a.D, p.debt.decimals) / (toHuman(a.S, p.collateral.decimals) * a.r)).toFixed(4)}; needs external ${p.debt.symbol} to repay`);
        }
        txs.push(await sendTx(this.env, ctx, this.req("withdraw", [p.collateral.address, st.withdraw, this.env.account], `withdraw ${st.withdraw} ${p.collateral.symbol}`)));
        const got = await this.swapMeasured(p.collateral, p.debt, st.withdraw, ctx, maxExit, txs);
        if (got.error) {
          // put the collateral back so HF returns to where it was
          const bal = await this.walletBalance(p.collateral);
          const back = bal < st.withdraw ? bal : st.withdraw;
          if (back > 0n) {
            txs.push(...(await ensureAllowance(this.env, ctx, p.collateral.address as Address, pool, back)));
            txs.push(await sendTx(this.env, ctx, this.req("supply", [p.collateral.address, back, this.env.account, REFERRAL_CODE], `rollback: re-supply ${back} ${p.collateral.symbol}`)));
          }
          return fail(`swap failed after ${iterations} iteration(s), collateral re-supplied: ${got.error}`);
        }
        const avail = carry + got.received;
        const debtNow = await this.env.publicClient.readContract({ address: (await this.reserveStatics([p.debt.address as Address])).get(lc(p.debt.address))!.vToken, abi: AAVE_TOKEN_ABI, functionName: "balanceOf", args: [this.env.account] });
        if (full && avail > debtNow + debtNow / 10_000n) {
          const approve = debtNow + debtNow / 10_000n + 1n;
          txs.push(...(await ensureAllowance(this.env, ctx, p.debt.address as Address, pool, approve)));
          txs.push(await sendTx(this.env, ctx, this.req("repay", [p.debt.address, MAX_UINT256, VARIABLE_RATE_MODE, this.env.account], `repay all ${p.debt.symbol}`)));
          carry = avail - debtNow;
        } else {
          const amt = avail < debtNow ? avail : debtNow;
          txs.push(...(await ensureAllowance(this.env, ctx, p.debt.address as Address, pool, amt)));
          txs.push(await sendTx(this.env, ctx, this.req("repay", [p.debt.address, amt, VARIABLE_RATE_MODE, this.env.account], `repay ${amt} ${p.debt.symbol}`)));
          carry = avail - amt;
        }
        iterations++;
        a = await this.readAccount(p);
      }
      if (!unwindStep(a.S, a.D, g, { ...params, priceRatio: a.r }).done) return fail(`stopped after ${iterations} iteration(s) before reaching the goal`);

      if ("fraction" in goal) {
        if (full) {
          if (a.D > 0n) return fail(`debt ${a.D} left after repay`);
          txs.push(await sendTx(this.env, ctx, this.req("withdraw", [p.collateral.address, MAX_UINT256, this.env.account], `withdraw all ${p.collateral.symbol}`)));
          // sell back the debt-asset overshoot bought as repay buffer
          const left = (await this.walletBalance(p.debt)) - startD;
          const leftUsd = toHuman(left > 0n ? left : 0n, p.debt.decimals) * a.priceD;
          if (left > 0n && leftUsd >= (this.opts.minStepUsd ?? 1)) {
            const back = await this.swapMeasured(p.debt, p.collateral, left, ctx, maxExit, txs);
            if (back.error) this.log("warn", `${this.id} ${p.pairId}: could not swap back ${left} ${p.debt.symbol} buffer: ${back.error}`);
          }
        } else {
          const ltv0 = toHuman(acct0.D, p.debt.decimals) / (toHuman(acct0.S, p.collateral.decimals) * acct0.r);
          const keep = a.D > 0n && ltv0 > 0 ? fromHumanFloor(toHuman(a.D, p.debt.decimals) / (ltv0 * a.r), p.collateral.decimals) + 1n : a.S - mulFrac(acct0.S, goal.fraction);
          const extra = a.S > keep ? a.S - keep : 0n;
          if (extra > 0n)
            txs.push(await sendTx(this.env, ctx, this.req("withdraw", [p.collateral.address, extra, this.env.account], `withdraw ${extra} ${p.collateral.symbol}`)));
        }
      }
      const fin = await this.readAccount(p);
      const ltv = fin.S > 0n ? toHuman(fin.D, p.debt.decimals) / (toHuman(fin.S, p.collateral.decimals) * fin.r) : 0;
      return { ok: true, txs, detail: `${iterations} iteration(s), LTV ${ltv.toFixed(4)}, HF ${fin.healthFactor === Infinity ? "inf" : fin.healthFactor.toFixed(3)}` };
    } catch (e) {
      return fail((e as Error).message.split("\n")[0]!);
    }
  }

  // -------------------------------------------------------------------------
  // Internals: tx building / simulation
  // -------------------------------------------------------------------------

  private req(functionName: "supply" | "borrow" | "repay" | "repayWithATokens" | "withdraw" | "setUserEMode" | "setUserUseReserveAsCollateral", args: readonly unknown[], description: string): TxRequest {
    return {
      to: this.market.pool,
      data: encodeFunctionData({ abi: POOL_ABI, functionName, args } as Parameters<typeof encodeFunctionData>[0]),
      description,
    };
  }

  private amt(x: bigint): string {
    return x === MAX_UINT256 ? "max" : x.toString();
  }

  /** Approve requests mirroring ensureAllowance (reset to 0 first when changing a non-zero allowance). */
  private async approveRequests(token: Address, amount: bigint): Promise<TxRequest[]> {
    const cur = await this.env.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.env.account, this.market.pool] });
    if (cur >= amount) return [];
    const out: TxRequest[] = [];
    if (cur > 0n)
      out.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.market.pool, 0n] }), description: `reset allowance ${token}` });
    out.push({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.market.pool, amount] }), description: `approve ${amount} ${token} -> pool` });
    return out;
  }

  /**
   * eth_simulateV1 batch of `reqs` on top of the current state (each call sees
   * the previous ones). supported=false when the RPC / viem cannot do it.
   */
  private async simulateBatch(reqs: TxRequest[], ctx: LiveContext): Promise<BatchSim> {
    const none: BatchSim = { supported: false, ok: false, records: [] };
    if (this.opts.multiCallSimulation === false || reqs.length < 2) return none;
    const sim = this.loose.simulateCalls;
    if (typeof sim !== "function") return none;
    let res: Awaited<ReturnType<NonNullable<LooseClient["simulateCalls"]>>>;
    try {
      res = await sim.call(this.env.publicClient, { account: this.env.account, calls: reqs.map((r) => ({ to: r.to, data: r.data, value: r.value })) });
    } catch (e) {
      this.log("debug", `${this.id}: eth_simulateV1 unavailable (${(e as Error).message.split("\n")[0]}); simulating step 1 only`);
      return none;
    }
    const gasPrice = await this.env.publicClient.getGasPrice();
    const native = await ctx.nativePriceUsd(this.chain);
    const records: TxRecord[] = [];
    for (let i = 0; i < reqs.length; i++) {
      const r = res.results[i];
      if (!r) return { supported: true, ok: false, records, failedIndex: i, error: "missing result" };
      if (r.status !== "success") return { supported: true, ok: false, records, failedIndex: i, error: (r.error?.message ?? "reverted").split("\n")[0] };
      const gasUsd = (Number(r.gasUsed * gasPrice) / 1e18) * native;
      const cap = reqs[i]!.maxGasUsd ?? ctx.limits.maxGasUsd[this.chain] ?? ctx.limits.maxGasUsd.default ?? 5;
      if (gasUsd > cap) return { supported: true, ok: false, records, failedIndex: i, error: `gas $${gasUsd.toFixed(2)} > cap $${cap}` };
      records.push({ chain: this.chain, description: reqs[i]!.description, gasUsd, simulated: true });
    }
    return { supported: true, ok: true, records };
  }

  /** Pure-Aave sequence: batch pre-simulation, then step 1 (dry-run) or every step (live) through sendTx. */
  private async executeSequence(reqs: TxRequest[], ctx: LiveContext, what: string): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    try {
      const batch = await this.simulateBatch(reqs, ctx);
      if (batch.supported && !batch.ok)
        return { ok: false, txs, detail: `${this.id} ${what}: pre-simulation failed at step ${(batch.failedIndex ?? 0) + 1} "${reqs[batch.failedIndex ?? 0]?.description}": ${batch.error}` };
      if (ctx.dryRun) {
        txs.push(await sendTx(this.env, ctx, reqs[0]!));
        if (batch.supported) txs.push(...batch.records.slice(1));
        const note =
          reqs.length < 2 ? "simulated" : batch.supported ? `simulated all ${reqs.length} steps (eth_simulateV1)` : `simulated step 1 of ${reqs.length} (no eth_simulateV1)`;
        return { ok: true, txs, detail: `dry-run ${what}: ${note}: ${reqs.map((r) => r.description).join(" -> ")}` };
      }
      for (const r of reqs) txs.push(await sendTx(this.env, ctx, r));
      return { ok: true, txs, detail: `${what}: ${reqs.map((r) => r.description).join(" -> ")}` };
    } catch (e) {
      return { ok: false, txs, detail: `${this.id} ${what}: ${(e as Error).message.split("\n")[0]}` };
    }
  }

  private loopSummary(plan: ReturnType<typeof planLoopSteps>, mode: ModeChoice, p: AavePairConfig, targetLtv: number): string {
    const steps = plan.steps
      .map((s) => (s.kind === "swap" ? `swap ${s.amount}->${s.expectedOut}` : `${s.kind} ${s.amount}`))
      .join(", ");
    return (
      `e-mode ${mode.categoryId} "${mode.label}" (LTV ${mode.ltv}, LT ${mode.liqLtv}); ${plan.iterations} iteration(s); ` +
      `supply ${plan.totalSupplied} ${p.collateral.symbol}, borrow ${plan.totalBorrowed} ${p.debt.symbol}; final LTV ${plan.finalLtv.toFixed(4)}` +
      `, leverage ${(1 / (1 - plan.finalLtv)).toFixed(2)}x` +
      `${plan.reachedTarget ? "" : ` (BELOW TARGET: iteration cap ${plan.iterations}; target LTV ${targetLtv} = ${(1 / (1 - targetLtv)).toFixed(2)}x)`}; steps: ${steps}`
    );
  }
}
