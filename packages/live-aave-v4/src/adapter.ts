/**
 * Aave V4 (hub & spoke) LendingAdapter.
 *
 * Security model
 *  - Every spoke call is ENCODED HERE from the verified ISpoke ABI (abi.ts)
 *    and checked by the tx guard (guard.ts) before it reaches sendTx
 *    (simulate -> gas cap -> dry-run stop -> send). AaveKit's server-built
 *    calldata is never signed; with `apiCrossCheck` AaveKit's plan for the
 *    same action must decode to exactly our call or we refuse.
 *  - Health-, rate- and cap-critical numbers are read ON-CHAIN, pinned to one
 *    block (dataAsOfMs = that block's timestamp). AaveKit only adds reward
 *    metadata and identity / consistency cross-checks.
 *  - Approvals are exact (no unlimited), spender = the configured spoke.
 *
 * Looping is iterative (no native flash loan in V4; AaveKit leverageQuote is
 * an intent/order flow with signatures, not a verifiable one-shot path):
 *   [approve] + multicall(supply equity, enable collateral, borrow b1)
 *   then repeat: swap b_i -> collateral (injected SwapAdapter), [approve] +
 *   multicall(supply out_i, borrow b_{i+1}) — each borrow sized from fresh
 *   on-chain state so LTV never exceeds the target.
 */
import { formatUnits, getAddress, isAddress, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import { bigDecimal, chainId as akChainId, evmAddress, ReservesRequestFilter, type ExecutionPlan, type Reserve } from "@aave/client";
import type { LoopPair, RewardRate } from "@incentive-router/core";
import {
  BroadcastUnconfirmedError,
  type AssetRef,
  type LendingAdapter,
  type LiveContext,
  type LiveResult,
  type Logger,
  type LoopPositionView,
  type SwapAdapter,
  type TxRecord,
} from "@incentive-router/live-common";
import { assertChainId, call, erc20Abi, erc20Balance, sendTx, verifyAsset, type EvmEnv, type TxRequest } from "@incentive-router/live-evm-base";
import { EIP1967_IMPLEMENTATION_SLOT, HUB_ABI, IRM_ABI, ORACLE_ABI, SPOKE_ABI, SPOKE_WRITE_FUNCTIONS } from "./abi.js";
import { aaveKitApi, pctValue, rewardsFromApiReserve, type AaveV4Api } from "./api.js";
import { AAVE_V4_PROTOCOL, aaveV4AdapterId, type AaveV4AdapterOptions, type AaveV4PairConfig } from "./config.js";
import { assertTx, checkTx, normalizeAddresses, TxGuardError, type SpokeCallSpec, type TxGuardPolicy } from "./guard.js";
import { exitBlockers, mapLoopPair, type PairStatus, type ReserveMarketData } from "./market.js";
import {
  MAX_UINT256,
  ORACLE_DECIMALS,
  RAY,
  fromHumanFloor,
  nextLoopBorrow,
  oraclePriceToUsd,
  planLoopSteps,
  planUnwind,
  toHuman,
  unwindStep,
  validateTargetLtv,
  valueRayToUsd,
  valueToUsd,
  wadToHealthFactor,
  type UnwindGoal,
  type UnwindParams,
} from "./math.js";

// ---------------------------------------------------------------------------
// On-chain struct shapes as decoded by viem (uint<=48 -> number, larger -> bigint)
// ---------------------------------------------------------------------------

interface SpokeReserveStruct {
  underlying: Address;
  hub: Address;
  assetId: number;
  decimals: number;
  collateralRisk: number;
  flags: number;
  dynamicConfigKey: number;
}
interface ReserveConfigStruct {
  collateralRisk: number;
  paused: boolean;
  frozen: boolean;
  borrowable: boolean;
  receiveSharesEnabled: boolean;
}
interface DynamicConfigStruct {
  collateralFactor: number;
  maxLiquidationBonus: number;
  liquidationFee: number;
}
interface UserPositionStruct {
  drawnShares: bigint;
  premiumShares: bigint;
  premiumOffsetRay: bigint;
  suppliedShares: bigint;
  dynamicConfigKey: number;
}
interface UserAccountDataStruct {
  riskPremium: bigint;
  avgCollateralFactor: bigint;
  healthFactor: bigint;
  totalCollateralValue: bigint;
  totalDebtValueRay: bigint;
  activeCollateralCount: bigint;
  borrowCount: bigint;
}
interface HubAssetStruct {
  liquidity: bigint;
  swept: bigint;
  liquidityFee: number;
  irStrategy: Address;
  underlying: Address;
  decimals: number;
}
interface HubSpokeDataStruct {
  addCap: number | bigint;
  drawCap: number | bigint;
  active: boolean;
  halted: boolean;
  deficitRay: bigint;
}
interface IrmDataStruct {
  optimalUsageRatio: number;
  baseDrawnRate: number;
  rateGrowthBeforeOptimal: number;
  rateGrowthAfterOptimal: number;
}

interface ResolvedPair {
  cfg: AaveV4PairConfig;
  collId: bigint;
  debtId: bigint;
  same: boolean;
  collToken: Address;
  debtToken: Address;
}

export interface ReserveSnapshot extends ReserveMarketData {
  hub: Address;
  assetId: bigint;
  dynamicConfigKey: number;
}

export interface UserSnapshot {
  /** Collateral reserve supply (assets). */
  supplied: bigint;
  /** Debt reserve total debt (drawn + premium). */
  debt: bigint;
  usingAsCollateral: boolean;
  /** Collateral factor pinned to the user's dynamic config key (what liquidation uses now). */
  pinnedCollateralFactorBps: number;
  accountRiskPremiumBps: number;
  lastRiskPremiumBps: number;
  healthFactor: number;
  accountCollateralUsd: number;
  accountDebtUsd: number;
}

export interface PairSnapshot {
  blockNumber: bigint;
  timestampMs: number;
  oracle: Address;
  coll: ReserveSnapshot;
  debt: ReserveSnapshot;
  user: UserSnapshot;
}

type ReadCall = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };

const lc = (a: string) => a.toLowerCase();
const sameAddr = (a: string, b: string) => lc(a) === lc(b);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
const minB = (a: bigint, b: bigint) => (a < b ? a : b);
const noopLog: Logger = () => {};
/** A tx of ours was signed + submitted but not confirmed: it may still land. */
const isUnconfirmed = (e: unknown): e is BroadcastUnconfirmedError =>
  e instanceof BroadcastUnconfirmedError || (e instanceof Error && e.name === "BroadcastUnconfirmedError");
/** Accrual margin on a repay meant to clear the debt (1 bp + 1 wei); leftover allowance is reset afterwards. */
const repayMargin = (debt: bigint) => debt / 10_000n + 1n;

export class AaveV4Adapter implements LendingAdapter {
  readonly id: string;
  readonly chain: string;
  readonly protocol = AAVE_V4_PROTOCOL;

  private readonly env: EvmEnv;
  private readonly api: AaveV4Api | null;
  private readonly spoke: Address;
  private readonly hubs: Address[];
  private readonly pairs: AaveV4PairConfig[];
  private readonly swapper?: SwapAdapter;
  private readonly log: Logger;
  private readonly policy: TxGuardPolicy;
  private readonly now: () => number;
  private readonly resolved = new Map<string, ResolvedPair>();
  private readonly statuses = new Map<string, PairStatus>();
  private readonly warned = new Set<string>();
  private claimCache?: { atMs: number; items: LoopPositionView["rewardsUnclaimed"] };

  constructor(private readonly o: AaveV4AdapterOptions) {
    const s = o.spoke;
    if (s.chain !== o.env.chain) throw new Error(`AaveV4Adapter: spoke chain "${s.chain}" != env chain "${o.env.chain}"`);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(s.spokeName)) throw new Error(`AaveV4Adapter: invalid spokeName "${s.spokeName}"`);
    this.env = o.env;
    this.chain = s.chain;
    this.id = aaveV4AdapterId(s);
    this.spoke = normalizeAddresses([s.spoke])[0]!;
    this.hubs = normalizeAddresses([s.hub, ...(s.extraHubs ?? [])]);
    this.pairs = o.pairs;
    this.swapper = o.swapper;
    this.log = o.log ?? noopLog;
    this.now = o.now ?? Date.now;
    this.api = o.api === null ? null : (o.api ?? aaveKitApi(o.client));
    const ids = new Set<string>();
    const tokens: Address[] = [];
    for (const p of o.pairs) {
      if (ids.has(p.pairId)) throw new Error(`AaveV4Adapter: duplicate pairId ${p.pairId}`);
      ids.add(p.pairId);
      for (const a of [p.collateral, p.debt]) {
        if (a.chain !== s.chain) throw new Error(`AaveV4Adapter ${p.pairId}: asset ${a.symbol} is on ${a.chain}, adapter on ${s.chain}`);
        if (!isAddress(a.address)) throw new Error(`AaveV4Adapter ${p.pairId}: invalid address for ${a.symbol}`);
        tokens.push(getAddress(a.address));
      }
    }
    if (o.swapper && o.swapper.chain !== s.chain) throw new Error(`AaveV4Adapter: swapper is on ${o.swapper.chain}, adapter on ${s.chain}`);
    this.policy = {
      chainId: o.env.viemChain.id,
      account: o.env.account,
      spokes: [this.spoke],
      positionManagers: normalizeAddresses(s.positionManagers),
      tokens,
      extraTargets: normalizeAddresses(o.allowedTargets),
      allowUndecoded: normalizeAddresses(o.allowUndecodedTargets),
    };
  }

  // =========================================================================
  // Reads
  // =========================================================================

  private warnOnce(key: string, msg: string, data?: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log("warn", `${this.id}: ${msg}`, data);
  }

  private pairCfg(pairId: string): AaveV4PairConfig {
    const p = this.pairs.find((x) => x.pairId === pairId);
    if (!p) throw new Error(`${this.id}: unknown pair ${pairId}`);
    return p;
  }

  /** Batched reads at one block (Multicall3, falling back to individual eth_calls). */
  private async readAll(calls: ReadCall[], blockNumber?: bigint): Promise<unknown[]> {
    const pc = this.env.publicClient;
    const bn = blockNumber !== undefined ? { blockNumber } : {};
    try {
      const mc = pc.multicall as unknown as (p: object) => Promise<unknown[]>;
      return await mc({ contracts: calls, allowFailure: false, ...bn });
    } catch {
      const rc = pc.readContract as unknown as (p: object) => Promise<unknown>;
      return Promise.all(calls.map((c) => rc({ ...c, ...bn })));
    }
  }

  private async read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint): Promise<T> {
    const rc = this.env.publicClient.readContract as unknown as (p: object) => Promise<T>;
    return rc({ address, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) });
  }

  private async discoverReserveId(asset: AssetRef): Promise<bigint> {
    const errors: string[] = [];
    for (const hub of this.hubs) {
      try {
        const assetId = await this.read<bigint>(hub, HUB_ABI as Abi, "getAssetId", [getAddress(asset.address)]);
        return await this.read<bigint>(this.spoke, SPOKE_ABI as Abi, "getReserveId", [hub, assetId]);
      } catch (e) {
        errors.push(`${hub}: ${errMsg(e)}`);
      }
    }
    throw new Error(`${asset.symbol} (${asset.address}) is not a reserve of spoke ${this.spoke} on hub(s) ${this.hubs.join(", ")} [${errors.join(" | ")}]`);
  }

  private async resolvePair(cfg: AaveV4PairConfig): Promise<ResolvedPair> {
    const hit = this.resolved.get(cfg.pairId);
    if (hit) return hit;
    const same = sameAddr(cfg.collateral.address, cfg.debt.address);
    const collId = cfg.collateralReserveId !== undefined ? BigInt(cfg.collateralReserveId) : await this.discoverReserveId(cfg.collateral);
    const debtId = same ? collId : cfg.debtReserveId !== undefined ? BigInt(cfg.debtReserveId) : await this.discoverReserveId(cfg.debt);
    const r: ResolvedPair = { cfg, collId, debtId, same, collToken: getAddress(cfg.collateral.address), debtToken: getAddress(cfg.debt.address) };
    this.resolved.set(cfg.pairId, r);
    return r;
  }

  private async legPrice(asset: AssetRef, oracleUsd: number): Promise<number> {
    if (!this.o.priceUsd) return oracleUsd;
    try {
      const p = await this.o.priceUsd(asset);
      if (Number.isFinite(p) && p > 0) return p;
      throw new Error(`invalid price ${p}`);
    } catch (e) {
      this.warnOnce(`px:${asset.symbol}`, `no market price for ${asset.symbol} (${errMsg(e)}); using the protocol oracle (depeg detection blind)`);
      return oracleUsd;
    }
  }

  private async readReserve(asset: AssetRef, reserveId: bigint, oracle: Address, bn: bigint): Promise<ReserveSnapshot> {
    const S = SPOKE_ABI as Abi;
    const H = HUB_ABI as Abi;
    const [reserve, config, price, supplied, rdebt] = (await this.readAll(
      [
        { address: this.spoke, abi: S, functionName: "getReserve", args: [reserveId] },
        { address: this.spoke, abi: S, functionName: "getReserveConfig", args: [reserveId] },
        { address: oracle, abi: ORACLE_ABI as Abi, functionName: "getReservePrice", args: [reserveId] },
        { address: this.spoke, abi: S, functionName: "getReserveSuppliedAssets", args: [reserveId] },
        { address: this.spoke, abi: S, functionName: "getReserveDebt", args: [reserveId] },
      ],
      bn
    )) as [SpokeReserveStruct, ReserveConfigStruct, bigint, bigint, readonly [bigint, bigint]];
    // Never act on a reserve that is not exactly the configured asset.
    if (!sameAddr(reserve.underlying, asset.address))
      throw new Error(`reserve ${reserveId} underlying ${reserve.underlying} != configured ${asset.symbol} ${asset.address}`);
    if (Number(reserve.decimals) !== asset.decimals) throw new Error(`reserve ${reserveId} decimals ${reserve.decimals} != configured ${asset.decimals}`);
    if (!this.hubs.some((h) => sameAddr(h, reserve.hub))) throw new Error(`reserve ${reserveId} is on hub ${reserve.hub}, not a configured hub`);
    const hub = getAddress(reserve.hub);
    const assetId = BigInt(reserve.assetId);
    const [dyn, hubAsset, drawnRate, owed, added, spokeData, spokeAdded, spokeOwed] = (await this.readAll(
      [
        { address: this.spoke, abi: S, functionName: "getDynamicReserveConfig", args: [reserveId, Number(reserve.dynamicConfigKey)] },
        { address: hub, abi: H, functionName: "getAsset", args: [assetId] },
        { address: hub, abi: H, functionName: "getAssetDrawnRate", args: [assetId] },
        { address: hub, abi: H, functionName: "getAssetOwed", args: [assetId] },
        { address: hub, abi: H, functionName: "getAddedAssets", args: [assetId] },
        { address: hub, abi: H, functionName: "getSpoke", args: [assetId, this.spoke] },
        { address: hub, abi: H, functionName: "getSpokeAddedAssets", args: [assetId, this.spoke] },
        { address: hub, abi: H, functionName: "getSpokeOwed", args: [assetId, this.spoke] },
      ],
      bn
    )) as [DynamicConfigStruct, HubAssetStruct, bigint, readonly [bigint, bigint], bigint, HubSpokeDataStruct, bigint, readonly [bigint, bigint]];
    let irm: IrmDataStruct | undefined;
    try {
      irm = await this.read<IrmDataStruct>(getAddress(hubAsset.irStrategy), IRM_ABI as Abi, "getInterestRateData", [assetId], bn);
    } catch (e) {
      this.warnOnce(`irm:${hub}:${assetId}`, `cannot read IRM of ${asset.symbol} (${errMsg(e)}); borrow rate ramp falls back to the core's uncertainty model`);
    }
    const oraclePriceUsd = oraclePriceToUsd(price, ORACLE_DECIMALS);
    return {
      reserveId,
      symbol: asset.symbol,
      address: getAddress(asset.address),
      decimals: asset.decimals,
      priceUsd: await this.legPrice(asset, oraclePriceUsd),
      oraclePriceUsd,
      reserveSupplied: supplied,
      reserveDrawn: rdebt[0],
      reservePremium: rdebt[1],
      collateralFactorBps: Number(dyn.collateralFactor),
      collateralRiskBps: Number(reserve.collateralRisk),
      paused: config.paused,
      frozen: config.frozen,
      borrowable: config.borrowable,
      hubLiquidity: BigInt(hubAsset.liquidity),
      hubSwept: BigInt(hubAsset.swept),
      hubDrawn: owed[0],
      hubPremium: owed[1],
      hubAdded: added,
      liquidityFeeBps: Number(hubAsset.liquidityFee),
      drawnRateRay: drawnRate,
      irm: irm
        ? {
            optimalUsageRatio: Number(irm.optimalUsageRatio),
            baseDrawnRate: Number(irm.baseDrawnRate),
            rateGrowthBeforeOptimal: Number(irm.rateGrowthBeforeOptimal),
            rateGrowthAfterOptimal: Number(irm.rateGrowthAfterOptimal),
          }
        : undefined,
      spokeActive: spokeData.active,
      spokeHalted: spokeData.halted,
      addCap: BigInt(spokeData.addCap),
      drawCap: BigInt(spokeData.drawCap),
      spokeAdded,
      spokeDrawn: spokeOwed[0],
      spokePremium: spokeOwed[1],
      spokeDeficit: (BigInt(spokeData.deficitRay) + RAY - 1n) / RAY,
      hub,
      assetId,
      dynamicConfigKey: Number(reserve.dynamicConfigKey),
    };
  }

  /** One consistent on-chain snapshot of a pair (both reserves + our account), pinned to the latest block. */
  async snapshot(pairOrId: string | ResolvedPair): Promise<PairSnapshot> {
    const rp = typeof pairOrId === "string" ? await this.resolvePair(this.pairCfg(pairOrId)) : pairOrId;
    const block = await this.env.publicClient.getBlock({ blockTag: "latest" });
    const bn = block.number as bigint;
    const timestampMs = Number(block.timestamp) * 1000;
    const maxStale = this.o.maxStaleMs ?? 5 * 60_000;
    if (this.now() - timestampMs > maxStale)
      this.log("warn", `${this.id}: RPC latest block ${bn} is ${Math.round((this.now() - timestampMs) / 1000)}s old`);
    const oracle = getAddress(await this.read<Address>(this.spoke, SPOKE_ABI as Abi, "ORACLE", [], bn));
    const coll = await this.readReserve(rp.cfg.collateral, rp.collId, oracle, bn);
    const debt = rp.same ? coll : await this.readReserve(rp.cfg.debt, rp.debtId, oracle, bn);
    const me = this.env.account;
    const S = SPOKE_ABI as Abi;
    const [supplied, totalDebt, status, upos, acct, lastRp] = (await this.readAll(
      [
        { address: this.spoke, abi: S, functionName: "getUserSuppliedAssets", args: [rp.collId, me] },
        { address: this.spoke, abi: S, functionName: "getUserTotalDebt", args: [rp.debtId, me] },
        { address: this.spoke, abi: S, functionName: "getUserReserveStatus", args: [rp.collId, me] },
        { address: this.spoke, abi: S, functionName: "getUserPosition", args: [rp.collId, me] },
        { address: this.spoke, abi: S, functionName: "getUserAccountData", args: [me] },
        { address: this.spoke, abi: S, functionName: "getUserLastRiskPremium", args: [me] },
      ],
      bn
    )) as [bigint, bigint, readonly [boolean, boolean], UserPositionStruct, UserAccountDataStruct, bigint];
    let pinned = coll.collateralFactorBps;
    if (BigInt(upos.suppliedShares) > 0n && Number(upos.dynamicConfigKey) !== coll.dynamicConfigKey) {
      const d = await this.read<DynamicConfigStruct>(this.spoke, S, "getDynamicReserveConfig", [rp.collId, Number(upos.dynamicConfigKey)], bn);
      pinned = Number(d.collateralFactor);
    }
    return {
      blockNumber: bn,
      timestampMs,
      oracle,
      coll,
      debt,
      user: {
        supplied,
        debt: totalDebt,
        usingAsCollateral: status[0],
        pinnedCollateralFactorBps: pinned,
        accountRiskPremiumBps: Number(acct.riskPremium),
        lastRiskPremiumBps: Number(lastRp),
        healthFactor: wadToHealthFactor(acct.healthFactor),
        accountCollateralUsd: valueToUsd(acct.totalCollateralValue),
        accountDebtUsd: valueRayToUsd(acct.totalDebtValueRay),
      },
    };
  }

  /**
   * Risk premium (fraction) that applies to OUR debt: the collateral's
   * collateralRisk (exact for a single-collateral position on this spoke),
   * or — with an open position — the max of that, the account's current
   * computed premium and the last applied one (conservative).
   */
  riskPremiumOf(s: PairSnapshot): number {
    let bps = s.coll.collateralRiskBps;
    if (s.user.debt > 0n) bps = Math.max(bps, s.user.accountRiskPremiumBps, s.user.lastRiskPremiumBps);
    return bps / 10_000;
  }

  private static oracleLtv(s: PairSnapshot): number {
    const cv = toHuman(s.user.supplied, s.coll.decimals) * s.coll.oraclePriceUsd;
    const dv = toHuman(s.user.debt, s.debt.decimals) * s.debt.oraclePriceUsd;
    return cv > 0 ? dv / cv : dv > 0 ? Infinity : 0;
  }

  private async apiReserves(): Promise<Map<string, Reserve> | null> {
    if (!this.api) return null;
    try {
      const list = await this.api.reserves({
        query: { spoke: { chainId: akChainId(this.env.viemChain.id), address: evmAddress(this.spoke) } },
        filter: ReservesRequestFilter.All,
      });
      return new Map(list.map((r) => [String(r.onChainId), r]));
    } catch (e) {
      this.warnOnce("api:reserves", `AaveKit unreachable (${errMsg(e)}); continuing with on-chain data only (no API rewards / cross-checks)`);
      return null;
    }
  }

  private async rewardsFor(rp: ResolvedPair, side: "supply" | "borrow", api: Map<string, Reserve> | null): Promise<RewardRate[]> {
    const asset = side === "supply" ? rp.cfg.collateral : rp.cfg.debt;
    const reserveId = side === "supply" ? rp.collId : rp.debtId;
    const out: RewardRate[] = [];
    if (this.o.extraRewards) {
      try {
        out.push(...(await this.o.extraRewards({ protocol: AAVE_V4_PROTOCOL, chain: this.chain, asset, side, marketId: `${this.spoke}:${reserveId}` })));
      } catch (e) {
        this.log("warn", `${this.id} ${rp.cfg.pairId}: extraRewards(${side}) failed: ${errMsg(e)}`);
      }
    }
    const mode = this.o.apiMerklRewards ?? "auto";
    const useApi = mode === "always" || (mode === "auto" && !this.o.extraRewards);
    const res = api?.get(String(reserveId));
    if (useApi && res) {
      const m = rewardsFromApiReserve(res, side, this.now());
      out.push(...m.rewards);
      for (const s of m.skipped) this.warnOnce(`rw:${s.id}`, `${rp.cfg.pairId}: AaveKit reward ${s.id} not counted: ${s.reason}`);
    }
    return out;
  }

  private quoteCtxFor(s: PairSnapshot): LiveContext {
    if (this.o.quoteCtx) return this.o.quoteCtx;
    const px = new Map<string, number>([
      [lc(s.coll.address), s.coll.priceUsd],
      [lc(s.debt.address), s.debt.priceUsd],
    ]);
    return {
      dryRun: true,
      log: this.log,
      limits: { maxGasUsd: {}, maxSlippageBps: 50, maxLoopIterations: 10 },
      priceUsd: async (a) => {
        const p = px.get(lc(a.address));
        if (p !== undefined) return p;
        if (this.o.priceUsd) return this.o.priceUsd(a);
        throw new Error(`no price for ${a.symbol}`);
      },
      nativePriceUsd: async () => {
        throw new Error("quote context has no native price");
      },
    };
  }

  /** swapCostFrac at the smallest probe (worst of both directions) and the largest probe within maxSlippageBps. */
  private async probeSwap(rp: ResolvedPair, s: PairSnapshot): Promise<{ costFrac: number; depthUsd: number }> {
    if (rp.same) return { costFrac: 0, depthUsd: Infinity };
    if (!this.swapper) {
      this.warnOnce(`noswap:${rp.cfg.pairId}`, `${rp.cfg.pairId}: no swapper configured; swap depth reported as 0`);
      return { costFrac: 0.005, depthUsd: 0 };
    }
    const ctx = this.quoteCtxFor(s);
    const sizes = [...(rp.cfg.swapProbeUsd ?? [10_000, 100_000, 1_000_000])].filter((x) => x > 0).sort((a, b) => a - b);
    const budget = ctx.limits.maxSlippageBps;
    const q = async (from: AssetRef, to: AssetRef, usd: number, price: number) => {
      try {
        const r = await this.swapper!.quote(from, to, fromHumanFloor(usd / price, from.decimals), ctx);
        return Number.isFinite(r.costBps) ? r.costBps : Infinity;
      } catch {
        return Infinity;
      }
    };
    let first: number | undefined;
    let depth = 0;
    for (const usd of sizes) {
      const [fwd, rev] = await Promise.all([
        q(rp.cfg.debt, rp.cfg.collateral, usd, s.debt.priceUsd),
        q(rp.cfg.collateral, rp.cfg.debt, usd, s.coll.priceUsd),
      ]);
      const cost = Math.max(fwd, rev);
      if (first === undefined) first = cost;
      if (cost <= budget) depth = usd;
      else break;
    }
    if (first === undefined || !Number.isFinite(first)) {
      this.warnOnce(`swapq:${rp.cfg.pairId}`, `${rp.cfg.pairId}: swap quotes failed; depth 0`);
      return { costFrac: 0.01, depthUsd: 0 };
    }
    return { costFrac: Math.max(0, first) / 10_000, depthUsd: depth };
  }

  private async pairMarket(rp: ResolvedPair, api: Map<string, Reserve> | null): Promise<{ pair: LoopPair; status: PairStatus }> {
    const s = await this.snapshot(rp);
    const [supplyRewards, borrowRewards, swap] = await Promise.all([this.rewardsFor(rp, "supply", api), this.rewardsFor(rp, "borrow", api), this.probeSwap(rp, s)]);
    const hasPos = s.user.supplied > 0n || s.user.debt > 0n;
    const out = mapLoopPair({
      protocol: AAVE_V4_PROTOCOL,
      chain: this.chain,
      pairId: rp.cfg.pairId,
      coll: s.coll,
      debt: s.debt,
      sameAsset: rp.same,
      riskPremiumFrac: this.riskPremiumOf(s),
      supplyRewards,
      borrowRewards,
      swapCostFrac: swap.costFrac,
      swapDepthUsd: swap.depthUsd,
      myLtv: hasPos ? AaveV4Adapter.oracleLtv(s) : undefined,
      dataAsOfMs: s.timestampMs,
    });
    // AaveKit consistency (never overrides on-chain values).
    if (api) {
      for (const [r, label] of [
        [s.coll, "collateral"],
        [s.debt, "debt"],
      ] as const) {
        const a = api.get(String(r.reserveId));
        if (!a) {
          this.warnOnce(`apimiss:${r.reserveId}`, `${rp.cfg.pairId}: AaveKit has no reserve ${r.reserveId} on this spoke`);
          continue;
        }
        const cfApi = pctValue(a.settings.collateralFactor);
        if (label === "collateral" && cfApi !== undefined && Math.abs(cfApi - r.collateralFactorBps / 10_000) > 1e-4)
          this.log("warn", `${this.id} ${rp.cfg.pairId}: AaveKit CF ${cfApi} != on-chain ${r.collateralFactorBps / 10_000}`);
        if (label === "debt" && a.settings.borrowable !== r.borrowable)
          this.log("warn", `${this.id} ${rp.cfg.pairId}: AaveKit borrowable=${a.settings.borrowable} != on-chain ${r.borrowable}`);
      }
    }
    if (!out.status.canOpen) this.log("info", `${this.id} ${rp.cfg.pairId}: entries blocked: ${out.status.reasons.join("; ")}`);
    return out;
  }

  async markets(): Promise<LoopPair[]> {
    const api = await this.apiReserves();
    const out: LoopPair[] = [];
    for (const cfg of this.pairs) {
      try {
        const rp = await this.resolvePair(cfg);
        const m = await this.pairMarket(rp, api);
        this.statuses.set(cfg.pairId, m.status);
        out.push(m.pair);
      } catch (e) {
        this.log("warn", `${this.id} ${cfg.pairId}: markets() failed: ${errMsg(e)}`);
      }
    }
    return out;
  }

  /**
   * Can a loop be opened on this pair right now, and why not? (Answers e.g.
   * "is USDt borrowable against USDe on this spoke" from on-chain data.)
   */
  async pairStatus(pairId: string): Promise<PairStatus> {
    const rp = await this.resolvePair(this.pairCfg(pairId));
    const m = await this.pairMarket(rp, null);
    this.statuses.set(pairId, m.status);
    return m.status;
  }

  /** Last status computed by markets() / pairStatus(). */
  lastPairStatus(pairId: string): PairStatus | undefined {
    return this.statuses.get(pairId);
  }

  async position(pairId: string): Promise<LoopPositionView | null> {
    const s = await this.snapshot(pairId);
    const u = s.user;
    if (u.supplied === 0n && u.debt === 0n) return null;
    const collateralUsd = toHuman(u.supplied, s.coll.decimals) * s.coll.priceUsd;
    const debtUsd = toHuman(u.debt, s.debt.decimals) * s.debt.priceUsd;
    return {
      pairId,
      collateralUsd,
      debtUsd,
      ltv: AaveV4Adapter.oracleLtv(s),
      healthFactor: u.healthFactor,
      equityUsd: collateralUsd - debtUsd,
      rewardsUnclaimed: await this.nonMerklClaimables(),
      asOfMs: s.timestampMs,
    };
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return erc20Balance(this.env, getAddress(asset.address));
  }

  // =========================================================================
  // Transaction building (all guarded)
  // =========================================================================

  private encodeSpokeCall(c: SpokeCallSpec): Hex {
    const me = this.env.account;
    return c.fn === "setUsingAsCollateral"
      ? call(SPOKE_ABI as Abi, "setUsingAsCollateral", [c.reserveId, c.enabled, me])
      : call(SPOKE_ABI as Abi, c.fn, [c.reserveId, c.amount, me]);
  }

  private describe(c: SpokeCallSpec, rp: ResolvedPair): string {
    const a = c.reserveId === rp.collId ? rp.cfg.collateral : rp.cfg.debt;
    if (c.fn === "setUsingAsCollateral") return `setUsingAsCollateral(${a.symbol}, ${c.enabled})`;
    const amt = c.amount === MAX_UINT256 ? "max" : formatUnits(c.amount, a.decimals);
    return `${c.fn} ${amt} ${a.symbol}`;
  }

  /** Spoke call(s) for one step: one multicall (atomic) unless disabled. Every request is guard-checked. */
  private async spokeReqs(calls: SpokeCallSpec[], rp: ResolvedPair): Promise<TxRequest[]> {
    for (const c of calls) await this.crossCheck(c, rp);
    const batch = (this.o.useSpokeMulticall ?? true) && calls.length > 1;
    const groups = batch ? [calls] : calls.map((c) => [c]);
    return groups.map((g) => {
      const data = g.length === 1 ? this.encodeSpokeCall(g[0]!) : call(SPOKE_ABI as Abi, "multicall", [g.map((c) => this.encodeSpokeCall(c))]);
      const req: TxRequest = { to: this.spoke, data, description: `${this.id} ${rp.cfg.pairId}: ${g.map((c) => this.describe(c, rp)).join(" + ")}` };
      assertTx(req, { kind: "spoke", spoke: this.spoke, calls: g }, this.policy);
      return req;
    });
  }

  /** Exact ERC20 approval(s) to the spoke (reset to 0 first when a non-zero allowance must change — USDT style). */
  private async approveReqs(token: Address, symbol: string, amount: bigint): Promise<TxRequest[]> {
    if (amount <= 0n) return [];
    const cur = await this.read<bigint>(token, erc20Abi as Abi, "allowance", [this.env.account, this.spoke]);
    if (cur >= amount) return [];
    const out: TxRequest[] = [];
    if (cur > 0n) out.push({ to: token, data: call(erc20Abi as Abi, "approve", [this.spoke, 0n]), description: `${this.id}: reset ${symbol} allowance -> spoke` });
    out.push({ to: token, data: call(erc20Abi as Abi, "approve", [this.spoke, amount]), description: `${this.id}: approve ${amount} ${symbol} -> spoke` });
    out.forEach((r, i) => assertTx(r, { kind: "approve", token, spender: this.spoke, amount: i === out.length - 1 ? amount : 0n }, this.policy));
    return out;
  }

  /**
   * AaveKit cross-check (opt-in): AaveKit's plan for the same action must
   * decode to exactly this spoke call. The plan is NEVER sent.
   */
  private async crossCheck(c: SpokeCallSpec, rp: ResolvedPair): Promise<void> {
    if (!this.o.apiCrossCheck) return;
    if (c.fn === "setUsingAsCollateral") return; // AaveKit builds it from a list of changes; not compared (see VERIFY_LIVE)
    if (c.fn === "withdraw" && c.amount === MAX_UINT256) return; // AaveKit "max" encoding is not specified
    if (!this.api) throw new Error(`${this.id}: apiCrossCheck needs AaveKit`);
    const map = await this.apiReserves();
    const res = map?.get(String(c.reserveId));
    if (!res) throw new Error(`${this.id}: apiCrossCheck: AaveKit has no reserve ${c.reserveId}`);
    const asset = c.reserveId === rp.collId ? rp.cfg.collateral : rp.cfg.debt;
    const value = bigDecimal(formatUnits(c.amount, asset.decimals));
    const sender = evmAddress(this.env.account);
    let plan: ExecutionPlan;
    if (c.fn === "supply") plan = await this.api.supply({ reserve: res.id, amount: { erc20: { value } }, sender });
    else if (c.fn === "borrow") plan = await this.api.borrow({ reserve: res.id, amount: { erc20: { value } }, sender });
    else if (c.fn === "repay") plan = await this.api.repay({ reserve: res.id, amount: { erc20: { value: { exact: value } } }, sender });
    else plan = await this.api.withdraw({ reserve: res.id, amount: { erc20: { exact: value } }, sender });
    const main = { kind: "spoke" as const, spoke: this.spoke, calls: [c] };
    let problems: string[];
    if (plan.__typename === "Erc20ApprovalRequired") {
      problems = checkTx(plan.originalTransaction, main, this.policy);
      for (const a of plan.approvals) {
        const ap = checkTx(a.byTransaction, { kind: "approve", token: getAddress(asset.address), spender: this.spoke, amount: c.amount }, this.policy);
        if (ap.length) this.log("warn", `${this.id}: AaveKit approval differs from ours (ignored, we approve ourselves): ${ap.join("; ")}`);
      }
    } else if (plan.__typename === "TransactionRequest") problems = checkTx(plan, main, this.policy);
    else problems = [`unexpected AaveKit plan ${plan.__typename}`];
    if (problems.length) throw new TxGuardError(problems.map((p) => `AaveKit cross-check: ${p}`), { to: this.spoke, data: this.encodeSpokeCall(c) });
  }

  /**
   * Simulate a dependent sequence with eth_simulateV1 (viem simulateCalls),
   * so e.g. approve -> supply can be proven in dry-run. Applies the gas cap
   * to every call.
   */
  private async simulateBatch(ctx: LiveContext, reqs: TxRequest[]): Promise<{ ok: true } | { ok: false; detail: string; unsupported?: boolean }> {
    type SimResult = { status: string; gasUsed: bigint; error?: Error };
    let results: SimResult[];
    try {
      const sim = this.env.publicClient.simulateCalls as unknown as (p: object) => Promise<{ results: SimResult[] }>;
      results = (await sim({ account: this.env.account, calls: reqs.map((r) => ({ to: r.to, data: r.data, value: r.value })) })).results;
    } catch (e) {
      return { ok: false, unsupported: true, detail: `eth_simulateV1 unavailable (${errMsg(e)})` };
    }
    const bad = results.findIndex((r) => r.status !== "success");
    if (bad >= 0) return { ok: false, detail: `"${reqs[bad]!.description}" reverted in batch simulation: ${errMsg(results[bad]!.error ?? "unknown")}` };
    const gasPrice = await this.env.publicClient.getGasPrice();
    const native = await ctx.nativePriceUsd(this.chain);
    for (let i = 0; i < reqs.length; i++) {
      const gasUsd = (Number(results[i]!.gasUsed * gasPrice) / 1e18) * native;
      const cap = reqs[i]!.maxGasUsd ?? ctx.limits.maxGasUsd[this.chain] ?? ctx.limits.maxGasUsd.default ?? 5;
      if (gasUsd > cap) return { ok: false, detail: `"${reqs[i]!.description}" gas $${gasUsd.toFixed(2)} > cap $${cap}` };
    }
    return { ok: true };
  }

  /**
   * Execute one dependent group of requests. Live: sendTx each in order.
   * Dry-run: a single request goes through sendTx (simulated against current
   * state); a longer group (approve -> spoke call) is proven with
   * eth_simulateV1 and the first request still goes through sendTx.
   */
  private async exec(ctx: LiveContext, reqs: TxRequest[]): Promise<TxRecord[]> {
    if (!reqs.length) return [];
    if (!ctx.dryRun) {
      const out: TxRecord[] = [];
      for (const r of reqs) out.push(await sendTx(this.env, ctx, r));
      return out;
    }
    if (reqs.length === 1) return [await sendTx(this.env, ctx, reqs[0]!)];
    const sim = await this.simulateBatch(ctx, reqs);
    if (!sim.ok) throw new Error(`dry-run: ${sim.detail}${sim.unsupported ? " — the step needs an allowance first and cannot be proven on this RPC" : ""}`);
    const first = await sendTx(this.env, ctx, reqs[0]!);
    return [first, ...reqs.slice(1).map((r) => ({ chain: this.chain, description: `${r.description} [batch-simulated]`, simulated: true }))];
  }

  private requireSwapper(): SwapAdapter {
    if (!this.swapper) throw new Error(`${this.id}: two-asset pair needs a swapper`);
    return this.swapper;
  }

  /** Swap with a cost ceiling; returns the measured received amount. */
  private async swapMeasured(ctx: LiveContext, from: AssetRef, to: AssetRef, amountIn: bigint, maxCostBps: number, txs: TxRecord[]): Promise<bigint> {
    const sw = this.requireSwapper();
    const q = await sw.quote(from, to, amountIn, ctx);
    if (!(q.costBps <= maxCostBps)) throw new Error(`swap ${from.symbol}->${to.symbol} cost ${q.costBps.toFixed(1)} bps > max ${maxCostBps} bps`);
    const before = await erc20Balance(this.env, getAddress(to.address));
    const r = await sw.swap(q, from, to, ctx);
    txs.push(...r.txs);
    if (!r.ok) throw new Error(`swap ${from.symbol}->${to.symbol} failed: ${r.detail ?? ""}`);
    const after = await erc20Balance(this.env, getAddress(to.address));
    const got = after > before ? after - before : 0n;
    if (got === 0n) throw new Error(`swap ${from.symbol}->${to.symbol} delivered nothing`);
    return got;
  }

  // =========================================================================
  // open
  // =========================================================================

  private async rewardMaxHealthFactor(rp: ResolvedPair): Promise<number> {
    const api = await this.apiReserves();
    const rs = [...(await this.rewardsFor(rp, "supply", api)), ...(await this.rewardsFor(rp, "borrow", api))];
    return rs.reduce((m, r) => (r.maxHealthFactor !== undefined ? Math.min(m, r.maxHealthFactor) : m), Infinity);
  }

  async open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    try {
      const rp = await this.resolvePair(this.pairCfg(pairId));
      const cfg = rp.cfg;
      if (equity < 0n) throw new Error("negative equity");
      const s = await this.snapshot(rp);
      const maxLtv = s.coll.collateralFactorBps / 10_000; // a borrow re-pins the account to the latest config
      const status = mapLoopPair({
        protocol: AAVE_V4_PROTOCOL,
        chain: this.chain,
        pairId,
        coll: s.coll,
        debt: s.debt,
        sameAsset: rp.same,
        riskPremiumFrac: this.riskPremiumOf(s),
        supplyRewards: [],
        borrowRewards: [],
        swapCostFrac: 0,
        swapDepthUsd: 0,
        dataAsOfMs: s.timestampMs,
      }).status;
      if (!status.canOpen) return { ok: false, txs, detail: `${this.id} ${pairId}: cannot open: ${status.reasons.join("; ")}` };
      validateTargetLtv(targetLtv, maxLtv);
      if (this.o.enforceRewardMaxHealthFactor) {
        const maxHf = await this.rewardMaxHealthFactor(rp);
        const hf = maxLtv / targetLtv;
        if (hf > maxHf) return { ok: false, txs, detail: `${this.id} ${pairId}: HF at target ${hf.toFixed(3)} > reward maxHealthFactor ${maxHf}` };
      }
      if (equity > 0n) {
        const bal = await erc20Balance(this.env, rp.collToken);
        if (bal < equity) return { ok: false, txs, detail: `${this.id} ${pairId}: wallet has ${formatUnits(bal, cfg.collateral.decimals)} ${cfg.collateral.symbol}, need ${formatUnits(equity, cfg.collateral.decimals)}` };
      }
      if (!rp.same) this.requireSwapper();

      const dc = cfg.collateral.decimals;
      const dd = cfg.debt.decimals;
      const r = s.coll.oraclePriceUsd / s.debt.oraclePriceUsd;
      const minBorrow = fromHumanFloor((cfg.minBorrowUsd ?? 10) / s.debt.oraclePriceUsd, dd);
      const maxIter = Math.max(1, Math.floor(ctx.limits.maxLoopIterations));
      // swap cost estimate at the first borrow size (also proves a route exists)
      let swapCostFrac = 0;
      const firstBorrowGuess = fromHumanFloor(nextLoopBorrow(toHuman(s.user.supplied + equity, dc), toHuman(s.user.debt, dd), targetLtv, r) * (1 - 1e-9), dd);
      const maxEntry = cfg.maxEntrySwapCostBps ?? 50;
      if (!rp.same && firstBorrowGuess >= minBorrow) {
        const q = await this.requireSwapper().quote(cfg.debt, cfg.collateral, firstBorrowGuess, ctx);
        if (!(q.costBps <= maxEntry)) return { ok: false, txs, detail: `${this.id} ${pairId}: entry swap cost ${q.costBps.toFixed(1)} bps > max ${maxEntry} bps` };
        swapCostFrac = Math.max(0, q.costBps) / 10_000;
      }
      const plan = planLoopSteps(equity, targetLtv, maxLtv, r, maxIter, {
        collateralDecimals: dc,
        debtDecimals: dd,
        swapCostFrac,
        minBorrow,
        existingCollateral: s.user.supplied,
        existingDebt: s.user.debt,
        sameAsset: rp.same,
      });
      if (plan.maxLtvSeen > targetLtv + 1e-9) throw new Error(`planner bug: LTV ${plan.maxLtvSeen} > target ${targetLtv}`);
      const firstBorrow = plan.steps.find((x) => x.kind === "borrow")?.amount ?? 0n;

      // ---- step 1: [approve] + multicall(supply equity, enable collateral, borrow b1)
      const calls: SpokeCallSpec[] = [];
      if (equity > 0n) calls.push({ fn: "supply", reserveId: rp.collId, amount: equity });
      if (!s.user.usingAsCollateral) calls.push({ fn: "setUsingAsCollateral", reserveId: rp.collId, enabled: true });
      if (firstBorrow > 0n) calls.push({ fn: "borrow", reserveId: rp.debtId, amount: firstBorrow });
      if (!calls.length) return { ok: true, txs, detail: `${this.id} ${pairId}: nothing to do (LTV already at/above target)` };
      const g1 = [...(await this.approveReqs(rp.collToken, cfg.collateral.symbol, equity)), ...(await this.spokeReqs(calls, rp))];
      const equityUsd = toHuman(equity, dc) * s.coll.priceUsd;
      const planText = `plan: ${plan.iterations} borrow(s), total ${formatUnits(plan.totalBorrowed, dd)} ${cfg.debt.symbol}, final LTV ${plan.finalLtv.toFixed(4)} (target ${targetLtv}, CF ${maxLtv}), risk premium ${(this.riskPremiumOf(s) * 100).toFixed(2)}%`;
      if (ctx.dryRun) {
        txs.push(...(await this.exec(ctx, g1)));
        return { ok: true, txs, amountUsd: equityUsd, detail: `${this.id} ${pairId}: [dry-run] step 1 simulated; remaining steps not simulated (each depends on a swap). ${planText}` };
      }

      // ---- live. Anchors: wallet balances that are NOT stray funds of this operation.
      const anchor = { coll: await erc20Balance(this.env, rp.collToken), debt: rp.same ? 0n : await erc20Balance(this.env, rp.debtToken) };
      let iter = 0;
      try {
        txs.push(...(await this.exec(ctx, g1)));
        anchor.coll = await erc20Balance(this.env, rp.collToken); // equity is supplied now
        let borrowed = firstBorrow;
        iter = firstBorrow > 0n ? 1 : 0;
        // remaining iterations, each sized from fresh on-chain state
        while (borrowed > 0n) {
          const received = rp.same ? borrowed : await this.swapMeasured(ctx, cfg.debt, cfg.collateral, borrowed, maxEntry, txs);
          const f = await this.snapshot(rp);
          let next = 0n;
          if (iter < maxIter) {
            const rr = f.coll.oraclePriceUsd / f.debt.oraclePriceUsd;
            next = fromHumanFloor(nextLoopBorrow(toHuman(f.user.supplied + received, dc), toHuman(f.user.debt, dd), targetLtv, rr) * (1 - 1e-9), dd);
            if (next < minBorrow) next = 0n;
          }
          const step: SpokeCallSpec[] = [{ fn: "supply", reserveId: rp.collId, amount: received }];
          if (next > 0n) step.push({ fn: "borrow", reserveId: rp.debtId, amount: next });
          txs.push(...(await this.exec(ctx, [...(await this.approveReqs(rp.collToken, cfg.collateral.symbol, received)), ...(await this.spokeReqs(step, rp))])));
          borrowed = next;
          if (next > 0n) iter++;
        }
      } catch (e) {
        const note = await this.recover(ctx, rp, anchor, e, txs);
        return { ok: false, txs, amountUsd: equityUsd, detail: `${this.id} ${pairId}: open stopped after ${iter} borrow(s): ${errMsg(e)}; ${note}` };
      }
      await this.resetAllowances(ctx, rp, txs);
      const end = await this.snapshot(rp);
      return {
        ok: true,
        txs,
        amountUsd: equityUsd,
        detail: `${this.id} ${pairId}: opened, ${iter} borrow(s), LTV ${AaveV4Adapter.oracleLtv(end).toFixed(4)}, HF ${end.user.healthFactor.toFixed(3)}`,
      };
    } catch (e) {
      return { ok: false, txs, detail: `${this.id} ${pairId}: ${errMsg(e)}` };
    }
  }

  /**
   * After a failed LIVE step. Never assumes the failed tx did not land: chain
   * and wallet are re-read. If any tx of ours is unconfirmed (it may still
   * land, holding a nonce) nothing more is sent — the observed state is
   * reported and the next cycle re-reads. Otherwise only funds observed above
   * the anchors are put back: debt asset -> repay (<= current debt),
   * collateral -> re-supply; then leftover allowances are reset to 0.
   */
  private async recover(ctx: LiveContext, rp: ResolvedPair, anchor: { coll: bigint; debt: bigint }, cause: unknown, txs: TxRecord[]): Promise<string> {
    const cfg = rp.cfg;
    const notes: string[] = [];
    const mark = (u: BroadcastUnconfirmedError) =>
      txs.push({ chain: this.chain, id: u.id, description: u.description, simulated: false, unconfirmed: true, ...(u.nonce !== undefined ? { nonce: u.nonce } : {}) });
    const observe = async () => {
      const s = await this.snapshot(rp);
      const c = await erc20Balance(this.env, rp.collToken);
      const d = rp.same ? c : await erc20Balance(this.env, rp.debtToken);
      return { s, c, d };
    };
    const show = (o: { s: PairSnapshot; c: bigint; d: bigint }) =>
      `observed: supplied ${formatUnits(o.s.user.supplied, cfg.collateral.decimals)} ${cfg.collateral.symbol}, debt ${formatUnits(o.s.user.debt, cfg.debt.decimals)} ${cfg.debt.symbol}, LTV ${AaveV4Adapter.oracleLtv(o.s).toFixed(4)}, wallet ${formatUnits(o.c, cfg.collateral.decimals)} ${cfg.collateral.symbol}${rp.same ? "" : ` / ${formatUnits(o.d, cfg.debt.decimals)} ${cfg.debt.symbol}`}`;
    let o: Awaited<ReturnType<typeof observe>>;
    try {
      o = await observe();
    } catch (e) {
      return `state re-read failed (${errMsg(e)}); no recovery attempted`;
    }
    if (isUnconfirmed(cause)) {
      mark(cause);
      return `tx ${cause.id} (nonce ${cause.nonce ?? "?"}) unconfirmed and may still land: no further txs sent; ${show(o)}`;
    }
    let halted = false;
    try {
      if (rp.same) {
        const surplus = o.c > anchor.coll ? o.c - anchor.coll : 0n;
        const amt = minB(surplus, o.s.user.debt);
        if (amt > 0n) {
          txs.push(...(await this.exec(ctx, [...(await this.approveReqs(rp.debtToken, cfg.debt.symbol, amt)), ...(await this.spokeReqs([{ fn: "repay", reserveId: rp.debtId, amount: amt }], rp))])));
          notes.push(`repaid ${formatUnits(amt, cfg.debt.decimals)} ${cfg.debt.symbol}`);
        }
      } else {
        const dSur = o.d > anchor.debt ? o.d - anchor.debt : 0n;
        const rep = minB(dSur, o.s.user.debt);
        if (rep > 0n) {
          txs.push(...(await this.exec(ctx, [...(await this.approveReqs(rp.debtToken, cfg.debt.symbol, rep)), ...(await this.spokeReqs([{ fn: "repay", reserveId: rp.debtId, amount: rep }], rp))])));
          notes.push(`repaid ${formatUnits(rep, cfg.debt.decimals)} ${cfg.debt.symbol}`);
        }
        const cSur = o.c > anchor.coll ? o.c - anchor.coll : 0n;
        if (cSur > 0n) {
          txs.push(...(await this.exec(ctx, [...(await this.approveReqs(rp.collToken, cfg.collateral.symbol, cSur)), ...(await this.spokeReqs([{ fn: "supply", reserveId: rp.collId, amount: cSur }], rp))])));
          notes.push(`re-supplied ${formatUnits(cSur, cfg.collateral.decimals)} ${cfg.collateral.symbol}`);
        }
      }
    } catch (e) {
      notes.push(`recovery tx failed: ${errMsg(e)}`);
      if (isUnconfirmed(e)) {
        mark(e);
        halted = true;
      }
    }
    if (!halted) {
      try {
        await this.resetAllowances(ctx, rp, txs);
      } catch (e) {
        notes.push(`allowance reset failed: ${errMsg(e)}`);
        if (isUnconfirmed(e)) mark(e);
      }
    }
    try {
      notes.push(show(await observe()));
    } catch {
      /* keep the notes we have */
    }
    return notes.join("; ");
  }

  /** Reset any non-zero allowance of the pair tokens to the spoke (live only). */
  private async resetAllowances(ctx: LiveContext, rp: ResolvedPair, txs: TxRecord[]): Promise<void> {
    if (ctx.dryRun) return;
    const tokens: [Address, string][] = [[rp.collToken, rp.cfg.collateral.symbol]];
    if (!rp.same) tokens.push([rp.debtToken, rp.cfg.debt.symbol]);
    for (const [token, symbol] of tokens) {
      const cur = await this.read<bigint>(token, erc20Abi as Abi, "allowance", [this.env.account, this.spoke]);
      if (cur === 0n) continue;
      const req: TxRequest = { to: token, data: call(erc20Abi as Abi, "approve", [this.spoke, 0n]), description: `${this.id}: reset leftover ${symbol} allowance -> spoke` };
      assertTx(req, { kind: "approve", token, spender: this.spoke, amount: 0n }, this.policy);
      txs.push(...(await this.exec(ctx, [req])));
    }
  }

  // =========================================================================
  // close / deleverage
  // =========================================================================

  async close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    if (!(fraction > 0 && fraction <= 1)) return { ok: false, txs: [], detail: `${this.id} ${pairId}: fraction out of range ${fraction}` };
    return this.unwind(pairId, fraction >= 1 ? { kind: "close" } : { kind: "fraction", fraction }, ctx);
  }

  async deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult> {
    if (!(targetLtv >= 0 && targetLtv < 1)) return { ok: false, txs: [], detail: `${this.id} ${pairId}: invalid targetLtv ${targetLtv}` };
    return this.unwind(pairId, { kind: "ltv", targetLtv }, ctx);
  }

  async simulateClose(pairId: string, ctx: LiveContext): Promise<boolean> {
    const r = await this.close(pairId, 1, { ...ctx, dryRun: true });
    if (!r.ok) this.log("warn", `${this.id} ${pairId}: simulateClose failed: ${r.detail ?? ""}`);
    return r.ok;
  }

  private unwindParams(rp: ResolvedPair, s: PairSnapshot, swapCostFrac: number): UnwindParams {
    const cfBps = Math.min(s.user.pinnedCollateralFactorBps, s.coll.collateralFactorBps); // a withdraw re-pins to the latest config
    return {
      collateralDecimals: rp.cfg.collateral.decimals,
      debtDecimals: rp.cfg.debt.decimals,
      priceRatio: s.coll.oraclePriceUsd / s.debt.oraclePriceUsd,
      liqLtv: cfBps / 10_000,
      minHealthFactor: rp.cfg.minUnwindHealthFactor ?? 1.04,
      emergencyMinHealthFactor: rp.cfg.emergencyUnwindHealthFactor ?? 1.01,
      swapCostFrac,
      sameAsset: rp.same,
    };
  }

  private async unwind(pairId: string, g: { kind: "close" } | { kind: "fraction"; fraction: number } | { kind: "ltv"; targetLtv: number }, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    try {
      const rp = await this.resolvePair(this.pairCfg(pairId));
      const cfg = rp.cfg;
      const s0 = await this.snapshot(rp);
      if (s0.user.supplied === 0n && s0.user.debt === 0n) return { ok: true, txs, detail: `${this.id} ${pairId}: no position` };
      const exits = exitBlockers(s0.coll, s0.debt);
      if (exits.length) return { ok: false, txs, detail: `${this.id} ${pairId}: exit blocked: ${exits.join("; ")}` };
      const goal: UnwindGoal = g.kind === "fraction" ? { kind: "fraction", fraction: g.fraction, startCollateral: s0.user.supplied, startDebt: s0.user.debt } : g;
      const maxIter = cfg.maxUnwindIterations ?? Math.max(40, 3 * Math.floor(ctx.limits.maxLoopIterations));
      const maxExit = cfg.maxExitSwapCostBps ?? 200;
      const dd = cfg.debt.decimals;
      const collBefore = await erc20Balance(this.env, rp.collToken);
      const anchor = { coll: collBefore, debt: rp.same ? 0n : await erc20Balance(this.env, rp.debtToken) };

      // swap cost estimate from a quote at the first step's size
      let swapCost = 0;
      if (!rp.same && s0.user.debt > 0n) {
        const st = unwindStep(s0.user.supplied, s0.user.debt, goal, this.unwindParams(rp, s0, 0));
        if (st.kind === "withdraw-repay") {
          const q = await this.requireSwapper().quote(cfg.collateral, cfg.debt, st.withdraw, ctx);
          if (!(q.costBps <= maxExit)) return { ok: false, txs, detail: `${this.id} ${pairId}: exit swap cost ${q.costBps.toFixed(1)} bps > max ${maxExit} bps` };
          swapCost = Math.max(0, q.costBps) / 10_000;
        }
      }
      if (unwindStep(s0.user.supplied, s0.user.debt, goal, this.unwindParams(rp, s0, 0)).kind === "done")
        return { ok: true, txs, detail: `${this.id} ${pairId}: nothing to do (LTV ${AaveV4Adapter.oracleLtv(s0).toFixed(4)})` };
      const planned = planUnwind(s0.user.supplied, s0.user.debt, goal, this.unwindParams(rp, s0, swapCost), maxIter);
      const planText = `plan: ${planned.steps.length} step(s), min HF ${planned.minHealthFactorSeen.toFixed(3)}${planned.feasible ? "" : `, NOT feasible: ${planned.reason}`}`;
      // A plan that only runs out of iterations is slow, not broken (each live call makes progress); a stuck plan is broken.
      if (!planned.feasible && ctx.dryRun && !planned.reason?.startsWith("not finished"))
        return { ok: false, txs, detail: `${this.id} ${pairId}: [dry-run] ${planText}` };

      let finished = false;
      try {
      for (let i = 0; i < maxIter && !finished; i++) {
        const s = i === 0 ? s0 : await this.snapshot(rp);
        const st = unwindStep(s.user.supplied, s.user.debt, goal, this.unwindParams(rp, s, swapCost));
        if (st.kind === "done") {
          finished = true;
          break;
        }
        if (st.kind === "stuck") return { ok: false, txs, detail: `${this.id} ${pairId}: unwind stuck: ${st.reason}` };
        if (st.kind === "withdraw-repay" && st.emergency)
          this.log("warn", `${this.id} ${pairId}: LTV above CF / minUnwindHealthFactor; unwinding with the emergency HF floor (HF after withdraw ${(this.unwindParams(rp, s, swapCost).liqLtv / st.ltvAfterWithdraw).toFixed(3)})`);
        if (st.kind === "withdraw") {
          if (st.withdraw === "max" && s.user.debt > 0n) throw new Error("internal: full withdraw with outstanding debt");
          const amount = st.withdraw === "max" ? MAX_UINT256 : st.withdraw;
          txs.push(...(await this.exec(ctx, await this.spokeReqs([{ fn: "withdraw", reserveId: rp.collId, amount }], rp))));
          finished = true;
          break;
        }
        // withdraw -> (swap) -> repay
        if (rp.same) {
          const amt = st.withdraw;
          const rep = minB(amt, s.user.debt + repayMargin(s.user.debt)); // never approve / repay beyond the debt (+accrual margin)
          const steps: SpokeCallSpec[] = [
            { fn: "withdraw", reserveId: rp.collId, amount: amt },
            { fn: "repay", reserveId: rp.debtId, amount: rep },
          ];
          txs.push(...(await this.exec(ctx, [...(await this.approveReqs(rp.debtToken, cfg.debt.symbol, rep)), ...(await this.spokeReqs(steps, rp))])));
          if (ctx.dryRun) break;
          continue;
        }
        txs.push(...(await this.exec(ctx, await this.spokeReqs([{ fn: "withdraw", reserveId: rp.collId, amount: st.withdraw }], rp))));
        if (ctx.dryRun) {
          // read-only proof that the exit swap route exists at this size
          const q = await this.requireSwapper().quote(cfg.collateral, cfg.debt, st.withdraw, ctx);
          if (!(q.costBps <= maxExit)) return { ok: false, txs, detail: `${this.id} ${pairId}: [dry-run] exit swap cost ${q.costBps.toFixed(1)} bps > max ${maxExit} bps` };
          break;
        }
        const got = await this.swapMeasured(ctx, cfg.collateral, cfg.debt, st.withdraw, maxExit, txs);
        const debtNow = await this.read<bigint>(this.spoke, SPOKE_ABI as Abi, "getUserTotalDebt", [rp.debtId, this.env.account]);
        // Approve / repay at most the current debt + a 1bp accrual margin (the spoke pulls only what is owed;
        // the leftover allowance is reset after the unwind). Excess debt asset stays in the wallet.
        const cap = debtNow + repayMargin(debtNow);
        const rep = minB(got, cap);
        const steps: SpokeCallSpec[] = [{ fn: "repay", reserveId: rp.debtId, amount: rep }];
        // Final close step: the swap covers the whole debt incl. margin -> repay + withdraw max atomically.
        const coversAll = got >= cap;
        if (goal.kind === "close" && coversAll) steps.push({ fn: "withdraw", reserveId: rp.collId, amount: MAX_UINT256 });
        txs.push(...(await this.exec(ctx, [...(await this.approveReqs(rp.debtToken, cfg.debt.symbol, rep)), ...(await this.spokeReqs(steps, rp))])));
        if (goal.kind === "close" && coversAll) finished = true;
      }
      } catch (e) {
        if (ctx.dryRun) throw e;
        const note = await this.recover(ctx, rp, anchor, e, txs);
        return { ok: false, txs, detail: `${this.id} ${pairId}: unwind stopped: ${errMsg(e)}; ${note}` };
      }
      if (ctx.dryRun) return { ok: true, txs, detail: `${this.id} ${pairId}: [dry-run] first unwind step simulated; later steps depend on swaps. ${planText}` };
      await this.resetAllowances(ctx, rp, txs);

      const end = await this.snapshot(rp);
      const collAfter = await erc20Balance(this.env, rp.collToken);
      const returned = collAfter > collBefore ? collAfter - collBefore : 0n;
      const amountUsd = toHuman(returned, cfg.collateral.decimals) * end.coll.priceUsd;
      const leftoverDebtAsset = rp.same ? 0n : await erc20Balance(this.env, rp.debtToken);
      const done =
        goal.kind === "close"
          ? end.user.debt === 0n && end.user.supplied === 0n
          : goal.kind === "ltv"
            ? AaveV4Adapter.oracleLtv(end) <= goal.targetLtv + 1e-6
            : unwindStep(end.user.supplied, end.user.debt, goal, this.unwindParams(rp, end, swapCost)).kind === "done";
      return {
        ok: done,
        txs,
        amountUsd,
        detail: `${this.id} ${pairId}: ${done ? "unwound" : "unwind incomplete"}; returned ${formatUnits(returned, cfg.collateral.decimals)} ${cfg.collateral.symbol}; debt left ${formatUnits(end.user.debt, dd)} ${cfg.debt.symbol}; LTV ${AaveV4Adapter.oracleLtv(end).toFixed(4)}${leftoverDebtAsset > 0n ? `; wallet holds ${formatUnits(leftoverDebtAsset, dd)} ${cfg.debt.symbol}` : ""}`,
      };
    } catch (e) {
      return { ok: false, txs, detail: `${this.id} ${pairId}: ${errMsg(e)}` };
    }
  }

  // =========================================================================
  // rewards
  // =========================================================================

  /**
   * Non-Merkl claimables from AaveKit, cached 10 min and bounded by a 5 s
   * timeout: position() is health-critical and must never wait on the API.
   */
  private async nonMerklClaimables(): Promise<LoopPositionView["rewardsUnclaimed"]> {
    if (!this.api) return [];
    const now = this.now();
    if (this.claimCache && now - this.claimCache.atMs < 10 * 60_000) return this.claimCache.items;
    const api = this.api;
    const fetchIt = async () => {
      const items = await api.userClaimableRewards({ user: evmAddress(this.env.account), chainId: akChainId(this.env.viemChain.id) });
      return items
        .filter((i) => i.__typename !== "UserMerklClaimableReward")
        .map((i) => ({
          token: i.claimable.token.info.symbol,
          amount: i.claimable.amount.onChainValue,
          decimals: i.claimable.amount.decimals,
          usd: i.claimable.exchange.value.toApproximateNumber(),
        }));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const items = await Promise.race([
        fetchIt(),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("timeout")), 5_000);
        }),
      ]);
      this.claimCache = { atMs: now, items };
      return items;
    } catch {
      return this.claimCache?.items ?? [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * AaveKit's claimable rewards are Merkl campaigns today
   * (UserMerklClaimableReward) — those are claimed wallet-wide by the
   * MerklClaimer and skipped here. Any other reward type is claimed via
   * AaveKit's claimRewards tx ONLY if its target is in allowUndecodedTargets
   * (we cannot decode that calldata).
   */
  async claimRewards(ctx: LiveContext, _pairId?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }> {
    const txs: TxRecord[] = [];
    if (!this.api) return { ok: true, txs, claimed: [], detail: `${this.id}: AaveKit disabled; no native rewards` };
    try {
      const user = evmAddress(this.env.account);
      const cid = akChainId(this.env.viemChain.id);
      const items = await this.api.userClaimableRewards({ user, chainId: cid });
      const merkl = items.filter((i) => i.__typename === "UserMerklClaimableReward");
      const other = items.filter((i) => i.__typename !== "UserMerklClaimableReward" && i.claimable.amount.onChainValue > 0n);
      if (!other.length) return { ok: true, txs, claimed: [], detail: `${this.id}: no native rewards; ${merkl.length} Merkl reward(s) left to the Merkl claimer` };
      const tx = await this.api.claimRewards({ ids: other.map((i) => i.id), chainId: cid, user });
      assertTx(tx, { kind: "opaque", to: getAddress(tx.to) }, this.policy);
      const req: TxRequest = { to: getAddress(tx.to), data: tx.data as Hex, value: tx.value, description: `${this.id}: claim ${other.length} reward(s)` };
      txs.push(...(await this.exec(ctx, [req])));
      return {
        ok: true,
        txs,
        claimed: other.map((i) => ({ token: i.claimable.token.info.symbol, amount: i.claimable.amount.onChainValue, decimals: i.claimable.amount.decimals })),
      };
    } catch (e) {
      return { ok: false, txs, claimed: [], detail: `${this.id}: claimRewards: ${errMsg(e)}` };
    }
  }

  // =========================================================================
  // verify
  // =========================================================================

  /** Selectors of `names` (from SPOKE_ABI) whose PUSHn literal is absent from `code`. */
  static missingSelectors(code: Hex, names: readonly string[]): string[] {
    const hex = code.toLowerCase();
    const out: string[] = [];
    for (const n of names) {
      const item = (SPOKE_ABI as Abi).find((x): x is AbiFunction => x.type === "function" && x.name === n);
      if (!item) {
        out.push(`${n} (not in ABI)`);
        continue;
      }
      let sel = toFunctionSelector(item).slice(2);
      while (sel.startsWith("00") && sel.length > 2) sel = sel.slice(2);
      const push = (0x5f + sel.length / 2).toString(16);
      if (!hex.includes(push + sel)) out.push(n);
    }
    return out;
  }

  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    const add = (m: string) => issues.push(`${this.id}: ${m}`);
    const pc = this.env.publicClient;
    const S = SPOKE_ABI as Abi;
    try {
      await assertChainId(this.env);
    } catch (e) {
      add(errMsg(e));
    }
    const hasCode = async (a: Address) => {
      const c = await pc.getCode({ address: a });
      return c && c !== "0x" ? c : null;
    };
    // spoke + implementation ABI
    try {
      const code = await hasCode(this.spoke);
      if (!code) add(`spoke ${this.spoke} has no code`);
      else {
        const slot = await pc.getStorageAt({ address: this.spoke, slot: EIP1967_IMPLEMENTATION_SLOT });
        const impl = slot && BigInt(slot) !== 0n ? getAddress(`0x${slot.slice(-40)}`) : null;
        const implCode = impl ? await hasCode(impl) : code;
        if (!implCode) add(`spoke implementation ${impl} has no code`);
        else {
          const missing = AaveV4Adapter.missingSelectors(implCode, [...SPOKE_WRITE_FUNCTIONS, "getUserAccountData", "getReserve", "getUserTotalDebt", "getUserSuppliedAssets"]);
          if (missing.length) add(`spoke implementation ${impl ?? this.spoke} lacks selectors for ${missing.join(", ")} (ABI version mismatch; adapter built from aave-v4 v0.5.11)`);
        }
      }
    } catch (e) {
      add(`spoke check failed: ${errMsg(e)}`);
    }
    // oracle
    try {
      const oracle = getAddress(await this.read<Address>(this.spoke, S, "ORACLE"));
      if (!(await hasCode(oracle))) add(`oracle ${oracle} has no code`);
      const dec = await this.read<number>(oracle, ORACLE_ABI as Abi, "decimals");
      if (Number(dec) !== ORACLE_DECIMALS) add(`oracle decimals ${dec} != ${ORACLE_DECIMALS}`);
      const sp = await this.read<Address>(oracle, ORACLE_ABI as Abi, "spoke");
      if (!sameAddr(sp, this.spoke)) add(`oracle.spoke() ${sp} != configured spoke`);
    } catch (e) {
      add(`oracle check failed: ${errMsg(e)}`);
    }
    for (const h of this.hubs) if (!(await hasCode(h).catch(() => null))) add(`hub ${h} has no code`);
    // pairs
    for (const cfg of this.pairs) {
      for (const a of [cfg.collateral, cfg.debt]) {
        try {
          for (const m of await verifyAsset(this.env, a)) add(`${cfg.pairId}: ${m}`);
        } catch (e) {
          add(`${cfg.pairId}: ${a.symbol} check failed: ${errMsg(e)}`);
        }
      }
      try {
        const rp = await this.resolvePair(cfg);
        for (const [asset, id] of [
          [cfg.collateral, rp.collId],
          [cfg.debt, rp.debtId],
        ] as const) {
          const res = await this.read<SpokeReserveStruct>(this.spoke, S, "getReserve", [id]);
          if (!sameAddr(res.underlying, asset.address)) add(`${cfg.pairId}: reserve ${id} underlying ${res.underlying} != ${asset.symbol} ${asset.address}`);
          if (Number(res.decimals) !== asset.decimals) add(`${cfg.pairId}: reserve ${id} decimals ${res.decimals} != ${asset.decimals}`);
          if (!this.hubs.some((h) => sameAddr(h, res.hub))) add(`${cfg.pairId}: reserve ${id} is on hub ${res.hub}, not a configured hub`);
          const [u, d] = await this.read<readonly [Address, number]>(getAddress(res.hub), HUB_ABI as Abi, "getAssetUnderlyingAndDecimals", [BigInt(res.assetId)]);
          if (!sameAddr(u, asset.address) || Number(d) !== asset.decimals) add(`${cfg.pairId}: hub asset ${res.assetId} is ${u}/${d}, expected ${asset.address}/${asset.decimals}`);
          const back = await this.read<bigint>(this.spoke, S, "getReserveId", [getAddress(res.hub), BigInt(res.assetId)]);
          if (back !== id) add(`${cfg.pairId}: spoke.getReserveId(hub, ${res.assetId}) = ${back} != configured reserve ${id}`);
        }
        const st = await this.pairStatus(cfg.pairId);
        if (!st.canOpen) add(`market ${cfg.pairId}: cannot open now: ${st.reasons.join("; ")}`);
      } catch (e) {
        add(`${cfg.pairId}: ${errMsg(e)}`);
      }
    }
    // allowlisted targets
    for (const t of [...(this.policy.extraTargets ?? []), ...(this.policy.allowUndecoded ?? []), ...(this.policy.positionManagers ?? [])])
      if (!(await hasCode(t).catch(() => null))) add(`allowlisted target ${t} has no code`);
    for (const pm of this.policy.positionManagers ?? []) {
      try {
        if (!(await this.read<boolean>(this.spoke, S, "isPositionManagerActive", [pm]))) add(`position manager ${pm} is not active on the spoke`);
        if (await this.read<boolean>(this.spoke, S, "isPositionManager", [this.env.account, pm]))
          this.log("warn", `${this.id}: our account has approved position manager ${pm} (it can act on our position)`);
      } catch (e) {
        add(`position manager ${pm}: ${errMsg(e)}`);
      }
    }
    // AaveKit identity cross-check
    if (this.api) {
      try {
        const sp = await this.api.spoke({ query: { spoke: { chainId: akChainId(this.env.viemChain.id), address: evmAddress(this.spoke) } } });
        if (!sp) add(`AaveKit does not know spoke ${this.spoke} on chain ${this.env.viemChain.id}`);
        else {
          if (!sameAddr(sp.address, this.spoke)) add(`AaveKit spoke address ${sp.address} != ${this.spoke}`);
          const label = this.o.spoke.spokeLabel;
          if (label && !sp.name.toLowerCase().includes(label.toLowerCase())) add(`AaveKit spoke name "${sp.name}" does not contain "${label}"`);
          const hub = sp.connectedHubs.find((h) => sameAddr(h.hub.address, this.hubs[0]!));
          if (!hub) add(`AaveKit: hub ${this.hubs[0]} is not connected to spoke "${sp.name}" (connected: ${sp.connectedHubs.map((h) => `${h.hub.name} ${h.hub.address}`).join(", ")})`);
          else if (this.o.spoke.hubName && !hub.hub.name.toLowerCase().includes(this.o.spoke.hubName.toLowerCase())) add(`AaveKit hub name "${hub.hub.name}" does not contain "${this.o.spoke.hubName}"`);
        }
        const map = await this.api.reserves({
          query: { spoke: { chainId: akChainId(this.env.viemChain.id), address: evmAddress(this.spoke) } },
          filter: ReservesRequestFilter.All,
        });
        const byId = new Map(map.map((r) => [String(r.onChainId), r]));
        for (const cfg of this.pairs) {
          const rp = this.resolved.get(cfg.pairId);
          if (!rp) continue;
          for (const [asset, id] of [
            [cfg.collateral, rp.collId],
            [cfg.debt, rp.debtId],
          ] as const) {
            const r = byId.get(String(id));
            if (!r) add(`AaveKit: no reserve ${id} (${asset.symbol}) on this spoke`);
            else {
              if (!sameAddr(r.asset.underlying.address, asset.address)) add(`AaveKit reserve ${id} underlying ${r.asset.underlying.address} != ${asset.address}`);
              if (r.asset.underlying.info.decimals !== asset.decimals) add(`AaveKit reserve ${id} decimals ${r.asset.underlying.info.decimals} != ${asset.decimals}`);
            }
          }
        }
      } catch (e) {
        if (this.o.requireApiCrossCheck) add(`AaveKit cross-check failed: ${errMsg(e)}`);
        else this.log("warn", `${this.id}: AaveKit cross-check skipped: ${errMsg(e)}`);
      }
    }
    return issues;
  }
}
