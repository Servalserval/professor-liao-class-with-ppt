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
import type { LoopPair, RewardRate } from "@incentive-router/core";
import {
  minusBps,
  type AssetRef,
  type LendingAdapter,
  type LiveContext,
  type LiveResult,
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
  claimableRewards,
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

export interface ScallopAdapterOptions {
  env: SuiEnv;
  pairs: ScallopPairConfig[];
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
  /** Also claim legacy spool (sCoin staking) rewards in claimRewards. Default false (this adapter never stakes in spools). */
  claimSpoolRewards?: boolean;
  now?: () => number;
}

interface ResolvedPair {
  cfg: ScallopPairConfig;
  collType: string;
  debtType: string;
  collName: string;
  debtName: string;
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

const normType = (t: string) => normalizeStructTag(t.startsWith("0x") ? t : `0x${t}`);

export class ScallopAdapter implements LendingAdapter {
  readonly id = "scallop";
  readonly chain = "sui";

  private readonly env: SuiEnv;
  private readonly pairs = new Map<string, ScallopPairConfig>();
  private sdkP?: Promise<ScallopSdkLike>;
  private resolved?: Promise<Map<string, ResolvedPair>>;
  private obligationCache = new Map<string, ObligationRef | null>();

  constructor(private readonly opts: ScallopAdapterOptions) {
    this.env = opts.env;
    if (!opts.pairs.length) throw new Error("scallop: no pairs configured");
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

  private async snapshots(pairs: ResolvedPair[]): Promise<{ snaps: Map<string, Snapshot>; incentives: Partial<Record<string, IncentivePoolLike>> }> {
    const sdk = await this.sdk();
    const names = [...new Set(pairs.flatMap((p) => [p.collName, p.debtName]))];
    const debtNames = [...new Set(pairs.map((p) => p.debtName))];
    const [{ pools, collaterals }, fees, incentives] = await Promise.all([
      sdk.query.getMarketPools(names),
      sdk.query.getFlashLoanFees(debtNames),
      sdk.query.getBorrowIncentivePools(debtNames),
    ]);
    const snaps = new Map<string, Snapshot>();
    for (const p of pairs) {
      const pool = pools[p.debtName];
      const coll = collaterals[p.collName];
      if (!pool) throw new Error(`scallop ${p.cfg.pairId}: no lending pool for ${p.debtName}`);
      if (!coll) throw new Error(`scallop ${p.cfg.pairId}: ${p.collName} has no collateral risk model`);
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
    const nowMs = this.now();
    const sdk = await this.sdk();
    const { snaps, incentives } = await this.snapshots(resolved);
    const exclude = new Set<string>([...sdk.constants.whitelist.rewardsAsPoint, ...sdk.constants.whitelist.deprecated]);
    return Promise.all(
      resolved.map(async (p) => {
        const snap = snaps.get(p.cfg.pairId)!;
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
      const res: LiveResult = { ok: true, txs: [rec], detail: b.description };
      if (b.amountUsd !== undefined) res.amountUsd = b.amountUsd;
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log("error", `scallop: ${label} failed: ${msg}`);
      return { ok: false, txs: [], detail: msg };
    }
  }

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    return this.run(ctx, `open ${pairId}`, () => this.buildOpen(pairId, equity, targetLtv, ctx));
  }

  private async buildOpen(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<Built> {
    const p = await this.pair(pairId);
    if (equity <= 0n) return { kind: "refuse", detail: "equity must be > 0" };
    const swapper = this.opts.swapper;
    if (!swapper) return { kind: "refuse", detail: "no swapper: Scallop loops are always two-asset" };
    const { snaps } = await this.snapshots([p]);
    const snap = snaps.get(pairId)!;
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
    const { snaps } = await this.snapshots([p]);
    const snap = snaps.get(pairId)!;
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

  async claimRewards(ctx: LiveContext, pairId?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }> {
    const claimed: { token: string; amount: bigint; decimals: number }[] = [];
    try {
      const sdk = await this.sdk();
      const resolved = pairId ? [await this.pair(pairId)] : [...(await this.resolvePairs()).values()];
      const { tx, stx } = sdk.createPtb();
      tx.setSender(this.env.address);
      const coins: TransactionObjectArgument[] = [];
      const seen = new Set<string>();
      for (const p of resolved) {
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
      if (this.opts.claimSpoolRewards) {
        const wl = sdk.constants.whitelist;
        const accounts = await sdk.query.getAllStakeAccounts(this.env.address);
        for (const [name, accs] of Object.entries(accounts)) {
          if (!wl.spool.has(name) || wl.deprecated.has(name)) continue;
          for (const acc of accs) {
            if (!(acc.points > 0)) continue;
            coins.push(...(await stx.claimQuick(name, acc.id)));
            claimed.push({ token: `spool:${name}`, amount: BigInt(Math.floor(acc.points)), decimals: 0 });
          }
        }
      }
      if (!coins.length) return { ok: true, txs: [], claimed: [], detail: "nothing to claim" };
      tx.transferObjects(coins, this.env.address);
      const rec: TxRecord = await executePtb(this.env, ctx, tx, `scallop claim ${claimed.map((c) => `${c.amount} ${c.token}`).join(", ")}`);
      return { ok: true, txs: [rec], claimed };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log("error", `scallop: claimRewards failed: ${msg}`);
      return { ok: false, txs: [], claimed: [], detail: msg };
    }
  }
}
