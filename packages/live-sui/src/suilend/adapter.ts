/**
 * Live Suilend (Sui) lending adapter.
 *
 * Model: up to TWO Suilend obligations per adapter instance.
 *  - LOOP obligation (config.obligationId, or the wallet's only other
 *    obligation in the market; created on first open). All loop pairs share
 *    it — Suilend computes health and reward eligibility per obligation, so
 *    position() reports obligation-wide LTV / health next to the pair's own
 *    amounts. Use one adapter (obligation) per pair when pairs must stay isolated.
 *  - SUPPLY obligation (config.supplyObligationId, or the borrow-free
 *    obligation holding supply deposits; created on first deposit) for the
 *    SupplyAdapter side. It is never borrowed against, so its deposits keep
 *    their liquidity-mining rewards (Suilend zeroes rewards of looped
 *    obligations only). See classifyObligations (pure.ts). Production: set
 *    both ids explicitly.
 *
 * Suilend has no native flash loan, so open / close / deleverage iterate
 * borrow -> (swap) -> deposit or withdraw -> (swap) -> repay inside ONE PTB,
 * bounded by ctx.limits.maxLoopIterations and planned by the pure
 * planLoopSteps / planUnwindSteps (pure.ts). Reserve prices are refreshed
 * once at the top of every PTB with SuilendClient.refreshAll (Pyth update +
 * refresh_reserve_price for every reserve of the obligation + the pair).
 *
 * Every write builds the PTB and goes through executePtb (simulate -> gas cap
 * -> dry-run stop -> sign/execute).
 */
import type {
  AssetRef,
  LendingAdapter,
  LiveContext,
  LiveResult,
  LoopPositionView,
  Logger,
  RewardRateQuery,
  SupplyAdapter,
  SupplyPositionView,
  TxRecord,
} from "@incentive-router/live-common";
import { applyFraction, BroadcastUnconfirmedError, fromUnits, toUnits } from "@incentive-router/live-common";
import type { LoopPair, RewardRate, SupplyMarket } from "@incentive-router/core";
import {
  coinBalance,
  executePtb,
  normalizeStructTag,
  normalizeSuiAddress,
  simulateOk,
  SUI_TYPE,
  Transaction,
  type PtbSwapQuote,
  type SuiEnv,
  type TransactionObjectArgument,
} from "../common.js";
import {
  borrowCapRemainingUsd,
  buildLoopPair,
  classifyObligations,
  ctokensFor,
  depositCapRemainingUsd,
  MIN_AVAILABLE_AMOUNT,
  pairLtvLimits,
  pairPositionNumbers,
  pairRewardIneligibility,
  planLoopSteps,
  planUnwindSteps,
  probeSwap,
  rateLimiterRemainingUsd,
  rewardIneligibility,
  rewardsEligible,
  sideRewardRates,
  withdrawableUsd,
  type LoopPlan,
  type PlanPrices,
  type RewardCoinInfo,
  type SwapProbe,
  type UnwindGoal,
  type UnwindPlan,
} from "./pure.js";
import {
  compoundReserves,
  createObligationIfNoneExists,
  DEFAULT_STABLECOIN_COINTYPES,
  defaultDeps,
  isDefaultSkippedReward,
  MAIN_LENDING_MARKET,
  obligationSnapshot,
  repriceReserves,
  reserveSnapshot,
  sendObligationToUser,
  toSdkSide,
  U64_MAX_STRING,
  type ReserveConfidence,
  type SuilendDeps,
} from "./sdk.js";
import type {
  ObligationSnapshot,
  RawObligation,
  RawReserve,
  ReserveSnapshot,
  SuilendAdapterConfig,
  SuilendClientLike,
  SuilendPairConfig,
  SuilendSupplyConfig,
} from "./types.js";

const noopLog: Logger = () => {};

/** Exit blocked by liquidity / outflow limit (simulateWithdraw -> false, not a read error). */
class SupplyExitBlocked extends Error {}
const SUI_GAS_RESERVE = 300_000_000n; // 0.3 SUI kept for gas when SUI is the collateral

export interface SuilendPositionView extends LoopPositionView {
  obligationId: string;
  collateralTokens: number;
  debtTokens: number;
  /** Raw Suilend weighted LTV Σborrow·bw / Σdeposits (ltv = this / bw of the pair debt). */
  weightedLtv: number;
  /** weightedUpperBound / allowed: >= 1 blocks further borrows AND withdrawals. */
  borrowLimitUsage: number;
  /** false when the obligation earns no liquidity-mining rewards (rule or observed). */
  rewardsEligible: boolean;
  rewardsIneligibleReason: string | null;
  /** Positions whose reward share is already 0 on-chain. */
  rewardsZeroedOnChain: string[];
}

export interface SuilendPairDiagnostics {
  pairId: string;
  lendingMarketId: string;
  rateLimiterRemainingUsd: number;
  rewardsIneligibleReason: string | null;
  rewardsDropped: boolean;
  unpricedRewardCoins: string[];
  oldestPriceAgeMs: number;
  pricesFromFeed: boolean;
  swap?: { entry: SwapProbe; exit: SwapProbe } | { error: string };
}

interface ObligationRef {
  capId: string | null;
  obligationId: string;
  raw: RawObligation;
  snap: ObligationSnapshot;
}

interface Loaded {
  client: SuilendClientLike;
  marketId: string;
  marketType: string;
  nowMs: number;
  reserves: RawReserve[];
  snaps: Map<string, ReserveSnapshot>;
  rateLimiterUsd: number;
  pricesFromFeed: boolean;
  /** Loop obligation. */
  obligation: ObligationRef | null;
  /** Dedicated borrow-free supply obligation. */
  supplyObligation: ObligationRef | null;
  /** Market-level pause (undefined = unknown). */
  paused: boolean | undefined;
}

type ClaimResult = LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] };

interface PairCtx {
  p: SuilendPairConfig;
  L: Loaded;
  coll: ReserveSnapshot;
  debt: ReserveSnapshot;
  same: boolean;
  prices: PlanPrices;
}

type Built = { tx: Transaction; detail: string; amountUsd: number } | { noop: string };

export class SuilendAdapter implements LendingAdapter, SupplyAdapter {
  readonly id = "suilend";
  readonly chain = "sui";
  private readonly env: SuiEnv;
  private readonly deps: SuilendDeps;
  private readonly pairs = new Map<string, SuilendPairConfig>();
  private readonly supply = new Map<string, { marketId: string; asset: AssetRef }>();
  private readonly stable: Set<string>;
  private readonly log: Logger;
  private market?: { id: string; type: string };
  private readonly metaCache = new Map<string, { decimals: number; symbol: string } | null>();
  private readonly probeCache = new Map<string, { at: number; v: SwapProbe }>();

  constructor(private readonly cfg: SuilendAdapterConfig) {
    this.env = cfg.env;
    this.deps = { ...defaultDeps, ...(cfg.deps ?? {}) };
    this.log = cfg.log ?? noopLog;
    for (const p of cfg.pairs) {
      if (this.pairs.has(p.pairId)) throw new Error(`suilend: duplicate pairId ${p.pairId}`);
      for (const a of [p.collateral, p.debt]) {
        if (a.chain !== "sui") throw new Error(`suilend: ${p.pairId} asset ${a.symbol} is on ${a.chain}, not sui`);
      }
      this.pairs.set(p.pairId, {
        pairId: p.pairId,
        collateral: { ...p.collateral, address: normalizeStructTag(p.collateral.address) },
        debt: { ...p.debt, address: normalizeStructTag(p.debt.address) },
      });
    }
    for (const sc of cfg.supply ?? []) {
      const marketId = sc.marketId ?? sc.asset.symbol;
      if (this.supply.has(marketId)) throw new Error(`suilend: duplicate supply marketId ${marketId}`);
      if (sc.asset.chain !== "sui") throw new Error(`suilend: supply ${marketId} asset ${sc.asset.symbol} is on ${sc.asset.chain}, not sui`);
      this.supply.set(marketId, { marketId, asset: { ...sc.asset, address: normalizeStructTag(sc.asset.address) } });
    }
    if (cfg.obligationId && cfg.supplyObligationId && normalizeSuiAddress(cfg.obligationId) === normalizeSuiAddress(cfg.supplyObligationId)) {
      throw new Error("suilend: obligationId and supplyObligationId must differ (supply deposits must not share the loop obligation)");
    }
    this.stable = new Set((cfg.stablecoinCoinTypes ?? DEFAULT_STABLECOIN_COINTYPES).map((t) => normalizeStructTag(t)));
  }

  // -------------------------------------------------------------------------
  // LendingAdapter: reads
  // -------------------------------------------------------------------------

  async markets(): Promise<LoopPair[]> {
    return (await this.readPairs()).map((x) => x.pair);
  }

  /** markets() plus the reasoning behind each pair (rate limiter, eligibility, swap probes, price age). */
  async marketDiagnostics(): Promise<SuilendPairDiagnostics[]> {
    return (await this.readPairs()).map((x) => x.diag);
  }

  async position(pairId: string): Promise<SuilendPositionView | null> {
    const p = this.pair(pairId);
    const L = await this.load();
    const o = L.obligation;
    if (!o) return null;
    const debt = this.snapOf(L, p.debt);
    const nums = pairPositionNumbers(o.snap, p.collateral.address, p.debt.address, debt.borrowWeight);
    if (!nums) return null;
    const elig = rewardsEligible(o.snap, this.stable);
    const info = await this.rewardCoinInfo(L, o.snap.rewards.map((r) => r.coinType));
    const agg = new Map<string, { amount: bigint; info: RewardCoinInfo }>();
    for (const r of o.snap.rewards) {
      const i = info.get(r.coinType) ?? { symbol: tail(r.coinType), decimals: 0 };
      const prev = agg.get(r.coinType);
      agg.set(r.coinType, { amount: (prev?.amount ?? 0n) + r.amount, info: i });
    }
    const reason =
      elig.reason ??
      (elig.zeroedOnChain.length
        ? `reward shares are 0 on-chain for ${elig.zeroedOnChain.join(", ")} (obligation was looped; each position must be touched again to restore)`
        : null);
    return {
      pairId,
      obligationId: o.obligationId,
      collateralUsd: nums.collateralUsd,
      debtUsd: nums.debtUsd,
      ltv: nums.ltv,
      healthFactor: nums.healthFactor,
      equityUsd: nums.collateralUsd - nums.debtUsd,
      rewardsUnclaimed: [...agg.values()].map(({ amount, info: i }) => ({
        token: i.symbol,
        amount,
        decimals: i.decimals,
        usd: i.priceUsd !== undefined ? fromUnits(amount, i.decimals) * i.priceUsd : 0,
      })),
      asOfMs: L.nowMs,
      collateralTokens: nums.collateralTokens,
      debtTokens: nums.debtTokens,
      weightedLtv: nums.weightedLtv,
      borrowLimitUsage: nums.borrowLimitUsage,
      rewardsEligible: elig.eligible,
      rewardsIneligibleReason: reason,
      rewardsZeroedOnChain: elig.zeroedOnChain,
    };
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return coinBalance(this.env, asset.address);
  }

  // -------------------------------------------------------------------------
  // SupplyAdapter (plain deposits in the dedicated borrow-free obligation)
  // -------------------------------------------------------------------------

  async supplyMarkets(): Promise<SupplyMarket[]> {
    if (!this.supply.size) return [];
    const L = await this.load();
    const so = L.supplyObligation;
    const types: string[] = [];
    for (const m of this.supply.values()) {
      const s = L.snaps.get(m.asset.address);
      if (s) types.push(...s.depositRewards.map((r) => r.coinType));
    }
    const info = await this.rewardCoinInfo(L, types);
    const maxAge = this.cfg.onChainPriceMaxAgeMs ?? 10 * 60_000;
    const out: SupplyMarket[] = [];
    for (const m of this.supply.values()) {
      const s = this.snapOf(L, m.asset);
      const { rates, unpriced } = sideRewardRates(s, "deposit", (t) => info.get(t), L.nowMs);
      const extra = await this.extra({ protocol: "suilend", chain: "sui", asset: m.asset, side: "supply", marketId: L.marketId });
      // A deposit-only obligation is never "looped": its reward shares are kept.
      const reason = rewardIneligibility([...(so?.snap.deposits.map((d) => d.coinType) ?? []), s.coinType], so?.snap.borrows.map((b) => b.coinType) ?? [], this.stable);
      const drop = reason !== null && !(this.cfg.assumeRewardsEligible === true);
      const mine = so?.snap.deposits.find((d) => d.coinType === s.coinType);
      const wUsd = withdrawableUsd(s, L.rateLimiterUsd);
      const notes = [
        `Suilend ${L.marketId === MAIN_LENDING_MARKET.id ? "Main" : L.marketId} market; deposits held in a dedicated borrow-free obligation (${so?.obligationId ?? "created on first deposit"})`,
        drop
          ? `deposit rewards DROPPED: ${reason}`
          : "rewards eligible: Suilend zeroes liquidity-mining shares only for looped obligations (same reserve deposited+borrowed; docs also exclude stable-deposit+stable-borrow) and this obligation never borrows",
        `withdrawable = available liquidity capped by the market outflow limit ($${L.rateLimiterUsd.toFixed(0)} remaining)`,
        ...(unpriced.length ? [`unpriced reward coins skipped: ${[...new Set(unpriced)].join(", ")}`] : []),
        ...(L.paused === undefined ? ["pause state unknown (market pause read failed); reserve-level pauses are not readable"] : []),
      ];
      const sm: SupplyMarket = {
        protocol: "suilend",
        chain: "sui",
        marketId: m.marketId,
        asset: { symbol: m.asset.symbol, assetId: s.coinType, priceUsd: s.price },
        totalSupplyUsd: s.depositedTokens * s.price,
        totalBorrowUsd: s.borrowedTokens * s.price,
        supplyAprBase: s.supplyApr,
        rewards: drop ? [] : [...rates, ...extra],
        irm: s.irmPoints.length >= 2 ? { points: s.irmPoints.map((p) => [p[0], p[1]] as [number, number]), reserveFactor: s.spreadFeeFrac } : undefined,
        withdrawableUsd: wUsd,
        supplyCapRemainingUsd: depositCapRemainingUsd(s),
        // SOURCE: suilend reserve.move — deposit_liquidity_and_mint_ctokens / redeem_ctokens charge no fee
        depositFeeFrac: 0,
        withdrawFeeFrac: 0,
        myDepositUsd: mine?.usd ?? 0,
        dataAsOfMs: L.pricesFromFeed || L.nowMs - s.priceUpdatedMs <= maxAge ? L.nowMs : s.priceUpdatedMs,
        note: notes.join("; "),
      };
      if (L.paused !== undefined) sm.paused = L.paused;
      out.push(sm);
    }
    return out;
  }

  async supplyPosition(marketId: string): Promise<SupplyPositionView | null> {
    const m = this.supplyMarket(marketId);
    const L = await this.load();
    const so = L.supplyObligation;
    if (!so) return null;
    const s = this.snapOf(L, m.asset);
    const d = so.snap.deposits.find((x) => x.coinType === s.coinType);
    const rewards = so.snap.rewards.filter((r) => r.side === "deposit" && r.reserveArrayIndex === s.arrayIndex);
    if (!d && !rewards.length) return null;
    const info = await this.rewardCoinInfo(L, rewards.map((r) => r.coinType));
    const agg = new Map<string, bigint>();
    for (const r of rewards) agg.set(r.coinType, (agg.get(r.coinType) ?? 0n) + r.amount);
    return {
      marketId,
      depositUsd: d?.usd ?? 0,
      units: d ? BigInt(Math.floor(Number(d.ctokens) * s.ctokenRatio)) : 0n,
      rewardsUnclaimed: [...agg.entries()].map(([t, amount]) => {
        const i = info.get(t) ?? { symbol: tail(t), decimals: 0 };
        return { token: i.symbol, amount, decimals: i.decimals, usd: i.priceUsd !== undefined ? fromUnits(amount, i.decimals) * i.priceUsd : 0 };
      }),
      asOfMs: L.nowMs,
    };
  }

  async deposit(marketId: string, amount: bigint, ctx: LiveContext): Promise<LiveResult> {
    return this.guard(ctx, `deposit ${marketId}`, async (): Promise<LiveResult> => {
      const m = this.supplyMarket(marketId);
      if (amount <= 0n) throw new Error("amount must be > 0");
      const L = await this.load();
      const s = this.snapOf(L, m.asset);
      if (L.paused === true) throw new Error(`lending market ${L.marketId} is paused`);
      const tokens = fromUnits(amount, s.decimals);
      if (tokens * s.price > depositCapRemainingUsd(s)) throw new Error(`${m.asset.symbol} reserve deposit cap room $${depositCapRemainingUsd(s).toFixed(0)} < deposit`);
      const bal = await this.walletBalance(m.asset);
      const need = s.coinType === normalizeStructTag(SUI_TYPE) ? amount + SUI_GAS_RESERVE : amount;
      if (bal < need) throw new Error(`wallet ${m.asset.symbol} balance ${bal} < ${need}`);
      const so = L.supplyObligation;
      if (so && !so.capId) throw new Error(`wallet does not own the ObligationOwnerCap of supply obligation ${so.obligationId}`);
      if (so && L.obligation && so.obligationId === L.obligation.obligationId) throw new Error("supply obligation equals the loop obligation");
      // the supply obligation must stay borrow-free (reward eligibility)
      if (so && so.snap.borrows.length) {
        throw new Error(`supply obligation ${so.obligationId} has borrows (${so.snap.borrows.map((b) => b.coinType).join(", ")}); refusing a plain deposit there`);
      }
      const tx = new Transaction();
      tx.setSender(this.env.address);
      let cap: unknown = so?.capId;
      let created = false;
      if (!so) {
        const r = createObligationIfNoneExists(L.client as never, tx, undefined);
        cap = r.obligationOwnerCapId;
        created = r.didCreate;
      }
      // deposit_liquidity_and_mint_ctokens + deposit_ctokens_into_obligation (no price refresh needed for deposits)
      await L.client.depositIntoObligation(this.env.address, s.coinType, amount.toString(), tx, cap);
      if (created) sendObligationToUser(cap as never, this.env.address, tx);
      const detail = `supply deposit ${tokens} ${m.asset.symbol} into ${created ? "a NEW supply obligation" : `supply obligation ${so!.obligationId}`}`;
      const rec = await this.exec(ctx, tx, `suilend ${detail}`);
      return { ok: true, txs: [rec], detail: withUnconfirmed(detail, rec), amountUsd: tokens * s.price };
    }, {});
  }

  async withdraw(marketId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    return this.guard(ctx, `withdraw ${marketId}`, async (): Promise<LiveResult> => {
      if (!(fraction > 0 && fraction <= 1)) throw new Error(`fraction ${fraction} out of (0,1]`);
      const b = await this.buildSupplyWithdraw(marketId, fraction);
      if ("noop" in b) return { ok: true, txs: [], detail: b.noop };
      const rec = await this.exec(ctx, b.tx, `suilend ${b.detail}`);
      return { ok: true, txs: [rec], detail: withUnconfirmed(b.detail, rec), amountUsd: b.amountUsd };
    }, {});
  }

  /** Full withdraw simulation: false = would revert / not enough liquidity or outflow room; throws on read errors. */
  async simulateWithdraw(marketId: string, ctx: LiveContext): Promise<boolean> {
    let b: Built;
    try {
      b = await this.buildSupplyWithdraw(marketId, 1, true);
    } catch (e) {
      if (e instanceof SupplyExitBlocked) {
        ctx.log("warn", `suilend: simulateWithdraw ${marketId}: ${e.message}`);
        return false;
      }
      throw e;
    }
    if ("noop" in b) return true;
    b.tx.setSenderIfNotSet(this.env.address);
    const sim = await this.env.grpc.core.simulateTransaction({ transaction: b.tx, include: { effects: true } });
    if (sim.$kind === "FailedTransaction") ctx.log("warn", `suilend: simulateWithdraw ${marketId} reverted: ${JSON.stringify(sim.FailedTransaction.status)}`);
    return sim.$kind === "Transaction";
  }

  private supplyMarket(marketId: string): { marketId: string; asset: AssetRef } {
    const m = this.supply.get(marketId);
    if (!m) throw new Error(`suilend: unknown supply market ${marketId}`);
    return m;
  }

  /**
   * Withdraw `fraction` of the supply deposit: exact cTokens (fraction 1 =
   * every cToken: max semantics without U64_MAX's silent partial fill), price
   * refresh first (withdraw refreshes the obligation on-chain).
   */
  private async buildSupplyWithdraw(marketId: string, fraction: number, strictLiquidity = false): Promise<Built> {
    const m = this.supplyMarket(marketId);
    const L = await this.load();
    const so = L.supplyObligation;
    if (!so) return { noop: "no supply obligation" };
    const s = this.snapOf(L, m.asset);
    const d = so.snap.deposits.find((x) => x.coinType === s.coinType);
    if (!d || d.ctokens === 0n) return { noop: `no ${marketId} deposit` };
    if (!so.capId) throw new Error(`wallet does not own the ObligationOwnerCap of supply obligation ${so.obligationId}`);
    const ctokens = fraction >= 1 ? d.ctokens : applyFraction(d.ctokens, fraction);
    if (ctokens <= 0n) return { noop: "withdraw amount rounds to 0" };
    const tokens = (Number(ctokens) * s.ctokenRatio) / 10 ** s.decimals;
    const usdHigh = tokens * s.priceHigh;
    const liquidity = fromUnits(s.availableAmount > MIN_AVAILABLE_AMOUNT ? s.availableAmount - MIN_AVAILABLE_AMOUNT : 0n, s.decimals);
    if (tokens > liquidity) {
      const e = `${marketId}: reserve available liquidity ${liquidity} < withdraw ${tokens} ${m.asset.symbol}`;
      if (strictLiquidity) throw new SupplyExitBlocked(e);
      throw new Error(e);
    }
    if (usdHigh > L.rateLimiterUsd) {
      const e = `${marketId}: withdraw $${usdHigh.toFixed(0)} exceeds the market outflow limit remaining $${L.rateLimiterUsd.toFixed(0)}`;
      if (strictLiquidity) throw new SupplyExitBlocked(e);
      throw new Error(e);
    }
    const tx = new Transaction();
    tx.setSender(this.env.address);
    await L.client.refreshAll(tx, so.raw, [s.coinType]);
    const coin = first(await L.client.withdraw(so.capId, so.obligationId, s.coinType, ctokens.toString(), tx, false));
    tx.transferObjects([coin], this.env.address);
    const detail = `supply withdraw ${(fraction * 100).toFixed(1)}% (${tokens} ${m.asset.symbol}, ${ctokens} cTokens) from supply obligation ${so.obligationId}`;
    return { tx, detail, amountUsd: tokens * s.price };
  }

  // -------------------------------------------------------------------------
  // LendingAdapter: writes
  // -------------------------------------------------------------------------

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    return this.guard(ctx, `open ${pairId}`, async (): Promise<LiveResult> => {
      const w = await this.pairCtx(pairId, ctx);
      const { p, L, coll, debt, same, prices } = w;
      if (equity <= 0n) throw new Error("equity must be > 0");
      const { maxLtv } = pairLtvLimits(coll, debt);
      if (!(targetLtv >= 0 && targetLtv < 1)) throw new Error(`targetLtv ${targetLtv} out of [0,1)`);
      if (targetLtv > maxLtv) {
        throw new Error(
          `targetLtv ${targetLtv} > pair maxLtv ${maxLtv.toFixed(4)} (openLtv ${coll.openLtv} / borrowWeight ${debt.borrowWeight}, price bounds folded in)`
        );
      }
      if (!(coll.openLtv > 0) && targetLtv > 0) throw new Error(`${p.collateral.symbol} cannot be used as collateral (openLtv 0)`);
      const bal = await this.walletBalance(p.collateral);
      const need = coll.coinType === normalizeStructTag(SUI_TYPE) ? equity + SUI_GAS_RESERVE : equity;
      if (bal < need) throw new Error(`wallet ${p.collateral.symbol} balance ${bal} < ${need}`);

      const o = L.obligation;
      if (o && !o.capId) throw new Error(`wallet does not own the ObligationOwnerCap of obligation ${o.obligationId}`);
      this.checkIsolation(o?.snap, debt, L.snaps);
      const reason = pairRewardIneligibility({ collateral: coll.coinType, debt: debt.coinType }, holdingsOf(o?.snap), this.stable);
      if (reason && targetLtv > 0) ctx.log("warn", `suilend: ${pairId} obligation will earn NO liquidity-mining rewards: ${reason}`);

      const nums = o ? pairPositionNumbers(o.snap, coll.coinType, debt.coinType, debt.borrowWeight) : null;
      const equityTokens = fromUnits(equity, coll.decimals);
      const depositRoomTokens = depositCapRemainingUsd(coll) / coll.price - equityTokens;
      if (depositRoomTokens < 0) throw new Error(`${p.collateral.symbol} reserve deposit cap would be exceeded by the equity deposit`);
      const others = this.otherContributions(o?.snap, coll, debt, nums);
      const slip = ctx.limits.maxSlippageBps / 10_000;
      const base = {
        ...prices,
        collateralTokens: (nums?.collateralTokens ?? 0) + equityTokens,
        debtTokens: nums?.debtTokens ?? 0,
        openLtv: coll.openLtv,
        borrowWeight: debt.borrowWeight,
        borrowFeeFrac: debt.borrowFeeFrac,
        ...others,
        targetLtv,
        maxIterations: Math.max(0, Math.floor(ctx.limits.maxLoopIterations)),
        stepSafety: this.cfg.stepSafety ?? 0.97,
        maxTotalBorrowTokens: borrowCapRemainingUsd(debt, L.rateLimiterUsd) / debt.price,
        maxTotalDepositTokens: depositRoomTokens,
        minStepTokens: 1 / debt.price, // ~$1
        collDecimals: coll.decimals,
        debtDecimals: debt.decimals,
      };
      let plan: LoopPlan = planLoopSteps({ ...base, conversionRate: same ? 1 : (debt.price / coll.price) * (1 - slip) });
      let rateNote = "";
      if (!same && plan.steps.length) {
        const q = await this.cfg.swapper!.quote(debt.coinType, coll.coinType, plan.totalBorrow);
        const rate = (fromUnits(q.amountOut, coll.decimals) / fromUnits(q.amountIn, debt.decimals)) * (1 - slip);
        rateNote = ` swap ${p.debt.symbol}->${p.collateral.symbol} ${q.costBps.toFixed(1)} bps @size`;
        plan = planLoopSteps({ ...base, conversionRate: rate });
      }
      const quotes: PtbSwapQuote[] = [];
      if (!same) {
        for (const s of plan.steps) {
          const q = await this.cfg.swapper!.quote(debt.coinType, coll.coinType, s.borrow);
          if (q.amountIn !== s.borrow) throw new Error(`swapper quoted amountIn ${q.amountIn} for requested ${s.borrow}`);
          if (q.amountOut < s.minCollateralOut) {
            throw new Error(`step quote ${q.amountOut} below planned min ${s.minCollateralOut} (${p.debt.symbol}->${p.collateral.symbol}); retry later`);
          }
          quotes.push(q);
        }
      }

      const tx = new Transaction();
      tx.setSender(this.env.address);
      const client = L.client;
      let cap: unknown;
      let created = false;
      if (o) cap = o.capId;
      else {
        const r = createObligationIfNoneExists(client as never, tx, undefined);
        cap = r.obligationOwnerCapId;
        created = r.didCreate;
      }
      await client.refreshAll(tx, o?.raw, [coll.coinType, debt.coinType]);
      await client.depositIntoObligation(this.env.address, coll.coinType, equity.toString(), tx, cap);
      for (const [k, s] of plan.steps.entries()) {
        const borrowed = first(await client.borrow(cap, o?.obligationId ?? "", debt.coinType, s.borrow.toString(), tx, false));
        if (same) client.deposit(borrowed, coll.coinType, cap, tx);
        else {
          const out = await this.cfg.swapper!.appendSwap(tx, {
            fromType: debt.coinType,
            toType: coll.coinType,
            coinIn: borrowed,
            quote: quotes[k]!,
            minOut: s.minCollateralOut,
          });
          client.deposit(out, coll.coinType, cap, tx);
        }
      }
      if (created) sendObligationToUser(cap as never, this.env.address, tx);

      const detail =
        `open ${pairId}: equity ${equityTokens} ${p.collateral.symbol}, ${plan.steps.length} loop steps, planned LTV ${plan.finalLtv.toFixed(4)}` +
        ` (target ${targetLtv}, limited by ${plan.limitedBy})${created ? ", new obligation" : ""}${rateNote}${reason ? `; rewards ineligible: ${reason}` : ""}`;
      const rec = await this.exec(ctx, tx, `suilend ${detail}`);
      return { ok: true, txs: [rec], detail: withUnconfirmed(detail, rec), amountUsd: equityTokens * coll.price };
    }, {});
  }

  async close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    return this.guard(ctx, `close ${pairId}`, async () => {
      if (!(fraction > 0 && fraction <= 1)) throw new Error(`fraction ${fraction} out of (0,1]`);
      return this.runBuilt(await this.buildUnwind(pairId, { kind: "close", fraction }, ctx), ctx);
    }, {});
  }

  async deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    return this.guard(ctx, `deleverage ${pairId}`, async () => {
      if (!(targetLtv >= 0 && targetLtv < 1)) throw new Error(`targetLtv ${targetLtv} out of [0,1)`);
      return this.runBuilt(await this.buildUnwind(pairId, { kind: "deleverage", targetLtv }, ctx), ctx);
    }, {});
  }

  async simulateClose(pairId: string, ctx: LiveContext): Promise<boolean> {
    try {
      const b = await this.buildUnwind(pairId, { kind: "close", fraction: 1 }, ctx);
      if ("noop" in b) return true;
      return await simulateOk(this.env, b.tx);
    } catch (e) {
      ctx.log("warn", `suilend: simulateClose ${pairId} failed to build: ${msg(e)}`);
      return false;
    }
  }

  /**
   * Claim every claimable pool reward. `id` = a loop pairId (loop obligation),
   * a supply marketId (supply obligation) or undefined (both). Rewards are
   * claimed per obligation (all reserves of it), in one PTB.
   */
  async claimRewards(ctx: LiveContext, id?: string): Promise<ClaimResult> {
    return this.guard(ctx, "claimRewards", async (): Promise<ClaimResult> => {
      const isPair = id !== undefined && this.pairs.has(id);
      const isSupply = id !== undefined && this.supply.has(id);
      if (id !== undefined && !isPair && !isSupply) throw new Error(`suilend: unknown pair / supply market ${id}`);
      const L = await this.load();
      const targets = [
        ...(id === undefined || isPair ? [L.obligation] : []),
        ...(id === undefined || isSupply ? [L.supplyObligation] : []),
      ].filter((o): o is ObligationRef => o !== null);
      const skip = new Set((this.cfg.skipRewardCoinTypes ?? []).map((t) => normalizeStructTag(t)));
      const keep = (t: string) => !(this.cfg.skipRewardCoinTypes ? skip.has(t) : isDefaultSkippedReward(t));
      const tx = new Transaction();
      tx.setSender(this.env.address);
      const all: ObligationSnapshot["rewards"] = [];
      const used: string[] = [];
      for (const o of targets) {
        const rewards = o.snap.rewards.filter((r) => keep(r.coinType));
        if (!rewards.length) continue;
        if (!o.capId) throw new Error(`wallet does not own the ObligationOwnerCap of obligation ${o.obligationId}`);
        L.client.claimRewardsAndSendToUser(
          this.env.address,
          o.capId,
          rewards.map((r) => ({ reserveArrayIndex: r.reserveArrayIndex, rewardIndex: BigInt(r.rewardIndex), rewardCoinType: r.coinType, side: toSdkSide(r.side) })),
          tx
        );
        all.push(...rewards);
        used.push(o.obligationId);
      }
      if (!all.length) return { ok: true, txs: [], claimed: [], detail: targets.length ? "nothing claimable" : "no obligation" };
      const info = await this.rewardCoinInfo(L, all.map((r) => r.coinType));
      const agg = new Map<string, bigint>();
      for (const r of all) agg.set(r.coinType, (agg.get(r.coinType) ?? 0n) + r.amount);
      const claimed = [...agg.entries()].map(([t, amount]) => ({ token: info.get(t)?.symbol ?? tail(t), amount, decimals: info.get(t)?.decimals ?? 0 }));
      const rec = await this.exec(ctx, tx, `suilend claim ${all.length} rewards (obligations ${used.join(", ")})`);
      return {
        ok: true,
        txs: [rec],
        claimed,
        detail: withUnconfirmed("claimed amounts are the pre-trade estimate (on-chain includes accrual until execution)", rec),
      };
    }, { claimed: [] });
  }

  // -------------------------------------------------------------------------
  // verifyConfig
  // -------------------------------------------------------------------------

  /** On-chain checks; returns a list of problems (empty = OK). "WARN:" entries are non-fatal. */
  async verifyConfig(env: SuiEnv = this.env): Promise<string[]> {
    const problems: string[] = [];
    const assets = new Map<string, AssetRef>();
    for (const p of this.pairs.values()) for (const a of [p.collateral, p.debt]) assets.set(a.address, a);
    for (const m of this.supply.values()) assets.set(m.asset.address, m.asset);
    for (const a of assets.values()) {
      try {
        const m = await this.deps.coinMetadata(env, a.address);
        if (!m) problems.push(`${a.symbol}: coin type ${a.address} has no CoinMetadata on-chain`);
        else if (m.decimals !== a.decimals) problems.push(`${a.symbol}: decimals ${a.decimals} in config, ${m.decimals} on-chain`);
      } catch (e) {
        problems.push(`${a.symbol}: coin metadata read failed: ${msg(e)}`);
      }
    }
    let client: SuilendClientLike | undefined;
    let market: { id: string; type: string } | undefined;
    try {
      market = await this.resolveMarket(env);
      client = await this.deps.loadClient(env, market.id, market.type);
      if (normalizeSuiAddress(client.lendingMarket.id) !== normalizeSuiAddress(market.id)) problems.push(`lending market id mismatch: ${client.lendingMarket.id}`);
    } catch (e) {
      problems.push(`lending market load failed: ${msg(e)}`);
    }
    if (client) {
      const byType = new Map(client.lendingMarket.reserves.map((r) => [normalizeStructTag(r.coinType), r]));
      for (const a of assets.values()) {
        const r = byType.get(a.address);
        if (!r) problems.push(`${a.symbol}: no reserve for ${a.address} in lending market ${market!.id}`);
        else if (r.mintDecimals !== a.decimals) problems.push(`${a.symbol}: reserve mintDecimals ${r.mintDecimals} != config ${a.decimals}`);
      }
      for (const p of this.pairs.values()) {
        const c = byType.get(p.collateral.address);
        if (c?.config.element && c.config.element.openLtvPct === 0) problems.push(`${p.pairId}: ${p.collateral.symbol} has openLtv 0 (not usable as collateral)`);
        if (p.collateral.address !== p.debt.address && !this.cfg.swapper) problems.push(`${p.pairId}: two-asset pair needs a swapper`);
      }
      if (this.cfg.supplyObligationId) {
        try {
          const o = await client.getObligation(this.cfg.supplyObligationId);
          if (normalizeSuiAddress(o.lendingMarketId) !== normalizeSuiAddress(market!.id)) problems.push(`supply obligation ${this.cfg.supplyObligationId} belongs to market ${o.lendingMarketId}`);
          if (o.borrows.length) problems.push(`supply obligation ${this.cfg.supplyObligationId} has borrows: its deposits would not be a plain, reward-eligible supply`);
        } catch (e) {
          problems.push(`supply obligation ${this.cfg.supplyObligationId} read failed: ${msg(e)}`);
        }
      }
      if (this.cfg.obligationId) {
        try {
          const o = await client.getObligation(this.cfg.obligationId);
          if (normalizeSuiAddress(o.lendingMarketId) !== normalizeSuiAddress(market!.id)) problems.push(`obligation ${this.cfg.obligationId} belongs to market ${o.lendingMarketId}`);
          const caps = await this.deps.listObligationCaps(env, env.address, market!.type);
          if (!caps.some((c) => normalizeSuiAddress(c.obligationId) === normalizeSuiAddress(this.cfg.obligationId!))) {
            problems.push(`WARN: ${env.address} does not own the ObligationOwnerCap of ${this.cfg.obligationId} (read-only)`);
          }
        } catch (e) {
          problems.push(`obligation ${this.cfg.obligationId} read failed: ${msg(e)}`);
        }
      }
    }
    if (!this.cfg.priceUpdateSource) {
      problems.push("WARN: no priceUpdateSource configured: writes fail whenever a Pyth feed of the obligation is >20s stale (@suilend/sdk registers no default)");
    }
    return problems;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private pair(pairId: string): SuilendPairConfig {
    const p = this.pairs.get(pairId);
    if (!p) throw new Error(`suilend: unknown pair ${pairId}`);
    return p;
  }

  private async resolveMarket(env: SuiEnv = this.env): Promise<{ id: string; type: string }> {
    const m = this.cfg.lendingMarket ?? "main";
    if (m === "main") return MAIN_LENDING_MARKET;
    const id = normalizeSuiAddress(m);
    if (this.cfg.lendingMarketType) return { id, type: normalizeStructTag(this.cfg.lendingMarketType) };
    return { id, type: await this.deps.resolveMarketType(env, id) };
  }

  private snapOf(L: Loaded, a: AssetRef): ReserveSnapshot {
    const s = L.snaps.get(a.address);
    if (!s) throw new Error(`suilend: no reserve for ${a.symbol} (${a.address}) in market ${L.marketId}`);
    return s;
  }

  private async load(): Promise<Loaded> {
    this.market ??= await this.resolveMarket();
    const { id: marketId, type: marketType } = this.market;
    const client = await this.deps.loadClient(this.env, marketId, marketType);
    if (this.cfg.priceUpdateSource) client.pythConnection = this.cfg.priceUpdateSource;
    const nowMs = this.deps.nowMs();

    // obligations (raw) first, so their reserves join the set that gets fresh prices / confidence
    type RawRef = { capId: string | null; obligationId: string; raw: RawObligation };
    const caps = await this.deps.listObligationCaps(this.env, this.env.address, marketType);
    const raws = new Map<string, RawRef>();
    await Promise.all(
      caps.map(async (c) => {
        const id = normalizeSuiAddress(c.obligationId);
        raws.set(id, { capId: c.id, obligationId: id, raw: await client.getObligation(c.obligationId) });
      })
    );
    const loopId = this.cfg.obligationId ? normalizeSuiAddress(this.cfg.obligationId) : undefined;
    const supplyId = this.cfg.supplyObligationId ? normalizeSuiAddress(this.cfg.supplyObligationId) : undefined;
    for (const id of [loopId, supplyId]) {
      // configured but not owned by this wallet: read-only
      if (id && !raws.has(id)) raws.set(id, { capId: null, obligationId: id, raw: await client.getObligation(id) });
    }
    for (const r of raws.values()) {
      if (normalizeSuiAddress(r.raw.lendingMarketId) !== normalizeSuiAddress(marketId)) {
        if (r.obligationId === loopId || r.obligationId === supplyId) {
          throw new Error(`suilend: obligation ${r.obligationId} belongs to market ${r.raw.lendingMarketId}, not ${marketId}`);
        }
        raws.delete(r.obligationId);
      }
    }
    const roles = classifyObligations(
      [...raws.values()].map((r) => ({
        obligationId: r.obligationId,
        depositTypes: r.raw.deposits.map((d) => normalizeStructTag(d.coinType)),
        borrowTypes: r.raw.borrows.map((b) => normalizeStructTag(b.coinType)),
      })),
      {
        loopId,
        supplyId,
        supplyAssets: new Set([...this.supply.values()].map((m) => m.asset.address)),
        wantSupply: this.supply.size > 0,
        wantLoop: this.pairs.size > 0 || this.supply.size === 0,
      }
    );
    const rawObl = roles.loop ? raws.get(roles.loop)! : null;
    const rawSupply = roles.supply ? raws.get(roles.supply)! : null;

    const interest = new Set<string>();
    for (const p of this.pairs.values()) {
      interest.add(p.collateral.address);
      interest.add(p.debt.address);
    }
    for (const m of this.supply.values()) interest.add(m.asset.address);
    for (const o of [rawObl, rawSupply]) {
      for (const d of o?.raw.deposits ?? []) interest.add(normalizeStructTag(d.coinType));
      for (const b of o?.raw.borrows ?? []) interest.add(normalizeStructTag(b.coinType));
    }

    let reserves = compoundReserves(client.lendingMarket.reserves, nowMs);
    let pricesFromFeed = false;
    if (this.cfg.priceFeed) {
      try {
        const idx = reserves.map((r, i) => (interest.has(normalizeStructTag(r.coinType)) ? i : -1)).filter((i) => i >= 0);
        const repriced = await repriceReserves(idx.map((i) => reserves[i]!), this.cfg.priceFeed);
        reserves = reserves.slice();
        idx.forEach((i, k) => (reserves[i] = repriced[k]!));
        pricesFromFeed = true;
      } catch (e) {
        this.log("warn", `suilend: priceFeed reprice failed, using on-chain prices: ${msg(e)}`);
      }
    }
    const confidence = new Map<string, ReserveConfidence>();
    await Promise.all(
      reserves
        .filter((r) => interest.has(normalizeStructTag(r.coinType)))
        .map(async (r) => {
          try {
            const c = await this.deps.reserveConfidence(this.env, r);
            if (c) confidence.set(normalizeStructTag(r.coinType), c);
          } catch (e) {
            this.log("warn", `suilend: confidence read failed for ${r.coinType}: ${msg(e)}`);
          }
        })
    );
    const snaps = new Map<string, ReserveSnapshot>();
    for (const r of reserves) {
      const t = normalizeStructTag(r.coinType);
      snaps.set(t, reserveSnapshot(r, confidence.get(t)));
    }
    const toRef = (r: RawRef | null): ObligationRef | null =>
      r ? { ...r, snap: obligationSnapshot(r.raw, reserves, nowMs, confidence.size ? confidence : undefined) } : null;
    let paused: boolean | undefined;
    try {
      paused = await this.deps.marketPaused(this.env, marketId, marketType);
    } catch (e) {
      this.log("warn", `suilend: market pause read failed: ${msg(e)}`);
    }
    return {
      client,
      marketId,
      marketType,
      nowMs,
      reserves,
      snaps,
      rateLimiterUsd: rateLimiterRemainingUsd(client.lendingMarket.rateLimiter, Math.floor(nowMs / 1000)),
      pricesFromFeed,
      obligation: toRef(rawObl),
      supplyObligation: toRef(rawSupply),
      paused,
    };
  }

  private async coinMeta(coinType: string): Promise<{ decimals: number; symbol: string } | null> {
    if (!this.metaCache.has(coinType)) {
      try {
        this.metaCache.set(coinType, await this.deps.coinMetadata(this.env, coinType));
      } catch (e) {
        this.log("warn", `suilend: coin metadata for ${coinType} failed: ${msg(e)}`);
        return null;
      }
    }
    return this.metaCache.get(coinType) ?? null;
  }

  /** Symbol / decimals / USD price per reward coin: reserve price when the coin is a reserve (as the SDK does), else cfg.rewardPriceUsd. */
  private async rewardCoinInfo(L: Loaded, coinTypes: string[]): Promise<Map<string, RewardCoinInfo>> {
    const out = new Map<string, RewardCoinInfo>();
    const configured = new Map<string, AssetRef>();
    for (const p of this.pairs.values()) for (const a of [p.collateral, p.debt]) configured.set(a.address, a);
    for (const t of new Set(coinTypes)) {
      const s = L.snaps.get(t);
      const meta = configured.has(t) ? { symbol: configured.get(t)!.symbol, decimals: configured.get(t)!.decimals } : await this.coinMeta(t);
      const symbol = meta?.symbol ?? tail(t);
      const decimals = s?.decimals ?? meta?.decimals;
      if (decimals === undefined) continue;
      let priceUsd = s?.price;
      if (priceUsd === undefined && this.cfg.rewardPriceUsd) {
        try {
          priceUsd = await this.cfg.rewardPriceUsd(t);
        } catch (e) {
          this.log("warn", `suilend: rewardPriceUsd(${t}) failed: ${msg(e)}`);
        }
      }
      out.set(t, { symbol, decimals, priceUsd });
    }
    return out;
  }

  private async extra(q: RewardRateQuery): Promise<RewardRate[]> {
    if (!this.cfg.extraRewards) return [];
    try {
      return await this.cfg.extraRewards(q);
    } catch (e) {
      this.log("warn", `suilend: extraRewards ${q.asset.symbol}/${q.side} failed: ${msg(e)}`);
      return [];
    }
  }

  private async probe(from: AssetRef, to: AssetRef, priceUsd: number): Promise<SwapProbe> {
    const key = `${from.address}>${to.address}`;
    const now = this.deps.nowMs();
    const hit = this.probeCache.get(key);
    if (hit && now - hit.at < 60_000) return hit.v;
    const v = await probeSwap(this.cfg.swapper!, from, to, priceUsd, {
      probeUsd: this.cfg.probeUsd ?? 10_000,
      maxUsd: this.cfg.depthProbeMaxUsd ?? 2_560_000,
      budgetBps: this.cfg.depthBudgetBps ?? 50,
    });
    this.probeCache.set(key, { at: now, v });
    return v;
  }

  private async readPairs(): Promise<{ pair: LoopPair; diag: SuilendPairDiagnostics }[]> {
    const L = await this.load();
    const holdings = holdingsOf(L.obligation?.snap);
    const rewardTypes: string[] = [];
    for (const p of this.pairs.values()) {
      for (const a of [p.collateral, p.debt]) {
        const s = L.snaps.get(a.address);
        if (s) rewardTypes.push(...s.depositRewards.map((r) => r.coinType), ...s.borrowRewards.map((r) => r.coinType));
      }
    }
    const info = await this.rewardCoinInfo(L, rewardTypes);
    const coinInfo = (t: string) => info.get(t);
    const out: { pair: LoopPair; diag: SuilendPairDiagnostics }[] = [];
    const maxAge = this.cfg.onChainPriceMaxAgeMs ?? 10 * 60_000;
    for (const p of this.pairs.values()) {
      const coll = this.snapOf(L, p.collateral);
      const debt = this.snapOf(L, p.debt);
      const same = coll.coinType === debt.coinType;
      const unpriced: string[] = [];
      const side = (s: ReserveSnapshot, sd: "deposit" | "borrow") => {
        const r = sideRewardRates(s, sd, coinInfo, L.nowMs);
        unpriced.push(...r.unpriced);
        return r.rates;
      };
      const mq = (asset: AssetRef, sd: "supply" | "borrow"): RewardRateQuery => ({ protocol: "suilend", chain: "sui", asset, side: sd, marketId: L.marketId });
      const [collSupplyX, debtBorrowX] = await Promise.all([this.extra(mq(p.collateral, "supply")), this.extra(mq(p.debt, "borrow"))]);
      const rewards = {
        collSupply: [...side(coll, "deposit"), ...collSupplyX],
        collBorrow: same ? [...side(coll, "borrow"), ...debtBorrowX] : side(coll, "borrow"),
        debtSupply: same ? [] : side(debt, "deposit"),
        debtBorrow: same ? [] : [...side(debt, "borrow"), ...debtBorrowX],
      };
      const reason = pairRewardIneligibility({ collateral: coll.coinType, debt: debt.coinType }, holdings, this.stable);
      const assume = this.cfg.assumeRewardsEligible === true;
      if (reason && !assume) this.log("info", `suilend: ${p.pairId} rewards dropped: ${reason}`);

      let swapCostFrac = 0;
      let swapDepthUsd = Infinity;
      let swapDiag: SuilendPairDiagnostics["swap"];
      if (!same) {
        // unknown until the probes succeed: NaN = missing data (NOT 0, which the core reads as "no exit capacity")
        swapCostFrac = (this.cfg.fallbackSwapCostBps ?? 100) / 10_000;
        swapDepthUsd = NaN;
        if (!this.cfg.swapper) swapDiag = { error: "no swapper configured" };
        else {
          try {
            const [entry, exit] = await Promise.all([this.probe(p.debt, p.collateral, debt.price), this.probe(p.collateral, p.debt, coll.price)]);
            swapCostFrac = Math.max(entry.costBpsAtProbe, exit.costBpsAtProbe) / 10_000;
            swapDepthUsd = Math.min(entry.depthUsd, exit.depthUsd);
            swapDiag = { entry, exit };
          } catch (e) {
            swapDiag = { error: msg(e) };
            this.log("warn", `suilend: swap probe ${p.pairId} failed: ${msg(e)}`);
          }
        }
      }
      const oldestPriceMs = Math.min(coll.priceUpdatedMs, debt.priceUpdatedMs);
      const dataAsOfMs = L.pricesFromFeed || L.nowMs - oldestPriceMs <= maxAge ? L.nowMs : oldestPriceMs;
      const myLtv = L.obligation ? pairPositionNumbers(L.obligation.snap, coll.coinType, debt.coinType, debt.borrowWeight)?.ltv : undefined;
      const pair = buildLoopPair({
        pair: p,
        coll,
        debt,
        rewards,
        ineligibleReason: reason,
        assumeEligible: assume,
        swapCostFrac,
        swapDepthUsd,
        rateLimiterRemainingUsd: L.rateLimiterUsd,
        dataAsOfMs,
        myLtv,
      });
      if (L.paused !== undefined) pair.paused = L.paused;
      out.push({
        pair,
        diag: {
          pairId: p.pairId,
          lendingMarketId: L.marketId,
          rateLimiterRemainingUsd: L.rateLimiterUsd,
          rewardsIneligibleReason: reason,
          rewardsDropped: reason !== null && !assume,
          unpricedRewardCoins: [...new Set(unpriced)],
          oldestPriceAgeMs: L.nowMs - oldestPriceMs,
          pricesFromFeed: L.pricesFromFeed,
          swap: swapDiag,
        },
      });
    }
    return out;
  }

  private async pairCtx(pairId: string, ctx: LiveContext): Promise<PairCtx> {
    const p = this.pair(pairId);
    const L = await this.load();
    const coll = this.snapOf(L, p.collateral);
    const debt = this.snapOf(L, p.debt);
    const same = coll.coinType === debt.coinType;
    if (!same && !this.cfg.swapper) throw new Error(`${pairId}: two-asset pair needs a swapper`);
    // Planning prices: protocol spot for LTV, and the more conservative of the
    // protocol bound and ctx.priceUsd for the health bounds.
    const px = async (a: AssetRef): Promise<number | undefined> => {
      try {
        const v = await ctx.priceUsd(a);
        return v > 0 ? v : undefined;
      } catch {
        return undefined;
      }
    };
    const [pc, pd] = await Promise.all([px(p.collateral), px(p.debt)]);
    for (const [s, v, a] of [[coll, pc, p.collateral], [debt, pd, p.debt]] as const) {
      if (v !== undefined && Math.abs(v / s.price - 1) > 0.02) ctx.log("warn", `suilend: ${a.symbol} oracle ${s.price} vs ctx price ${v} differ > 2%`);
    }
    const prices: PlanPrices = {
      collPrice: coll.price,
      debtPrice: debt.price,
      collPriceLow: Math.min(coll.priceLow, pc ?? Infinity),
      debtPriceHigh: Math.max(debt.priceHigh, pd ?? 0),
    };
    return { p, L, coll, debt, same, prices };
  }

  /** allowed / weighted-upper contributions of the obligation's OTHER positions (USD). */
  private otherContributions(
    o: ObligationSnapshot | undefined,
    coll: ReserveSnapshot,
    debt: ReserveSnapshot,
    nums: { collateralTokens: number; debtTokens: number } | null
  ): { otherAllowedUsd: number; otherWeightedBorrowUsd: number } {
    if (!o) return { otherAllowedUsd: 0, otherWeightedBorrowUsd: 0 };
    const mineAllowed = (nums?.collateralTokens ?? 0) * coll.priceLow * coll.openLtv;
    const mineWeighted = (nums?.debtTokens ?? 0) * debt.priceHigh * debt.borrowWeight;
    return {
      otherAllowedUsd: Math.max(0, o.allowedBorrowUsd - mineAllowed),
      otherWeightedBorrowUsd: Math.max(0, o.weightedBorrowUpperUsd - mineWeighted),
    };
  }

  /** Suilend isolated reserves: an obligation borrowing one may hold no other borrow. */
  private checkIsolation(o: ObligationSnapshot | undefined, debt: ReserveSnapshot, snaps: Map<string, ReserveSnapshot>): void {
    if (!o) return;
    const otherBorrows = o.borrows.filter((b) => b.coinType !== debt.coinType);
    if (debt.isolated && otherBorrows.length) throw new Error(`${debt.coinType} is isolated: obligation already borrows ${otherBorrows.map((b) => b.coinType).join(", ")}`);
    const iso = otherBorrows.find((b) => snaps.get(b.coinType)?.isolated);
    if (iso) throw new Error(`obligation borrows isolated ${iso.coinType}; cannot add a ${debt.coinType} borrow`);
  }

  private async buildUnwind(pairId: string, goal: { kind: "close"; fraction: number } | { kind: "deleverage"; targetLtv: number }, ctx: LiveContext): Promise<Built> {
    const { p, L, coll, debt, same, prices } = await this.pairCtx(pairId, ctx);
    const o = L.obligation;
    if (!o) return { noop: "no obligation" };
    if (!o.capId) throw new Error(`wallet does not own the ObligationOwnerCap of obligation ${o.obligationId}`);
    const nums = pairPositionNumbers(o.snap, coll.coinType, debt.coinType, debt.borrowWeight);
    if (!nums || (nums.collateralTokens <= 0 && nums.debtTokens <= 0)) return { noop: `no ${pairId} position` };
    const C0 = nums.collateralTokens;
    const D0 = nums.debtTokens;
    const ltv0 = C0 > 0 ? (D0 * debt.price) / (C0 * coll.price) : Infinity;
    if (goal.kind === "deleverage" && ltv0 <= goal.targetLtv) return { noop: `LTV ${ltv0.toFixed(4)} already <= ${goal.targetLtv}` };
    const unwindGoal: UnwindGoal =
      goal.kind === "close" ? { kind: "debt", targetDebtTokens: goal.fraction >= 1 ? 0 : D0 * (1 - goal.fraction) } : { kind: "ltv", targetLtv: goal.targetLtv };

    const slip = ctx.limits.maxSlippageBps / 10_000;
    const safety = this.cfg.stepSafety ?? 0.97;
    const others = this.otherContributions(o.snap, coll, debt, nums);
    const base = {
      ...prices,
      collateralTokens: C0,
      debtTokens: D0,
      openLtv: coll.openLtv,
      borrowWeight: debt.borrowWeight,
      ...others,
      goal: unwindGoal,
      interestBufferFrac: (this.cfg.interestBufferBps ?? 10) / 10_000,
      maxIterations: Math.max(0, Math.floor(ctx.limits.maxLoopIterations)),
      stepSafety: safety,
      minStepTokens: Math.min(1 / coll.price, C0 / 1e6),
      maxTotalWithdrawUsd: L.rateLimiterUsd,
      collPriceHigh: coll.priceHigh,
      collDecimals: coll.decimals,
      debtDecimals: debt.decimals,
    };
    let plan: UnwindPlan = planUnwindSteps({ ...base, conversionRate: same ? 1 : (coll.price / debt.price) * (1 - slip) });
    let rateNote = "";
    if (!same && plan.steps.length) {
      const total = plan.steps.reduce((s, x) => s + x.withdraw, 0n);
      const q = await this.cfg.swapper!.quote(coll.coinType, debt.coinType, total);
      const rate = (fromUnits(q.amountOut, debt.decimals) / fromUnits(q.amountIn, coll.decimals)) * (1 - slip);
      rateNote = ` swap ${p.collateral.symbol}->${p.debt.symbol} ${q.costBps.toFixed(1)} bps @size`;
      plan = planUnwindSteps({ ...base, conversionRate: rate });
    }
    if (!plan.feasible) throw new Error(`${pairId} unwind infeasible: ${plan.reason}`);

    // remaining collateral handling
    const full = goal.kind === "close" && goal.fraction >= 1;
    let extraTokens = 0;
    if (goal.kind === "close" && !full) {
      extraTokens = Math.max(0, plan.finalCollateralTokens - C0 * (1 - goal.fraction));
      // keep the final withdraw inside the open-LTV limit too
      const allowed = (plan.finalCollateralTokens * prices.collPriceLow * coll.openLtv + others.otherAllowedUsd) * safety;
      const weighted = plan.finalDebtTokens * prices.debtPriceHigh * debt.borrowWeight + others.otherWeightedBorrowUsd;
      const room = coll.openLtv > 0 ? Math.max(0, (allowed - weighted) / (prices.collPriceLow * coll.openLtv * safety)) : extraTokens;
      extraTokens = Math.min(extraTokens, room);
    }
    const finalWithdrawUsd = (full ? plan.finalCollateralTokens : extraTokens) * coll.priceHigh;
    if (plan.totalWithdrawUsd + finalWithdrawUsd > L.rateLimiterUsd) {
      throw new Error(
        `${pairId}: withdrawals $${(plan.totalWithdrawUsd + finalWithdrawUsd).toFixed(0)} exceed the market outflow limit remaining $${L.rateLimiterUsd.toFixed(0)}`
      );
    }

    const quotes: PtbSwapQuote[] = [];
    if (!same) {
      for (const s of plan.steps) {
        const q = await this.cfg.swapper!.quote(coll.coinType, debt.coinType, s.withdraw);
        if (q.amountIn !== s.withdraw) throw new Error(`swapper quoted amountIn ${q.amountIn} for requested ${s.withdraw}`);
        if (q.amountOut < s.minDebtOut) throw new Error(`step quote ${q.amountOut} below planned min ${s.minDebtOut}; retry later`);
        quotes.push(q);
      }
    }

    const tx = new Transaction();
    tx.setSender(this.env.address);
    const client = L.client;
    const cap = o.capId;
    const oblId = o.obligationId;
    await client.refreshAll(tx, o.raw, [coll.coinType, debt.coinType]);
    const collCoins: TransactionObjectArgument[] = [];
    const debtCoins: TransactionObjectArgument[] = [];
    let ctokensLeft = o.snap.deposits.find((d) => d.coinType === coll.coinType)?.ctokens ?? 0n;
    for (const [k, s] of plan.steps.entries()) {
      const ct = ctokensFor(s.withdraw, coll.ctokenRatio, ctokensLeft);
      ctokensLeft -= ct;
      const wcoin = first(await client.withdraw(cap, oblId, coll.coinType, ct.toString(), tx, false));
      if (same) {
        client.repay(oblId, debt.coinType, wcoin, tx);
        collCoins.push(wcoin);
      } else {
        const [swapIn] = tx.splitCoins(wcoin, [s.withdraw]);
        collCoins.push(wcoin);
        const out = await this.cfg.swapper!.appendSwap(tx, {
          fromType: coll.coinType,
          toType: debt.coinType,
          coinIn: swapIn!,
          quote: quotes[k]!,
          minOut: s.minDebtOut,
        });
        client.repay(oblId, debt.coinType, out, tx);
        debtCoins.push(out);
      }
    }
    if (full) {
      collCoins.push(first(await client.withdraw(cap, oblId, coll.coinType, U64_MAX_STRING, tx, false)));
    } else if (extraTokens > 0) {
      const extraBase = toUnits(extraTokens, coll.decimals);
      const ct = BigInt(Math.floor(Number(extraBase) / coll.ctokenRatio));
      if (ct > 0n && ct <= ctokensLeft) collCoins.push(first(await client.withdraw(cap, oblId, coll.coinType, ct.toString(), tx, false)));
    }
    this.mergeAndSend(tx, collCoins);
    this.mergeAndSend(tx, debtCoins);

    const what = goal.kind === "close" ? `close ${pairId} ${(goal.fraction * 100).toFixed(1)}%` : `deleverage ${pairId} to LTV ${goal.targetLtv}`;
    const detail =
      `${what}: ${plan.steps.length} unwind steps, LTV ${ltv0.toFixed(4)} -> ${plan.finalLtv.toFixed(4)} (planned), debt ${D0} -> ${plan.finalDebtTokens} ${p.debt.symbol}` +
      `${full ? ", remaining collateral withdrawn (U64_MAX)" : ""}${!same && debtCoins.length ? `, leftover ${p.debt.symbol} sent to wallet` : ""}${rateNote}`;
    const amountUsd = full ? plan.finalCollateralTokens * coll.price : extraTokens * coll.price;
    return { tx, detail, amountUsd };
  }

  private mergeAndSend(tx: Transaction, coins: TransactionObjectArgument[]): void {
    if (!coins.length) return;
    if (coins.length > 1) tx.mergeCoins(coins[0]!, coins.slice(1));
    tx.transferObjects([coins[0]!], this.env.address);
  }

  private async runBuilt(b: Built, ctx: LiveContext): Promise<LiveResult> {
    if ("noop" in b) return { ok: true, txs: [], detail: b.noop };
    const rec = await this.exec(ctx, b.tx, `suilend ${b.detail}`);
    return { ok: true, txs: [rec], detail: withUnconfirmed(b.detail, rec), amountUsd: b.amountUsd };
  }

  /** executePtb; an executed-but-unconfirmed record is logged (callers must re-read state before acting again). */
  private async exec(ctx: LiveContext, tx: Transaction, description: string): Promise<TxRecord> {
    const rec = await executePtb(this.env, ctx, tx, description);
    if (rec.unconfirmed) ctx.log("warn", `suilend: ${description} executed as ${rec.id} but checkpoint confirmation is pending; re-read state before retrying`);
    return rec;
  }

  /**
   * Error boundary for writes. BroadcastUnconfirmedError = signed + submitted,
   * fate unknown: it MAY HAVE LANDED, so the digest is returned as an
   * unconfirmed TxRecord (never "nothing happened"); callers re-read state.
   */
  private async guard<R extends LiveResult>(ctx: LiveContext, what: string, fn: () => Promise<R>, empty: Omit<R, keyof LiveResult>): Promise<R> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BroadcastUnconfirmedError) {
        const detail = `suilend: ${what}: broadcast unconfirmed (may have landed) digest=${e.id}: ${e.message}`;
        ctx.log("error", detail);
        const txs: TxRecord[] = [{ chain: "sui", id: e.id, description: e.description, simulated: false, unconfirmed: true }];
        return { ...empty, ok: false, txs, detail } as unknown as R;
      }
      ctx.log("error", `suilend: ${what} failed: ${msg(e)}`);
      return { ...empty, ok: false, txs: [], detail: msg(e) } as unknown as R;
    }
  }
}

function holdingsOf(o: ObligationSnapshot | undefined): { deposits: string[]; borrows: string[] } | undefined {
  return o ? { deposits: o.deposits.map((d) => d.coinType), borrows: o.borrows.map((b) => b.coinType) } : undefined;
}

function first(res: unknown): TransactionObjectArgument {
  const x = (res as TransactionObjectArgument[])[0];
  if (!x) throw new Error("suilend: SDK call returned no result");
  return x;
}

function withUnconfirmed(detail: string, rec: TxRecord): string {
  return rec.unconfirmed ? `${detail} [UNCONFIRMED: executed as ${rec.id}, checkpoint wait failed; re-read state]` : detail;
}

function tail(coinType: string): string {
  return coinType.split("::").pop() ?? coinType;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
