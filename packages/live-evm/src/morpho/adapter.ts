/**
 * Morpho Blue live adapter (also Morpho-Blue-code forks with the same core
 * interface, e.g. Lista Lending "Moolah" on BNB Chain: flavor "lista").
 *
 * Model
 *  - A market = (loanToken, collateralToken, oracle, irm, lltv), id = keccak of
 *    the 5-word tuple. Collateral is NOT lent out and earns no Morpho interest:
 *    the pair's collateral leg carries only the token's intrinsic yield
 *    (constructor hook `intrinsicApr`, default 0) and collateral-side rewards;
 *    Morpho's supply/borrow rates, utilization and IRM live on the debt leg.
 *  - Exit = sell collateral -> loan token (swapper) -> repay -> withdraw.
 *    Withdrawing own collateral never depends on market liquidity, so exit
 *    capacity is the swap depth; market liquidity only caps further borrowing
 *    (debt.borrowCapRemainingUsd).
 *  - No flash loans (they need a callback contract; we deploy nothing): loops
 *    are iterated with separate txs through sendTx, intermediate LTV capped at
 *    LLTV * stepLtvFactor. Dry-run simulates the dependent first sequence
 *    (approve -> supplyCollateral -> borrow) as ONE eth_simulateV1 bundle
 *    (viem simulateCalls); later iterations depend on swap output and are
 *    planned, not simulated.
 *
 * The SDK fetchers (fetchMarket / fetchPosition ...) hard-code the registry's
 * Morpho address for the client's chain, so this adapter reads the contracts
 * directly with the SDK's ABIs (works for a configured singleton / fork) and
 * uses the SDK's math (SharesMath, MathLib, MarketUtils, AdaptiveCurveIrmLib).
 */
import { AdaptiveCurveIrmLib, getChainAddresses, MarketUtils, MathLib } from "@morpho-org/blue-sdk";
import { isAddress, isAddressEqual, zeroAddress } from "viem";
import type { IrmModel, LoopPair, RewardRate } from "@incentive-router/core";
import {
  fromUnits,
  unitsToUsd,
  usdToUnits,
  type AssetRef,
  type LendingAdapter,
  type LiveContext,
  type LiveResult,
  type Logger,
  type LoopPositionView,
  type RewardRateProvider,
  type RewardRateQuery,
  type SwapAdapter,
  type SwapQuote,
  type TxRecord,
} from "@incentive-router/live-common";
import {
  assertChainId,
  call,
  ensureAllowance,
  erc20Abi,
  erc20Balance,
  sendTx,
  verifyAsset,
  type Address,
  type EvmEnv,
  type Hex,
  type TxRequest,
} from "@incentive-router/live-evm-base";
import { adaptiveCurveIrmAbi, blueAbi, blueOracleAbi, listaMoolahAbi } from "./abis.js";
import {
  accrueInterest,
  adaptiveCurveFactor,
  adaptiveCurveIrmModel,
  borrowSharesToAssetsUp,
  collateralValue,
  fromWad,
  healthFactor,
  loanToCollateral,
  oracleLtv,
  planLoopSteps,
  planUnwindSteps,
  ratePerSecondToApr,
  resolveUnwindTarget,
  supplyAprFromBorrow,
  utilization,
  type LoopState,
  type MarketTotals,
  type PlanParams,
  type UnwindTarget,
} from "./math.js";
import { simulateBundle } from "./sim.js";

export type MorphoFlavor = "morpho" | "lista";

export interface MorphoPairConfig {
  pairId: string;
  marketId: Hex;
  /** The market's collateral token. */
  collateral: AssetRef;
  /** The market's loan token. */
  debt: AssetRef;
  /** Expected LLTV (fraction, e.g. 0.915). Checked against chain by verifyConfig when set. */
  lltv?: number;
  /**
   * Static exit-route numbers (e.g. an instant ERC-4626 redemption the
   * swapper does not know). Each one overrides the swapper probe.
   */
  swapCostFrac?: number;
  swapDepthUsd?: number;
}

export interface MorphoBlueAdapterOptions {
  env: EvmEnv;
  markets: MorphoPairConfig[];
  /** USD prices for markets()/position(), which get no LiveContext. */
  priceUsd: (asset: AssetRef) => Promise<number>;
  /** Morpho singleton. Default: @morpho-org/blue-sdk address registry `blue` for env's chainId. Required for "lista". */
  morpho?: Address;
  /** "morpho" (default): oracle.price(). "lista": Moolah.getPrice(params), minLoan, whitelist/broker/provider checks. */
  flavor?: MorphoFlavor;
  /** Protocol name used in reward queries. Default "morpho" / "lista". */
  protocol?: string;
  /** Adapter / venue id. Default `${protocol}:${env.chain}`. */
  id?: string;
  swapper?: SwapAdapter;
  extraRewards?: RewardRateProvider;
  /** Intrinsic yield of the collateral token (sUSDe, sUSDS, PT ...), APR. Default 0. */
  intrinsicApr?: (collateral: AssetRef) => Promise<number>;
  /** pair.maxLtv = LLTV * this (default 0.9). Opening targets above it are refused. */
  maxLtvFactor?: number;
  /** Max LTV at any intermediate loop / unwind step = LLTV * this (default 0.95, must be >= maxLtvFactor). */
  stepLtvFactor?: number;
  /** Refuse a swap step whose quoted cost exceeds this; also the depth budget of the probe (default 30 bps). */
  maxSwapCostBps?: number;
  /** USD sizes probed (collateral -> loan) to measure swap depth. Default [1e3, 1e4, 1e5, 1e6]. */
  swapProbeUsd?: number[];
  /** Cache of swap probes (default 10 min). */
  swapProbeTtlMs?: number;
  /** LiveContext used for swap quotes from markets() (default: dry-run ctx built from priceUsd). */
  quoteCtx?: LiveContext;
  /** Skip loop / unwind steps smaller than this (default $1). */
  minStepUsd?: number;
  /** Oversell on a full repay, bps (default 20; at least maxSlippageBps + 5 is used). */
  closeBufferBps?: number;
  /** Accept a `morpho` override that differs from the SDK registry for flavor "morpho" (a same-interface fork). */
  trustConfiguredMorpho?: boolean;
  log?: Logger;
}

export interface MarketParamsTuple {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

interface PairState {
  params: MarketParamsTuple;
  blockTs: bigint;
  /** market(id) as stored (what the IRM is called with). */
  stored: MarketTotals;
  /** Accrued to blockTs with borrowRateView. */
  totals: MarketTotals;
  ratePerSec: bigint;
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
  debt: bigint;
  price: bigint;
  liquidity: bigint;
  minDebt?: bigint;
  loop: LoopState;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export class MorphoBlueAdapter implements LendingAdapter {
  readonly id: string;
  readonly chain: string;
  readonly protocol: string;
  readonly flavor: MorphoFlavor;
  readonly morpho: Address;

  private readonly env: EvmEnv;
  private readonly pairs = new Map<string, MorphoPairConfig>();
  private readonly priceUsd: (a: AssetRef) => Promise<number>;
  private readonly swapper?: SwapAdapter;
  private readonly extraRewards?: RewardRateProvider;
  private readonly intrinsicApr: (a: AssetRef) => Promise<number>;
  private readonly maxLtvFactor: number;
  private readonly stepLtvFactor: number;
  private readonly maxSwapCostBps: number;
  private readonly swapProbeUsd: number[];
  private readonly swapProbeTtlMs: number;
  private readonly quoteCtx: LiveContext;
  private readonly minStepUsd: number;
  private readonly closeBufferBps: number;
  private readonly trustConfiguredMorpho: boolean;
  private readonly registryMorpho?: Address;
  private readonly sdkAdaptiveIrm?: Address;
  private readonly log: Logger;
  private readonly paramsCache = new Map<string, MarketParamsTuple>();
  private readonly swapCache = new Map<string, { atMs: number; costFrac: number; depthUsd: number }>();

  constructor(o: MorphoBlueAdapterOptions) {
    this.env = o.env;
    this.chain = o.env.chain;
    this.flavor = o.flavor ?? "morpho";
    this.protocol = o.protocol ?? this.flavor;
    this.id = o.id ?? `${this.protocol}:${this.chain}`;
    this.log = o.log ?? (() => {});
    this.priceUsd = o.priceUsd;
    this.swapper = o.swapper;
    this.extraRewards = o.extraRewards;
    this.intrinsicApr = o.intrinsicApr ?? (async () => 0);
    this.maxLtvFactor = o.maxLtvFactor ?? 0.9;
    this.stepLtvFactor = o.stepLtvFactor ?? 0.95;
    if (!(this.maxLtvFactor > 0 && this.maxLtvFactor <= this.stepLtvFactor && this.stepLtvFactor < 1))
      throw new Error(`${this.id}: need 0 < maxLtvFactor (${this.maxLtvFactor}) <= stepLtvFactor (${this.stepLtvFactor}) < 1`);
    this.maxSwapCostBps = o.maxSwapCostBps ?? 30;
    this.swapProbeUsd = [...(o.swapProbeUsd ?? [1_000, 10_000, 100_000, 1_000_000])].sort((a, b) => a - b);
    this.swapProbeTtlMs = o.swapProbeTtlMs ?? 10 * 60_000;
    this.minStepUsd = o.minStepUsd ?? 1;
    this.closeBufferBps = o.closeBufferBps ?? 20;
    this.trustConfiguredMorpho = o.trustConfiguredMorpho ?? false;

    const chainId = o.env.viemChain.id;
    let reg: { blue: Address; adaptiveCurveIrm: Address } | undefined;
    try {
      reg = getChainAddresses(chainId); // SOURCE: @morpho-org/morpho-ts addresses registry (re-exported by @morpho-org/blue-sdk)
    } catch {
      reg = undefined;
    }
    this.registryMorpho = reg?.blue;
    if (o.morpho) {
      if (!isAddress(o.morpho)) throw new Error(`${this.id}: morpho ${o.morpho} is not an address`);
      this.morpho = o.morpho;
    } else if (this.flavor === "lista") {
      throw new Error(`${this.id}: flavor "lista" needs an explicit \`morpho\` (Moolah) address from config; verifyConfig reads it back`);
    } else if (reg) {
      this.morpho = reg.blue;
    } else {
      throw new Error(`${this.id}: chainId ${chainId} is not in the @morpho-org/blue-sdk address registry; pass \`morpho\``);
    }
    // The registry describes Morpho's own deployment; a fork's IRM is not the registry's AdaptiveCurveIrm.
    this.sdkAdaptiveIrm = this.flavor === "morpho" && reg && isAddressEqual(this.morpho, reg.blue) ? reg.adaptiveCurveIrm : undefined;

    for (const p of o.markets) {
      if (this.pairs.has(p.pairId)) throw new Error(`${this.id}: duplicate pairId ${p.pairId}`);
      if (!/^0x[0-9a-fA-F]{64}$/.test(p.marketId)) throw new Error(`${this.id}: pair ${p.pairId}: marketId must be 32 bytes hex`);
      if (p.collateral.symbol === p.debt.symbol)
        throw new Error(`${this.id}: pair ${p.pairId}: collateral and debt symbols are equal; Morpho collateral is not lent, a same-asset pair would be mis-modelled by the core`);
      for (const a of [p.collateral, p.debt]) if (!isAddress(a.address)) throw new Error(`${this.id}: pair ${p.pairId}: ${a.symbol} address ${a.address} invalid`);
      this.pairs.set(p.pairId, p);
    }

    this.quoteCtx = o.quoteCtx ?? {
      dryRun: true,
      log: this.log,
      limits: { maxGasUsd: {}, maxSlippageBps: this.maxSwapCostBps, maxLoopIterations: 8 },
      priceUsd: this.priceUsd,
      nativePriceUsd: async () => {
        throw new Error("nativePriceUsd is not available in the markets() quote context; pass `quoteCtx`");
      },
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private pair(pairId: string): MorphoPairConfig {
    const p = this.pairs.get(pairId);
    if (!p) throw new Error(`${this.id}: unknown pair ${pairId}`);
    return p;
  }

  private async readParams(pc: MorphoPairConfig): Promise<MarketParamsTuple> {
    const [loanToken, collateralToken, oracle, irm, lltv] = await this.env.publicClient.readContract({
      address: this.morpho,
      abi: blueAbi,
      functionName: "idToMarketParams",
      args: [pc.marketId],
    });
    return { loanToken, collateralToken, oracle, irm, lltv };
  }

  /** Immutable params, validated once against the id hash and the configured tokens. */
  private async params(pc: MorphoPairConfig): Promise<MarketParamsTuple> {
    const hit = this.paramsCache.get(pc.pairId);
    if (hit) return hit;
    const p = await this.readParams(pc);
    const problems = this.paramsProblems(pc, p);
    if (problems.length) throw new Error(`${this.id}: ${problems.join("; ")}`);
    this.paramsCache.set(pc.pairId, p);
    return p;
  }

  private paramsProblems(pc: MorphoPairConfig, p: MarketParamsTuple): string[] {
    const out: string[] = [];
    if (p.loanToken === zeroAddress && p.lltv === 0n) return [`pair ${pc.pairId}: market ${pc.marketId} does not exist on ${this.morpho}`];
    const id = MarketUtils.getMarketId(p);
    if (id.toLowerCase() !== pc.marketId.toLowerCase()) out.push(`pair ${pc.pairId}: params hash to ${id}, not ${pc.marketId}`);
    if (!isAddressEqual(p.loanToken, pc.debt.address as Address))
      out.push(`pair ${pc.pairId}: market loanToken ${p.loanToken} != configured debt ${pc.debt.symbol} ${pc.debt.address}`);
    if (!isAddressEqual(p.collateralToken, pc.collateral.address as Address))
      out.push(`pair ${pc.pairId}: market collateralToken ${p.collateralToken} != configured collateral ${pc.collateral.symbol} ${pc.collateral.address}`);
    if (pc.lltv !== undefined && Math.abs(fromWad(p.lltv) - pc.lltv) > 1e-9) out.push(`pair ${pc.pairId}: LLTV ${fromWad(p.lltv)} != configured ${pc.lltv}`);
    return out;
  }

  private async blockTs(): Promise<bigint> {
    const b = await this.env.publicClient.getBlock();
    return b.timestamp;
  }

  private async readMarket(pc: MorphoPairConfig, p: MarketParamsTuple, blockTs: bigint): Promise<{ stored: MarketTotals; totals: MarketTotals; ratePerSec: bigint }> {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = await this.env.publicClient.readContract({
      address: this.morpho,
      abi: blueAbi,
      functionName: "market",
      args: [pc.marketId],
    });
    const stored: MarketTotals = { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee };
    if (lastUpdate === 0n) throw new Error(`${this.id}: market ${pc.marketId} (${pc.pairId}) is not created`);
    const ratePerSec =
      p.irm === zeroAddress
        ? 0n
        : await this.env.publicClient.readContract({
            address: p.irm,
            abi: adaptiveCurveIrmAbi,
            functionName: "borrowRateView",
            args: [p, { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee }],
          });
    return { stored, totals: accrueInterest(stored, ratePerSec, blockTs), ratePerSec };
  }

  private async readPosition(pc: MorphoPairConfig): Promise<{ supplyShares: bigint; borrowShares: bigint; collateral: bigint }> {
    const [supplyShares, borrowShares, collateral] = await this.env.publicClient.readContract({
      address: this.morpho,
      abi: blueAbi,
      functionName: "position",
      args: [pc.marketId, this.env.account],
    });
    return { supplyShares, borrowShares, collateral };
  }

  /** Collateral price in loan token, ORACLE_PRICE_SCALE (what the protocol uses for health). */
  private async oraclePrice(p: MarketParamsTuple): Promise<bigint> {
    if (this.flavor === "lista")
      return this.env.publicClient.readContract({ address: this.morpho, abi: listaMoolahAbi, functionName: "getPrice", args: [p] });
    if (p.oracle === zeroAddress) throw new Error(`${this.id}: market has no oracle`);
    return this.env.publicClient.readContract({ address: p.oracle, abi: blueOracleAbi, functionName: "price" });
  }

  private async minDebt(p: MarketParamsTuple): Promise<bigint | undefined> {
    if (this.flavor !== "lista") return undefined;
    return this.env.publicClient.readContract({ address: this.morpho, abi: listaMoolahAbi, functionName: "minLoan", args: [p] });
  }

  private async isPaused(): Promise<boolean> {
    if (this.flavor !== "lista") return false; // Morpho Blue has no pause
    return this.env.publicClient.readContract({ address: this.morpho, abi: listaMoolahAbi, functionName: "paused" });
  }

  private async state(pc: MorphoPairConfig): Promise<PairState> {
    const params = await this.params(pc);
    const blockTs = await this.blockTs();
    const [m, pos, price, minDebt] = await Promise.all([this.readMarket(pc, params, blockTs), this.readPosition(pc), this.oraclePrice(params), this.minDebt(params)]);
    const debt = pos.borrowShares === 0n ? 0n : borrowSharesToAssetsUp(pos.borrowShares, m.totals);
    const liquidity = m.totals.totalSupplyAssets > m.totals.totalBorrowAssets ? m.totals.totalSupplyAssets - m.totals.totalBorrowAssets : 0n;
    return {
      params,
      blockTs,
      stored: m.stored,
      totals: m.totals,
      ratePerSec: m.ratePerSec,
      ...pos,
      debt,
      price,
      liquidity,
      minDebt,
      loop: { collateral: pos.collateral, debt },
    };
  }

  /**
   * IrmModel for the debt leg (see adaptiveCurveIrmModel for the approximation).
   *  - Morpho's AdaptiveCurveIrm (registry address): rateAtTarget rolled
   *    forward to now with the SDK's AdaptiveCurveIrmLib.getBorrowRate.
   *  - Other IRMs exposing rateAtTarget(id) (fork adaptive IRMs, e.g. Lista's,
   *    which also clamps to a cap / floor): r fitted through the observed
   *    borrowRateView at the current utilization.
   *  - Anything else: undefined (the core then ramps the observed APR).
   */
  private async irmModel(pc: MorphoPairConfig, p: MarketParamsTuple, stored: MarketTotals, ratePerSec: bigint, blockTs: bigint): Promise<IrmModel | undefined> {
    const fee = fromWad(stored.fee);
    if (p.irm === zeroAddress) return { points: [[0, 0], [1, 0]], reserveFactor: fee };
    let rat: bigint;
    try {
      rat = await this.env.publicClient.readContract({ address: p.irm, abi: adaptiveCurveIrmAbi, functionName: "rateAtTarget", args: [pc.marketId] });
    } catch {
      return undefined;
    }
    if (this.sdkAdaptiveIrm && isAddressEqual(p.irm, this.sdkAdaptiveIrm)) {
      const elapsed = blockTs > stored.lastUpdate ? blockTs - stored.lastUpdate : 0n;
      const { endRateAtTarget } = AdaptiveCurveIrmLib.getBorrowRate(MarketUtils.getUtilization(stored), rat, elapsed);
      return adaptiveCurveIrmModel(ratePerSecondToApr(endRateAtTarget), fee);
    }
    const f = adaptiveCurveFactor(utilization(stored));
    return adaptiveCurveIrmModel(f > 0 ? ratePerSecondToApr(ratePerSec) / f : 0, fee);
  }

  private async rewards(pc: MorphoPairConfig, asset: AssetRef, side: RewardRateQuery["side"]): Promise<RewardRate[]> {
    if (!this.extraRewards) return [];
    try {
      return await this.extraRewards({ protocol: this.protocol, chain: this.chain, asset, side, marketId: pc.marketId });
    } catch (e) {
      this.log("warn", `${this.id}: reward rates for ${pc.pairId} ${side} failed: ${msg(e)}`);
      return [];
    }
  }

  private async intrinsic(pc: MorphoPairConfig): Promise<number> {
    try {
      const x = await this.intrinsicApr(pc.collateral);
      return Number.isFinite(x) ? x : 0;
    } catch (e) {
      this.log("warn", `${this.id}: intrinsicApr(${pc.collateral.symbol}) failed, using 0: ${msg(e)}`);
      return 0;
    }
  }

  /**
   * Swap cost / depth between collateral and loan token. Cost = worst of the
   * two directions at the smallest probe; depth = largest probe size of the
   * EXIT direction (collateral -> loan) within maxSwapCostBps. No swapper and
   * no override -> depth 0 (the core then sees no exit capacity).
   */
  private async swapStats(pc: MorphoPairConfig, pColl: number, pDebt: number): Promise<{ costFrac: number; depthUsd: number }> {
    if (pc.swapCostFrac !== undefined && pc.swapDepthUsd !== undefined) return { costFrac: pc.swapCostFrac, depthUsd: pc.swapDepthUsd };
    const hit = this.swapCache.get(pc.pairId);
    if (hit && Date.now() - hit.atMs < this.swapProbeTtlMs) return { costFrac: pc.swapCostFrac ?? hit.costFrac, depthUsd: pc.swapDepthUsd ?? hit.depthUsd };
    let costFrac = 0;
    let depthUsd = 0;
    if (this.swapper && this.swapProbeUsd.length && pColl > 0 && pDebt > 0) {
      const ctx = this.quoteCtx;
      let costIn = Number.NaN;
      try {
        const q = await this.swapper.quote(pc.debt, pc.collateral, usdToUnits(this.swapProbeUsd[0]!, pDebt, pc.debt.decimals), ctx);
        costIn = q.costBps;
      } catch (e) {
        this.log("warn", `${this.id}: entry swap quote ${pc.debt.symbol}->${pc.collateral.symbol} failed: ${msg(e)}`);
      }
      let costOut = Number.NaN;
      for (const usd of this.swapProbeUsd) {
        let q: SwapQuote;
        try {
          q = await this.swapper.quote(pc.collateral, pc.debt, usdToUnits(usd, pColl, pc.collateral.decimals), ctx);
        } catch (e) {
          this.log("warn", `${this.id}: exit swap quote ${pc.collateral.symbol}->${pc.debt.symbol} $${usd} failed: ${msg(e)}`);
          break;
        }
        if (Number.isNaN(costOut)) costOut = q.costBps;
        if (!(q.costBps <= this.maxSwapCostBps)) break;
        depthUsd = usd;
      }
      if (Number.isNaN(costIn) || Number.isNaN(costOut)) depthUsd = 0; // no route one way = no loop
      const worst = Math.max(Number.isNaN(costIn) ? 0 : costIn, Number.isNaN(costOut) ? 0 : costOut);
      costFrac = Math.max(0, worst) / 1e4;
      this.swapCache.set(pc.pairId, { atMs: Date.now(), costFrac, depthUsd });
    }
    return { costFrac: pc.swapCostFrac ?? costFrac, depthUsd: pc.swapDepthUsd ?? depthUsd };
  }

  // -------------------------------------------------------------------------
  // LendingAdapter: reads
  // -------------------------------------------------------------------------

  async markets(): Promise<LoopPair[]> {
    const [blockTs, paused] = await Promise.all([this.blockTs(), this.isPaused()]);
    return Promise.all([...this.pairs.values()].map((pc) => this.pairMarket(pc, blockTs, paused)));
  }

  private async pairMarket(pc: MorphoPairConfig, blockTs: bigint, paused: boolean): Promise<LoopPair> {
    const params = await this.params(pc);
    const [m, pos, collPool, pColl, pDebt, intrinsic, collRewards, supplyRewards, borrowRewards] = await Promise.all([
      this.readMarket(pc, params, blockTs),
      this.readPosition(pc),
      erc20Balance(this.env, pc.collateral.address as Address, this.morpho),
      this.priceUsd(pc.collateral),
      this.priceUsd(pc.debt),
      this.intrinsic(pc),
      this.rewards(pc, pc.collateral, "collateral"),
      this.rewards(pc, pc.debt, "supply"),
      this.rewards(pc, pc.debt, "borrow"),
    ]);
    const irm = await this.irmModel(pc, params, m.stored, m.ratePerSec, blockTs);
    const swap = await this.swapStats(pc, pColl, pDebt);
    const util = utilization(m.stored);
    const fee = fromWad(m.stored.fee);
    const borrowApr = ratePerSecondToApr(m.ratePerSec);
    const lltv = fromWad(params.lltv);
    const liquidity = m.totals.totalSupplyAssets > m.totals.totalBorrowAssets ? m.totals.totalSupplyAssets - m.totals.totalBorrowAssets : 0n;
    const debtUsd = (x: bigint) => unitsToUsd(x, pDebt, pc.debt.decimals);

    let myLtv: number | undefined;
    if (pos.borrowShares > 0n || pos.collateral > 0n) {
      const price = await this.oraclePrice(params);
      myLtv = oracleLtv(pos.collateral, pos.borrowShares === 0n ? 0n : borrowSharesToAssetsUp(pos.borrowShares, m.totals), price);
    }

    return {
      protocol: this.id,
      chain: this.chain,
      pairId: pc.pairId,
      collateral: {
        symbol: pc.collateral.symbol,
        assetId: pc.collateral.address,
        priceUsd: pColl,
        // Morpho keeps no per-market collateral total: Morpho's balance of the
        // token (all markets + any loan-side supply) is an UPPER bound. It only
        // feeds reward dilution (conservative) and the collateral "market"
        // headroom (collateral is never borrowed, so totalBorrowUsd = 0).
        totalSupplyUsd: unitsToUsd(collPool, pColl, pc.collateral.decimals),
        totalBorrowUsd: 0,
        supplyAprBase: intrinsic,
        borrowAprBase: 0,
        supplyRewards: collRewards,
        borrowRewards: [],
        supplyCapRemainingUsd: null,
        borrowCapRemainingUsd: null,
      },
      debt: {
        symbol: pc.debt.symbol,
        assetId: pc.debt.address,
        priceUsd: pDebt,
        totalSupplyUsd: debtUsd(m.totals.totalSupplyAssets),
        totalBorrowUsd: debtUsd(m.totals.totalBorrowAssets),
        supplyAprBase: supplyAprFromBorrow(borrowApr, util, fee),
        borrowAprBase: borrowApr,
        supplyRewards,
        borrowRewards,
        irm,
        supplyCapRemainingUsd: null,
        // Borrowing more is limited by the market's idle liquidity.
        borrowCapRemainingUsd: debtUsd(liquidity),
      },
      maxLtv: lltv * this.maxLtvFactor,
      liqLtv: lltv,
      swapCostFrac: swap.costFrac,
      swapDepthUsd: swap.depthUsd,
      flashloanFeeFrac: 0,
      paused,
      myLtv,
      dataAsOfMs: Number(blockTs) * 1000,
    };
  }

  async position(pairId: string): Promise<LoopPositionView | null> {
    const pc = this.pair(pairId);
    const st = await this.state(pc);
    if (st.collateral === 0n && st.borrowShares === 0n) return null;
    const pDebt = await this.priceUsd(pc.debt);
    let pColl = await this.priceUsd(pc.collateral);
    if (!(pColl > 0)) {
      // Fall back to the oracle-implied price (collateral valued in loan token).
      const one = 10n ** BigInt(pc.collateral.decimals);
      pColl = fromUnits(collateralValue(one, st.price), pc.debt.decimals) * pDebt;
    }
    const collateralUsd = unitsToUsd(st.collateral, pColl, pc.collateral.decimals);
    const debtUsd = unitsToUsd(st.debt, pDebt, pc.debt.decimals);
    return {
      pairId,
      collateralUsd,
      debtUsd,
      ltv: oracleLtv(st.collateral, st.debt, st.price),
      healthFactor: healthFactor(st.collateral, st.debt, st.price, st.params.lltv),
      equityUsd: collateralUsd - debtUsd,
      rewardsUnclaimed: [],
      asOfMs: Number(st.blockTs) * 1000,
    };
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return erc20Balance(this.env, asset.address as Address);
  }

  // -------------------------------------------------------------------------
  // Tx builders
  // -------------------------------------------------------------------------

  private supplyCollateralReq(pc: MorphoPairConfig, p: MarketParamsTuple, assets: bigint): TxRequest {
    return {
      to: this.morpho,
      data: call(blueAbi, "supplyCollateral", [p, assets, this.env.account, "0x"]),
      description: `${this.id} supplyCollateral ${assets} ${pc.collateral.symbol} (${pc.pairId})`,
    };
  }

  private borrowReq(pc: MorphoPairConfig, p: MarketParamsTuple, assets: bigint): TxRequest {
    return {
      to: this.morpho,
      data: call(blueAbi, "borrow", [p, assets, 0n, this.env.account, this.env.account]),
      description: `${this.id} borrow ${assets} ${pc.debt.symbol} (${pc.pairId})`,
    };
  }

  private repayReq(pc: MorphoPairConfig, p: MarketParamsTuple, assets: bigint, shares: bigint): TxRequest {
    return {
      to: this.morpho,
      data: call(blueAbi, "repay", [p, assets, shares, this.env.account, "0x"]),
      description: `${this.id} repay ${shares > 0n ? `${shares} shares (all)` : `${assets}`} ${pc.debt.symbol} (${pc.pairId})`,
    };
  }

  private withdrawCollateralReq(pc: MorphoPairConfig, p: MarketParamsTuple, assets: bigint): TxRequest {
    return {
      to: this.morpho,
      data: call(blueAbi, "withdrawCollateral", [p, assets, this.env.account, this.env.account]),
      description: `${this.id} withdrawCollateral ${assets} ${pc.collateral.symbol} (${pc.pairId})`,
    };
  }

  /** Same policy as ensureAllowance (exact amount, reset-to-0 first), as requests for a bundle. */
  private async approveReqs(token: Address, spender: Address, amount: bigint): Promise<TxRequest[]> {
    const cur = await this.env.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.env.account, spender] });
    if (cur >= amount) return [];
    const out: TxRequest[] = [];
    if (cur > 0n) out.push({ to: token, data: call(erc20Abi, "approve", [spender, 0n]), description: `reset allowance ${token} -> ${spender}` });
    out.push({ to: token, data: call(erc20Abi, "approve", [spender, amount]), description: `approve ${amount} ${token} -> ${spender}` });
    return out;
  }

  // -------------------------------------------------------------------------
  // Planning helpers
  // -------------------------------------------------------------------------

  private async dust(pc: MorphoPairConfig, ctx: LiveContext): Promise<bigint> {
    try {
      return usdToUnits(this.minStepUsd, await ctx.priceUsd(pc.debt), pc.debt.decimals);
    } catch {
      return 0n;
    }
  }

  private planParams(st: PairState, ctx: LiveContext, swapCostFrac: number, maxIterations: number, dust: bigint, unwind = false): PlanParams {
    const lltv = fromWad(st.params.lltv);
    let stepLtvCap = lltv * this.stepLtvFactor;
    // A position already above the normal step cap could never withdraw;
    // unwinds may then step up to 99% of LLTV (logged by the caller).
    if (unwind && oracleLtv(st.collateral, st.debt, st.price) >= stepLtvCap) stepLtvCap = lltv * 0.99;
    return {
      price: st.price,
      stepLtvCap,
      swapCostFrac,
      maxIterations,
      minDebt: st.minDebt,
      dust,
      borrowLiquidity: st.liquidity,
      sellBufferBps: Math.max(this.closeBufferBps, ctx.limits.maxSlippageBps + 5),
    };
  }

  /** Quote, check cost, swap, and return what actually arrived (wallet delta). */
  private async swapMeasured(from: AssetRef, to: AssetRef, amountIn: bigint, ctx: LiveContext, txs: TxRecord[]): Promise<{ received: bigint; costBps: number }> {
    if (!this.swapper) throw new Error("no swapper configured");
    const q = await this.swapper.quote(from, to, amountIn, ctx);
    if (!(q.costBps <= this.maxSwapCostBps)) throw new Error(`swap ${from.symbol}->${to.symbol} via ${q.route} costs ${q.costBps}bps > max ${this.maxSwapCostBps}bps`);
    const before = await this.walletBalance(to);
    const r = await this.swapper.swap(q, from, to, ctx);
    txs.push(...r.txs);
    if (!r.ok) throw new Error(`swap ${from.symbol}->${to.symbol} failed: ${r.detail ?? "?"}`);
    const after = await this.walletBalance(to);
    return { received: after > before ? after - before : 0n, costBps: q.costBps };
  }

  private broadcastNote(txs: TxRecord[]): string {
    return txs.some((t) => !t.simulated) ? " [some txs were already broadcast: the position is consistent but may be partially (de)levered; check the wallet for leftover tokens]" : "";
  }

  // -------------------------------------------------------------------------
  // LendingAdapter: writes
  // -------------------------------------------------------------------------

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    const fail = (detail: string): LiveResult => ({ ok: false, txs, detail: `${this.id} open ${pairId}: ${detail}` });
    try {
      const pc = this.pair(pairId);
      if (equity <= 0n) return fail("equity must be > 0");
      if (!(targetLtv >= 0 && targetLtv < 1)) return fail(`target LTV ${targetLtv} not in [0,1)`);
      if (await this.isPaused()) return fail("protocol is paused");
      const st = await this.state(pc);
      const maxLtv = fromWad(st.params.lltv) * this.maxLtvFactor;
      if (targetLtv > maxLtv + 1e-9) return fail(`target LTV ${pct(targetLtv)} exceeds maxLtv ${pct(maxLtv)} (LLTV x ${this.maxLtvFactor})`);
      const bal = await this.walletBalance(pc.collateral);
      if (bal < equity) return fail(`wallet has ${bal} ${pc.collateral.symbol}, need ${equity}`);
      if (targetLtv > 0 && !this.swapper) return fail("no swapper configured (needed to convert borrowed loan token to collateral)");

      const dust = await this.dust(pc, ctx);
      const base = this.planParams(st, ctx, 0, ctx.limits.maxLoopIterations, dust);
      let plan = planLoopSteps(st.loop, equity, targetLtv, base);
      let cost = 0;
      let quote: SwapQuote | undefined;
      const b0 = plan.steps.find((s) => s.kind === "borrow");
      if (b0 && b0.kind === "borrow") {
        quote = await this.swapper!.quote(pc.debt, pc.collateral, b0.assets, ctx);
        if (!(quote.costBps <= this.maxSwapCostBps)) return fail(`swap ${pc.debt.symbol}->${pc.collateral.symbol} via ${quote.route} costs ${quote.costBps}bps > max ${this.maxSwapCostBps}bps`);
        cost = Math.max(0, quote.costBps) / 1e4;
        plan = planLoopSteps(st.loop, equity, targetLtv, { ...base, swapCostFrac: cost });
      }
      if (plan.finalLtv > maxLtv + 1e-6) return fail(`projected LTV ${pct(plan.finalLtv)} would exceed maxLtv ${pct(maxLtv)}`);
      const equityUsd = unitsToUsd(equity, await ctx.priceUsd(pc.collateral), pc.collateral.decimals);
      const summary = `plan: +${equity} ${pc.collateral.symbol} collateral, ${plan.iterations} borrow->swap->supply iteration(s), projected LTV ${pct(plan.finalLtv)} (target ${pct(targetLtv)}${plan.reachedTarget ? "" : ", not reached within maxLoopIterations / liquidity / min loan"})`;

      if (ctx.dryRun) {
        const b1 = plan.steps.find((s) => s.kind === "borrow");
        const reqs = [
          ...(await this.approveReqs(pc.collateral.address as Address, this.morpho, equity)),
          this.supplyCollateralReq(pc, st.params, equity),
          ...(b1 && b1.kind === "borrow" ? [this.borrowReq(pc, st.params, b1.assets)] : []),
        ];
        const sim = await simulateBundle(this.env, ctx, reqs);
        txs.push(...sim.records);
        const notes = [
          summary,
          sim.bundled ? `simulated ${reqs.length} dependent call(s) in sequence` : sim.note,
          quote ? `swap #1 ${quote.route} quoted ${quote.costBps}bps` : undefined,
          plan.iterations > 0 ? "swaps and iterations 2+ not simulated (they need the borrowed funds / swap output)" : undefined,
        ];
        return { ok: true, txs, amountUsd: equityUsd, detail: notes.filter(Boolean).join("; ") };
      }

      txs.push(...(await ensureAllowance(this.env, ctx, pc.collateral.address as Address, this.morpho, equity)));
      txs.push(await sendTx(this.env, ctx, this.supplyCollateralReq(pc, st.params, equity)));
      let iters = 0;
      while (iters < ctx.limits.maxLoopIterations) {
        const cur = await this.state(pc);
        const next = planLoopSteps(cur.loop, 0n, targetLtv, this.planParams(cur, ctx, cost, 1, dust));
        const b = next.steps.find((s) => s.kind === "borrow");
        if (!b || b.kind !== "borrow") break;
        txs.push(await sendTx(this.env, ctx, this.borrowReq(pc, cur.params, b.assets)));
        const sw = await this.swapMeasured(pc.debt, pc.collateral, b.assets, ctx, txs);
        cost = Math.max(0, sw.costBps) / 1e4;
        if (sw.received === 0n) throw new Error(`swap returned no ${pc.collateral.symbol}; ${b.assets} ${pc.debt.symbol} left in the wallet`);
        txs.push(...(await ensureAllowance(this.env, ctx, pc.collateral.address as Address, this.morpho, sw.received)));
        txs.push(await sendTx(this.env, ctx, this.supplyCollateralReq(pc, cur.params, sw.received)));
        iters++;
      }
      const fin = await this.state(pc);
      const ltv = oracleLtv(fin.collateral, fin.debt, fin.price);
      return { ok: true, txs, amountUsd: equityUsd, detail: `${this.id} open ${pairId}: ${iters} iteration(s), LTV ${pct(ltv)} (target ${pct(targetLtv)})` };
    } catch (e) {
      return fail(msg(e) + this.broadcastNote(txs));
    }
  }

  async close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    if (!(fraction > 0 && fraction <= 1)) return { ok: false, txs: [], detail: `${this.id} close ${pairId}: fraction ${fraction} not in (0,1]` };
    return this.unwind(pairId, { kind: "fraction", fraction }, ctx, "close");
  }

  async deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    if (!(targetLtv >= 0 && targetLtv < 1)) return { ok: false, txs: [], detail: `${this.id} deleverage ${pairId}: target ${targetLtv} not in [0,1)` };
    return this.unwind(pairId, { kind: "ltv", ltv: targetLtv }, ctx, "deleverage");
  }

  private async unwind(pairId: string, target: UnwindTarget, ctx: LiveContext, label: "close" | "deleverage"): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    const fail = (detail: string): LiveResult => ({ ok: false, txs, detail: `${this.id} ${label} ${pairId}: ${detail}` });
    try {
      const pc = this.pair(pairId);
      const st0 = await this.state(pc);
      if (st0.collateral === 0n && st0.borrowShares === 0n) return { ok: true, txs, detail: `${this.id} ${label} ${pairId}: no position` };
      if (await this.isPaused()) return fail("protocol is paused");
      if (st0.debt > 0n && !this.swapper) return fail("no swapper configured (needed to sell collateral for the loan token)");
      const dust = await this.dust(pc, ctx);
      const base = this.planParams(st0, ctx, 0, ctx.limits.maxLoopIterations, dust, true);
      if (base.stepLtvCap > fromWad(st0.params.lltv) * this.stepLtvFactor)
        ctx.log("warn", `${this.id} ${label} ${pairId}: LTV ${pct(oracleLtv(st0.collateral, st0.debt, st0.price))} is above the step cap; unwinding with steps up to 99% of LLTV`);
      let plan = planUnwindSteps(st0.loop, target, base);
      let cost = 0;
      let quote: SwapQuote | undefined;
      const s0 = plan.steps.find((s) => s.kind === "swapToLoan");
      if (s0 && s0.kind === "swapToLoan") {
        quote = await this.swapper!.quote(pc.collateral, pc.debt, s0.collateralIn, ctx);
        if (!(quote.costBps <= this.maxSwapCostBps)) return fail(`swap ${pc.collateral.symbol}->${pc.debt.symbol} via ${quote.route} costs ${quote.costBps}bps > max ${this.maxSwapCostBps}bps`);
        cost = Math.max(0, quote.costBps) / 1e4;
        plan = planUnwindSteps(st0.loop, target, { ...base, swapCostFrac: cost });
      }
      const resolved = resolveUnwindTarget(st0.loop, target, { ...base, swapCostFrac: cost });
      const summary = `plan: ${plan.iterations} withdraw->swap->repay iteration(s), projected LTV ${pct(plan.finalLtv)}, debt ${plan.final.debt}${plan.reachedTarget ? "" : " — target NOT reachable within maxLoopIterations"}`;

      if (ctx.dryRun) {
        const first = plan.steps[0];
        if (first && first.kind === "withdrawCollateral") txs.push(await sendTx(this.env, ctx, this.withdrawCollateralReq(pc, st0.params, first.assets)));
        const notes = [summary, quote ? `swap #1 ${quote.route} quoted ${quote.costBps}bps` : undefined, plan.iterations > 0 ? "only step 1 (withdrawCollateral) simulated; swap/repay need its output" : undefined];
        return { ok: plan.reachedTarget, txs, detail: `${this.id} ${label} ${pairId}: ${notes.filter(Boolean).join("; ")}` };
      }

      const collBefore = await this.walletBalance(pc.collateral);
      let repaid = 0n;
      let withdrawn = 0n;
      let got = 0n;
      let spent = 0n;
      let iters = 0;
      for (let guard = 0; guard <= ctx.limits.maxLoopIterations + 1; guard++) {
        const cur = await this.state(pc);
        const remaining: UnwindTarget = {
          kind: "repay",
          repay: resolved.repay === "all" ? "all" : resolved.repay > repaid ? resolved.repay - repaid : 0n,
          withdrawTotal:
            resolved.withdrawTotal === undefined ? undefined : resolved.withdrawTotal === "all" ? "all" : resolved.withdrawTotal > withdrawn ? resolved.withdrawTotal - withdrawn : 0n,
        };
        const next = planUnwindSteps(cur.loop, remaining, this.planParams(cur, ctx, cost, iters < ctx.limits.maxLoopIterations ? 1 : 0, dust, true));
        const w = next.steps[0];
        if (!w || w.kind !== "withdrawCollateral") break;
        txs.push(await sendTx(this.env, ctx, this.withdrawCollateralReq(pc, cur.params, w.assets)));
        withdrawn += w.assets;
        if (next.steps[1]?.kind !== "swapToLoan") break; // that was the final withdraw
        const sw = await this.swapMeasured(pc.collateral, pc.debt, w.assets, ctx, txs);
        cost = Math.max(0, sw.costBps) / 1e4;
        got += sw.received;
        const now = await this.state(pc);
        const wantAll = resolved.repay === "all" || (remaining.repay as bigint) >= now.debt;
        // 1 bp + 1 wei covers interest accrued until inclusion when repaying by shares.
        const buffered = now.debt + MathLib.mulDivUp(now.debt, 1n, 10_000n) + 1n;
        if (wantAll && sw.received >= buffered) {
          txs.push(...(await ensureAllowance(this.env, ctx, pc.debt.address as Address, this.morpho, buffered)));
          txs.push(await sendTx(this.env, ctx, this.repayReq(pc, now.params, 0n, now.borrowShares)));
          repaid += now.debt;
          spent += now.debt;
        } else {
          let amt = min(sw.received, now.debt);
          if (resolved.repay !== "all") amt = min(amt, remaining.repay as bigint);
          if (amt > 0n) {
            txs.push(...(await ensureAllowance(this.env, ctx, pc.debt.address as Address, this.morpho, amt)));
            txs.push(await sendTx(this.env, ctx, this.repayReq(pc, now.params, amt, 0n)));
            repaid += amt;
            spent += amt;
          }
        }
        iters++;
      }

      let leftoverNote = "";
      const leftover = got > spent ? got - spent : 0n;
      if (label === "close" && leftover > dust && this.swapper) {
        try {
          const back = await this.swapMeasured(pc.debt, pc.collateral, min(leftover, await this.walletBalance(pc.debt)), ctx, txs);
          leftoverNote = `; swapped leftover ${leftover} ${pc.debt.symbol} back to ${back.received} ${pc.collateral.symbol}`;
        } catch (e) {
          leftoverNote = `; leftover ${leftover} ${pc.debt.symbol} stays in the wallet (${msg(e)})`;
        }
      } else if (leftover > dust) leftoverNote = `; ${leftover} ${pc.debt.symbol} swap surplus stays in the wallet`;
      const fin = await this.state(pc);
      const collAfter = await this.walletBalance(pc.collateral);
      const returned = collAfter > collBefore ? collAfter - collBefore : 0n;
      const finLtv = oracleLtv(fin.collateral, fin.debt, fin.price);
      const reached =
        target.kind === "ltv"
          ? finLtv <= target.ltv + 1e-6
          : resolved.repay === "all"
            ? fin.borrowShares === 0n && (resolved.withdrawTotal !== "all" || fin.collateral === 0n)
            : repaid >= (resolved.repay as bigint);
      return {
        ok: reached,
        txs,
        amountUsd: unitsToUsd(returned, await ctx.priceUsd(pc.collateral), pc.collateral.decimals),
        detail: `${this.id} ${label} ${pairId}: ${iters} iteration(s), LTV ${pct(finLtv)}, debt ${fin.debt}, collateral ${fin.collateral}, returned ${returned} ${pc.collateral.symbol}${reached ? "" : " — target NOT reached (maxLoopIterations); call again"}${leftoverNote}`,
      };
    } catch (e) {
      return fail(msg(e) + this.broadcastNote(txs));
    }
  }

  /**
   * Proves the exit path right now: the full sell size quotes within
   * maxSwapCostBps (depth), the plan completes within maxLoopIterations, and
   * the first withdrawCollateral simulates. The swap/repay legs depend on the
   * withdrawn collateral and cannot be simulated without a flash loan.
   */
  async simulateClose(pairId: string, ctx: LiveContext): Promise<boolean> {
    const dry: LiveContext = { ...ctx, dryRun: true };
    try {
      const pc = this.pair(pairId);
      const st = await this.state(pc);
      if (st.collateral === 0n && st.borrowShares === 0n) return true;
      if (await this.isPaused()) {
        ctx.log("warn", `${this.id} simulateClose ${pairId}: protocol paused`);
        return false;
      }
      if (st.debt === 0n) {
        await sendTx(this.env, dry, this.withdrawCollateralReq(pc, st.params, st.collateral));
        return true;
      }
      if (!this.swapper) {
        ctx.log("warn", `${this.id} simulateClose ${pairId}: no swapper`);
        return false;
      }
      const dust = await this.dust(pc, dry);
      const base = this.planParams(st, dry, 0, dry.limits.maxLoopIterations, dust, true);
      const buf = BigInt(base.sellBufferBps ?? 0);
      const sellAll = (loanToCollateral(st.debt, st.price, "Up") * (10_000n + buf)) / 10_000n;
      const q = await this.swapper.quote(pc.collateral, pc.debt, min(sellAll, st.collateral), dry);
      if (!(q.costBps <= this.maxSwapCostBps)) {
        ctx.log("warn", `${this.id} simulateClose ${pairId}: selling ${sellAll} ${pc.collateral.symbol} costs ${q.costBps}bps > ${this.maxSwapCostBps}bps`);
        return false;
      }
      const plan = planUnwindSteps(st.loop, { kind: "fraction", fraction: 1 }, { ...base, swapCostFrac: Math.max(0, q.costBps) / 1e4 });
      if (!plan.reachedTarget) {
        ctx.log("warn", `${this.id} simulateClose ${pairId}: full close needs more than ${dry.limits.maxLoopIterations} iterations`);
        return false;
      }
      const first = plan.steps[0];
      if (first && first.kind === "withdrawCollateral") await sendTx(this.env, dry, this.withdrawCollateralReq(pc, st.params, first.assets));
      return true;
    } catch (e) {
      ctx.log("warn", `${this.id} simulateClose ${pairId} failed: ${msg(e)}`);
      return false;
    }
  }

  async claimRewards(_ctx: LiveContext, _pairId?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }> {
    return {
      ok: true,
      txs: [],
      claimed: [],
      detail: `${this.id}: Morpho Blue has no protocol-native rewards; Merkl campaigns on Morpho markets are claimed by the rewards module (Merkl distributor)`,
    };
  }

  // -------------------------------------------------------------------------
  // verify
  // -------------------------------------------------------------------------

  /** Reads every configured address / market back on-chain. Empty = OK for live. */
  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    const pub = this.env.publicClient;
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        issues.push(`${label}: ${msg(e)}`);
      }
    };
    await attempt("chainId", () => assertChainId(this.env));
    const code = await pub.getCode({ address: this.morpho }).catch(() => undefined);
    if (!code || code === "0x") return [...issues, `${this.id}: morpho ${this.morpho} has no code on ${this.chain}`];
    if (this.flavor === "morpho" && this.registryMorpho && !isAddressEqual(this.registryMorpho, this.morpho) && !this.trustConfiguredMorpho)
      issues.push(`${this.id}: morpho ${this.morpho} differs from the @morpho-org/blue-sdk registry (${this.registryMorpho}); set trustConfiguredMorpho for an intended fork`);
    if (this.flavor === "lista")
      await attempt(`${this.id}: paused()`, async () => {
        if (await this.isPaused()) issues.push(`${this.id}: Moolah is paused`);
      });
    if (!this.swapper) issues.push(`${this.id}: no swapper configured: loops cannot be opened or closed`);

    for (const pc of this.pairs.values()) {
      const tag = `${this.id} ${pc.pairId}`;
      for (const a of [pc.collateral, pc.debt]) if (a.chain !== this.chain) issues.push(`${tag}: ${a.symbol} is on ${a.chain}, adapter is on ${this.chain}`);
      for (const a of [pc.collateral, pc.debt]) await attempt(`${tag}: ${a.symbol}`, async () => void issues.push(...(await verifyAsset(this.env, a))));
      let p: MarketParamsTuple;
      try {
        p = await this.readParams(pc);
      } catch (e) {
        issues.push(`${tag}: idToMarketParams: ${msg(e)}`);
        continue;
      }
      const pp = this.paramsProblems(pc, p);
      issues.push(...pp.map((x) => `${this.id}: ${x}`));
      if (pp.length) continue;
      await attempt(`${tag}: market()`, async () => {
        const [, , , , lastUpdate] = await pub.readContract({ address: this.morpho, abi: blueAbi, functionName: "market", args: [pc.marketId] });
        if (lastUpdate === 0n) issues.push(`${tag}: market not created`);
      });
      if (this.flavor === "morpho") {
        const oc = await pub.getCode({ address: p.oracle }).catch(() => undefined);
        if (!oc || oc === "0x") issues.push(`${tag}: oracle ${p.oracle} has no code`);
      }
      await attempt(`${tag}: oracle price`, async () => {
        const price = await this.oraclePrice(p);
        if (!(price > 0n)) issues.push(`${tag}: oracle price is 0`);
      });
      if (p.irm !== zeroAddress)
        await attempt(`${tag}: irm ${p.irm}`, async () => {
          const s = await this.readMarket(pc, p, await this.blockTs());
          void s;
        });
      if (this.flavor === "lista") {
        const id = pc.marketId;
        await attempt(`${tag}: minLoan`, async () => void (await this.minDebt(p)));
        await attempt(`${tag}: isWhiteList`, async () => {
          if (!(await pub.readContract({ address: this.morpho, abi: listaMoolahAbi, functionName: "isWhiteList", args: [id, this.env.account] })))
            issues.push(`${tag}: wallet ${this.env.account} is not whitelisted for this market`);
        });
        await attempt(`${tag}: brokers`, async () => {
          const b = await pub.readContract({ address: this.morpho, abi: listaMoolahAbi, functionName: "brokers", args: [id] });
          if (b !== zeroAddress) issues.push(`${tag}: market has broker ${b} (only the broker may borrow/repay)`);
        });
        await attempt(`${tag}: providers`, async () => {
          const pr = await pub.readContract({ address: this.morpho, abi: listaMoolahAbi, functionName: "providers", args: [id, p.collateralToken] });
          if (pr !== zeroAddress) issues.push(`${tag}: collateral has provider ${pr} (supplyCollateral must go through it)`);
        });
      }
    }
    return issues;
  }
}
