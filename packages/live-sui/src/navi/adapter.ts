/**
 * Live Navi Protocol (Sui) lending adapter on @naviprotocol/lending 2.1.0.
 *
 * Design
 *  - One configured pair = collateral asset + debt asset in ONE Navi market
 *    (default "main"; Navi Prime isolated markets via `market`). Pools are keyed
 *    by (market, coinType).
 *  - E-Mode: when an active e-mode covers collateral (isCollateral, ltv>0) and
 *    debt (isDebt) and beats the pool LTV (or is requested by id), the pair
 *    uses the e-mode LTV / LT. Navi e-mode positions live in a dedicated
 *    "EMode cap" (AccountCap registered in the e-mode registry; SDK
 *    createEModeCapPTB) so they never touch the wallet's main Navi account.
 *    Non-e-mode pairs use the wallet address account.
 *  - open/close/deleverage are ONE PTB each: Navi oracle refresh (Pyth push
 *    when stale) -> flash loan (preferred) or an iterative
 *    deposit/borrow(/swap) loop -> everything executed via executePtb
 *    (simulate -> gas cap -> dry-run stop -> sign).
 *  - Units / Move semantics: see ./math.ts header (checked against Navi's Move sources).
 *
 * Rates: Pool.currentSupplyRate / currentBorrowRate are ray APRs (no
 * conversion). Incentives: Pool.{supply,borrow}IncentiveApyInfo.boostedApr is
 * a PERCENT labelled APR by the SDK (types.d.ts "Boosted APR"); Navi's own
 * `apy` field is the plain sum vaultApr + boostedApr (+ staking yields), i.e.
 * not compounded, so boostedApr is used as an APR. Set
 * `incentiveRateKind: "apy"` to convert it with daily compounding instead.
 */
import { coinWithBalance } from "@mysten/sui/transactions";
import type { TransactionResult } from "@mysten/sui/transactions";
import type { LoopLeg, LoopPair, RewardRate } from "@incentive-router/core";
import {
  minusBps,
  toUnits,
  type AssetRef,
  type LendingAdapter,
  type LiveContext,
  type LiveResult,
  type Logger,
  type LoopPositionView,
  type RewardRateProvider,
  type TxRecord,
} from "@incentive-router/live-common";
import {
  SuiSimulationError,
  Transaction,
  coinBalance,
  executePtb,
  normalizeStructTag,
  normalizeSuiAddress,
  simulateOk,
  type PtbSwapQuote,
  type PtbSwapper,
  type SuiEnv,
  type TransactionObjectArgument,
} from "../common.js";
import * as M from "./math.js";
import {
  NAVI_DEFAULT_MARKET,
  defaultNaviSdk,
  type NaviLendingReward,
  type NaviMarketConfig,
  type NaviPool,
  type NaviSdk,
  type NaviSuiClient,
  type NaviUserLendingInfo,
} from "./sdk.js";

// ---------------------------------------------------------------------------
// Public config / types
// ---------------------------------------------------------------------------

export interface NaviPairConfig {
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
  /** Navi market key (MARKETS of @naviprotocol/lending: "main", "sui-usdc", ...). Default "main". */
  market?: string;
  /** "auto" (default) = best covering active e-mode if it beats the pool LTV; "off"; or an explicit emodeId. */
  emode?: "auto" | "off" | number;
}

export interface NaviAdapterOptions {
  env: SuiEnv;
  pairs: NaviPairConfig[];
  /** Required for pairs whose collateral and debt coin types differ. */
  swapper?: PtbSwapper;
  /** Extra reward streams (Merkl etc.) merged into markets(). */
  extraRewards?: RewardRateProvider;
  /** Override SDK functions (tests / advanced use). */
  sdk?: Partial<NaviSdk>;
  /** Logger for read paths that have no LiveContext (markets / position). */
  log?: Logger;
  /** Probe sizes (USD) for swap cost / depth of different-asset pairs. Default [10k, 100k, 1M]. */
  swapProbeUsd?: number[];
  /** Cost budget (bps) defining LoopPair.swapDepthUsd. Default 30. */
  swapDepthBudgetBps?: number;
  /** How to read Navi's boostedApr incentive numbers (see file header). Default "apr". */
  incentiveRateKind?: "apr" | "apy";
  /** Read my position in markets() to fill LoopPair.myLtv. Default true. */
  includeMyLtv?: boolean;
  /** Extra flash-fee margin on unwinds; any excess repayment is returned on-chain. Default 1 bp. */
  flashFeeMarginFrac?: number;
}

/** How a pair resolved against live Navi data (market, e-mode, LTVs). */
export interface NaviPairInfo {
  pairId: string;
  market: string;
  marketId: number;
  /** E-mode used for this pair (null = pool LTV on the wallet's main Navi account). */
  emodeId: number | null;
  maxLtv: number;
  liqLtv: number;
  collateralAssetId: number;
  debtAssetId: number;
  sameAsset: boolean;
}

export type NaviAccount = { kind: "address"; id: string } | { kind: "cap"; id: string; emodeId: number };
type WriteAccount = NaviAccount | { kind: "newCap"; emodeId: number };

interface PairState {
  cfg: NaviPairConfig & { market: string; emode: "auto" | "off" | number };
  market: NaviMarketConfig;
  same: boolean;
  collType: string;
  debtType: string;
  pools: NaviPool[];
  coll: NaviPool;
  debt: NaviPool;
  emode: M.ChosenEmode | null;
  maxLtv: number;
  liqLtv: number;
  collPrice: number;
  debtPrice: number;
  /** Debt base units per collateral base unit at Navi oracle prices. */
  priceRatio: number;
  paused: boolean;
  asOfMs: number;
}

interface AccountState {
  account: NaviAccount;
  collateral: bigint;
  debt: bigint;
  entries: NaviUserLendingInfo[];
}

interface FlashInfo {
  fee: number;
  min?: bigint;
  max?: bigint;
}

interface Built {
  tx: Transaction;
  description: string;
  detail: string;
  amountUsd?: number;
}
type BuildResult = Built | { error: string };

type UnwindMode = { kind: "fraction"; fraction: number } | { kind: "target"; ltv: number };

const noopLog: Logger = () => {};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function fail(detail: string): LiveResult {
  return { ok: false, txs: [], detail };
}
function isBuilt(b: BuildResult): b is Built {
  return (b as Built).tx !== undefined;
}
/** Normalized coin type; Navi's Pool.coinType has no 0x prefix, suiCoinType does — both normalize equal. */
function normType(t: string): string {
  return normalizeStructTag(t);
}
type FlashReceipt = Awaited<ReturnType<NaviSdk["flashloanPTB"]>>[number];
/** tx.pure.u64 typed as the pure-Input member of Navi's TransactionResult union (same runtime object). */
type PureU64 = { $kind: "Input"; Input: number; type?: "pure" };
function u64(tx: Transaction, v: bigint): PureU64 {
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 out of range: ${v}`);
  return tx.pure.u64(v) as PureU64;
}
function sameAccount(a: WriteAccount, b: WriteAccount): boolean {
  if (a.kind === "newCap" || b.kind === "newCap") return false;
  return a.kind === b.kind && normalizeSuiAddress(a.id) === normalizeSuiAddress(b.id);
}
function describeAccount(a: WriteAccount): string {
  if (a.kind === "address") return "wallet Navi account";
  if (a.kind === "cap") return `e-mode ${a.emodeId} cap ${a.id}`;
  return `new e-mode ${a.emodeId} cap`;
}
function secondsSince(tsMs: string | number | undefined, nowMs: number): number {
  const t = Number(tsMs ?? 0);
  return t > 0 ? Math.max(0, (nowMs - t) / 1000) : 3600;
}
function digitsToBig(s: unknown): bigint | undefined {
  return typeof s === "string" && /^\d+$/.test(s) ? BigInt(s) : typeof s === "number" && Number.isInteger(s) ? BigInt(s) : undefined;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class NaviAdapter implements LendingAdapter {
  readonly id = "navi";
  readonly chain = "sui";

  private readonly env: SuiEnv;
  private readonly pairs: Map<string, PairState["cfg"]>;
  private readonly swapper?: PtbSwapper;
  private readonly extraRewards?: RewardRateProvider;
  private readonly sdk: NaviSdk;
  private readonly log: Logger;
  private readonly probeUsd: number[];
  private readonly depthBudgetBps: number;
  private readonly incentiveRateKind: "apr" | "apy";
  private readonly includeMyLtv: boolean;
  private readonly flashFeeMargin: number;
  private readonly coinMeta = new Map<string, { symbol: string; decimals: number } | null>();
  private readonly info = new Map<string, NaviPairInfo>();
  /** Last successfully probed swap cost per pair (fallback when a probe fails). */
  private readonly lastSwapCost = new Map<string, number>();

  constructor(opts: NaviAdapterOptions) {
    this.env = opts.env;
    this.swapper = opts.swapper;
    this.extraRewards = opts.extraRewards;
    this.sdk = { ...defaultNaviSdk, ...(opts.sdk ?? {}) };
    this.log = opts.log ?? noopLog;
    this.probeUsd = opts.swapProbeUsd?.length ? [...opts.swapProbeUsd].sort((a, b) => a - b) : [10_000, 100_000, 1_000_000];
    this.depthBudgetBps = opts.swapDepthBudgetBps ?? 30;
    this.incentiveRateKind = opts.incentiveRateKind ?? "apr";
    this.includeMyLtv = opts.includeMyLtv ?? true;
    this.flashFeeMargin = opts.flashFeeMarginFrac ?? 0.0001;
    this.pairs = new Map();
    for (const p of opts.pairs) {
      if (this.pairs.has(p.pairId)) throw new Error(`navi: duplicate pairId ${p.pairId}`);
      if (p.collateral.chain !== "sui" || p.debt.chain !== "sui") throw new Error(`navi: pair ${p.pairId} assets must be on chain "sui"`);
      const same = normType(p.collateral.address) === normType(p.debt.address);
      if (!same && !this.swapper) throw new Error(`navi: pair ${p.pairId} has different assets and needs a swapper`);
      this.pairs.set(p.pairId, { ...p, market: p.market ?? NAVI_DEFAULT_MARKET, emode: p.emode ?? "auto" });
    }
  }

  private get client(): NaviSuiClient {
    // SuiGrpcClient exposes the v2 `core` API the SDK requires (simulateTransaction, getObject, listCoins ...)
    return this.env.grpc as unknown as NaviSuiClient;
  }

  private pairCfg(pairId: string): PairState["cfg"] {
    const c = this.pairs.get(pairId);
    if (!c) throw new Error(`navi: unknown pairId ${pairId}`);
    return c;
  }

  /** Last resolution of a pair (market, e-mode, LTVs) seen by markets()/position()/writes. */
  pairInfo(pairId: string): NaviPairInfo | undefined {
    return this.info.get(pairId);
  }

  // -------------------------------------------------------------------------
  // Pair / pool loading
  // -------------------------------------------------------------------------

  private async loadPair(pairId: string): Promise<PairState> {
    const cfg = this.pairCfg(pairId);
    const market = this.sdk.getMarketConfig(cfg.market);
    const collType = normType(cfg.collateral.address);
    const debtType = normType(cfg.debt.address);
    const same = collType === debtType;
    const markets = market.key === NAVI_DEFAULT_MARKET ? [market.key] : [market.key, NAVI_DEFAULT_MARKET];
    const pools = await this.sdk.getPools({ markets, disableCache: true });
    const asOfMs = Date.now();
    const find = (t: string) => pools.find((p) => p.market === market.key && normType(p.suiCoinType ?? p.coinType) === t);
    const coll = find(collType);
    if (!coll) throw new Error(`navi: no pool for ${cfg.collateral.symbol} (${collType}) in market ${market.key}`);
    const debt = same ? coll : find(debtType);
    if (!debt) throw new Error(`navi: no pool for ${cfg.debt.symbol} (${debtType}) in market ${market.key}`);
    for (const [p, a] of [
      [coll, cfg.collateral],
      [debt, cfg.debt],
    ] as const) {
      if (p.token?.decimals !== undefined && p.token.decimals !== a.decimals)
        throw new Error(`navi: ${a.symbol} decimals mismatch: config ${a.decimals}, Navi ${p.token.decimals}`);
    }
    const poolLtv = Number.isFinite(Number(coll.ltvValue)) ? Number(coll.ltvValue) : M.rayToFrac(coll.ltv);
    const emode = M.chooseEmode(coll.emodes ?? [], coll.id, debt.id, cfg.emode, poolLtv);
    if (typeof cfg.emode === "number" && !emode) throw new Error(`navi: e-mode ${cfg.emode} is not active / does not cover ${pairId}`);
    const maxLtv = emode?.ltv ?? poolLtv;
    const liqLtv = emode?.lt ?? Number(coll.liquidationFactor?.threshold);
    if (!(maxLtv > 0 && maxLtv < 1) || !(liqLtv > 0 && liqLtv < 1)) throw new Error(`navi: ${pairId} invalid LTVs ${maxLtv}/${liqLtv}`);
    const collPrice = Number(coll.oracle?.price);
    const debtPrice = Number(debt.oracle?.price);
    const priceRatio = same ? 1 : M.priceRatioOf(collPrice, cfg.collateral.decimals, debtPrice, cfg.debt.decimals);
    const inactive = (p: NaviPool) => (!!p.status && p.status !== "active") || !!p.isDeprecated || p.oracle?.valid === false;
    const ps: PairState = {
      cfg,
      market,
      same,
      collType,
      debtType,
      pools,
      coll,
      debt,
      emode,
      maxLtv,
      liqLtv,
      collPrice,
      debtPrice,
      priceRatio,
      paused: inactive(coll) || inactive(debt),
      asOfMs,
    };
    this.info.set(pairId, {
      pairId,
      market: market.key,
      marketId: market.id,
      emodeId: emode?.emodeId ?? null,
      maxLtv,
      liqLtv,
      collateralAssetId: coll.id,
      debtAssetId: debt.id,
      sameAsset: same,
    });
    return ps;
  }

  /**
   * Borrow fee of the debt asset for `account` (Navi keys per-user overrides by the
   * borrowing account: the cap's owner address for e-mode caps). getBorrowFee returns
   * PERCENT (per-user get_borrow_fee_v2 on 10000 units / 100, or global bps / 100).
   */
  private async borrowFeeFrac(ps: PairState, account: string = this.env.address): Promise<number> {
    const pct = await this.sdk.getBorrowFee({
      address: account,
      asset: ps.debt.id,
      client: this.client,
      market: ps.market.key,
      cacheTime: 300_000,
    });
    const frac = Number(pct) / 100;
    if (!(frac >= 0 && frac < 0.1)) throw new Error(`navi: implausible borrow fee ${pct}% for ${ps.cfg.debt.symbol}`);
    return frac;
  }

  private async flashInfo(ps: PairState, pool: NaviPool): Promise<FlashInfo | null> {
    const assets = await this.sdk.getAllFlashLoanAssets({ market: ps.market.key, cacheTime: 60_000 });
    const t = normType(pool.suiCoinType ?? pool.coinType);
    const a = assets.find((x) => normType(x.coinType) === t);
    if (!a) return null;
    const fee = Number(a.flashloanFee);
    if (!(fee >= 0 && fee < 0.05)) return null;
    return { fee, min: digitsToBig(a.min), max: digitsToBig(a.max) };
  }

  private flashUsable(fi: FlashInfo | null, amount: bigint, ctx?: LiveContext): fi is FlashInfo {
    if (!fi) return false;
    if (fi.max !== undefined && amount > fi.max) {
      ctx?.log("warn", `navi: flash amount ${amount} > flash max ${fi.max}; using iterative path`);
      return false;
    }
    if (fi.min !== undefined && amount < fi.min) return false;
    return true;
  }

  private async coinInfo(ps: PairState | null, coinType: string): Promise<{ symbol: string; decimals: number }> {
    const t = normType(coinType);
    const p = ps?.pools.find((x) => normType(x.suiCoinType ?? x.coinType) === t);
    if (p?.token) return { symbol: p.token.symbol, decimals: p.token.decimals };
    if (!this.coinMeta.has(t)) {
      try {
        const r = await this.env.grpc.core.getCoinMetadata({ coinType: t });
        this.coinMeta.set(t, r.coinMetadata ? { symbol: r.coinMetadata.symbol, decimals: r.coinMetadata.decimals } : null);
      } catch {
        this.coinMeta.set(t, null);
      }
    }
    return this.coinMeta.get(t) ?? { symbol: t.split("::").pop() ?? t, decimals: 9 };
  }

  private priceOf(ps: PairState, coinType: string): number {
    const t = normType(coinType);
    const p = ps.pools.find((x) => normType(x.suiCoinType ?? x.coinType) === t);
    const v = Number(p?.oracle?.price ?? p?.token?.price ?? 0);
    return Number.isFinite(v) ? v : 0;
  }

  // -------------------------------------------------------------------------
  // Accounts (wallet address vs e-mode cap)
  // -------------------------------------------------------------------------

  private async accounts(ps: PairState): Promise<{ target: WriteAccount; candidates: NaviAccount[] }> {
    const addr: NaviAccount = { kind: "address", id: normalizeSuiAddress(this.env.address) };
    if (ps.cfg.emode === "off") return { target: addr, candidates: [addr] };
    const caps = (await this.sdk.getUserEModeCaps(this.env.address, { client: this.client, disableCache: true }))
      .filter((c) => c.marketId === ps.market.id)
      .map((c): NaviAccount => ({ kind: "cap", id: normalizeSuiAddress(c.accountCap), emodeId: c.emodeId }));
    if (ps.emode) {
      const id = ps.emode.emodeId;
      const mine = caps.filter((c) => c.kind === "cap" && c.emodeId === id);
      const others = caps.filter((c) => !(c.kind === "cap" && c.emodeId === id));
      return { target: mine[0] ?? { kind: "newCap", emodeId: id }, candidates: [...mine, ...others, addr] };
    }
    return { target: addr, candidates: [...caps, addr] };
  }

  private async readAccount(ps: PairState, account: NaviAccount): Promise<AccountState> {
    const all = await this.sdk.getLendingState(account.id, { client: this.client, markets: [ps.market.key], disableCache: true });
    const entries = all.filter((e) => e.market === ps.market.key);
    const c = entries.find((e) => e.assetId === ps.coll.id);
    const d = entries.find((e) => e.assetId === ps.debt.id);
    return {
      account,
      collateral: c ? M.naviNormalToBase(c.supplyBalance, ps.cfg.collateral.decimals) : 0n,
      debt: d ? M.naviNormalToBase(d.borrowBalance, ps.cfg.debt.decimals) : 0n,
      entries,
    };
  }

  /** First candidate account holding collateral or debt of this pair. */
  private async positionState(ps: PairState, candidates: NaviAccount[]): Promise<AccountState | null> {
    for (const a of candidates) {
      const st = await this.readAccount(ps, a);
      if (st.collateral > 0n || st.debt > 0n) return st;
    }
    return null;
  }

  private accountHealth(st: AccountState): number | undefined {
    const emodeId = st.account.kind === "cap" ? st.account.emodeId : undefined;
    const rows = st.entries.map((e) => {
      const p = e.pool;
      const price = Number(p.oracle?.price ?? 0);
      let lt = Number(p.liquidationFactor?.threshold ?? 0);
      if (emodeId !== undefined) {
        const ea = p.emodes?.find((x) => x.emodeId === emodeId)?.assets.find((x) => x.assetId === p.id);
        if (ea) lt = ea.lt;
      }
      return {
        collateralUsd: (Number(e.supplyBalance) / 1e9) * price,
        liqThreshold: lt,
        debtUsd: (Number(e.borrowBalance) / 1e9) * price,
      };
    });
    const hf = M.healthFactor(rows);
    return Number.isFinite(hf) ? hf : undefined;
  }

  // -------------------------------------------------------------------------
  // markets()
  // -------------------------------------------------------------------------

  async markets(): Promise<LoopPair[]> {
    const out: LoopPair[] = [];
    for (const pairId of this.pairs.keys()) {
      try {
        out.push(await this.marketFor(pairId));
      } catch (e) {
        this.log("error", `navi: markets() failed for ${pairId}`, { error: errMsg(e) });
      }
    }
    return out;
  }

  private rate(pct: string | number | undefined): number {
    const f = M.pctToFrac(pct);
    return this.incentiveRateKind === "apy" ? M.apyToApr(f) : f;
  }

  private async buildLeg(ps: PairState, pool: NaviPool, asset: AssetRef, borrowFeeFrac?: number): Promise<LoopLeg> {
    const price = Number(pool.oracle?.price);
    const amt = M.poolAmounts(pool);
    const caps = M.capsRemaining(pool);
    const sym = async (types: string[] | undefined) => Promise.all((types ?? []).map(async (t) => (await this.coinInfo(ps, t)).symbol));
    const supplyTokens = await sym(pool.supplyIncentiveApyInfo?.rewardCoin);
    const borrowTokens = await sym(pool.borrowIncentiveApyInfo?.rewardCoin);
    return {
      symbol: asset.symbol,
      assetId: normType(asset.address),
      priceUsd: price,
      totalSupplyUsd: amt.supply * price,
      totalBorrowUsd: amt.borrow * price,
      supplyAprBase: M.rayToFrac(pool.currentSupplyRate),
      borrowAprBase: M.rayToFrac(pool.currentBorrowRate),
      supplyRewards: M.splitRewardApr(this.rate(pool.supplyIncentiveApyInfo?.boostedApr), supplyTokens),
      borrowRewards: M.splitRewardApr(this.rate(pool.borrowIncentiveApyInfo?.boostedApr), borrowTokens),
      irm: M.buildIrmModel(pool.borrowRateFactors?.fields),
      supplyCapRemainingUsd: caps.supply === null ? null : caps.supply * price,
      borrowCapRemainingUsd: caps.borrow === null ? null : caps.borrow * price,
      borrowFeeFrac,
    };
  }

  /**
   * Quote the probe ladder (smallest first, stop once over budget). Throws only when
   * the smallest probe fails (depth unknown). If a larger probe fails after smaller
   * ones succeeded, the depth measured so far is returned as a lower bound.
   */
  private async probeSwap(ps: PairState): Promise<{ costFrac: number; depthUsd: number }> {
    const results: { usd: number; costBps: number }[] = [];
    for (const usd of this.probeUsd) {
      const amountIn = toUnits(usd / ps.debtPrice, ps.cfg.debt.decimals);
      let q: PtbSwapQuote;
      try {
        q = await this.swapper!.quote(ps.debtType, ps.collType, amountIn);
        if (!Number.isFinite(q.costBps)) throw new Error(`non-finite costBps ${q.costBps}`);
      } catch (e) {
        if (!results.length) throw e;
        this.log("warn", `navi: swap probe $${usd} failed for ${ps.cfg.pairId}; depth reported as lower bound`, { error: errMsg(e) });
        break;
      }
      results.push({ usd, costBps: Math.max(0, q.costBps) });
      if (q.costBps > this.depthBudgetBps) break;
    }
    return { costFrac: (results[0]?.costBps ?? 0) / 1e4, depthUsd: M.swapDepthFromProbes(results, this.depthBudgetBps) };
  }

  private async marketFor(pairId: string): Promise<LoopPair> {
    const ps = await this.loadPair(pairId);
    let borrowFee: number | undefined;
    try {
      borrowFee = await this.borrowFeeFrac(ps);
    } catch (e) {
      this.log("warn", `navi: borrow fee unavailable for ${pairId}`, { error: errMsg(e) });
    }
    let flashDebt: FlashInfo | null = null;
    try {
      flashDebt = await this.flashInfo(ps, ps.debt);
    } catch (e) {
      this.log("warn", `navi: flash-loan assets unavailable`, { error: errMsg(e) });
    }
    const collLeg = await this.buildLeg(ps, ps.coll, ps.cfg.collateral, ps.same ? borrowFee : undefined);
    const debtLeg = ps.same ? collLeg : await this.buildLeg(ps, ps.debt, ps.cfg.debt, borrowFee);

    if (this.extraRewards) {
      const q = { protocol: "navi", chain: "sui", marketId: ps.market.key } as const;
      const [sup, bor] = await Promise.all([
        this.extraRewards({ ...q, asset: ps.cfg.collateral, side: "supply" }).catch((e: unknown) => {
          this.log("warn", `navi: extraRewards(supply) failed for ${pairId}`, { error: errMsg(e) });
          return [] as RewardRate[];
        }),
        this.extraRewards({ ...q, asset: ps.cfg.debt, side: "borrow" }).catch((e: unknown) => {
          this.log("warn", `navi: extraRewards(borrow) failed for ${pairId}`, { error: errMsg(e) });
          return [] as RewardRate[];
        }),
      ]);
      collLeg.supplyRewards.push(...sup);
      debtLeg.borrowRewards.push(...bor);
    }

    let swapCostFrac = 0;
    let swapDepthUsd = Infinity;
    if (!ps.same) {
      try {
        const s = await this.probeSwap(ps);
        swapCostFrac = s.costFrac;
        swapDepthUsd = s.depthUsd; // 0 only when probes succeeded and none fit the budget
        this.lastSwapCost.set(pairId, s.costFrac);
      } catch (e) {
        // Unknown, not zero: NaN tells the core to use its last known depth / treat as missing
        // data (0 would read as "no exit capacity" and force an urgent exit).
        swapDepthUsd = NaN;
        swapCostFrac = this.lastSwapCost.get(pairId) ?? this.depthBudgetBps / 1e4;
        this.log("warn", `navi: swap probe failed for ${pairId}; swapDepthUsd=NaN, swapCostFrac=${swapCostFrac}`, { error: errMsg(e) });
      }
    }

    let myLtv: number | undefined;
    if (this.includeMyLtv) {
      try {
        const acc = await this.accounts(ps);
        const st = await this.positionState(ps, acc.candidates);
        if (st && st.collateral > 0n) myLtv = M.ltvOf(st.collateral, st.debt, ps.priceRatio);
      } catch (e) {
        this.log("warn", `navi: position read failed for ${pairId}`, { error: errMsg(e) });
      }
    }

    this.log("debug", `navi: ${pairId} market=${ps.market.key} emode=${ps.emode?.emodeId ?? "none"} maxLtv=${ps.maxLtv} liqLtv=${ps.liqLtv}`);
    return {
      protocol: "navi",
      chain: "sui",
      pairId,
      collateral: collLeg,
      debt: debtLeg,
      maxLtv: ps.maxLtv,
      liqLtv: ps.liqLtv,
      swapCostFrac,
      swapDepthUsd,
      flashloanFeeFrac: flashDebt?.fee,
      paused: ps.paused,
      myLtv,
      dataAsOfMs: ps.asOfMs,
    };
  }

  // -------------------------------------------------------------------------
  // position()
  // -------------------------------------------------------------------------

  async position(pairId: string): Promise<LoopPositionView | null> {
    const ps = await this.loadPair(pairId);
    const acc = await this.accounts(ps);
    const st = await this.positionState(ps, acc.candidates);
    if (!st) return null;
    const collateralUsd = M.unitsToNumber(st.collateral, ps.cfg.collateral.decimals) * ps.collPrice;
    const debtUsd = M.unitsToNumber(st.debt, ps.cfg.debt.decimals) * ps.debtPrice;
    let rewardsUnclaimed: LoopPositionView["rewardsUnclaimed"] = [];
    try {
      rewardsUnclaimed = (await this.unclaimed(ps, st)).map(({ coinType: _c, ...r }) => r);
    } catch (e) {
      this.log("warn", `navi: reward read failed for ${pairId}`, { error: errMsg(e) });
    }
    return {
      pairId,
      collateralUsd,
      debtUsd,
      ltv: collateralUsd > 0 ? debtUsd / collateralUsd : debtUsd > 0 ? Infinity : 0,
      healthFactor: this.accountHealth(st),
      equityUsd: collateralUsd - debtUsd,
      rewardsUnclaimed,
      asOfMs: Date.now(),
    };
  }

  private rewardMatches(ps: PairState, st: AccountState, r: NaviLendingReward): boolean {
    const t = normType(r.assetCoinType);
    return (
      r.market === ps.market.key &&
      normalizeSuiAddress(r.address) === normalizeSuiAddress(st.account.id) &&
      (t === ps.collType || t === ps.debtType)
    );
  }

  private async groupRewards(
    ps: PairState | null,
    rewards: NaviLendingReward[]
  ): Promise<{ token: string; coinType: string; amount: bigint; decimals: number; usd: number }[]> {
    const sums = new Map<string, number>();
    for (const r of rewards) {
      if (!(r.userClaimableReward > 0)) continue;
      const t = normType(r.rewardCoinType);
      sums.set(t, (sums.get(t) ?? 0) + r.userClaimableReward);
    }
    const out: { token: string; coinType: string; amount: bigint; decimals: number; usd: number }[] = [];
    for (const [coinType, human] of sums) {
      const info = await this.coinInfo(ps, coinType);
      const price = ps ? this.priceOf(ps, coinType) : 0;
      // userClaimableReward is a human amount (SDK divides the raw u256 by the reward feed's decimals)
      out.push({ token: info.symbol, coinType, amount: toUnits(human, info.decimals), decimals: info.decimals, usd: human * price });
    }
    return out;
  }

  private async unclaimed(ps: PairState, st: AccountState) {
    const rewards = await this.sdk.getUserAvailableLendingRewards(this.env.address, { client: this.client, markets: [ps.market.key] });
    return this.groupRewards(
      ps,
      rewards.filter((r) => this.rewardMatches(ps, st, r))
    );
  }

  // -------------------------------------------------------------------------
  // PTB building blocks
  // -------------------------------------------------------------------------

  /** Fresh tx with Navi oracle updates for every asset of the account + this pair (Pyth push when stale). */
  private async txWithOracle(ps: PairState, ctx: LiveContext): Promise<Transaction> {
    // getPriceFeeds' d.ts omits `market`, but it forwards options to getConfig({market}) at runtime
    // (the SDK's own updateOraclePriceBeforeUserOperationPTB passes market the same way).
    const feeds = await this.sdk.getPriceFeeds({ market: ps.market.key } as unknown as Parameters<NaviSdk["getPriceFeeds"]>[0]);
    let positions: Awaited<ReturnType<NaviSdk["getLendingPositions"]>> = [];
    try {
      positions = await this.sdk.getLendingPositions(this.env.address, { client: this.client, markets: [ps.market.key], disableCache: true });
    } catch (e) {
      ctx.log("warn", "navi: could not read positions for oracle feed selection; updating pair feeds only", { error: errMsg(e) });
    }
    const relevant = this.sdk.filterPriceFeeds(feeds, { lendingPositions: positions, pools: [ps.coll, ps.debt] });
    const tx = new Transaction();
    try {
      await this.sdk.updateOraclePricesPTB(tx, relevant, { client: this.client, market: ps.market.key, updatePythPriceFeeds: true });
      return tx;
    } catch (e) {
      ctx.log("warn", "navi: Pyth price push failed; refreshing Navi oracle without it", { error: errMsg(e) });
      const tx2 = new Transaction();
      await this.sdk.updateOraclePricesPTB(tx2, relevant, { client: this.client, market: ps.market.key, updatePythPriceFeeds: false });
      return tx2;
    }
  }

  private lendOpts(ps: PairState, cap: string | TransactionResult | undefined) {
    return cap === undefined ? { market: ps.market.key } : { market: ps.market.key, accountCap: cap };
  }

  private fromBalance(tx: Transaction, type: string, bal: TransactionObjectArgument): TransactionResult {
    return tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [type], arguments: [bal] });
  }
  private intoBalance(tx: Transaction, type: string, coin: TransactionObjectArgument): TransactionResult {
    return tx.moveCall({ target: "0x2::coin::into_balance", typeArguments: [type], arguments: [coin] });
  }

  /** Repay; cap repays return the excess as a coin (sent to the wallet), address repays send it automatically. */
  private async repay(tx: Transaction, ps: PairState, coin: TransactionObjectArgument, cap: string | undefined): Promise<void> {
    const r = await this.sdk.repayCoinPTB(tx, ps.debt, coin, this.lendOpts(ps, cap));
    if (cap !== undefined && r && typeof (r as Transaction).moveCall !== "function") {
      tx.transferObjects([r as TransactionObjectArgument], this.env.address);
    }
  }

  private checkCaps(ps: PairState, supplyAdd: bigint, borrowAdd: bigint, flashColl = 0n): string | null {
    const h = (x: bigint, d: number) => M.unitsToNumber(x, d);
    const sAdd = h(supplyAdd, ps.cfg.collateral.decimals);
    const bAdd = h(borrowAdd, ps.cfg.debt.decimals);
    const ca = M.poolAmounts(ps.coll);
    if (Number.isFinite(ca.supplyCap) && ca.supply + sAdd > ca.supplyCap)
      return `supply cap: ${ps.cfg.collateral.symbol} pool has ${(ca.supplyCap - ca.supply).toFixed(2)} left, need ${sAdd.toFixed(2)}`;
    const fAdd = h(flashColl, ps.cfg.collateral.decimals);
    if (fAdd > 0 && fAdd >= ca.supply - ca.borrow) return `flash loan ${fAdd.toFixed(2)} ${ps.cfg.collateral.symbol} exceeds pool liquidity`;
    const da = M.poolAmounts(ps.debt);
    const newSupply = da.supply + (ps.same ? sAdd : 0);
    const ratio = M.rayToFrac(ps.debt.borrowCapCeiling);
    if (ratio > 0 && da.borrow + bAdd > ratio * newSupply) return `borrow cap: ${ps.cfg.debt.symbol} borrow would exceed ${(ratio * 100).toFixed(0)}% of supply`;
    if (bAdd > 0 && da.borrow + bAdd >= newSupply) return `liquidity: ${ps.cfg.debt.symbol} pool cannot lend ${bAdd.toFixed(2)}`;
    return null;
  }

  // -------------------------------------------------------------------------
  // open()
  // -------------------------------------------------------------------------

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    try {
      const ps = await this.loadPair(pairId);
      if (!(equity > 0n)) return fail("equity must be > 0");
      if (!(targetLtv > 0 && targetLtv < 1)) return fail(`targetLtv ${targetLtv} out of (0,1)`);
      const cap = ps.maxLtv * M.MAX_TARGET_LTV_FRAC;
      if (targetLtv > cap) return fail(`targetLtv ${targetLtv} > ${M.MAX_TARGET_LTV_FRAC} x maxLtv ${ps.maxLtv} (= ${cap.toFixed(4)})`);
      if (ps.paused) return fail(`${pairId}: Navi pool inactive / deprecated / oracle invalid`);
      const bal = await this.walletBalance(ps.cfg.collateral);
      if (bal < equity) return fail(`wallet has ${bal} ${ps.cfg.collateral.symbol} base units < equity ${equity}`);

      const acc = await this.accounts(ps);
      const existing = await this.positionState(ps, acc.candidates);
      if (existing && !sameAccount(existing.account, acc.target))
        return fail(`existing ${pairId} position is in ${describeAccount(existing.account)}, pair now resolves to ${describeAccount(acc.target)}; close it first`);
      const target: WriteAccount = existing?.account ?? acc.target;
      const bf = await this.borrowFeeFrac(ps, target.kind === "newCap" ? this.env.address : target.id);
      const fi = await this.flashInfo(ps, ps.coll);
      const ex = { existingCollateral: existing?.collateral ?? 0n, existingDebt: existing?.debt ?? 0n };
      const errors: string[] = [];

      if (fi) {
        const b = await this.buildFlashOpen(ps, target, equity, targetLtv, bf, fi, ex, ctx);
        if (isBuilt(b)) {
          try {
            const rec = await executePtb(this.env, ctx, b.tx, b.description);
            return { ok: true, txs: [rec], detail: b.detail, amountUsd: b.amountUsd };
          } catch (e) {
            if (!(e instanceof SuiSimulationError)) throw e;
            errors.push(`flash: ${e.message}`);
            ctx.log("warn", `navi: flash open simulation failed, trying iterative loop`, { error: e.message });
          }
        } else errors.push(`flash: ${b.error}`);
      } else errors.push(`flash: ${ps.cfg.collateral.symbol} not flash-loanable on Navi ${ps.market.key}`);

      const it = await this.buildIterativeOpen(ps, target, equity, targetLtv, bf, ex, ctx);
      if (!isBuilt(it)) return fail([...errors, `iterative: ${it.error}`].join("; "));
      const rec = await executePtb(this.env, ctx, it.tx, it.description);
      return { ok: true, txs: [rec], detail: [it.detail, ...errors.map((x) => `(fallback because ${x})`)].join(" "), amountUsd: it.amountUsd };
    } catch (e) {
      ctx.log("error", `navi: open ${pairId} failed`, { error: errMsg(e) });
      return fail(errMsg(e));
    }
  }

  /** Account argument for lending calls; creates the e-mode cap inside the PTB when needed. */
  private async accountArg(tx: Transaction, ps: PairState, target: WriteAccount): Promise<{ cap?: string | TransactionResult; newCap?: TransactionResult }> {
    if (target.kind === "address") return {};
    if (target.kind === "cap") return { cap: target.id };
    const newCap = await this.sdk.createEModeCapPTB(tx, target.emodeId, { market: ps.market.key });
    return { cap: newCap, newCap };
  }

  private async buildFlashOpen(
    ps: PairState,
    target: WriteAccount,
    equity: bigint,
    t: number,
    bf: number,
    fi: FlashInfo,
    ex: { existingCollateral: bigint; existingDebt: bigint },
    ctx: LiveContext
  ): Promise<BuildResult> {
    const slipBps = ctx.limits.maxSlippageBps;
    const base = { equity, targetLtv: t, flashFeeFrac: fi.fee, borrowFeeFrac: bf, priceRatio: ps.priceRatio, ...ex };
    let plan: M.FlashOpenPlan | undefined;
    let quote: PtbSwapQuote | undefined;
    let minOut = 0n;
    if (ps.same) {
      plan = M.solveFlashOpen({ ...base, swapCostFrac: 0 });
    } else {
      const guess = M.solveFlashOpen({ ...base, swapCostFrac: slipBps / 1e4 });
      if (guess.flash === 0n) plan = guess;
      else {
        const q0 = await this.swapper!.quote(ps.debtType, ps.collType, guess.borrow);
        let c = Math.max(0, q0.costBps) / 1e4 + slipBps / 1e4;
        for (let i = 0; i < 4 && !quote; i++) {
          const p = M.solveFlashOpen({ ...base, swapCostFrac: Math.min(c, 0.5) });
          const q = await this.swapper!.quote(ps.debtType, ps.collType, p.borrow);
          const slipMin = minusBps(q.amountOut, slipBps);
          if (slipMin >= p.flashRepay) {
            plan = p;
            quote = q;
            minOut = slipMin;
          } else {
            c = 1 - Number(slipMin) / (Number(p.borrow) / ps.priceRatio) + 1e-5;
          }
        }
        if (!quote) return { error: "swap quotes cannot cover the flash repayment within the slippage budget" };
      }
    }
    if (!plan) return { error: "no plan" };
    if (plan.expectedLtv > ps.maxLtv * M.MAX_TARGET_LTV_FRAC + 1e-9)
      return { error: `post-trade LTV ${plan.expectedLtv.toFixed(4)} > ${M.MAX_TARGET_LTV_FRAC} x maxLtv` };
    if (!this.flashUsable(fi, plan.flash, ctx) && plan.flash > 0n) return { error: `flash amount ${plan.flash} outside Navi flash limits` };
    const capErr = this.checkCaps(ps, equity + plan.flash, plan.borrow, plan.flash);
    if (capErr) return { error: capErr };

    const tx = await this.txWithOracle(ps, ctx);
    const { cap, newCap } = await this.accountArg(tx, ps, target);
    const lo = this.lendOpts(ps, cap);
    const equityCoin = tx.add(coinWithBalance({ type: ps.collType, balance: equity }));
    let receipt: FlashReceipt | undefined;
    if (plan.flash > 0n) {
      const [flashBal, rcpt] = await this.sdk.flashloanPTB(tx, ps.coll, u64(tx, plan.flash), { market: ps.market.key });
      if (!flashBal || !rcpt) return { error: "flashloanPTB returned no balance/receipt" };
      receipt = rcpt;
      tx.mergeCoins(equityCoin, [this.fromBalance(tx, ps.collType, flashBal)]);
    }
    await this.sdk.depositCoinPTB(tx, ps.coll, equityCoin, lo);
    if (plan.flash > 0n && receipt) {
      const borrowed = await this.sdk.borrowCoinPTB(tx, ps.debt, u64(tx, plan.borrow), lo);
      const collOut = ps.same
        ? borrowed
        : await this.swapper!.appendSwap(tx, { fromType: ps.debtType, toType: ps.collType, coinIn: borrowed, quote: quote!, minOut });
      const [left] = await this.sdk.repayFlashLoanPTB(tx, ps.coll, receipt, this.intoBalance(tx, ps.collType, collOut), { market: ps.market.key });
      if (left) tx.transferObjects([this.fromBalance(tx, ps.collType, left)], this.env.address);
    }
    if (newCap) tx.transferObjects([newCap], this.env.address);

    const L = 1 / (1 - t);
    return {
      tx,
      description: `navi: flash-open ${ps.cfg.pairId} equity=${equity} flash=${plan.flash} borrow=${plan.borrow} (${L.toFixed(2)}x)`,
      detail: `flash loop: deposited ${equity + plan.flash}, borrowed ${plan.borrow} ${ps.cfg.debt.symbol}, expected LTV ${plan.expectedLtv.toFixed(4)}${ps.emode ? ` (e-mode ${ps.emode.emodeId})` : ""}`,
      amountUsd: M.unitsToNumber(equity, ps.cfg.collateral.decimals) * ps.collPrice,
    };
  }

  private async buildIterativeOpen(
    ps: PairState,
    target: WriteAccount,
    equity: bigint,
    t: number,
    bf: number,
    ex: { existingCollateral: bigint; existingDebt: bigint },
    ctx: LiveContext
  ): Promise<BuildResult> {
    const slipBps = ctx.limits.maxSlippageBps;
    let c = 0;
    if (!ps.same) {
      const rough = M.planLoopSteps(equity, t, ps.maxLtv, ps.priceRatio, ctx.limits.maxLoopIterations, { borrowFeeFrac: bf, ...ex });
      const total = rough.steps.reduce((s, x) => s + x.borrow, 0n);
      if (total > 0n) {
        const q = await this.swapper!.quote(ps.debtType, ps.collType, total);
        c = Math.max(0, q.costBps) / 1e4 + slipBps / 1e4;
      }
    }
    const plan = M.planLoopSteps(equity, t, ps.maxLtv, ps.priceRatio, ctx.limits.maxLoopIterations, { swapCostFrac: c, borrowFeeFrac: bf, ...ex });
    if (plan.achievedLtv > ps.maxLtv * M.MAX_TARGET_LTV_FRAC + 1e-9) return { error: `planned LTV ${plan.achievedLtv} too high` };
    const totalBorrow = plan.steps.reduce((s, x) => s + x.borrow, 0n);
    const totalDeposit = plan.steps.reduce((s, x) => s + x.expectedDeposit, equity);
    const capErr = this.checkCaps(ps, totalDeposit, totalBorrow);
    if (capErr) return { error: capErr };

    const tx = await this.txWithOracle(ps, ctx);
    const { cap, newCap } = await this.accountArg(tx, ps, target);
    const lo = this.lendOpts(ps, cap);
    const equityCoin = tx.add(coinWithBalance({ type: ps.collType, balance: equity }));
    await this.sdk.depositCoinPTB(tx, ps.coll, equityCoin, lo);
    for (const step of plan.steps) {
      const borrowed = await this.sdk.borrowCoinPTB(tx, ps.debt, u64(tx, step.borrow), lo);
      let toDeposit: TransactionObjectArgument = borrowed;
      if (!ps.same) {
        const q = await this.swapper!.quote(ps.debtType, ps.collType, step.borrow);
        const slipMin = minusBps(q.amountOut, slipBps);
        if (slipMin < step.expectedDeposit) return { error: `swap quote for step (${q.amountOut}) worse than plan (${step.expectedDeposit})` };
        toDeposit = await this.swapper!.appendSwap(tx, { fromType: ps.debtType, toType: ps.collType, coinIn: borrowed, quote: q, minOut: slipMin });
      }
      await this.sdk.depositCoinPTB(tx, ps.coll, toDeposit, lo);
    }
    if (newCap) tx.transferObjects([newCap], this.env.address);
    return {
      tx,
      description: `navi: loop-open ${ps.cfg.pairId} equity=${equity} steps=${plan.steps.length} borrow=${totalBorrow}`,
      detail:
        `iterative loop: ${plan.steps.length} steps, expected LTV ${plan.achievedLtv.toFixed(4)}` +
        (plan.targetReached ? "" : ` (target ${t} not reached within ${ctx.limits.maxLoopIterations} iterations)`),
      amountUsd: M.unitsToNumber(equity, ps.cfg.collateral.decimals) * ps.collPrice,
    };
  }

  // -------------------------------------------------------------------------
  // close() / deleverage() / simulateClose()
  // -------------------------------------------------------------------------

  async close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    if (!(fraction > 0 && fraction <= 1)) return fail(`fraction ${fraction} out of (0,1]`);
    return this.unwind(pairId, { kind: "fraction", fraction }, ctx);
  }

  async deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    if (!(targetLtv >= 0 && targetLtv < 1)) return fail(`targetLtv ${targetLtv} out of [0,1)`);
    return this.unwind(pairId, { kind: "target", ltv: targetLtv }, ctx);
  }

  async simulateClose(pairId: string, ctx: LiveContext): Promise<boolean> {
    try {
      const ps = await this.loadPair(pairId);
      const st = await this.positionState(ps, (await this.accounts(ps)).candidates);
      if (!st) return true;
      const flash = await this.buildUnwind(ps, st, { kind: "fraction", fraction: 1 }, ctx, true);
      if (isBuilt(flash) && (await simulateOk(this.env, flash.tx))) return true;
      const it = await this.buildUnwind(ps, st, { kind: "fraction", fraction: 1 }, ctx, false);
      if (isBuilt(it)) return simulateOk(this.env, it.tx);
      ctx.log("warn", `navi: simulateClose ${pairId}: ${isBuilt(flash) ? "flash close simulation failed" : flash.error}; iterative: ${it.error}`);
      return false;
    } catch (e) {
      ctx.log("warn", `navi: simulateClose ${pairId} failed`, { error: errMsg(e) });
      return false;
    }
  }

  private async unwind(pairId: string, mode: UnwindMode, ctx: LiveContext): Promise<LiveResult> {
    try {
      const ps = await this.loadPair(pairId);
      const st = await this.positionState(ps, (await this.accounts(ps)).candidates);
      if (!st) return mode.kind === "fraction" ? { ok: true, txs: [], detail: "no position" } : fail("no position");
      if (mode.kind === "target") {
        const cur = M.ltvOf(st.collateral, st.debt, ps.priceRatio);
        if (cur <= mode.ltv + 1e-6) return { ok: true, txs: [], detail: `LTV ${cur.toFixed(4)} already <= target ${mode.ltv}` };
      }
      const errors: string[] = [];
      const txs: TxRecord[] = [];
      const flash = await this.buildUnwind(ps, st, mode, ctx, true);
      if (isBuilt(flash)) {
        try {
          txs.push(await executePtb(this.env, ctx, flash.tx, flash.description));
          return { ok: true, txs, detail: flash.detail, amountUsd: flash.amountUsd };
        } catch (e) {
          if (!(e instanceof SuiSimulationError)) throw e;
          errors.push(`flash: ${e.message}`);
          ctx.log("warn", `navi: flash unwind simulation failed, trying iterative`, { error: e.message });
        }
      } else errors.push(`flash: ${flash.error}`);
      const it = await this.buildUnwind(ps, st, mode, ctx, false);
      if (!isBuilt(it)) return fail([...errors, `iterative: ${it.error}`].join("; "));
      txs.push(await executePtb(this.env, ctx, it.tx, it.description));
      return { ok: true, txs, detail: [it.detail, ...errors.map((x) => `(fallback because ${x})`)].join(" "), amountUsd: it.amountUsd };
    } catch (e) {
      ctx.log("error", `navi: unwind ${pairId} failed`, { error: errMsg(e) });
      return fail(errMsg(e));
    }
  }

  /** Estimated swap cost (+ slippage allowance) of collateral -> debt for `amount` collateral. */
  private async unwindCost(ps: PairState, amount: bigint, slipBps: number): Promise<number> {
    if (ps.same || amount <= 0n) return 0;
    const q = await this.swapper!.quote(ps.collType, ps.debtType, amount);
    return Math.max(0, q.costBps) / 1e4 + slipBps / 1e4;
  }

  private async buildUnwind(ps: PairState, st: AccountState, mode: UnwindMode, ctx: LiveContext, useFlash: boolean): Promise<BuildResult> {
    const now = Date.now();
    const C = st.collateral;
    const D = st.debt;
    const pr = ps.priceRatio;
    const slipBps = ctx.limits.maxSlippageBps;
    const cap = st.account.kind === "cap" ? st.account.id : undefined;
    const lo = this.lendOpts(ps, cap);
    const full = mode.kind === "fraction" && mode.fraction >= 1;
    const collSym = ps.cfg.collateral.symbol;
    const debtSym = ps.cfg.debt.symbol;
    const usd = (x: bigint) => M.unitsToNumber(x, ps.cfg.collateral.decimals) * ps.collPrice;
    const wAll = M.withdrawAllRequest(C, M.rayToFrac(ps.coll.currentSupplyRate), secondsSince(ps.coll.lastUpdateTimestamp, now));

    // --- no debt: plain withdraw ------------------------------------------------
    if (D === 0n) {
      if (mode.kind === "target") return { error: "no debt to deleverage" };
      const req = full ? wAll : M.mulFracFloor(C, mode.fraction);
      const tx = await this.txWithOracle(ps, ctx);
      const coin = await this.sdk.withdrawCoinPTB(tx, ps.coll, u64(tx, req), lo);
      tx.transferObjects([coin], this.env.address);
      return { tx, description: `navi: withdraw ${req} ${collSym} (${ps.cfg.pairId})`, detail: `withdrew ${req} ${collSym}, no debt`, amountUsd: usd(req) };
    }

    const debtBuffered = M.debtWithBuffer(D, M.rayToFrac(ps.debt.currentBorrowRate), secondsSince(ps.debt.lastUpdateTimestamp, now));

    if (useFlash) {
      const fi = await this.flashInfo(ps, ps.debt);
      if (!fi) return { error: `${debtSym} not flash-loanable on Navi ${ps.market.key}` };
      const ffm = fi.fee + this.flashFeeMargin;
      let y: bigint; // debt repaid with the flash loan
      let wReq: bigint; // collateral withdraw request
      let swapIn = 0n; // collateral swapped -> debt (different assets)
      let quote: PtbSwapQuote | undefined;
      let minOut = 0n;
      let needed: bigint; // flash repayment (debt units)

      if (mode.kind === "fraction") {
        y = full ? debtBuffered : M.mulFracFloor(D, mode.fraction);
        wReq = full ? wAll : M.mulFracFloor(C, mode.fraction);
        needed = M.flashRepayAmount(y, ffm);
        if (ps.same) {
          if ((full ? C : wReq) < needed) return { error: `collateral ${C} cannot cover flash repayment ${needed}` };
        } else {
          let c = await this.unwindCost(ps, M.convCeil(needed, 1 / pr), slipBps);
          for (let i = 0; i < 4 && !quote; i++) {
            const s = M.convCeil(needed, 1 / (pr * (1 - Math.min(c, 0.5))));
            const q = await this.swapper!.quote(ps.collType, ps.debtType, s);
            const slipMin = minusBps(q.amountOut, slipBps);
            if (slipMin >= needed) {
              quote = q;
              swapIn = s;
              minOut = slipMin;
            } else c = 1 - Number(slipMin) / (Number(s) * pr) + 1e-5;
          }
          if (!quote) return { error: "swap quotes cannot cover the flash repayment" };
          if ((full ? C : wReq) < swapIn) return { error: `withdrawn collateral cannot fund the swap (${swapIn} needed)` };
        }
      } else {
        // target LTV
        let c = 0;
        if (!ps.same) {
          const guess = M.solveDeleverage({ collateral: C, debt: D, targetLtv: mode.ltv, priceRatio: pr, swapCostFrac: slipBps / 1e4, flashFeeFrac: ffm });
          c = await this.unwindCost(ps, guess?.withdraw ?? C / 10n, slipBps);
        }
        let sol: { repay: bigint; withdraw: bigint } | null = null;
        for (let i = 0; i < 4; i++) {
          sol = M.solveDeleverage({ collateral: C, debt: D, targetLtv: mode.ltv, priceRatio: pr, swapCostFrac: Math.min(c, 0.5), flashFeeFrac: ffm });
          if (!sol) return { error: `target LTV ${mode.ltv} unreachable with current costs` };
          if (ps.same) break;
          const q = await this.swapper!.quote(ps.collType, ps.debtType, sol.withdraw);
          const slipMin = minusBps(q.amountOut, slipBps);
          if (slipMin >= M.flashRepayAmount(sol.repay, ffm)) {
            quote = q;
            minOut = slipMin;
            break;
          }
          c = 1 - Number(slipMin) / (Number(sol.withdraw) * pr) + 1e-5;
        }
        if (!sol || (!ps.same && !quote)) return { error: "swap quotes cannot cover the deleverage" };
        y = sol.repay;
        if (mode.ltv <= 1e-9 || y >= D) y = debtBuffered; // repay everything
        needed = M.flashRepayAmount(y, ffm);
        wReq = ps.same ? M.maxBig(sol.withdraw, needed) : sol.withdraw;
        swapIn = ps.same ? 0n : sol.withdraw;
        if (!ps.same && y === debtBuffered && quote && minOut < needed) return { error: "swap cannot cover full repayment" };
      }
      if (y <= 0n) return { error: "nothing to repay" };
      if (!this.flashUsable(fi, y, ctx)) return { error: `flash amount ${y} outside Navi flash limits` };
      if (M.poolAmounts(ps.debt).supply - M.poolAmounts(ps.debt).borrow <= M.unitsToNumber(y, ps.cfg.debt.decimals))
        return { error: `${debtSym} pool liquidity too low for a ${y} flash loan` };

      const tx = await this.txWithOracle(ps, ctx);
      const [flashBal, receipt] = await this.sdk.flashloanPTB(tx, ps.debt, u64(tx, y), { market: ps.market.key });
      if (!flashBal || !receipt) return { error: "flashloanPTB returned no balance/receipt" };
      await this.repay(tx, ps, this.fromBalance(tx, ps.debtType, flashBal), cap);
      const wCoin = await this.sdk.withdrawCoinPTB(tx, ps.coll, u64(tx, wReq), lo);
      let repayBal: TransactionResult;
      let wCoinConsumed = false;
      if (ps.same) {
        const [part] = tx.splitCoins(wCoin, [u64(tx, needed)]);
        repayBal = this.intoBalance(tx, ps.debtType, part!);
      } else {
        let swapCoin: TransactionObjectArgument;
        if (mode.kind === "target" && swapIn === wReq) {
          swapCoin = wCoin;
          wCoinConsumed = true;
        } else {
          const [part] = tx.splitCoins(wCoin, [u64(tx, swapIn)]);
          swapCoin = part!;
        }
        const out = await this.swapper!.appendSwap(tx, { fromType: ps.collType, toType: ps.debtType, coinIn: swapCoin, quote: quote!, minOut });
        repayBal = this.intoBalance(tx, ps.debtType, out);
      }
      const [left] = await this.sdk.repayFlashLoanPTB(tx, ps.debt, receipt, repayBal, { market: ps.market.key });
      const toWallet: TransactionObjectArgument[] = [];
      if (left) toWallet.push(this.fromBalance(tx, ps.debtType, left));
      if (!wCoinConsumed) toWallet.push(wCoin);
      if (toWallet.length) tx.transferObjects(toWallet, this.env.address);

      const what = mode.kind === "fraction" ? `close ${mode.fraction}` : `deleverage -> ${mode.ltv}`;
      const returned = full ? C : wReq;
      return {
        tx,
        description: `navi: flash-${what} ${ps.cfg.pairId} repay=${y} ${debtSym} withdraw=${wReq} ${collSym}`,
        detail: `flash ${what}: repaid ${y} ${debtSym}${full ? " (all debt + buffer; excess refunded)" : ""}, withdrew ${full ? "all" : wReq} ${collSym}`,
        amountUsd: mode.kind === "fraction" ? Math.max(0, usd(returned) - M.unitsToNumber(y, ps.cfg.debt.decimals) * ps.debtPrice) : 0,
      };
    }

    // --- iterative: withdraw -> (swap) -> repay ---------------------------------
    let c = 0;
    if (!ps.same) c = await this.unwindCost(ps, M.convCeil(D, 1 / pr) / 4n + 1n, slipBps);
    let repayTarget: bigint;
    let finalWithdraw: bigint | "all" = 0n;
    if (mode.kind === "fraction") {
      repayTarget = full ? debtBuffered : M.mulFracFloor(D, mode.fraction);
    } else {
      const dv = Number(D) / pr;
      const denom = 1 - c - mode.ltv;
      if (!(denom > 0)) return { error: `target LTV ${mode.ltv} unreachable` };
      const w = (dv - mode.ltv * Number(C)) / denom;
      repayTarget = mode.ltv <= 1e-9 ? debtBuffered : BigInt(Math.max(0, Math.floor(w * (1 - c) * pr)));
    }
    const plan = M.planUnwindSteps({
      collateral: C,
      debt: D,
      repayTarget,
      liqLtv: ps.liqLtv,
      priceRatio: pr,
      maxIterations: ctx.limits.maxLoopIterations,
      swapCostFrac: c,
    });
    if (!plan.steps.length) return { error: "no withdraw headroom for an iterative unwind" };
    if (full && !plan.reached) return { error: `cannot fully close within ${ctx.limits.maxLoopIterations} iterations without a flash loan` };
    if (mode.kind === "fraction" && !plan.reached) return { error: `cannot repay ${mode.fraction} of debt within ${ctx.limits.maxLoopIterations} iterations` };
    if (full) finalWithdraw = "all";
    else if (mode.kind === "fraction") {
      const want = M.mulFracFloor(C, mode.fraction);
      finalWithdraw = want > plan.withdrawn ? want - plan.withdrawn : 0n;
    }

    const tx = await this.txWithOracle(ps, ctx);
    for (const step of plan.steps) {
      const wCoin = await this.sdk.withdrawCoinPTB(tx, ps.coll, u64(tx, step.withdraw), lo);
      let repayCoin: TransactionObjectArgument = wCoin;
      if (!ps.same) {
        const q = await this.swapper!.quote(ps.collType, ps.debtType, step.withdraw);
        const slipMin = minusBps(q.amountOut, slipBps);
        if (slipMin < step.minRepay) return { error: `swap quote for unwind step (${q.amountOut}) worse than plan (${step.minRepay})` };
        repayCoin = await this.swapper!.appendSwap(tx, { fromType: ps.collType, toType: ps.debtType, coinIn: wCoin, quote: q, minOut: slipMin });
      }
      await this.repay(tx, ps, repayCoin, cap);
    }
    if (finalWithdraw === "all" || finalWithdraw > 0n) {
      const req = finalWithdraw === "all" ? M.withdrawAllRequest(C - plan.withdrawn, M.rayToFrac(ps.coll.currentSupplyRate), 3600) : finalWithdraw;
      const coin = await this.sdk.withdrawCoinPTB(tx, ps.coll, u64(tx, req), lo);
      tx.transferObjects([coin], this.env.address);
    }
    const what = mode.kind === "fraction" ? `close ${mode.fraction}` : `deleverage -> ${mode.ltv}`;
    return {
      tx,
      description: `navi: loop-${what} ${ps.cfg.pairId} steps=${plan.steps.length} repay=${plan.repaid} ${debtSym}`,
      detail: `iterative ${what}: ${plan.steps.length} steps, repaid >= ${plan.repaid} ${debtSym}` + (plan.reached ? "" : " (target not fully reached)"),
      amountUsd: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Rewards / wallet / verification
  // -------------------------------------------------------------------------

  async claimRewards(
    ctx: LiveContext,
    pairId?: string
  ): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number; coinType: string }[] }> {
    try {
      const markets = pairId ? [this.pairCfg(pairId).market] : [...new Set([...this.pairs.values()].map((p) => p.market))];
      let rewards = await this.sdk.getUserAvailableLendingRewards(this.env.address, { client: this.client, markets });
      rewards = rewards.filter((r) => r.userClaimableReward > 0);
      let ps: PairState | null = null;
      if (pairId) {
        ps = await this.loadPair(pairId);
        const st = await this.positionState(ps, (await this.accounts(ps)).candidates);
        rewards = st ? rewards.filter((r) => this.rewardMatches(ps!, st, r)) : [];
      }
      if (!rewards.length) return { ok: true, txs: [], claimed: [], detail: "nothing to claim" };
      const tx = new Transaction();
      // Transfer every claimed coin to the wallet (also e-mode cap rewards, which the SDK
      // would otherwise send to the cap's address).
      await this.sdk.claimLendingRewardsPTB(tx, rewards, { customCoinReceive: { type: "transfer", transfer: this.env.address } });
      const rec = await executePtb(this.env, ctx, tx, `navi: claim rewards (${rewards.length} entries${pairId ? `, ${pairId}` : ""})`);
      const claimed = (await this.groupRewards(ps, rewards)).map(({ token, amount, decimals, coinType }) => ({ token, amount, decimals, coinType }));
      return { ok: true, txs: [rec], claimed, detail: "amounts are the pre-claim estimate from Navi's claimable query" };
    } catch (e) {
      ctx.log("error", "navi: claimRewards failed", { error: errMsg(e) });
      return { ok: false, txs: [], claimed: [], detail: errMsg(e) };
    }
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return coinBalance(this.env, asset.address);
  }

  /**
   * On-chain config checks: coin types exist with the configured decimals,
   * a Navi pool exists for each (market, coinType) and the pool object on
   * chain is a Pool<coinType>, the market's Storage object exists, explicit
   * e-modes cover the pair, and pairs do not share an account+asset.
   * Returns issues (empty = ok).
   */
  async verifyConfig(env: SuiEnv = this.env): Promise<string[]> {
    const issues: string[] = [];
    const core = env.grpc.core;
    const poolsByMarket = new Map<string, NaviPool[]>();
    const storageChecked = new Set<string>();
    const usage = new Map<string, string>();
    for (const cfg of this.pairs.values()) {
      const pid = cfg.pairId;
      let market: NaviMarketConfig;
      try {
        market = this.sdk.getMarketConfig(cfg.market);
      } catch {
        issues.push(`${pid}: unknown Navi market "${cfg.market}"`);
        continue;
      }
      const collType = normType(cfg.collateral.address);
      const debtType = normType(cfg.debt.address);
      if ((collType === debtType) !== (cfg.collateral.symbol === cfg.debt.symbol))
        issues.push(`${pid}: same-asset detection disagrees (coin types ${collType === debtType ? "equal" : "differ"}, symbols ${cfg.collateral.symbol}/${cfg.debt.symbol})`);
      if (collType !== debtType && !this.swapper) issues.push(`${pid}: different assets but no swapper configured`);

      if (!poolsByMarket.has(market.key)) {
        try {
          poolsByMarket.set(market.key, await this.sdk.getPools({ markets: [market.key], disableCache: true }));
        } catch (e) {
          issues.push(`${pid}: cannot fetch Navi pools for market ${market.key}: ${errMsg(e)}`);
          poolsByMarket.set(market.key, []);
        }
      }
      const pools = poolsByMarket.get(market.key)!;
      if (!storageChecked.has(market.key)) {
        storageChecked.add(market.key);
        try {
          const conf = await this.sdk.getConfig({ market: market.key });
          const { object } = await core.getObject({ objectId: conf.storage });
          if (!normType(object.type).endsWith("::storage::Storage")) issues.push(`${market.key}: Navi storage ${conf.storage} has type ${object.type}`);
        } catch (e) {
          issues.push(`${market.key}: Navi storage object check failed: ${errMsg(e)}`);
        }
      }

      const poolOf: Record<string, NaviPool | undefined> = {};
      for (const [role, a, t] of [
        ["collateral", cfg.collateral, collType],
        ["debt", cfg.debt, debtType],
      ] as const) {
        try {
          const meta = await core.getCoinMetadata({ coinType: t });
          if (!meta.coinMetadata) issues.push(`${pid}: ${role} ${a.symbol} coin type ${t} has no on-chain metadata`);
          else if (meta.coinMetadata.decimals !== a.decimals)
            issues.push(`${pid}: ${role} ${a.symbol} decimals ${a.decimals} != on-chain ${meta.coinMetadata.decimals}`);
        } catch (e) {
          issues.push(`${pid}: ${role} ${a.symbol} metadata read failed: ${errMsg(e)}`);
        }
        const pool = pools.find((p) => p.market === market.key && normType(p.suiCoinType ?? p.coinType) === t);
        poolOf[role] = pool;
        if (!pool) {
          issues.push(`${pid}: no Navi pool for ${role} ${a.symbol} (${t}) in market ${market.key}`);
          continue;
        }
        if (pool.token?.decimals !== a.decimals) issues.push(`${pid}: ${role} ${a.symbol} decimals ${a.decimals} != Navi pool ${pool.token?.decimals}`);
        if ((pool.status && pool.status !== "active") || pool.isDeprecated) issues.push(`${pid}: Navi ${a.symbol} pool status ${pool.status ?? "deprecated"}`);
        try {
          const { object } = await core.getObject({ objectId: pool.contract.pool });
          if (!normType(object.type).endsWith(`::pool::Pool<${t}>`)) issues.push(`${pid}: Navi pool object ${pool.contract.pool} type ${object.type} is not Pool<${t}>`);
        } catch (e) {
          issues.push(`${pid}: Navi pool object ${pool.contract.pool} not readable: ${errMsg(e)}`);
        }
      }
      const cp = poolOf.collateral;
      const dp = poolOf.debt;
      let emodeId: number | null = null;
      if (cp && dp) {
        const poolLtv = Number(cp.ltvValue);
        const em = M.chooseEmode(cp.emodes ?? [], cp.id, dp.id, cfg.emode, poolLtv);
        if (typeof cfg.emode === "number" && !em) issues.push(`${pid}: e-mode ${cfg.emode} not active or does not cover ${cfg.collateral.symbol}->${cfg.debt.symbol}`);
        emodeId = em?.emodeId ?? null;
      }
      const acct = emodeId === null ? "address" : `emode:${emodeId}`;
      for (const t of new Set([collType, debtType])) {
        const key = `${market.key}|${acct}|${t}`;
        const prev = usage.get(key);
        if (prev) issues.push(`${pid}: shares Navi account (${acct}) and asset ${t} with ${prev} in market ${market.key}; positions would be conflated`);
        else usage.set(key, pid);
      }
    }
    return issues;
  }
}
