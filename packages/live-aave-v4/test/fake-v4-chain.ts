/**
 * Offline stateful fake of one Aave V4 spoke (USDe collateral reserve 1,
 * USDt debt reserve 2, both on one hub) + oracle + IRM + two ERC20s + a swap
 * venue, behind viem-shaped PublicClient / WalletClient objects. Spoke
 * semantics follow aave-v4 v0.5.11: supply pulls via allowance, borrow and
 * withdraw require HF >= 1 (HF = CF * collateral / debt), withdraw/repay cap
 * at the balance / debt, multicall applies inner calls atomically.
 */
import { decodeFunctionData, erc20Abi, getAddress, keccak256, pad, toFunctionSelector, type Abi, type AbiFunction, type Address, type Chain, type Hex } from "viem";
import type { AssetRef, LiveContext, SwapAdapter, SwapQuote } from "@incentive-router/live-common";
import { Mutex, type EvmEnv, type PublicClient, type WalletClient } from "@incentive-router/live-evm-base";
import { SPOKE_ABI, SPOKE_WRITE_FUNCTIONS } from "../src/abi.js";
import { MAX_SPOKE_CAP, MAX_UINT256 } from "../src/math.js";

export const ME = getAddress("0x1111111111111111111111111111111111111111");
export const SPOKE = getAddress("0x2222222222222222222222222222222222222222");
export const USDE = getAddress("0x3333333333333333333333333333333333333333");
export const USDT = getAddress("0x4444444444444444444444444444444444444444");
export const HUB = getAddress("0x5555555555555555555555555555555555555555");
export const ORACLE = getAddress("0x8888888888888888888888888888888888888888");
export const IRM = getAddress("0x9999999999999999999999999999999999999999");
export const IMPL = getAddress("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
export const COLL_ID = 1n;
export const DEBT_ID = 2n;
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

export const usdeRef: AssetRef = { chain: "avalanche", symbol: "USDe", address: USDE, decimals: 18 };
export const usdtRef: AssetRef = { chain: "avalanche", symbol: "USDt", address: USDT, decimals: 6 };

interface State {
  wallet: Record<string, bigint>;
  allowance: Record<string, bigint>;
  supplied: bigint;
  debt: bigint;
  usingAsCollateral: boolean;
  lastRiskPremium: bigint;
}

const lc = (a: string) => a.toLowerCase();
const clone = (s: State): State => ({ ...s, wallet: { ...s.wallet }, allowance: { ...s.allowance } });

export class FakeV4 {
  cfBps = 9300;
  collateralRiskBps = 2500;
  debtBorrowable = true;
  collPaused = false;
  drawnRateUsdt = 4n * 10n ** 25n; // 4% RAY
  drawnRateUsde = 1n * 10n ** 25n;
  priceUsde = 100_000_000n; // $1 (8 dec)
  priceUsdt = 100_000_000n;
  swapCostBps = 5;
  swapFails = false;
  simulateCallsSupported = true;
  implSelectors: readonly string[] = [...SPOKE_WRITE_FUNCTIONS, "getUserAccountData", "getReserve", "getUserTotalDebt", "getUserSuppliedAssets"];
  blockTs = Math.floor(Date.UTC(2026, 9, 29, 12) / 1000);
  /** Txs that were applied on-chain, in order. */
  sent: { to: Address; data: Hex }[] = [];
  /** Every raw tx submitted via sendRawTransaction (applied or not). */
  submitted = 0;
  /**
   * Make the Nth submission (0-based) ambiguous: "landed" = applied but no
   * receipt (wait times out); "dropped" = submit times out and the node never
   * saw it. Either way sendTx throws BroadcastUnconfirmedError.
   */
  unconfirmed?: { at: number; mode: "landed" | "dropped" };
  private nonce = 0;
  private signed = new Map<Hex, { to: Address; data: Hex }>();
  private mined = new Map<Hex, "success" | "reverted">();
  private noReceipt = new Set<Hex>();
  /** Highest LTV after any borrow / withdraw; lowest HF after any withdraw while in debt. */
  maxLtvSeen = 0;
  minHfAfterWithdraw = Infinity;
  state: State = { wallet: { [lc(USDE)]: 10_000n * E18, [lc(USDT)]: 0n }, allowance: { [lc(USDE)]: 0n, [lc(USDT)]: 0n }, supplied: 0n, debt: 0n, usingAsCollateral: false, lastRiskPremium: 0n };

  private collUsd(s: State) {
    return (Number(s.supplied) / 1e18) * (Number(this.priceUsde) / 1e8);
  }
  private debtUsd(s: State) {
    return (Number(s.debt) / 1e6) * (Number(this.priceUsdt) / 1e8);
  }
  ltv(s = this.state) {
    const c = this.collUsd(s);
    return c > 0 ? this.debtUsd(s) / c : 0;
  }
  hf(s = this.state) {
    return s.debt > 0n ? ((this.cfBps / 1e4) * this.collUsd(s)) / this.debtUsd(s) : Infinity;
  }

  // ------------------------------------------------------------------ writes
  private applySpoke(s: State, data: Hex, track: boolean): void {
    const d = decodeFunctionData({ abi: SPOKE_ABI, data }) as unknown as { functionName: string; args: readonly unknown[] };
    const tok = (id: bigint) => (id === COLL_ID ? lc(USDE) : lc(USDT));
    switch (d.functionName) {
      case "multicall":
        for (const inner of d.args[0] as Hex[]) this.applySpoke(s, inner, track);
        return;
      case "supply": {
        const [id, amt, who] = d.args as [bigint, bigint, Address];
        if (lc(who) !== lc(ME) || id !== COLL_ID) throw new Error("Unauthorized/unsupported supply");
        if (this.collPaused) throw new Error("ReservePaused");
        const t = tok(id);
        if (s.allowance[t]! < amt) throw new Error("ERC20InsufficientAllowance");
        if (s.wallet[t]! < amt) throw new Error("ERC20InsufficientBalance");
        s.allowance[t]! -= amt;
        s.wallet[t]! -= amt;
        s.supplied += amt;
        return;
      }
      case "setUsingAsCollateral":
        s.usingAsCollateral = d.args[1] as boolean;
        return;
      case "borrow": {
        const [id, amt] = d.args as [bigint, bigint];
        if (id !== DEBT_ID || !this.debtBorrowable) throw new Error("ReserveNotBorrowable");
        s.debt += amt;
        s.wallet[lc(USDT)]! += amt;
        if (!s.usingAsCollateral || this.hf(s) < 1) throw new Error("HealthFactorBelowThreshold");
        s.lastRiskPremium = BigInt(this.collateralRiskBps);
        if (track) this.maxLtvSeen = Math.max(this.maxLtvSeen, this.ltv(s));
        return;
      }
      case "withdraw": {
        const [id, amt] = d.args as [bigint, bigint];
        if (id !== COLL_ID) throw new Error("unsupported withdraw");
        const w = amt < s.supplied ? amt : s.supplied;
        s.supplied -= w;
        s.wallet[lc(USDE)]! += w;
        if (s.debt > 0n && this.hf(s) < 1) throw new Error("HealthFactorBelowThreshold");
        if (track && s.debt > 0n) {
          this.maxLtvSeen = Math.max(this.maxLtvSeen, this.ltv(s));
          this.minHfAfterWithdraw = Math.min(this.minHfAfterWithdraw, this.hf(s));
        }
        return;
      }
      case "repay": {
        const [id, amt] = d.args as [bigint, bigint];
        if (id !== DEBT_ID) throw new Error("unsupported repay");
        const r = amt < s.debt ? amt : s.debt;
        const t = lc(USDT);
        if (s.allowance[t]! < r) throw new Error("ERC20InsufficientAllowance");
        if (s.wallet[t]! < r) throw new Error("ERC20InsufficientBalance");
        s.allowance[t]! -= r;
        s.wallet[t]! -= r;
        s.debt -= r;
        return;
      }
      default:
        throw new Error(`fake spoke: ${d.functionName} not implemented`);
    }
  }

  private apply(s: State, to: Address, data: Hex, track: boolean): void {
    if (lc(to) === lc(SPOKE)) return this.applySpoke(s, data, track);
    if (lc(to) === lc(USDE) || lc(to) === lc(USDT)) {
      const d = decodeFunctionData({ abi: erc20Abi, data }) as unknown as { functionName: string; args: readonly unknown[] };
      if (d.functionName !== "approve") throw new Error(`fake token: ${d.functionName}`);
      const [spender, amt] = d.args as [Address, bigint];
      if (lc(spender) !== lc(SPOKE)) throw new Error("fake token: approve to non-spoke");
      s.allowance[lc(to)] = amt;
      return;
    }
    throw new Error(`fake: no contract at ${to}`);
  }

  // ------------------------------------------------------------------ reads
  private read(address: Address, functionName: string, args: readonly unknown[] = []): unknown {
    const s = this.state;
    const a = lc(address);
    if (a === lc(SPOKE)) {
      const id = args[0] as bigint;
      switch (functionName) {
        case "ORACLE":
          return ORACLE;
        case "getReserve":
          if (id === COLL_ID) return { underlying: USDE, hub: HUB, assetId: 0, decimals: 18, collateralRisk: this.collateralRiskBps, flags: 0, dynamicConfigKey: 1 };
          if (id === DEBT_ID) return { underlying: USDT, hub: HUB, assetId: 1, decimals: 6, collateralRisk: 0, flags: 4, dynamicConfigKey: 1 };
          throw new Error("ReserveNotListed");
        case "getReserveConfig":
          return id === COLL_ID
            ? { collateralRisk: this.collateralRiskBps, paused: this.collPaused, frozen: false, borrowable: false, receiveSharesEnabled: true }
            : { collateralRisk: 0, paused: false, frozen: false, borrowable: this.debtBorrowable, receiveSharesEnabled: true };
        case "getDynamicReserveConfig":
          return id === COLL_ID ? { collateralFactor: this.cfBps, maxLiquidationBonus: 10_300, liquidationFee: 1000 } : { collateralFactor: 0, maxLiquidationBonus: 10_000, liquidationFee: 0 };
        case "getReserveSuppliedAssets":
          return id === COLL_ID ? 20_000_000n * E18 + s.supplied : 0n;
        case "getReserveDebt":
          return id === COLL_ID ? [0n, 0n] : [2_000_000n * E6 + s.debt, 0n];
        case "getUserSuppliedAssets":
          return id === COLL_ID ? s.supplied : 0n;
        case "getUserTotalDebt":
          return id === DEBT_ID ? s.debt : 0n;
        case "getUserReserveStatus":
          return id === COLL_ID ? [s.usingAsCollateral, false] : [false, s.debt > 0n];
        case "getUserPosition":
          return { drawnShares: 0n, premiumShares: 0n, premiumOffsetRay: 0n, suppliedShares: id === COLL_ID ? s.supplied : 0n, dynamicConfigKey: 1 };
        case "getUserAccountData": {
          const hf = this.hf();
          return {
            riskPremium: s.debt > 0n ? BigInt(this.collateralRiskBps) : 0n,
            avgCollateralFactor: BigInt(this.cfBps) * 10n ** 14n,
            healthFactor: Number.isFinite(hf) ? BigInt(Math.floor(hf * 1e9)) * 10n ** 9n : MAX_UINT256,
            totalCollateralValue: BigInt(Math.floor(this.collUsd(s) * 1e8)) * 10n ** 18n,
            totalDebtValueRay: BigInt(Math.floor(this.debtUsd(s) * 1e8)) * 10n ** 45n,
            activeCollateralCount: s.supplied > 0n ? 1n : 0n,
            borrowCount: s.debt > 0n ? 1n : 0n,
          };
        }
        case "getUserLastRiskPremium":
          return s.lastRiskPremium;
        case "getReserveId": {
          const [hub, assetId] = args as [Address, bigint];
          if (lc(hub) !== lc(HUB)) throw new Error("not listed");
          return assetId === 0n ? COLL_ID : DEBT_ID;
        }
        case "isPositionManagerActive":
        case "isPositionManager":
          return false;
      }
    }
    if (a === lc(ORACLE)) {
      if (functionName === "getReservePrice") return (args[0] as bigint) === COLL_ID ? this.priceUsde : this.priceUsdt;
      if (functionName === "decimals") return 8;
      if (functionName === "spoke") return SPOKE;
    }
    if (a === lc(HUB)) {
      const assetId = args[0] as bigint;
      const usde = assetId === 0n;
      switch (functionName) {
        case "getAssetId":
          if (lc(args[0] as string) === lc(USDE)) return 0n;
          if (lc(args[0] as string) === lc(USDT)) return 1n;
          throw new Error("AssetNotListed");
        case "getAssetUnderlyingAndDecimals":
          return usde ? [USDE, 18] : [USDT, 6];
        case "getAsset":
          return usde
            ? { liquidity: 5_000_000n * E18, swept: 0n, liquidityFee: 1000, irStrategy: IRM, underlying: USDE, decimals: 18 }
            : { liquidity: 3_500_000n * E6 - s.debt, swept: 0n, liquidityFee: 1000, irStrategy: IRM, underlying: USDT, decimals: 6 };
        case "getAssetDrawnRate":
          return usde ? this.drawnRateUsde : this.drawnRateUsdt;
        case "getAssetOwed":
          return usde ? [1_000_000n * E18, 0n] : [10_000_000n * E6 + s.debt, 50_000n * E6];
        case "getAddedAssets":
          return usde ? 50_000_000n * E18 + s.supplied : 13_550_000n * E6;
        case "getSpoke":
          return usde
            ? { drawnShares: 0n, premiumShares: 0n, premiumOffsetRay: 0n, addedShares: 0n, addCap: Number(MAX_SPOKE_CAP), drawCap: 0, riskPremiumThreshold: 0, active: true, halted: false, deficitRay: 0n }
            : { drawnShares: 0n, premiumShares: 0n, premiumOffsetRay: 0n, addedShares: 0n, addCap: 0, drawCap: 12_000_000, riskPremiumThreshold: 0, active: true, halted: false, deficitRay: 0n };
        case "getSpokeAddedAssets":
          return usde ? 20_000_000n * E18 + s.supplied : 0n;
        case "getSpokeOwed":
          return usde ? [0n, 0n] : [2_000_000n * E6 + s.debt, 0n];
      }
    }
    if (a === lc(IRM) && functionName === "getInterestRateData")
      return { optimalUsageRatio: 9000, baseDrawnRate: 0, rateGrowthBeforeOptimal: 500, rateGrowthAfterOptimal: 6000 };
    if (a === lc(USDE) || a === lc(USDT)) {
      switch (functionName) {
        case "balanceOf":
          return lc(args[0] as string) === lc(ME) ? s.wallet[a]! : 0n;
        case "allowance":
          return lc(args[0] as string) === lc(ME) && lc(args[1] as string) === lc(SPOKE) ? s.allowance[a]! : 0n;
        case "symbol":
          return a === lc(USDE) ? "USDe" : "USDt";
        case "decimals":
          return a === lc(USDE) ? 18 : 6;
      }
    }
    throw new Error(`fake read: ${address}.${functionName} not implemented`);
  }

  // ------------------------------------------------------------------ viem-shaped clients
  readonly publicClient = {
    getChainId: async () => 43114,
    getBlock: async () => ({ number: 100n, timestamp: BigInt(this.blockTs) }),
    readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => this.read(p.address, p.functionName, p.args),
    multicall: async (p: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[] }) =>
      p.contracts.map((c) => this.read(c.address, c.functionName, c.args)),
    call: async (p: { to: Address; data: Hex }) => {
      this.apply(clone(this.state), p.to, p.data, false);
      return { data: "0x" };
    },
    estimateGas: async () => 100_000n,
    getGasPrice: async () => 25n * 10n ** 9n,
    simulateCalls: async (p: { calls: { to: Address; data: Hex }[] }) => {
      if (!this.simulateCallsSupported) throw new Error("the method eth_simulateV1 does not exist/is not available");
      const s = clone(this.state);
      const results: { status: string; gasUsed: bigint; error?: Error }[] = [];
      let failed = false;
      for (const c of p.calls) {
        if (failed) {
          results.push({ status: "failure", gasUsed: 0n, error: new Error("skipped") });
          continue;
        }
        try {
          this.apply(s, c.to, c.data, false);
          results.push({ status: "success", gasUsed: 100_000n });
        } catch (e) {
          failed = true;
          results.push({ status: "failure", gasUsed: 0n, error: e as Error });
        }
      }
      return { results };
    },
    sendRawTransaction: async (p: { serializedTransaction: Hex }) => {
      const raw = p.serializedTransaction;
      const tx = this.signed.get(raw);
      if (!tx) throw new Error("fake: unknown raw tx");
      const hash = keccak256(raw);
      const idx = this.submitted++;
      const amb = this.unconfirmed?.at === idx ? this.unconfirmed.mode : undefined;
      if (amb === "dropped") throw new Error("request timed out");
      const s = clone(this.state);
      try {
        this.apply(s, tx.to, tx.data, true);
        this.state = s;
        this.sent.push(tx);
        this.mined.set(hash, "success");
      } catch {
        this.mined.set(hash, "reverted");
      }
      this.nonce++;
      if (amb === "landed") this.noReceipt.add(hash);
      return hash;
    },
    getTransaction: async (p: { hash: Hex }) => {
      if (!this.mined.has(p.hash)) throw new Error("transaction not found");
      return { hash: p.hash };
    },
    waitForTransactionReceipt: async (p: { hash: Hex }) => {
      if (this.noReceipt.has(p.hash)) throw new Error("Timed out while waiting for transaction");
      const st = this.mined.get(p.hash);
      if (!st) throw new Error("Timed out while waiting for transaction");
      return { status: st, gasUsed: 100_000n, effectiveGasPrice: 25n * 10n ** 9n };
    },
    getCode: async (p: { address: Address }) => {
      if (lc(p.address) === lc(IMPL)) {
        const sels = this.implSelectors.map((n) => {
          const item = (SPOKE_ABI as Abi).find((x): x is AbiFunction => x.type === "function" && x.name === n)!;
          return "63" + toFunctionSelector(item).slice(2);
        });
        return `0x6080${sels.join("")}` as Hex;
      }
      return [SPOKE, ORACLE, HUB, IRM, USDE, USDT].some((x) => lc(x) === lc(p.address)) ? ("0x60016000" as Hex) : undefined;
    },
    getStorageAt: async (p: { address: Address }) => (lc(p.address) === lc(SPOKE) ? pad(IMPL) : pad("0x0")),
  };

  readonly walletClient = {
    account: { address: ME },
    prepareTransactionRequest: async (p: { to: Address; data: Hex; value?: bigint; gas?: bigint }) => ({ ...p, nonce: this.nonce }),
    signTransaction: async (p: { to: Address; data: Hex; nonce: number }) => {
      // Unique, opaque "raw tx"; the fake keeps the mapping back to (to, data).
      const raw = `0x02${(this.signed.size + 1).toString(16).padStart(8, "0")}${p.nonce.toString(16).padStart(8, "0")}${p.to.slice(2)}${p.data.slice(2)}` as Hex;
      this.signed.set(raw, { to: p.to, data: p.data });
      return raw;
    },
  };

  env(readOnly = false): EvmEnv {
    return {
      chain: "avalanche",
      viemChain: { id: 43114, name: "avalanche" } as Chain,
      publicClient: this.publicClient as unknown as PublicClient,
      walletClient: readOnly ? undefined : (this.walletClient as unknown as WalletClient),
      account: ME,
      lock: new Mutex(),
    };
  }

  /** USDe/USDt at oracle prices minus `swapCostBps`. */
  readonly swapper: SwapAdapter = {
    id: "fake-swap",
    chain: "avalanche",
    quote: async (from: AssetRef, to: AssetRef, amountIn: bigint): Promise<SwapQuote> => {
      const pIn = lc(from.address) === lc(USDE) ? this.priceUsde : this.priceUsdt;
      const pOut = lc(to.address) === lc(USDE) ? this.priceUsde : this.priceUsdt;
      const out = (amountIn * pIn * 10n ** BigInt(to.decimals) * BigInt(10_000 - this.swapCostBps)) / (pOut * 10n ** BigInt(from.decimals) * 10_000n);
      return { amountIn, amountOut: out, costBps: this.swapCostBps, route: "fake", validUntilMs: Date.now() + 60_000 };
    },
    swap: async (q: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext) => {
      if (this.swapFails) return { ok: false, txs: [], detail: "no route" };
      if (ctx.dryRun) return { ok: true, txs: [{ chain: "avalanche", description: "fake swap", simulated: true }] };
      const f = lc(from.address);
      const t = lc(to.address);
      if (this.state.wallet[f]! < q.amountIn) return { ok: false, txs: [], detail: "insufficient" };
      this.state.wallet[f]! -= q.amountIn;
      this.state.wallet[t]! += q.amountOut;
      return { ok: true, txs: [{ chain: "avalanche", id: "0xswap", description: `swap ${from.symbol}->${to.symbol}`, simulated: false }] };
    },
  };
}

export function testCtx(dryRun: boolean, over: Partial<LiveContext> = {}): LiveContext {
  return {
    dryRun,
    log: () => {},
    limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 50, maxLoopIterations: 12 },
    priceUsd: async () => 1,
    nativePriceUsd: async () => 30,
    ...over,
  };
}
