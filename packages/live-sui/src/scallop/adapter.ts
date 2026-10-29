/**
 * Live Scallop (Sui) lending adapter.
 *
 * Loop shape (the only one the protocol allows — see math.ts header):
 *   collateral X sits in an obligation (earns NO supply APR), debt Y is
 *   borrowed from Y's lending pool (pays Y's borrow APR, earns Scallop
 *   borrow-incentive rewards when the obligation is staked), Y is swapped to
 *   X inside the same PTB.
 *
 * Every write is ONE PTB through executePtb (simulate -> gas cap -> dry-run
 * stop -> sign). Leverage uses Scallop's own flash loan on the DEBT asset:
 *   open:       flash Y -> swap Y->X -> deposit (equity + swap) -> xOracle update
 *               -> borrow Y -> repay flash -> stake obligation (borrow incentives)
 *   deleverage/ flash Y -> repay debt -> xOracle update -> withdraw X -> swap
 *   close:      part of X -> Y -> repay flash -> rest of X to wallet -> re-stake
 * The obligation is unstaked first when it is locked by the borrow-incentive
 * program (as the SDK's own BorrowService does around borrow/repay).
 */
import { coinWithBalance, type Transaction, type TransactionObjectArgument, type TransactionResult } from "@mysten/sui/transactions";
import type { LoopPair, RewardRate, SupplyMarket } from "@incentive-router/core";
import {
  BroadcastUnconfirmedError,
  minusBps,
  type AssetRef,
  type LendingAdapter,
  type SupplyAdapter,
  type SupplyPositionView,
  type LiveContext,
  type LiveResult,
  type Logger,
  type LoopPositionView,
  type RewardRateProvider,
  type TxRecord,
} from "@incentive-router/live-common";
import {
  coinBalance,
  executePtb,
  normalizeStructTag,
  normalizeSuiAddress,
  simulateOk,
  type PtbSwapQuote,
  type PtbSwapper,
  type SuiEnv,
} from "../common.js";
import {
  buildScallopLoopPair,
  buildScallopSupplyMarket,
  claimableRewards,
  holdingUnits,
  mintedUnitsLowerBound,
  planSpoolStake,
  planWithdraw,
  spoolIsLive,
  spoolPendingReward,
  underlyingOf,
  measuredBoost,
  ltvOf,
  nextSwapIn,
  openAmounts,
  oracleRate,
  planClose,
  planDeleverage,
  planOpenFlash,
  positionFromAccount,
  summarizeSwapProbe,
  toSafeNumber,
  unitsFromNumber,
  unitsUsd,
  type CollateralLike,
  type IncentivePoolLike,
  type ObligationAccountLike,
  type OpenPlanInput,
  type PoolLike,
  type SpoolLike,
  type StakeAccountLike,
  type SupplyHoldings,
  type SwapProbe,
  type UnwindPlan,
} from "./math.js";
import { createScallopSdk, type ScallopSdkLike, type ScallopSdkOptions } from "./sdk.js";
import { verifyScallopConfig, type ScallopVerifyReport } from "./verify.js";

export interface ScallopPairConfig {
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
  /** Pin this pair to an existing obligation (otherwise discovered by content, or created on open). */
  obligationId?: string;
}

/**
 * Supply-only market = Scallop LENDING: the coin is minted into the pool's
 * MarketCoin (held as sCoin, or staked in the spool). Obligation collateral
 * earns nothing on Scallop, so "supply" never means collateral here.
 */
export interface ScallopSupplyConfig {
  asset: AssetRef;
  /** Default: asset.symbol. */
  marketId?: string;
  /**
   * Stake the MarketCoin in the asset's spool for spool rewards. Only ever
   * done when that spool is live (whitelisted, not deprecated, emitting, not
   * full); default true (= stake whenever it is live). false = hold sCoin.
   */
  stakeInSpool?: boolean;
}

export interface ScallopAdapterOptions {
  env: SuiEnv;
  /** Loop pairs (may be empty when only supply markets are configured). */
  pairs: ScallopPairConfig[];
  /** Plain-lending markets for SupplyAdapter. */
  supply?: ScallopSupplyConfig[];
  /** Required for any write: Scallop cannot loop the same asset, so every loop swaps. */
  swapper?: PtbSwapper;
  extraRewards?: RewardRateProvider;
  /** Obligation to use when exactly one pair is configured (per-pair `obligationId` otherwise). */
  obligationId?: string;
  /**
   * veSCA boost (1..4) for borrow-incentive APRs. Applied ONLY when the
   * obligation is bound to a veSCA key on-chain (getBindedVeScaKey); a
   * measured boost from the obligation's incentive account wins over this.
   * Capped by each reward's on-chain max boost. Default 1 (unboosted).
   */
  veScaBoost?: number;
  /** Injected SDK port (tests). Default: createScallopSdk(env, sdkOptions). */
  sdk?: ScallopSdkLike | (() => Promise<ScallopSdkLike>);
  sdkOptions?: ScallopSdkOptions;
  /** Swap-depth probe for markets(): USD sizes and the cost budget that defines depth. */
  swapProbe?: { sizesUsd?: number[]; maxCostBps?: number };
  /** Full close repays debt * (1 + bps) to cover interest accrued until execution; excess is refunded by repay(). Default 5. */
  closeDebtBufferBps?: number;
  /** Refuse open/deleverage when Scallop's price and ctx.priceUsd differ by more than this. Default 0.02. */
  maxPriceDeviation?: number;
  /**
   * Minimum remaining spool capacity (USD) for staking to be worth it; below
   * it no spool reward is reported and deposits hold sCoin. Default 1000.
   */
  minSpoolRoomUsd?: number;
  /**
   * Also claim spool rewards of stake accounts NOT belonging to a configured
   * supply market (configured supply markets' spools are always claimed).
   * Default false. Deprecated spools are never claimed.
   */
  claimSpoolRewards?: boolean;
  now?: () => number;
  /** Logger for ctx-free reads (markets() skips failing pairs with a warning). Default: console.warn. */
  log?: Logger;
}

interface ResolvedPair {
  cfg: ScallopPairConfig;
  collType: string;
  debtType: string;
  collName: string;
  debtName: string;
}

interface ResolvedSupply {
  cfg: ScallopSupplyConfig;
  marketId: string;
  coinType: string;
  coinName: string;
  sCoinName?: string;
  sCoinType?: string;
  marketCoinType: string;
  /** Spool / stake market coin name (= market coin name, e.g. "susdc"). */
  spoolName: string;
}

interface SupplyState {
  pool: PoolLike & { conversionRate: number };
  spool?: SpoolLike;
  spoolDeprecated: boolean;
  /** Spool live AND staking enabled AND at least minSpoolRoomUsd of spool capacity left. */
  staking: boolean;
  /** Remaining spool capacity, market-coin units / USD (0 when no spool). */
  roomUnits: bigint;
  roomUsd: number;
  myStakedUsd: number;
  /** USD staked in the spool by everyone (spool reward dilution basis). */
  spoolStakedUsd: number;
  /** Underlying-USD of my sCoin / MarketCoin held in the wallet (not staked). */
  myUnstakedUsd: number;
  holdings: SupplyHoldings;
  accounts: StakeAccountLike[];
  paused: boolean;
}

interface ObligationRef {
  id: string;
  keyId: string;
  locked: boolean;
}

interface Snapshot {
  pool: PoolLike;
  coll: CollateralLike;
  flashFeeFrac?: number;
  maxLtv: number;
  liqLtv: number;
}

interface Holdings {
  collateral: bigint;
  debt: bigint;
  /** Every coin type the obligation references (xOracle must be refreshed for all of them). */
  coinNames: string[];
  acct: ObligationAccountLike;
}

type Built =
  | { kind: "noop"; detail: string }
  | { kind: "refuse"; detail: string }
  | { kind: "tx"; tx: Transaction; description: string; amountUsd?: number };

const DEFAULT_PROBE_SIZES = [1_000, 10_000, 100_000];
const DEFAULT_PROBE_MAX_BPS = 30;
const LTV_EPS = 1e-4;

const defaultLog: Logger = (level, msg, data) => console.warn(`[${level}] ${msg}`, ...(data ? [data] : []));

const normType = (t: string) => normalizeStructTag(t.startsWith("0x") ? t : `0x${t}`);

export class ScallopAdapter implements LendingAdapter, SupplyAdapter {
  readonly id = "scallop";
  readonly chain = "sui";

  private readonly env: SuiEnv;
  private readonly pairs = new Map<string, ScallopPairConfig>();
  private readonly supplyCfg = new Map<string, ScallopSupplyConfig>();
  private sdkP?: Promise<ScallopSdkLike>;
  private resolved?: Promise<Map<string, ResolvedPair>>;
  private resolvedSupply?: Promise<Map<string, ResolvedSupply>>;
  private obligationCache = new Map<string, ObligationRef | null>();

  constructor(private readonly opts: ScallopAdapterOptions) {
    this.env = opts.env;
    if (!opts.pairs.length && !opts.supply?.length) throw new Error("scallop: no pairs or supply markets configured");
    if (opts.pairs.length && opts.supply?.length) {
      throw new Error("scallop: configure loop pairs and supply markets in separate adapter instances (one role per venue entry)");
    }
    for (const m of opts.supply ?? []) {
      const id = m.marketId ?? m.asset.symbol;
      if (this.supplyCfg.has(id)) throw new Error(`scallop: duplicate supply marketId ${id}`);
      if (m.asset.chain !== "sui") throw new Error(`scallop supply ${id}: asset must be on sui`);
      this.supplyCfg.set(id, m);
    }
    const shapes = new Set<string>();
    for (const p of opts.pairs) {
      if (this.pairs.has(p.pairId)) throw new Error(`scallop: duplicate pairId ${p.pairId}`);
      if (p.collateral.chain !== "sui" || p.debt.chain !== "sui") throw new Error(`scallop ${p.pairId}: assets must be on sui`);
      const c = normType(p.collateral.address);
      const d = normType(p.debt.address);
      if (c === d) {
        throw new Error(
          `scallop ${p.pairId}: same-asset loops are impossible on Scallop (deposit_collateral aborts when the coin is already debt, borrow aborts when it is collateral)`
        );
      }
      const shape = `${c}|${d}`;
      if (shapes.has(shape) && !p.obligationId) throw new Error(`scallop ${p.pairId}: two pairs with the same assets need explicit obligationIds`);
      shapes.add(shape);
      this.pairs.set(p.pairId, p);
    }
    if (opts.obligationId && opts.pairs.length > 1) {
      throw new Error("scallop: top-level obligationId is only allowed with one pair; set ScallopPairConfig.obligationId per pair");
    }
    const b = opts.veScaBoost ?? 1;
    if (!(b >= 1 && b <= 4)) throw new Error(`scallop: veScaBoost ${b} out of [1,4]`);
  }

  // -------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private sdk(): Promise<ScallopSdkLike> {
    if (!this.sdkP) {
      const s = this.opts.sdk;
      this.sdkP = (typeof s === "function" ? s() : s ? Promise.resolve(s) : createScallopSdk(this.env, this.opts.sdkOptions)).catch((e) => {
        this.sdkP = undefined;
        throw e;
      });
    }
    return this.sdkP;
  }

  private resolvePairs(): Promise<Map<string, ResolvedPair>> {
    if (!this.resolved) {
      this.resolved = (async () => {
        const sdk = await this.sdk();
        const out = new Map<string, ResolvedPair>();
        for (const cfg of this.pairs.values()) {
          const collType = normType(cfg.collateral.address);
          const debtType = normType(cfg.debt.address);
          const collName = sdk.utils.parseCoinNameFromType(collType);
          const debtName = sdk.utils.parseCoinNameFromType(debtType);
          for (const [name, type, a] of [[collName, collType, cfg.collateral], [debtName, debtType, cfg.debt]] as const) {
            const known = sdk.constants.coinTypes[name];
            if (!known || normType(known) !== type) throw new Error(`scallop ${cfg.pairId}: ${a.symbol} (${type}) is not a Scallop asset`);
            const dec = sdk.constants.coinDecimals[name];
            if (dec !== undefined && dec !== a.decimals) throw new Error(`scallop ${cfg.pairId}: ${a.symbol} decimals ${a.decimals} != Scallop ${dec}`);
          }
          if (!sdk.constants.whitelist.collateral.has(collName)) throw new Error(`scallop ${cfg.pairId}: ${collName} is not a Scallop collateral`);
          if (!sdk.constants.whitelist.borrowing.has(debtName)) throw new Error(`scallop ${cfg.pairId}: ${debtName} is not borrowable on Scallop`);
          out.set(cfg.pairId, { cfg, collType, debtType, collName, debtName });
        }
        return out;
      })().catch((e) => {
        this.resolved = undefined;
        throw e;
      });
    }
    return this.resolved;
  }

  private async pair(pairId: string): Promise<ResolvedPair> {
    const p = (await this.resolvePairs()).get(pairId);
    if (!p) throw new Error(`scallop: unknown pair ${pairId}`);
    return p;
  }

  private resolveSupply(): Promise<Map<string, ResolvedSupply>> {
    if (!this.resolvedSupply) {
      this.resolvedSupply = (async () => {
        const sdk = await this.sdk();
        const out = new Map<string, ResolvedSupply>();
        for (const [marketId, cfg] of this.supplyCfg) {
          const coinType = normType(cfg.asset.address);
          const coinName = sdk.utils.parseCoinNameFromType(coinType);
          const known = sdk.constants.coinTypes[coinName];
          if (!known || normType(known) !== coinType) throw new Error(`scallop supply ${marketId}: ${cfg.asset.symbol} (${coinType}) is not a Scallop asset`);
          const dec = sdk.constants.coinDecimals[coinName];
          if (dec !== undefined && dec !== cfg.asset.decimals) throw new Error(`scallop supply ${marketId}: decimals ${cfg.asset.decimals} != Scallop ${dec}`);
          if (!sdk.constants.whitelist.lending.has(coinName)) throw new Error(`scallop supply ${marketId}: ${coinName} has no Scallop lending pool`);
          const sCoinName = sdk.utils.parseSCoinName<string>(coinName);
          const r: ResolvedSupply = {
            cfg,
            marketId,
            coinType,
            coinName,
            marketCoinType: normType(sdk.utils.parseMarketCoinType(coinName)),
            spoolName: sdk.utils.parseMarketCoinName<string>(coinName),
          };
          if (sCoinName) {
            r.sCoinName = sCoinName;
            r.sCoinType = normType(sdk.utils.parseSCoinType(sCoinName));
          }
          out.set(marketId, r);
        }
        return out;
      })().catch((e) => {
        this.resolvedSupply = undefined;
        throw e;
      });
    }
    return this.resolvedSupply;
  }

  private async supplyMarket(marketId: string): Promise<ResolvedSupply> {
    const m = (await this.resolveSupply()).get(marketId);
    if (!m) throw new Error(`scallop: unknown supply market ${marketId}`);
    return m;
  }

  /** The obligation backing a pair: pinned, else the owned one holding only this pair's assets. null = none yet. */
  private async obligationFor(p: ResolvedPair, opts: { allowEmpty?: boolean } = {}): Promise<ObligationRef | null> {
    const cacheKey = `${p.cfg.pairId}|${opts.allowEmpty ? 1 : 0}`;
    if (this.obligationCache.has(cacheKey)) return this.obligationCache.get(cacheKey)!;
    const sdk = await this.sdk();
    const owned = await sdk.query.getObligations(this.env.address);
    const pinned = p.cfg.obligationId ?? (this.pairs.size === 1 ? this.opts.obligationId : undefined);
    let found: ObligationRef | null = null;
    if (pinned) {
      const o = owned.find((x) => normalizeSuiAddress(x.id) === normalizeSuiAddress(pinned));
      if (!o) throw new Error(`scallop ${p.cfg.pairId}: obligation ${pinned} is not owned by ${this.env.address} (no ObligationKey)`);
      found = { id: o.id, keyId: o.keyId, locked: o.locked };
    } else {
      let empty: ObligationRef | null = null;
      for (const o of owned) {
        const data = await sdk.query.queryObligation(o.id);
        if (!data) continue;
        const colls = data.collaterals.filter((c) => BigInt(c.amount) > 0n).map((c) => normType(c.type));
        const debts = data.debts.filter((d) => BigInt(d.amount) > 0n).map((d) => normType(d.type));
        if (!colls.length && !debts.length) {
          if (!empty) empty = { id: o.id, keyId: o.keyId, locked: o.locked };
          continue;
        }
        if (colls.every((t) => t === p.collType) && debts.every((t) => t === p.debtType)) {
          found = { id: o.id, keyId: o.keyId, locked: o.locked };
          break;
        }
      }
      if (!found && opts.allowEmpty) found = empty;
    }
    this.obligationCache.set(cacheKey, found);
    return found;
  }

  private invalidate(): void {
    this.obligationCache.clear();
  }

  /** Market state per pair; a pair whose market data is unusable maps to an Error (batched SDK failures throw). */
  private async snapshots(pairs: ResolvedPair[]): Promise<{ snaps: Map<string, Snapshot | Error>; incentives: Partial<Record<string, IncentivePoolLike>> }> {
    const sdk = await this.sdk();
    const names = [...new Set(pairs.flatMap((p) => [p.collName, p.debtName]))];
    const debtNames = [...new Set(pairs.map((p) => p.debtName))];
    const [{ pools, collaterals }, fees, incentives] = await Promise.all([
      sdk.query.getMarketPools(names),
      sdk.query.getFlashLoanFees(debtNames),
      sdk.query.getBorrowIncentivePools(debtNames),
    ]);
    const snaps = new Map<string, Snapshot | Error>();
    for (const p of pairs) {
      const pool = pools[p.debtName];
      const coll = collaterals[p.collName];
      if (!pool) {
        snaps.set(p.cfg.pairId, new Error(`scallop ${p.cfg.pairId}: no lending pool for ${p.debtName}`));
        continue;
      }
      if (!coll) {
        snaps.set(p.cfg.pairId, new Error(`scallop ${p.cfg.pairId}: ${p.collName} has no collateral risk model`));
        continue;
      }
      const bw = pool.borrowWeight > 0 ? pool.borrowWeight : 1;
      snaps.set(p.cfg.pairId, {
        pool,
        coll,
        flashFeeFrac: fees[p.debtName],
        maxLtv: coll.collateralFactor / bw,
        liqLtv: coll.liquidationFactor / bw,
      });
    }
    return { snaps, incentives };
  }

  private async snapshot(p: ResolvedPair): Promise<Snapshot> {
    const s = (await this.snapshots([p])).snaps.get(p.cfg.pairId)!;
    if (s instanceof Error) throw s;
    return s;
  }

  private async holdings(ob: ObligationRef, p: ResolvedPair): Promise<Holdings> {
    const sdk = await this.sdk();
    const [acct, raw] = await Promise.all([sdk.query.getObligationAccountById(ob.id), sdk.query.queryObligation(ob.id)]);
    const coinNames = new Set<string>([p.collName, p.debtName]);
    for (const c of raw?.collaterals ?? []) coinNames.add(sdk.utils.parseCoinNameFromType(normType(c.type)));
    for (const d of raw?.debts ?? []) coinNames.add(sdk.utils.parseCoinNameFromType(normType(d.type)));
    const rawColl = raw?.collaterals.find((c) => normType(c.type) === p.collType);
    return {
      // collateral never accrues: take the exact on-chain amount
      collateral: rawColl ? BigInt(rawColl.amount) : unitsFromNumber(acct.collaterals[p.collName]?.depositedAmount ?? 0),
      // debt accrues per second: SDK value is index-adjusted to "now", round up
      debt: unitsFromNumber(acct.debts[p.debtName]?.borrowedAmount ?? 0, "ceil"),
      coinNames: [...coinNames],
      acct,
    };
  }

  /** No swapper = known inability to swap (depth 0); failed quotes = unknown (NaN, see summarizeSwapProbe). */
  private async swapProbe(p: ResolvedPair, snap: Snapshot): Promise<SwapProbe> {
    const sw = this.opts.swapper;
    if (!sw) return { costFrac: 1, depthUsd: 0 };
    const sizes = this.opts.swapProbe?.sizesUsd ?? DEFAULT_PROBE_SIZES;
    const maxBps = this.opts.swapProbe?.maxCostBps ?? DEFAULT_PROBE_MAX_BPS;
    const results = await Promise.all(
      sizes.map(async (sizeUsd) => {
        try {
          const inDebt = BigInt(Math.floor((sizeUsd / snap.pool.coinPrice) * 10 ** p.cfg.debt.decimals));
          const inColl = BigInt(Math.floor((sizeUsd / snap.coll.coinPrice) * 10 ** p.cfg.collateral.decimals));
          const [a, b] = await Promise.all([sw.quote(p.debtType, p.collType, inDebt), sw.quote(p.collType, p.debtType, inColl)]);
          const costs = [a.costBps, b.costBps];
          return { sizeUsd, costBps: costs.every(Number.isFinite) ? Math.max(...costs) : null };
        } catch {
          return { sizeUsd, costBps: null };
        }
      })
    );
    return summarizeSwapProbe(results, maxBps);
  }

  private async extra(asset: AssetRef, side: "borrow" | "collateral"): Promise<RewardRate[]> {
    if (!this.opts.extraRewards) return [];
    return this.opts.extraRewards({ protocol: "scallop", chain: "sui", asset, side });
  }

  /** veSCA boost to apply to a pair's borrow incentives. */
  private async boostFor(ob: ObligationRef | null, acct: ObligationAccountLike | undefined, debtName: string): Promise<number> {
    if (!ob) return 1;
    const sdk = await this.sdk();
    const bound = await sdk.query.getBindedVeScaKey(ob.id);
    if (!bound) return 1;
    const measured = acct ? measuredBoost(acct, debtName) : undefined;
    return measured !== undefined ? Math.max(1, measured) : this.opts.veScaBoost ?? 1;
  }

  private async checkPriceDeviation(p: ResolvedPair, snap: Snapshot, ctx: LiveContext): Promise<string | null> {
    const tol = this.opts.maxPriceDeviation ?? 0.02;
    const [c, d] = await Promise.all([ctx.priceUsd(p.cfg.collateral), ctx.priceUsd(p.cfg.debt)]);
    const dev = (a: number, b: number) => (a > 0 && b > 0 ? Math.abs(a / b - 1) : Infinity);
    const dc = dev(snap.coll.coinPrice, c);
    const dd = dev(snap.pool.coinPrice, d);
    if (dc > tol || dd > tol) {
      return `price deviation vs ctx: ${p.cfg.collateral.symbol} ${(dc * 100).toFixed(2)}%, ${p.cfg.debt.symbol} ${(dd * 100).toFixed(2)}% > ${(tol * 100).toFixed(2)}%`;
    }
    return null;
  }

  private prices(p: ResolvedPair, snap: Snapshot) {
    return {
      collPriceUsd: snap.coll.coinPrice,
      debtPriceUsd: snap.pool.coinPrice,
      collDecimals: p.cfg.collateral.decimals,
      debtDecimals: p.cfg.debt.decimals,
    };
  }

  /** Quote `from -> to` so that the slippage-protected output covers `needOut`. */
  private async quoteForOut(from: string, to: string, needOut: bigint, firstIn: bigint, slipBps: number): Promise<{ q: PtbSwapQuote; minOut: bigint }> {
    const sw = this.opts.swapper!;
    let amountIn = firstIn;
    for (let k = 0; k < 4; k++) {
      const q = await sw.quote(from, to, amountIn);
      const minOut = minusBps(q.amountOut, slipBps);
      if (minOut >= needOut) return { q, minOut };
      amountIn = nextSwapIn(needOut, q.amountIn, minOut);
    }
    throw new Error(`scallop: swap ${from} -> ${to} cannot deliver ${needOut} within ${slipBps} bps`);
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  async markets(): Promise<LoopPair[]> {
    const resolved = [...(await this.resolvePairs()).values()];
    if (!resolved.length) return [];
    const nowMs = this.now();
    const sdk = await this.sdk();
    const { snaps, incentives } = await this.snapshots(resolved);
    const exclude = new Set<string>([...sdk.constants.whitelist.rewardsAsPoint, ...sdk.constants.whitelist.deprecated]);
    const results = await Promise.allSettled(
      resolved.map(async (p) => {
        const snap = snaps.get(p.cfg.pairId)!;
        if (snap instanceof Error) throw snap;
        const ob = await this.obligationFor(p);
        let acct: ObligationAccountLike | undefined;
        let myLtv: number | undefined;
        if (ob) {
          acct = await sdk.query.getObligationAccountById(ob.id);
          myLtv = positionFromAccount(acct, p.cfg.pairId, p.collName, p.debtName, nowMs)?.ltv;
        }
        const [swap, boost, extraColl, extraBorrow] = await Promise.all([
          this.swapProbe(p, snap),
          this.boostFor(ob, acct, p.debtName),
          this.extra(p.cfg.collateral, "collateral"),
          this.extra(p.cfg.debt, "borrow"),
        ]);
        return buildScallopLoopPair({
          pairId: p.cfg.pairId,
          collateral: p.cfg.collateral,
          debt: p.cfg.debt,
          collateralMarket: snap.coll,
          debtPool: snap.pool,
          incentive: incentives[p.debtName],
          flashFeeFrac: snap.flashFeeFrac,
          swap,
          boost,
          rewardExclude: exclude,
          extra: { collateral: extraColl, borrow: extraBorrow },
          myLtv,
          nowMs,
        });
      })
    );
    // One broken pair must not hide the others; but if nothing is readable, fail loudly.
    const out: LoopPair[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") out.push(r.value);
      else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(`${resolved[i]!.cfg.pairId}: ${msg}`);
        (this.opts.log ?? defaultLog)("warn", `scallop: markets() skipping pair ${resolved[i]!.cfg.pairId}: ${msg}`);
      }
    });
    if (!out.length) throw new Error(`scallop: markets() failed for every pair: ${errors.join("; ")}`);
    return out;
  }

  async position(pairId: string): Promise<LoopPositionView | null> {
    const p = await this.pair(pairId);
    const ob = await this.obligationFor(p);
    if (!ob) return null;
    const sdk = await this.sdk();
    const acct = await sdk.query.getObligationAccountById(ob.id);
    return positionFromAccount(acct, pairId, p.collName, p.debtName, this.now());
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return coinBalance(this.env, asset.address);
  }

  async verifyConfig(env: SuiEnv = this.env): Promise<ScallopVerifyReport> {
    const sdk = await this.sdk();
    return verifyScallopConfig(env, sdk, [...this.pairs.values()], {
      supply: [...this.supplyCfg].map(([marketId, c]) => ({ marketId, asset: c.asset })),
      obligationIds: Object.fromEntries(
        [...this.pairs.values()].map((p) => [p.pairId, p.obligationId ?? (this.pairs.size === 1 ? this.opts.obligationId : undefined)])
      ),
    });
  }

  // -------------------------------------------------------------------------
  // writes
  // -------------------------------------------------------------------------

  private async run(ctx: LiveContext, label: string, build: () => Promise<Built>): Promise<LiveResult> {
    try {
      const b = await build();
      if (b.kind === "noop") return { ok: true, txs: [], detail: b.detail };
      if (b.kind === "refuse") {
        ctx.log("warn", `scallop: refused ${label}: ${b.detail}`);
        return { ok: false, txs: [], detail: b.detail };
      }
      const rec = await executePtb(this.env, ctx, b.tx, b.description);
      if (!ctx.dryRun) this.invalidate();
      const res: LiveResult = { ok: true, txs: [rec], detail: rec.unconfirmed ? `executed (${rec.id}), checkpoint not yet observed: ${b.description}` : b.description };
      if (b.amountUsd !== undefined) res.amountUsd = b.amountUsd;
      return res;
    } catch (e) {
      if (e instanceof BroadcastUnconfirmedError) return this.unconfirmed(ctx, label, e);
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log("error", `scallop: ${label} failed: ${msg}`);
      return { ok: false, txs: [], detail: msg };
    }
  }

  /**
   * Signed and handed to the network, fate unknown: it MAY HAVE LANDED. Report
   * the digest as an unconfirmed record (never "nothing happened") and drop
   * cached state so the next read re-reads the chain.
   */
  private unconfirmed(ctx: LiveContext, label: string, e: BroadcastUnconfirmedError): LiveResult {
    this.invalidate();
    ctx.log("warn", `scallop: ${label} UNCONFIRMED, may have landed: ${e.id}`, { error: e.message });
    return {
      ok: false,
      txs: [{ chain: e.chain, id: e.id, description: e.description, simulated: false, unconfirmed: true }],
      detail: `UNCONFIRMED: may have landed as ${e.id}; re-read state before retrying (${e.message})`,
    };
  }

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    return this.run(ctx, `open ${pairId}`, () => this.buildOpen(pairId, equity, targetLtv, ctx));
  }

  private async buildOpen(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<Built> {
    const p = await this.pair(pairId);
    if (equity <= 0n) return { kind: "refuse", detail: "equity must be > 0" };
    const swapper = this.opts.swapper;
    if (!swapper) return { kind: "refuse", detail: "no swapper: Scallop loops are always two-asset" };
    const snap = await this.snapshot(p);
    if (!(targetLtv > 0) || targetLtv >= snap.maxLtv) {
      return { kind: "refuse", detail: `target LTV ${targetLtv} not in (0, maxLtv ${snap.maxLtv.toFixed(4)})` };
    }
    if (snap.flashFeeFrac === undefined) return { kind: "refuse", detail: `no flash-loan fee entry for ${p.debtName} (flash loan unavailable)` };
    const dev = await this.checkPriceDeviation(p, snap, ctx);
    if (dev) return { kind: "refuse", detail: dev };
    const bal = await this.walletBalance(p.cfg.collateral);
    if (bal < equity) return { kind: "refuse", detail: `wallet ${p.cfg.collateral.symbol} ${bal} < equity ${equity}` };

    const ob = await this.obligationFor(p, { allowEmpty: true });
    const h = ob ? await this.holdings(ob, p) : null;
    const prices = this.prices(p, snap);
    const slip = ctx.limits.maxSlippageBps;
    const base: Omit<OpenPlanInput, "swapRateMin"> = {
      ...prices,
      equity,
      collateralNow: h?.collateral ?? 0n,
      debtNow: h?.debt ?? 0n,
      targetLtv,
      borrowFeeFrac: snap.pool.borrowFee,
      flashFeeFrac: snap.flashFeeFrac,
    };
    // Converge the flash amount on the quoted (slippage-protected) swap rate.
    let rate = oracleRate(snap.pool.coinPrice, p.cfg.debt.decimals, snap.coll.coinPrice, p.cfg.collateral.decimals) * (1 - slip / 10_000 - 0.003);
    let F = planOpenFlash({ ...base, swapRateMin: rate });
    let q: PtbSwapQuote | undefined;
    let minOut = 0n;
    for (let k = 0; F > 0n && k < 4; k++) {
      q = await swapper.quote(p.debtType, p.collType, F);
      minOut = minusBps(q.amountOut, slip);
      rate = Number(minOut) / Number(q.amountIn);
      const next = planOpenFlash({ ...base, swapRateMin: rate });
      const diff = next > F ? next - F : F - next;
      if (diff * 500n <= F || k === 3) break; // within 0.2%: keep the quote we have (its amountIn === F)
      F = next;
    }
    if (F > 0n && (!q || q.amountIn !== F)) return { kind: "refuse", detail: "swap quote did not converge" };
    const a = openAmounts({ ...base, swapRateMin: rate }, F, minOut);
    if (a.ltvAfterWorst > snap.maxLtv - LTV_EPS) {
      return { kind: "refuse", detail: `post-trade LTV ${a.ltvAfterWorst.toFixed(4)} would exceed maxLtv ${snap.maxLtv.toFixed(4)}` };
    }
    const pool = snap.pool;
    const debtCash = unitsFromNumber(Math.max(0, pool.supplyAmount - pool.borrowAmount));
    if (F > 0n) {
      if (a.borrowAmount <= unitsFromNumber(pool.minBorrowAmount)) return { kind: "refuse", detail: `borrow ${a.borrowAmount} <= min borrow ${pool.minBorrowAmount}` };
      if (debtCash < F + a.borrowAmount) return { kind: "refuse", detail: `${p.debtName} pool cash ${debtCash} < flash ${F} + borrow ${a.borrowAmount}` };
      const borrowRoom = unitsFromNumber(Math.max(0, (pool.maxBorrowCoin - pool.borrowCoin) * 10 ** p.cfg.debt.decimals));
      if (a.borrowAmount > borrowRoom) return { kind: "refuse", detail: `borrow ${a.borrowAmount} exceeds ${p.debtName} borrow-limit headroom ${borrowRoom}` };
    }
    const collRoom = unitsFromNumber(Math.max(0, (snap.coll.maxDepositCoin - snap.coll.depositCoin) * 10 ** p.cfg.collateral.decimals));
    if (equity + (F > 0n ? minOut : 0n) > collRoom) return { kind: "refuse", detail: `collateral cap headroom ${collRoom} too small` };

    // --- build the PTB
    const sdk = await this.sdk();
    const { tx, stx } = sdk.createPtb();
    tx.setSender(this.env.address);
    let obArg: string | TransactionObjectArgument;
    let keyArg: string | TransactionObjectArgument;
    let hotPotato: TransactionObjectArgument | undefined;
    if (ob) {
      obArg = ob.id;
      keyArg = ob.keyId;
      if (ob.locked) await stx.unstakeObligationQuick(ob.id, ob.keyId);
    } else {
      const [o, k, hp] = stx.openObligation();
      obArg = o;
      keyArg = k;
      hotPotato = hp;
    }
    const equityCoin = tx.add(coinWithBalance({ type: p.collType, balance: equity }));
    if (F > 0n) {
      const [flashCoin, loan] = stx.borrowFlashLoan(tx.pure.u64(F), p.debtName) as TransactionResult;
      const out = await swapper.appendSwap(tx, { fromType: p.debtType, toType: p.collType, coinIn: flashCoin!, quote: q!, minOut });
      tx.mergeCoins(out, [equityCoin]);
      stx.depositCollateral(obArg, out, p.collName);
      await stx.updateAssetPricesQuick(h?.coinNames ?? [p.collName, p.debtName]);
      const borrowed = stx.borrow(obArg, keyArg, toSafeNumber(a.borrowAmount, "borrow amount"), p.debtName);
      stx.repayFlashLoan(borrowed, loan!, p.debtName);
    } else {
      stx.depositCollateral(obArg, equityCoin, p.collName);
    }
    if (ob) {
      if (a.debtAfter > 0n) await stx.stakeObligationWithVeScaQuick(ob.id, ob.keyId);
    } else {
      if (a.debtAfter > 0n) stx.stakeObligation(obArg, keyArg);
      stx.returnObligation(obArg, hotPotato!);
      tx.transferObjects([keyArg as TransactionObjectArgument], this.env.address);
    }
    const equityUsd = unitsUsd(equity, snap.coll.coinPrice, p.cfg.collateral.decimals);
    return {
      kind: "tx",
      tx,
      amountUsd: equityUsd,
      description:
        `scallop open ${pairId}: +${equity} ${p.collName}` +
        (F > 0n ? `, flash ${F} ${p.debtName} -> >=${minOut} ${p.collName}, borrow ${a.borrowAmount}` : ", deposit only") +
        ` (LTV<=${a.ltvAfterWorst.toFixed(4)})` +
        (ob ? "" : " [new obligation]"),
    };
  }

  async close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    return this.run(ctx, `close ${pairId}`, () => this.buildUnwind(pairId, { fraction }, ctx));
  }

  async deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    return this.run(ctx, `deleverage ${pairId}`, () => this.buildUnwind(pairId, { targetLtv }, ctx));
  }

  async simulateClose(pairId: string, ctx: LiveContext): Promise<boolean> {
    try {
      const b = await this.buildUnwind(pairId, { fraction: 1 }, ctx);
      if (b.kind === "noop") return true;
      if (b.kind === "refuse") {
        ctx.log("warn", `scallop: simulateClose ${pairId} refused: ${b.detail}`);
        return false;
      }
      return await simulateOk(this.env, b.tx);
    } catch (e) {
      ctx.log("warn", `scallop: simulateClose ${pairId} failed to build: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  private async buildUnwind(pairId: string, mode: { fraction: number } | { targetLtv: number }, ctx: LiveContext): Promise<Built> {
    const p = await this.pair(pairId);
    if ("fraction" in mode && !(mode.fraction > 0 && mode.fraction <= 1)) return { kind: "refuse", detail: `fraction ${mode.fraction} out of (0,1]` };
    const ob = await this.obligationFor(p);
    if (!ob) return { kind: "noop", detail: "no position" };
    const h = await this.holdings(ob, p);
    if (h.collateral === 0n && h.debt === 0n) return { kind: "noop", detail: "no position" };
    const snap = await this.snapshot(p);
    const prices = this.prices(p, snap);
    const slip = ctx.limits.maxSlippageBps;
    const ff = snap.flashFeeFrac;
    if (h.debt > 0n) {
      if (!this.opts.swapper) return { kind: "refuse", detail: "no swapper configured" };
      if (ff === undefined) return { kind: "refuse", detail: `no flash-loan fee entry for ${p.debtName} (flash loan unavailable)` };
    }
    const isDelev = "targetLtv" in mode;
    if (isDelev) {
      if (!(mode.targetLtv >= 0 && mode.targetLtv < snap.maxLtv)) return { kind: "refuse", detail: `target LTV ${mode.targetLtv} not in [0, maxLtv)` };
      const now = positionFromAccount(h.acct, pairId, p.collName, p.debtName, this.now());
      if (!now || now.ltv <= mode.targetLtv) return { kind: "noop", detail: `LTV ${now?.ltv.toFixed(4) ?? "0"} already <= ${mode.targetLtv}` };
      const dev = await this.checkPriceDeviation(p, snap, ctx);
      if (dev) return { kind: "refuse", detail: dev };
    } else {
      const dev = await this.checkPriceDeviation(p, snap, ctx);
      if (dev) ctx.log("warn", `scallop: close ${pairId} proceeding despite ${dev}`); // exits must stay possible
    }

    const planFor = (rate: number): UnwindPlan => {
      const common = { ...prices, collateralNow: h.collateral, debtNow: h.debt, flashFeeFrac: ff ?? 0, swapRateMin: rate };
      return isDelev
        ? planDeleverage({ ...common, targetLtv: mode.targetLtv })
        : planClose({ ...common, fraction: mode.fraction, maxLtv: snap.maxLtv, debtBufferBps: this.opts.closeDebtBufferBps ?? 5 });
    };
    let plan: UnwindPlan;
    let q: PtbSwapQuote | undefined;
    let minOut = 0n;
    if (h.debt > 0n) {
      // 1) plan on the oracle rate, 2) quote, 3) re-plan on the quoted
      // (slippage-protected) rate, 4) make sure the quote we execute covers the
      // flash repayment. The executed swap input is always the quote's amountIn.
      const rate0 = oracleRate(snap.coll.coinPrice, p.cfg.collateral.decimals, snap.pool.coinPrice, p.cfg.debt.decimals) * (1 - slip / 10_000 - 0.003);
      const est = planFor(rate0);
      let r = await this.quoteForOut(p.collType, p.debtType, est.minSwapOut, est.swapIn, slip);
      plan = planFor(Number(r.minOut) / Number(r.q.amountIn));
      if (r.minOut < plan.minSwapOut) r = await this.quoteForOut(p.collType, p.debtType, plan.minSwapOut, plan.swapIn, slip);
      q = r.q;
      minOut = r.minOut;
      const swapIn = q.amountIn;
      if (isDelev) {
        // deleverage withdraws exactly what it swaps
        if (swapIn > h.collateral) return { kind: "refuse", detail: "collateral cannot cover the swap needed to repay the debt" };
        const collateralAfter = h.collateral - swapIn;
        plan = { ...plan, withdrawAmount: swapIn, swapIn, collateralToWallet: 0n, collateralAfter, ltvAfterWorst: ltvOf(collateralAfter, plan.debtAfter, prices) };
      } else {
        if (swapIn > plan.withdrawAmount) return { kind: "refuse", detail: `withdrawable collateral ${plan.withdrawAmount} < swap input ${swapIn} needed to repay the debt` };
        plan = { ...plan, swapIn, collateralToWallet: plan.withdrawAmount - swapIn };
      }
    } else {
      plan = planFor(1);
    }
    // The flash loan is drawn from the debt pool's cash (collateral itself is
    // segregated and always withdrawable). TODO: flash-free iterative unwind
    // fallback for when the debt pool is fully utilized.
    const cash = unitsFromNumber(Math.max(0, snap.pool.supplyAmount - snap.pool.borrowAmount));
    if (plan.repayAmount > cash) {
      return { kind: "refuse", detail: `${p.debtName} pool cash ${cash} < flash loan ${plan.repayAmount} needed to unwind` };
    }

    // --- build the PTB
    const sdk = await this.sdk();
    const { tx, stx } = sdk.createPtb();
    tx.setSender(this.env.address);
    if (ob.locked) await stx.unstakeObligationQuick(ob.id, ob.keyId);
    let loan: TransactionObjectArgument | undefined;
    if (plan.repayAmount > 0n) {
      const [flashCoin, l] = stx.borrowFlashLoan(tx.pure.u64(plan.repayAmount), p.debtName) as TransactionResult;
      loan = l;
      stx.repay(ob.id, flashCoin!, p.debtName); // repays min(debt, coin), refunds the rest to the sender
    }
    if (plan.withdrawAmount > 0n) {
      await stx.updateAssetPricesQuick(h.coinNames);
      const collCoin = stx.takeCollateral(ob.id, ob.keyId, toSafeNumber(plan.withdrawAmount, "withdraw amount"), p.collName);
      if (plan.repayAmount > 0n) {
        const swapInCoin = plan.swapIn === plan.withdrawAmount ? collCoin : tx.splitCoins(collCoin, [tx.pure.u64(plan.swapIn)])[0]!;
        const out = await this.opts.swapper!.appendSwap(tx, { fromType: p.collType, toType: p.debtType, coinIn: swapInCoin, quote: q!, minOut });
        stx.repayFlashLoan(out, loan!, p.debtName); // overpayment is refunded to the sender by the protocol
      }
      if (plan.withdrawAmount > plan.swapIn || plan.repayAmount === 0n) tx.transferObjects([collCoin], this.env.address);
    }
    if (plan.debtAfter > 0n) await stx.stakeObligationWithVeScaQuick(ob.id, ob.keyId);

    const what = isDelev ? `deleverage to ${mode.targetLtv}` : `close ${(mode.fraction * 100).toFixed(1)}%`;
    return {
      kind: "tx",
      tx,
      amountUsd: unitsUsd(plan.collateralToWallet, snap.coll.coinPrice, p.cfg.collateral.decimals),
      description:
        `scallop ${what} ${pairId}: repay ${plan.repayAmount} ${p.debtName}, withdraw ${plan.withdrawAmount} ${p.collName}` +
        (plan.swapIn > 0n ? ` (swap ${plan.swapIn} -> >=${minOut})` : "") +
        `, LTV after <= ${plan.ltvAfterWorst.toFixed(4)}`,
    };
  }

  /**
   * Claim everything claimable, in ONE PTB: borrow incentives of the loop
   * obligations and spool rewards of the configured supply markets (plus all
   * other non-deprecated spool stake accounts when `claimSpoolRewards`).
   * `id` = a pairId or a supply marketId to restrict the claim.
   */
  async claimRewards(ctx: LiveContext, id?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }> {
    const claimed: { token: string; amount: bigint; decimals: number }[] = [];
    try {
      const sdk = await this.sdk();
      const allPairs = await this.resolvePairs();
      const allSupply = await this.resolveSupply();
      if (id !== undefined && !allPairs.has(id) && !allSupply.has(id)) throw new Error(`scallop: unknown pair / supply market ${id}`);
      const pairs = id === undefined ? [...allPairs.values()] : allPairs.has(id) ? [allPairs.get(id)!] : [];
      const supply = id === undefined ? [...allSupply.values()] : allSupply.has(id) ? [allSupply.get(id)!] : [];
      const { tx, stx } = sdk.createPtb();
      tx.setSender(this.env.address);
      const coins: TransactionObjectArgument[] = [];

      const seen = new Set<string>();
      for (const p of pairs) {
        const ob = await this.obligationFor(p);
        if (!ob || seen.has(ob.id)) continue;
        seen.add(ob.id);
        const acct = await sdk.query.getObligationAccountById(ob.id);
        const byCoin = new Map<string, { amount: bigint; decimals: number; token: string }>();
        for (const r of claimableRewards(acct)) {
          const cur = byCoin.get(r.coinName) ?? { amount: 0n, decimals: r.coinDecimal, token: r.symbol || r.coinName };
          cur.amount += BigInt(Math.floor(r.availableClaimAmount));
          byCoin.set(r.coinName, cur);
        }
        for (const [coinName, v] of byCoin) {
          coins.push(stx.claimBorrowIncentive(ob.id, ob.keyId, coinName));
          claimed.push({ token: v.token, amount: v.amount, decimals: v.decimals });
        }
      }

      // Spool rewards (normal `claim` = spool user::redeem_rewards per stake account).
      const wl = sdk.constants.whitelist;
      const spoolNames = new Set(supply.map((m) => m.spoolName));
      if (this.opts.claimSpoolRewards && id === undefined) for (const n of wl.spool) spoolNames.add(n);
      const names = [...spoolNames].filter((n) => {
        if (wl.deprecated.has(n)) {
          ctx.log("warn", `scallop: not claiming deprecated spool ${n}`);
          return false;
        }
        return wl.spool.has(n);
      });
      if (names.length) {
        const [accounts, spools] = await Promise.all([sdk.query.getAllStakeAccounts(this.env.address), sdk.query.getSpools(names)]);
        for (const n of names) {
          const spool = spools[n];
          if (!spool) continue;
          for (const acc of accounts[n] ?? []) {
            const pending = spoolPendingReward(spool, [acc]);
            if (pending <= 0n) continue;
            coins.push(stx.claim(acc.id, n));
            claimed.push({ token: this.symbolOf(sdk, spool.rewardCoinType), amount: pending, decimals: spool.rewardCoinDecimal });
          }
        }
      }

      if (!coins.length) return { ok: true, txs: [], claimed: [], detail: "nothing to claim" };
      tx.transferObjects(coins, this.env.address);
      const rec: TxRecord = await executePtb(this.env, ctx, tx, `scallop claim ${claimed.map((c) => `${c.amount} ${c.token}`).join(", ")}`);
      return { ok: true, txs: [rec], claimed };
    } catch (e) {
      if (e instanceof BroadcastUnconfirmedError) return { ...this.unconfirmed(ctx, "claimRewards", e), claimed };
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log("error", `scallop: claimRewards failed: ${msg}`);
      return { ok: false, txs: [], claimed: [], detail: msg };
    }
  }

  private symbolOf(sdk: ScallopSdkLike, coinType: string): string {
    const name = sdk.utils.parseCoinNameFromType(coinType);
    return sdk.utils.parseSymbol(name) || name;
  }

  // -------------------------------------------------------------------------
  // SupplyAdapter: plain Scallop lending
  // -------------------------------------------------------------------------

  private async supplyState(m: ResolvedSupply): Promise<SupplyState> {
    const sdk = await this.sdk();
    const wl = sdk.constants.whitelist;
    const spoolListed = wl.spool.has(m.spoolName);
    const [{ pools }, spools, accountsAll, sBal, mBal] = await Promise.all([
      sdk.query.getMarketPools([m.coinName]),
      spoolListed ? sdk.query.getSpools([m.spoolName]) : Promise.resolve({} as Partial<Record<string, SpoolLike>>),
      sdk.query.getAllStakeAccounts(this.env.address),
      m.sCoinType ? coinBalance(this.env, m.sCoinType) : Promise.resolve(0n),
      coinBalance(this.env, m.marketCoinType),
    ]);
    const pool = pools[m.coinName];
    if (!pool) throw new Error(`scallop supply ${m.marketId}: no lending pool for ${m.coinName}`);
    const spool = spools[m.spoolName] ?? undefined;
    const spoolDeprecated = wl.deprecated.has(m.spoolName) || wl.deprecated.has(m.coinName);
    const live = spoolIsLive(spool, this.now(), { whitelisted: spoolListed, deprecated: spoolDeprecated });
    const accounts = (accountsAll[m.spoolName] ?? []).map((a) => ({ id: a.id, staked: a.staked, index: a.index, points: a.points }));
    const dec = m.cfg.asset.decimals;
    const usdOfUnits = (marketUnits: bigint) => unitsUsd(underlyingOf(marketUnits, pool.conversionRate), pool.coinPrice, dec);
    const roomUnits = spool ? unitsFromNumber(Math.max(0, spool.maxStake - spool.stakedAmount)) : 0n;
    const roomUsd = usdOfUnits(roomUnits);
    const staked = accounts.filter((a) => a.staked > 0).map((a) => ({ accountId: a.id, units: unitsFromNumber(a.staked) }));
    return {
      pool,
      spool: spool ?? undefined,
      spoolDeprecated,
      staking: live && (m.cfg.stakeInSpool ?? true) && roomUsd >= (this.opts.minSpoolRoomUsd ?? 1_000),
      roomUnits,
      roomUsd,
      myStakedUsd: usdOfUnits(staked.reduce((a, x) => a + x.units, 0n)),
      spoolStakedUsd: spool ? usdOfUnits(unitsFromNumber(Math.max(0, spool.stakedAmount))) : 0,
      myUnstakedUsd: usdOfUnits(sBal + mBal),
      holdings: { sCoin: sBal, marketCoin: mBal, staked },
      accounts,
      // The SDK does not expose the pool's active flag (VERIFY_LIVE); a
      // deprecated pool or a zero supply limit means deposits are off.
      paused: wl.deprecated.has(m.coinName) || !(pool.maxSupplyCoin > 0),
    };
  }

  private depositUsd(m: ResolvedSupply, st: SupplyState): { units: bigint; usd: number } {
    const units = underlyingOf(holdingUnits(st.holdings), st.pool.conversionRate);
    return { units, usd: unitsUsd(units, st.pool.coinPrice, m.cfg.asset.decimals) };
  }

  async supplyMarkets(): Promise<SupplyMarket[]> {
    const all = [...(await this.resolveSupply()).values()];
    if (!all.length) return [];
    const nowMs = this.now();
    const sdk = await this.sdk();
    const results = await Promise.allSettled(
      all.map(async (m) => {
        const st = await this.supplyState(m);
        const extra = this.opts.extraRewards
          ? await this.opts.extraRewards({ protocol: "scallop", chain: "sui", asset: m.cfg.asset, side: "supply", marketId: m.marketId })
          : [];
        const input: Parameters<typeof buildScallopSupplyMarket>[0] = {
          marketId: m.marketId,
          asset: m.cfg.asset,
          pool: st.pool,
          extra,
          paused: st.paused,
          myDepositUsd: this.depositUsd(m, st).usd,
          nowMs,
        };
        if (st.staking && st.spool) {
          // Reward only the part that is or can be staked: my staked + the
          // spool's remaining room. Unstaked sCoin I hold earns no spool
          // reward until the next deposit restakes it (deposit() does).
          input.spool = st.spool;
          input.spoolRewardToken = this.symbolOf(sdk, st.spool.rewardCoinType);
          input.spoolCapUsd = st.myStakedUsd + st.roomUsd;
          input.spoolBasisUsd = st.spoolStakedUsd;
          if (st.myUnstakedUsd > 0.01) {
            input.note = `Scallop lending; $${st.myUnstakedUsd.toFixed(2)} held as unstaked sCoin earns no spool reward until the next deposit restakes it`;
          }
        }
        return buildScallopSupplyMarket(input);
      })
    );
    const out: SupplyMarket[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") out.push(r.value);
      else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        errors.push(`${all[i]!.marketId}: ${msg}`);
        (this.opts.log ?? defaultLog)("warn", `scallop: supplyMarkets() skipping ${all[i]!.marketId}: ${msg}`);
      }
    });
    if (!out.length) throw new Error(`scallop: supplyMarkets() failed for every market: ${errors.join("; ")}`);
    return out;
  }

  async supplyPosition(marketId: string): Promise<SupplyPositionView | null> {
    const m = await this.supplyMarket(marketId);
    const st = await this.supplyState(m);
    const { units, usd } = this.depositUsd(m, st);
    const rewards: SupplyPositionView["rewardsUnclaimed"] = [];
    if (st.spool && st.accounts.length && !st.spoolDeprecated) {
      const pending = spoolPendingReward(st.spool, st.accounts);
      if (pending > 0n) {
        const sdk = await this.sdk();
        rewards.push({
          token: this.symbolOf(sdk, st.spool.rewardCoinType),
          amount: pending,
          decimals: st.spool.rewardCoinDecimal,
          usd: unitsUsd(pending, st.spool.rewardCoinPrice, st.spool.rewardCoinDecimal),
        });
      }
    }
    if (units === 0n && !rewards.length) return null;
    return { marketId, depositUsd: usd, units, rewardsUnclaimed: rewards, asOfMs: this.now() };
  }

  async deposit(marketId: string, amount: bigint, ctx: LiveContext): Promise<LiveResult> {
    return this.run(ctx, `deposit ${marketId}`, () => this.buildDeposit(marketId, amount));
  }

  private async buildDeposit(marketId: string, amount: bigint): Promise<Built> {
    const m = await this.supplyMarket(marketId);
    if (amount <= 0n) return { kind: "refuse", detail: "amount must be > 0" };
    const st = await this.supplyState(m);
    if (st.paused) return { kind: "refuse", detail: `${m.coinName} lending is paused / deprecated / has no supply limit` };
    const bal = await this.walletBalance(m.cfg.asset);
    if (bal < amount) return { kind: "refuse", detail: `wallet ${m.cfg.asset.symbol} ${bal} < ${amount}` };
    const dec = m.cfg.asset.decimals;
    const room = unitsFromNumber(Math.max(0, (st.pool.maxSupplyCoin - st.pool.supplyCoin) * 10 ** dec));
    if (amount > room) return { kind: "refuse", detail: `supply-limit headroom ${room} < ${amount}` };
    // Stake up to the spool's remaining room (the reported reward is capped the
    // same way), restaking sCoin / MarketCoin already held when room is left.
    const plan = st.staking
      ? planSpoolStake({
          newUnitsLb: mintedUnitsLowerBound(amount, st.pool.conversionRate),
          existingUnits: st.holdings.sCoin + st.holdings.marketCoin,
          roomUnits: st.roomUnits,
        })
      : { stakeUnits: 0n, includeExisting: false, stakeAll: false };

    const sdk = await this.sdk();
    const { tx, stx } = sdk.createPtb();
    tx.setSender(this.env.address);
    const coin = tx.add(coinWithBalance({ type: m.coinType, balance: amount }));
    const marketCoin = stx.supply(coin, m.coinName); // mint::mint -> MarketCoin<T>
    const keep = (c: TransactionObjectArgument) => {
      // anything not staked is held as sCoin (or as MarketCoin when the pool has no sCoin)
      tx.transferObjects([m.sCoinName ? stx.mintSCoin(m.spoolName, c) : c], this.env.address);
    };
    let how: string;
    if (plan.stakeUnits > 0n) {
      if (plan.includeExisting) {
        const parts: TransactionObjectArgument[] = [];
        if (st.holdings.sCoin > 0n && m.sCoinName && m.sCoinType) {
          parts.push(stx.burnSCoin(m.sCoinName, tx.add(coinWithBalance({ type: m.sCoinType, balance: st.holdings.sCoin }))));
        }
        if (st.holdings.marketCoin > 0n) parts.push(tx.add(coinWithBalance({ type: m.marketCoinType, balance: st.holdings.marketCoin })));
        if (parts.length) tx.mergeCoins(marketCoin, parts);
      }
      const toStake = plan.stakeAll ? marketCoin : tx.splitCoins(marketCoin, [tx.pure.u64(plan.stakeUnits)])[0]!;
      const existing = st.accounts[0]?.id;
      if (existing) stx.stake(existing, toStake, m.spoolName);
      else {
        const account = stx.createStakeAccount(m.spoolName);
        stx.stake(account, toStake, m.spoolName);
        tx.transferObjects([account], this.env.address);
      }
      if (!plan.stakeAll) keep(marketCoin);
      how =
        `${plan.stakeAll ? "staked" : `staked ${plan.stakeUnits} units (spool room), rest held`} in spool ${m.spoolName}` +
        (plan.includeExisting ? " incl. restaking held sCoin" : "") +
        (existing ? "" : " (new stake account)");
    } else {
      keep(marketCoin);
      how = m.sCoinName ? `held as ${m.sCoinName}` : "held as MarketCoin";
    }
    return {
      kind: "tx",
      tx,
      amountUsd: unitsUsd(amount, st.pool.coinPrice, dec),
      description: `scallop deposit ${marketId}: ${amount} ${m.coinName}, ${how}`,
    };
  }

  async withdraw(marketId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    return this.run(ctx, `withdraw ${marketId}`, () => this.buildWithdraw(marketId, fraction));
  }

  private async buildWithdraw(marketId: string, fraction: number): Promise<Built> {
    const m = await this.supplyMarket(marketId);
    if (!(fraction > 0 && fraction <= 1)) return { kind: "refuse", detail: `fraction ${fraction} out of (0,1]` };
    const st = await this.supplyState(m);
    const plan = planWithdraw(st.holdings, fraction);
    if (plan.units === 0n) return { kind: "noop", detail: "no deposit" };
    const underlying = underlyingOf(plan.units, st.pool.conversionRate);
    const cash = unitsFromNumber(Math.max(0, st.pool.supplyAmount - st.pool.borrowAmount));
    if (underlying > cash) return { kind: "refuse", detail: `${m.coinName} pool cash ${cash} < withdrawal ${underlying}` };

    const sdk = await this.sdk();
    const { tx, stx } = sdk.createPtb();
    tx.setSender(this.env.address);
    const parts: TransactionObjectArgument[] = [];
    for (const u of plan.unstake) parts.push(stx.unstake(u.accountId, toSafeNumber(u.units, "unstake amount"), m.spoolName));
    if (plan.sCoin > 0n) {
      if (!m.sCoinName || !m.sCoinType) throw new Error(`scallop supply ${marketId}: sCoin balance without an sCoin type`);
      const sCoin = tx.add(coinWithBalance({ type: m.sCoinType, balance: plan.sCoin }));
      parts.push(stx.burnSCoin(m.sCoinName, sCoin));
    }
    if (plan.marketCoin > 0n) parts.push(tx.add(coinWithBalance({ type: m.marketCoinType, balance: plan.marketCoin })));
    const [first, ...rest] = parts;
    if (rest.length) tx.mergeCoins(first!, rest);
    const out = stx.withdraw(first!, m.coinName); // redeem::redeem -> Coin<T>
    tx.transferObjects([out], this.env.address);
    return {
      kind: "tx",
      tx,
      amountUsd: unitsUsd(underlying, st.pool.coinPrice, m.cfg.asset.decimals),
      description:
        `scallop withdraw ${(fraction * 100).toFixed(1)}% ${marketId}: ${plan.units} market units (~${underlying} ${m.coinName})` +
        (plan.unstake.length ? `, unstaking ${plan.unstake.length} spool account(s)` : ""),
    };
  }

  /** Full-withdraw simulation: true = would succeed, false = would revert / no liquidity; read errors THROW. */
  async simulateWithdraw(marketId: string, _ctx: LiveContext): Promise<boolean> {
    const b = await this.buildWithdraw(marketId, 1);
    if (b.kind === "noop") return true;
    if (b.kind === "refuse") return false;
    b.tx.setSenderIfNotSet(this.env.address);
    const sim = await this.env.grpc.core.simulateTransaction({ transaction: b.tx, include: { effects: true } });
    return sim.$kind === "Transaction";
  }
}
