/**
 * Plain deposits into ERC-4626 vaults (SupplyAdapter): Euler v2 EVaults,
 * MetaMorpho (Morpho) vaults, Fluid fTokens and any other ERC-4626.
 *
 * Writes are standard ERC-4626 for every flavor: exact approve -> deposit(assets,
 * us) -> reset leftover allowance; redeem(shares, us, us). Flavors differ only
 * in how the market data is read:
 *  - euler:      supply APR = interestRate() (RAY/s) x year x utilization x (1 - interestFee/1e4);
 *                withdrawable = cash(); IRMLinearKink IRM model when the IRM exposes its params;
 *                deposits disabled when OP_DEPOSIT is hooked with no hook target.
 *  - metamorpho: @morpho-org/blue-sdk-viem fetchAccrualVault -> net APY (after the
 *                performance fee) and liquidity (idle + what its markets can return now).
 *  - fluid:      APR from share-price growth (the fToken price includes its lending rewards);
 *                withdrawable <= asset idle at Fluid Liquidity (upper bound, see note).
 *  - generic:    APR from convertToAssets growth over `aprLookbackHours` (needs historical
 *                eth_call); withdrawable = underlying held by the vault (conservative).
 * Every flavor also bounds withdrawable by maxWithdraw(us) when that binds.
 */
import type { AccrualVault } from "@morpho-org/blue-sdk";
import { getChainAddresses } from "@morpho-org/blue-sdk";
import { fetchAccrualVault } from "@morpho-org/blue-sdk-viem";
import { ContractFunctionRevertedError, ExecutionRevertedError, RawContractError, isAddress, isAddressEqual, zeroAddress } from "viem";
import type { IrmModel, RewardRate, SupplyMarket } from "@incentive-router/core";
import {
  BroadcastUnconfirmedError,
  chainInfo,
  unitsToUsd,
  type AssetRef,
  type LiveContext,
  type LiveResult,
  type Logger,
  type RewardRateProvider,
  type SupplyAdapter,
  type SupplyPositionView,
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
  type TxRequest,
} from "@incentive-router/live-evm-base";
import { simulateBundle } from "../morpho/sim.js";
import { EULER_OP_DEPOSIT, EULER_OP_REDEEM, EULER_OP_WITHDRAW, erc4626Abi, eulerEVaultAbi, eulerIrmLinearKinkAbi, fluidFTokenAbi, metaMorphoAbi } from "./abis.js";
import { apyContinuousToApr, eulerRateToApr, eulerSupplyApr, growthApr, linearKinkIrmModel, linearKinkRate, priceProbeShares, UNLIMITED_DEPOSIT, type LinearKink } from "./math.js";

export type VaultFlavor = "euler" | "metamorpho" | "fluid" | "generic";

export interface VaultConfig {
  /** Default: the vault address, lowercase. */
  marketId?: string;
  address: Address;
  /** The vault's underlying asset (checked against asset() by verifyConfig). */
  asset: AssetRef;
  flavor: VaultFlavor;
  /** Venue id for tiers / caps. Default per flavor: euler | morpho-vault | fluid | erc4626. */
  protocol?: string;
  curator?: string;
  /**
   * Protocol id used for extraRewards queries. Default per flavor matches the
   * Merkl provider's rule keys: euler-v2 | morpho | fluid | erc4626.
   */
  rewardProtocol?: string;
}

export interface ERC4626VaultAdapterOptions {
  env: EvmEnv;
  vaults: VaultConfig[];
  extraRewards?: RewardRateProvider;
  /** USD price of the underlying for supplyMarkets()/supplyPosition() (no ctx). Default 1 (the runner overrides with market prices). */
  priceUsd?: (a: AssetRef) => Promise<number>;
  log?: Logger;
  /** Share-price growth window for fluid / generic APR (default 24 h). */
  aprLookbackHours?: number;
  /** Cache of share-price-growth APRs (default 30 min). */
  aprCacheMinutes?: number;
  /** MetaMorpho reader. Default: @morpho-org/blue-sdk-viem fetchAccrualVault(address, env.publicClient). */
  fetchMorphoVault?: (address: Address) => Promise<AccrualVault>;
}

const DEFAULT_PROTOCOL: Record<VaultFlavor, string> = { euler: "euler", metamorpho: "morpho-vault", fluid: "fluid", generic: "erc4626" };
const DEFAULT_REWARD_PROTOCOL: Record<VaultFlavor, string> = { euler: "euler-v2", metamorpho: "morpho", fluid: "fluid", generic: "erc4626" };

interface Vault extends VaultConfig {
  marketId: string;
  protocol: string;
  rewardProtocol: string;
}

interface FlavorData {
  apr: number;
  /** undefined = unknown (reported as NaN). */
  withdrawable?: bigint;
  irm?: IrmModel;
  paused?: boolean;
  underlying?: string[];
  notes: string[];
}

interface Block {
  number: bigint;
  timestamp: bigint;
}

const lc = (a: string) => a.toLowerCase();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const minB = (a: bigint, b: bigint) => (a < b ? a : b);

/** sendTx threw after the tx was signed and handed to the network: it may still land. */
export function isUnconfirmed(e: unknown): e is BroadcastUnconfirmedError {
  return e instanceof BroadcastUnconfirmedError || (e as Error | undefined)?.name === "BroadcastUnconfirmedError";
}

/** eth_call reverted (as opposed to an RPC / transport failure). */
export function isRevertError(e: unknown): boolean {
  let x: unknown = e;
  for (let i = 0; i < 10 && x; i++) {
    if (x instanceof ExecutionRevertedError || x instanceof RawContractError || x instanceof ContractFunctionRevertedError) return true;
    x = (x as { cause?: unknown }).cause;
  }
  return /execution reverted|\brevert(ed)?\b/i.test((e as Error | undefined)?.message ?? "");
}

function unconfirmedRecord(chain: string, e: BroadcastUnconfirmedError): TxRecord {
  return { chain, id: e.id, description: e.description, simulated: false, unconfirmed: true, nonce: e.nonce };
}

function fractionOf(x: bigint, f: number): bigint {
  return (x * BigInt(Math.round(f * 1_000_000))) / 1_000_000n;
}

export class ERC4626VaultAdapter implements SupplyAdapter {
  readonly id: string;
  readonly chain: string;
  private readonly env: EvmEnv;
  private readonly vaults = new Map<string, Vault>();
  private readonly extraRewards?: RewardRateProvider;
  private readonly priceUsd: (a: AssetRef) => Promise<number>;
  private readonly log: Logger;
  private readonly lookbackHours: number;
  private readonly aprCacheMs: number;
  private readonly fetchMorphoVault: (address: Address) => Promise<AccrualVault>;
  private readonly shareDecimals = new Map<string, number>();
  private readonly aprCache = new Map<string, { atMs: number; apr: number; hours: number }>();

  constructor(o: ERC4626VaultAdapterOptions) {
    this.env = o.env;
    this.chain = o.env.chain;
    this.id = `vault:${this.chain}`;
    this.extraRewards = o.extraRewards;
    this.priceUsd = o.priceUsd ?? (async () => 1);
    this.log = o.log ?? (() => {});
    this.lookbackHours = o.aprLookbackHours ?? 24;
    if (!(this.lookbackHours > 0 && this.lookbackHours <= 24 * 30)) throw new Error(`${this.id}: aprLookbackHours ${this.lookbackHours} not in (0, 720]`);
    this.aprCacheMs = (o.aprCacheMinutes ?? 30) * 60_000;
    this.fetchMorphoVault = o.fetchMorphoVault ?? ((a) => fetchAccrualVault(a, this.env.publicClient));
    for (const c of o.vaults) {
      if (!isAddress(c.address)) throw new Error(`${this.id}: vault address ${c.address} invalid`);
      if (!isAddress(c.asset.address)) throw new Error(`${this.id}: asset ${c.asset.symbol} address ${c.asset.address} invalid`);
      if (!DEFAULT_PROTOCOL[c.flavor]) throw new Error(`${this.id}: unknown flavor ${String(c.flavor)}`);
      const marketId = c.marketId ?? lc(c.address);
      if (this.vaults.has(marketId)) throw new Error(`${this.id}: duplicate marketId ${marketId}`);
      this.vaults.set(marketId, { ...c, marketId, protocol: c.protocol ?? DEFAULT_PROTOCOL[c.flavor], rewardProtocol: c.rewardProtocol ?? DEFAULT_REWARD_PROTOCOL[c.flavor] });
    }
  }

  private vault(marketId: string): Vault {
    const v = this.vaults.get(marketId) ?? this.vaults.get(lc(marketId));
    if (!v) throw new Error(`${this.id}: unknown market ${marketId}`);
    return v;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private get pc() {
    return this.env.publicClient;
  }

  private async latestBlock(): Promise<Block> {
    const b = await this.pc.getBlock();
    if (b.number === null) throw new Error("latest block has no number");
    return { number: b.number, timestamp: b.timestamp };
  }

  private sharesOf(v: Vault, blockNumber?: bigint): Promise<bigint> {
    return this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: "balanceOf", args: [this.env.account], blockNumber });
  }

  private convertToAssets(v: Vault, shares: bigint, blockNumber?: bigint): Promise<bigint> {
    return this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: "convertToAssets", args: [shares], blockNumber });
  }

  private maxOf(v: Vault, fn: "maxDeposit" | "maxRedeem" | "maxWithdraw"): Promise<bigint> {
    return this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: fn, args: [this.env.account] });
  }

  private async decimalsOf(v: Vault): Promise<number> {
    const hit = this.shareDecimals.get(v.marketId);
    if (hit !== undefined) return hit;
    const d = await this.pc.readContract({ address: v.address, abi: erc20Abi, functionName: "decimals" });
    this.shareDecimals.set(v.marketId, d);
    return d;
  }

  /** The block about `hours` ago: estimate from chainInfo.blockSeconds, refined once with the observed block time. */
  private async blockAgo(now: Block, hours: number): Promise<Block> {
    const want = hours * 3600;
    const get = async (n: bigint): Promise<Block> => {
      const b = await this.pc.getBlock({ blockNumber: n < 0n ? 0n : n });
      return { number: b.number ?? n, timestamp: b.timestamp };
    };
    let b = await get(now.number - BigInt(Math.max(1, Math.round(want / chainInfo(this.chain).blockSeconds))));
    const dt = Number(now.timestamp - b.timestamp);
    const dn = Number(now.number - b.number);
    if (dn > 0 && dt > 0 && Math.abs(dt - want) > want * 0.1) b = await get(now.number - BigInt(Math.max(1, Math.round(want / (dt / dn)))));
    return b;
  }

  /** Share-price growth APR; last known value (or NaN = unknown) when history cannot be read. */
  private async growth(v: Vault, now: Block, force = false): Promise<{ apr: number; note: string }> {
    const hit = this.aprCache.get(v.marketId);
    if (!force && hit && Date.now() - hit.atMs < this.aprCacheMs) return { apr: hit.apr, note: `APR from ${hit.hours.toFixed(1)}h share-price growth` };
    try {
      const probe = priceProbeShares(await this.decimalsOf(v));
      const past = await this.blockAgo(now, this.lookbackHours);
      const [a1, a0] = await Promise.all([this.convertToAssets(v, probe, now.number), this.convertToAssets(v, probe, past.number)]);
      const elapsed = Number(now.timestamp - past.timestamp);
      const apr = growthApr(a1, a0, elapsed);
      this.aprCache.set(v.marketId, { atMs: Date.now(), apr, hours: elapsed / 3600 });
      return { apr, note: `APR from ${(elapsed / 3600).toFixed(1)}h share-price growth` };
    } catch (e) {
      if (force) throw e;
      if (hit) return { apr: hit.apr, note: `share-price history read failed (${msg(e)}); last known APR` };
      this.log("warn", `${this.id} ${v.marketId}: share-price history read failed: ${msg(e)}`);
      return { apr: Number.NaN, note: `APR unknown: share-price history read failed (${msg(e)}); needs an archive RPC` };
    }
  }

  private async eulerIrm(v: Vault, irm: Address, cash: bigint, borrows: bigint, rate: bigint, fee: number, notes: string[]): Promise<IrmModel | undefined> {
    if (irm === zeroAddress) return undefined;
    try {
      const [baseRate, slope1, slope2, kink] = await Promise.all(
        (["baseRate", "slope1", "slope2", "kink"] as const).map((fn) => this.pc.readContract({ address: irm, abi: eulerIrmLinearKinkAbi, functionName: fn }))
      );
      const m: LinearKink = { baseRate: baseRate!, slope1: slope1!, slope2: slope2!, kink: kink! };
      const modelRate = linearKinkRate(m, cash, borrows);
      const diff = modelRate > rate ? modelRate - rate : rate - modelRate;
      // interestRate() is stored at the last interaction; accept small drift only.
      if (diff * 100n > rate + 1n) {
        notes.push("IRM params do not reproduce interestRate(); IRM model omitted");
        return undefined;
      }
      return linearKinkIrmModel(m, fee);
    } catch {
      notes.push("IRM is not IRMLinearKink; no IRM model");
      return undefined;
    }
  }

  private async flavorData(v: Vault, now: Block, totalAssets: bigint, myShares: bigint, myAssets: bigint): Promise<FlavorData> {
    const notes: string[] = [];
    const boundByMaxWithdraw = async (w: bigint | undefined): Promise<bigint | undefined> => {
      if (myShares === 0n) return w;
      const mw = await this.maxOf(v, "maxWithdraw");
      return mw < myAssets ? (w === undefined ? mw : minB(w, mw)) : w;
    };
    if (v.flavor === "euler") {
      const r = <F extends "cash" | "totalBorrows" | "interestRate" | "interestFee" | "interestRateModel" | "hookConfig">(fn: F) =>
        this.pc.readContract({ address: v.address, abi: eulerEVaultAbi, functionName: fn });
      const [cash, borrows, rate, fee, irm, hook] = await Promise.all([r("cash"), r("totalBorrows"), r("interestRate"), r("interestFee"), r("interestRateModel"), r("hookConfig")]);
      const [hookTarget, hookedOps] = hook as readonly [Address, number];
      const disabled = (op: number) => (hookedOps & op) !== 0 && hookTarget === zeroAddress;
      const apr = eulerSupplyApr(eulerRateToApr(rate as bigint), cash as bigint, borrows as bigint, Number(fee));
      const irmModel = await this.eulerIrm(v, irm as Address, cash as bigint, borrows as bigint, rate as bigint, Number(fee), notes);
      let withdrawable: bigint | undefined = cash as bigint;
      if (disabled(EULER_OP_WITHDRAW) || disabled(EULER_OP_REDEEM)) {
        withdrawable = 0n;
        notes.push("withdraw/redeem disabled by the vault's hook config");
      }
      if (hookTarget !== zeroAddress) notes.push(`hook target ${hookTarget} may restrict operations`);
      return { apr, withdrawable, irm: irmModel, paused: disabled(EULER_OP_DEPOSIT), underlying: [`euler:${this.chain}:${lc(v.address)}`], notes };
    }
    if (v.flavor === "metamorpho") {
      const mv = await this.fetchMorphoVault(v.address);
      let apr: number;
      try {
        apr = apyContinuousToApr(mv.getNetApy(now.timestamp));
        notes.push(`net of ${(Number(mv.fee) / 1e16).toFixed(1)}% performance fee`);
      } catch (e) {
        const g = await this.growth(v, now);
        apr = g.apr;
        notes.push(`SDK APY unavailable (${msg(e)}); ${g.note}`);
      }
      const underlying = [...mv.allocations.values()].filter((a) => a.position.supplyAssets > 0n).map((a) => `morpho:${this.chain}:${a.marketId}`);
      if (!v.curator) notes.push(`curator ${mv.curator}`);
      return { apr, withdrawable: await boundByMaxWithdraw(minB(mv.liquidity, totalAssets)), underlying, notes };
    }
    const g = await this.growth(v, now);
    notes.push(g.note);
    if (v.flavor === "fluid") {
      const data = await this.pc.readContract({ address: v.address, abi: fluidFTokenAbi, functionName: "getData" });
      const liquidity = data[0];
      const idle = await erc20Balance(this.env, v.asset.address as Address, liquidity);
      notes.push("withdrawable = asset idle at Fluid Liquidity: an UPPER bound (the fToken's expanding withdrawal limit is not read)");
      if (data[5]) notes.push("fToken rewards active (included in the share-price APR)");
      return { apr: g.apr, withdrawable: await boundByMaxWithdraw(minB(idle, totalAssets)), underlying: [`fluid-liquidity:${this.chain}:${lc(liquidity)}`], notes };
    }
    const idle = await erc20Balance(this.env, v.asset.address as Address, v.address);
    notes.push("withdrawable = underlying held by the vault (conservative: deployed funds count as locked)");
    return { apr: g.apr, withdrawable: await boundByMaxWithdraw(minB(idle, totalAssets)), notes };
  }

  private async rewards(v: Vault): Promise<RewardRate[]> {
    if (!this.extraRewards) return [];
    try {
      return await this.extraRewards({ protocol: v.rewardProtocol, chain: this.chain, asset: v.asset, side: "supply", marketId: lc(v.address) });
    } catch (e) {
      this.log("warn", `${this.id} ${v.marketId}: reward rates failed: ${msg(e)}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // SupplyAdapter: reads
  // -------------------------------------------------------------------------

  /**
   * Per-vault isolation: a vault whose read fails (e.g. the MetaMorpho SDK
   * fetch) is skipped with a warning instead of hiding every other vault.
   * Throws only when every configured vault failed.
   */
  async supplyMarkets(): Promise<SupplyMarket[]> {
    const now = await this.latestBlock();
    const vaults = [...this.vaults.values()];
    const settled = await Promise.allSettled(vaults.map((v) => this.market(v, now)));
    const out: SupplyMarket[] = [];
    const errors: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") out.push(r.value);
      else {
        const e = `${vaults[i]!.marketId} (${vaults[i]!.flavor}): ${msg(r.reason)}`;
        errors.push(e);
        this.log("warn", `${this.id}: skipping vault ${e}`);
      }
    });
    if (vaults.length && !out.length) throw new Error(`${this.id}: every vault read failed: ${errors.join("; ")}`);
    return out;
  }

  private async market(v: Vault, now: Block): Promise<SupplyMarket> {
    const [totalAssets, myShares, maxDep, price, rewards] = await Promise.all([
      this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: "totalAssets" }),
      this.sharesOf(v),
      this.maxOf(v, "maxDeposit"),
      this.priceUsd(v.asset),
      this.rewards(v),
    ]);
    const myAssets = myShares > 0n ? await this.convertToAssets(v, myShares) : 0n;
    const fd = await this.flavorData(v, now, totalAssets, myShares, myAssets);
    const usd = (x: bigint) => unitsToUsd(x, price, v.asset.decimals);
    const notes = [v.curator ? `curator ${v.curator}` : undefined, ...fd.notes].filter(Boolean);
    return {
      protocol: v.protocol,
      chain: this.chain,
      marketId: v.marketId,
      // utilization = 1 - withdrawable/totalAssets is not a lending utilization: the core uses the liquidity rules instead
      kind: "vault",
      asset: { symbol: v.asset.symbol, assetId: lc(v.asset.address), priceUsd: price },
      totalSupplyUsd: usd(totalAssets),
      totalBorrowUsd: fd.withdrawable === undefined ? 0 : usd(totalAssets > fd.withdrawable ? totalAssets - fd.withdrawable : 0n),
      supplyAprBase: fd.apr,
      rewards,
      irm: fd.irm,
      withdrawableUsd: fd.withdrawable === undefined ? Number.NaN : usd(fd.withdrawable),
      supplyCapRemainingUsd: maxDep >= UNLIMITED_DEPOSIT ? undefined : usd(maxDep),
      paused: fd.paused ?? false,
      myDepositUsd: usd(myAssets),
      dataAsOfMs: Number(now.timestamp) * 1000,
      underlying: fd.underlying,
      note: notes.length ? notes.join("; ") : undefined,
    };
  }

  /** Exit value of my shares: previewRedeem (includes any withdrawal fee), convertToAssets if it reverts. */
  private async exitValue(v: Vault, shares: bigint): Promise<bigint> {
    try {
      return await this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: "previewRedeem", args: [shares] });
    } catch (e) {
      if (!isRevertError(e)) throw e;
      return this.convertToAssets(v, shares);
    }
  }

  async supplyPosition(marketId: string): Promise<SupplyPositionView | null> {
    const v = this.vault(marketId);
    const [shares, now] = await Promise.all([this.sharesOf(v), this.latestBlock()]);
    if (shares === 0n) return null;
    const [units, price] = await Promise.all([this.exitValue(v, shares), this.priceUsd(v.asset)]);
    return { marketId: v.marketId, depositUsd: unitsToUsd(units, price, v.asset.decimals), units, rewardsUnclaimed: [], asOfMs: Number(now.timestamp) * 1000 };
  }

  async walletBalance(asset: AssetRef): Promise<bigint> {
    return erc20Balance(this.env, asset.address as Address);
  }

  // -------------------------------------------------------------------------
  // SupplyAdapter: writes
  // -------------------------------------------------------------------------

  private depositReq(v: Vault, amount: bigint): TxRequest {
    return { to: v.address, data: call(erc4626Abi, "deposit", [amount, this.env.account]), description: `${this.id} deposit ${amount} ${v.asset.symbol} into ${v.marketId}` };
  }

  private redeemReq(v: Vault, shares: bigint): TxRequest {
    return { to: v.address, data: call(erc4626Abi, "redeem", [shares, this.env.account, this.env.account]), description: `${this.id} redeem ${shares} shares of ${v.marketId}` };
  }

  /** Exact-amount approve requests (reset to 0 first, as ensureAllowance does) for a dry-run bundle. */
  private async approveReqs(token: Address, spender: Address, amount: bigint): Promise<TxRequest[]> {
    const cur = await this.pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.env.account, spender] });
    if (cur >= amount) return [];
    const out: TxRequest[] = [];
    if (cur > 0n) out.push({ to: token, data: call(erc20Abi, "approve", [spender, 0n]), description: `reset allowance ${token} -> ${spender}` });
    out.push({ to: token, data: call(erc20Abi, "approve", [spender, amount]), description: `approve ${amount} ${token} -> ${spender}` });
    return out;
  }

  /**
   * Leave no allowance behind (a vault that pulled less than approved). Best
   * effort: never fails the caller. Sends NOTHING once any tx of this call is
   * unconfirmed: a new tx could take the pending nonce and replace it.
   */
  private async resetAllowance(token: Address, spender: Address, ctx: LiveContext, txs: TxRecord[]): Promise<void> {
    if (txs.some((t) => t.unconfirmed)) return;
    try {
      const cur = await this.pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.env.account, spender] });
      if (cur === 0n) return;
      txs.push(await sendTx(this.env, ctx, { to: token, data: call(erc20Abi, "approve", [spender, 0n]), description: `reset leftover allowance ${cur} ${token} -> ${spender}` }));
    } catch (e) {
      if (isUnconfirmed(e)) txs.push(unconfirmedRecord(this.chain, e));
      this.log("warn", `${this.id}: allowance reset ${token} -> ${spender} failed: ${msg(e)}`);
    }
  }

  async deposit(marketId: string, amount: bigint, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    const fail = (d: string): LiveResult => ({ ok: false, txs, detail: `${this.id} deposit ${marketId}: ${d}` });
    try {
      const v = this.vault(marketId);
      if (!(amount > 0n)) return fail("amount must be > 0");
      const token = v.asset.address as Address;
      const [have, maxDep, before] = await Promise.all([this.walletBalance(v.asset), this.maxOf(v, "maxDeposit"), this.sharesOf(v)]);
      if (have < amount) return fail(`wallet has ${have} ${v.asset.symbol} base units, need ${amount}`);
      if (maxDep < amount) return fail(maxDep === 0n ? "deposits disabled or vault full (maxDeposit = 0)" : `vault cap: maxDeposit ${maxDep} < amount ${amount}`);
      if (v.flavor === "fluid") {
        const minDep = await this.pc.readContract({ address: v.address, abi: fluidFTokenAbi, functionName: "minDeposit" });
        if (amount < minDep) return fail(`below Fluid minDeposit ${minDep}`);
      }
      const price = await ctx.priceUsd(v.asset);
      const req = this.depositReq(v, amount);
      if (ctx.dryRun) {
        const reqs = [...(await this.approveReqs(token, v.address, amount)), req];
        const sim = await simulateBundle(this.env, ctx, reqs);
        txs.push(...sim.records);
        return { ok: true, txs, amountUsd: unitsToUsd(amount, price, v.asset.decimals), detail: `dry-run: ${reqs.length > 1 ? (sim.bundled ? "approve + deposit simulated in sequence" : sim.note) : "deposit simulated"}` };
      }
      txs.push(...(await ensureAllowance(this.env, ctx, token, v.address, amount)));
      try {
        txs.push(await sendTx(this.env, ctx, req));
      } catch (e) {
        if (!isUnconfirmed(e)) {
          await this.resetAllowance(token, v.address, ctx, txs);
          throw e;
        }
        // Unconfirmed: re-read only. Nothing more is signed in this call (no allowance reset):
        // a follow-up tx could reuse the pending nonce and cancel the deposit we report.
        txs.push(unconfirmedRecord(this.chain, e));
        const [now, left] = await Promise.all([
          this.sharesOf(v),
          this.pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.env.account, v.address] }),
        ]);
        const allowanceNote = left > 0n ? `; allowance ${left} left to ${v.address} (not reset while a tx is unconfirmed)` : "";
        if (now > before) {
          const got = await this.convertToAssets(v, now - before);
          return { ok: true, txs, amountUsd: unitsToUsd(got, price, v.asset.decimals), detail: `deposit ${e.id} unconfirmed but the share balance shows it landed (${before} -> ${now})${allowanceNote}` };
        }
        return fail(`UNCONFIRMED: deposit ${e.id} (nonce ${e.nonce ?? "?"}) may still land; shares ${before} -> ${now} at re-read. Resolve it before retrying${allowanceNote}`);
      }
      await this.resetAllowance(token, v.address, ctx, txs);
      const after = await this.sharesOf(v);
      const got = after > before ? await this.convertToAssets(v, after - before) : 0n;
      return { ok: true, txs, amountUsd: unitsToUsd(got, price, v.asset.decimals), detail: `deposited ${amount} ${v.asset.symbol} (shares ${before} -> ${after})` };
    } catch (e) {
      if (isUnconfirmed(e)) txs.push(unconfirmedRecord(this.chain, e));
      return fail(msg(e));
    }
  }

  async withdraw(marketId: string, fraction: number, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    const fail = (d: string): LiveResult => ({ ok: false, txs, detail: `${this.id} withdraw ${marketId}: ${d}` });
    if (!(fraction > 0 && fraction <= 1)) return fail(`fraction must be in (0,1], got ${fraction}`);
    try {
      const v = this.vault(marketId);
      const shares = await this.sharesOf(v);
      if (shares === 0n) return { ok: true, txs, detail: `${this.id} withdraw ${marketId}: no deposit` };
      const full = fraction >= 1 - 1e-9;
      const need = full ? shares : fractionOf(shares, fraction);
      if (need === 0n) return fail("amount rounds to 0 shares");
      const [maxR, maxW, expected] = await Promise.all([this.maxOf(v, "maxRedeem"), this.maxOf(v, "maxWithdraw"), this.exitValue(v, need)]);
      if (maxR < need || maxW + 2n < expected)
        return fail(
          `illiquid: maxRedeem ${maxR} < ${need} shares needed or maxWithdraw ${maxW} < ${expected} ${v.asset.symbol} (the vault's assets are lent out / locked right now); the router treats this as a failed exit and retries`
        );
      const price = await ctx.priceUsd(v.asset);
      const req = this.redeemReq(v, need);
      if (ctx.dryRun) {
        txs.push(await sendTx(this.env, ctx, req));
        return { ok: true, txs, amountUsd: unitsToUsd(expected, price, v.asset.decimals), detail: `dry-run: redeem ${need}${full ? " (all)" : ""} shares simulated` };
      }
      const wBefore = await this.walletBalance(v.asset);
      try {
        txs.push(await sendTx(this.env, ctx, req));
      } catch (e) {
        if (!isUnconfirmed(e)) throw e;
        txs.push(unconfirmedRecord(this.chain, e));
        const [now, wNow] = await Promise.all([this.sharesOf(v), this.walletBalance(v.asset)]);
        if (now < shares && wNow > wBefore)
          return { ok: true, txs, amountUsd: unitsToUsd(wNow - wBefore, price, v.asset.decimals), detail: `redeem ${e.id} unconfirmed but balances show it landed (shares ${shares} -> ${now})` };
        return fail(`UNCONFIRMED: redeem ${e.id} (nonce ${e.nonce ?? "?"}) may still land; shares ${shares} -> ${now} at re-read. Resolve it before retrying.`);
      }
      const got = (await this.walletBalance(v.asset)) - wBefore;
      return { ok: true, txs, amountUsd: unitsToUsd(got > 0n ? got : 0n, price, v.asset.decimals), detail: `redeemed ${need} shares${full ? " (all)" : ""} for ${got} ${v.asset.symbol}` };
    } catch (e) {
      if (isUnconfirmed(e)) txs.push(unconfirmedRecord(this.chain, e));
      return fail(msg(e));
    }
  }

  /** eth_call of redeem(all my shares): true = would succeed, false = reverts; RPC errors throw. */
  async simulateWithdraw(marketId: string, _ctx: LiveContext): Promise<boolean> {
    const v = this.vault(marketId);
    const shares = await this.sharesOf(v);
    if (shares === 0n) return true;
    try {
      await this.pc.call({ account: this.env.account, to: v.address, data: this.redeemReq(v, shares).data });
      return true;
    } catch (e) {
      if (isRevertError(e)) {
        this.log("warn", `${this.id} simulateWithdraw ${marketId}: redeem(all) reverts: ${msg(e)}`);
        return false;
      }
      throw e;
    }
  }

  async claimRewards(_ctx: LiveContext, _marketId?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }> {
    return { ok: true, txs: [], claimed: [], detail: `${this.id}: vault rewards accrue in the share price or via Merkl (claimed by the rewards module)` };
  }

  // -------------------------------------------------------------------------
  // verify
  // -------------------------------------------------------------------------

  /** Reads every configured vault back on-chain. Empty = OK for live. */
  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        issues.push(`${label}: ${msg(e)}`);
      }
    };
    await attempt(`${this.id}: chainId`, () => assertChainId(this.env));
    for (const v of this.vaults.values()) {
      const tag = `${this.id} ${v.marketId} (${v.flavor})`;
      const code = await this.pc.getCode({ address: v.address }).catch(() => undefined);
      if (!code || code === "0x") {
        issues.push(`${tag}: vault ${v.address} has no code`);
        continue;
      }
      if (v.asset.chain !== this.chain) issues.push(`${tag}: asset ${v.asset.symbol} is on ${v.asset.chain}, adapter is on ${this.chain}`);
      await attempt(`${tag}: asset()`, async () => {
        const a = await this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: "asset" });
        if (!isAddressEqual(a, v.asset.address as Address)) issues.push(`${tag}: vault asset() ${a} != configured ${v.asset.symbol} ${v.asset.address}`);
      });
      await attempt(`${tag}: ${v.asset.symbol}`, async () => void issues.push(...(await verifyAsset(this.env, v.asset))));
      await attempt(`${tag}: decimals()/totalAssets()/convertToAssets()`, async () => {
        const d = await this.decimalsOf(v);
        if (d < v.asset.decimals) issues.push(`${tag}: share decimals ${d} < asset decimals ${v.asset.decimals} (not a standard ERC-4626 offset)`);
        await this.pc.readContract({ address: v.address, abi: erc4626Abi, functionName: "totalAssets" });
        await this.convertToAssets(v, priceProbeShares(d));
      });
      await attempt(`${tag}: maxDeposit`, async () => {
        if ((await this.maxOf(v, "maxDeposit")) === 0n) issues.push(`${tag}: deposits disabled or vault full (maxDeposit(us) = 0)`);
      });
      if (v.flavor === "euler")
        await attempt(`${tag}: EVault selectors`, async () => {
          const r = <F extends "EVC" | "interestRate" | "interestFee" | "cash" | "hookConfig">(fn: F) => this.pc.readContract({ address: v.address, abi: eulerEVaultAbi, functionName: fn });
          const [evc, , , , hook] = await Promise.all([r("EVC"), r("interestRate"), r("interestFee"), r("cash"), r("hookConfig")]);
          if (evc === zeroAddress) issues.push(`${tag}: EVC() is zero`);
          const [target, ops] = hook as readonly [Address, number];
          if (target === zeroAddress && (ops & EULER_OP_DEPOSIT) !== 0) issues.push(`${tag}: deposits disabled (OP_DEPOSIT hooked, no hook target)`);
          if (target === zeroAddress && (ops & (EULER_OP_WITHDRAW | EULER_OP_REDEEM)) !== 0) issues.push(`${tag}: withdrawals disabled by hook config`);
        });
      if (v.flavor === "metamorpho")
        await attempt(`${tag}: MetaMorpho`, async () => {
          const morpho = await this.pc.readContract({ address: v.address, abi: metaMorphoAbi, functionName: "MORPHO" });
          let blue: Address | undefined;
          try {
            blue = getChainAddresses(this.env.viemChain.id).blue; // SOURCE: @morpho-org/blue-sdk address registry
          } catch {
            blue = undefined;
          }
          if (blue && !isAddressEqual(morpho, blue)) issues.push(`${tag}: MORPHO() ${morpho} != registry Morpho ${blue}`);
          const mv = await this.fetchMorphoVault(v.address); // SDK fetcher checks the MetaMorpho factory
          if (!isAddressEqual(mv.asset, v.asset.address as Address)) issues.push(`${tag}: SDK vault asset ${mv.asset} != configured`);
        });
      if (v.flavor === "fluid")
        await attempt(`${tag}: fToken getData()/minDeposit()`, async () => {
          const data = await this.pc.readContract({ address: v.address, abi: fluidFTokenAbi, functionName: "getData" });
          const lcode = await this.pc.getCode({ address: data[0] });
          if (!lcode || lcode === "0x") issues.push(`${tag}: Fluid Liquidity ${data[0]} has no code`);
          await this.pc.readContract({ address: v.address, abi: fluidFTokenAbi, functionName: "minDeposit" });
        });
      if (v.flavor === "fluid" || v.flavor === "generic")
        await attempt(`${tag}: APR needs historical eth_call ${this.lookbackHours}h back (archive RPC)`, async () => void (await this.growth(v, await this.latestBlock(), true)));
    }
    return issues;
  }
}
