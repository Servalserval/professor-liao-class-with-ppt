/**
 * Offline tests for the ERC-4626 vault adapter. RPC = an in-memory chain of
 * ERC-4626 vaults (FakeVaults) behind a mocked viem PublicClient /
 * WalletClient; MetaMorpho data = SDK AccrualVault objects built from
 * @morpho-org/blue-sdk classes. Addresses are synthetic test values.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccrualPosition, AccrualVault, getChainAddresses, Market, MarketParams } from "@morpho-org/blue-sdk";
import { decodeFunctionData, erc20Abi, erc4626Abi, keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { Mutex, viemChainFor, type EvmEnv } from "@incentive-router/live-evm-base";
import type { AssetRef, LiveContext, RewardRateQuery } from "@incentive-router/live-common";
import {
  ERC4626VaultAdapter,
  EULER_OP_DEPOSIT,
  EULER_SECONDS_PER_YEAR,
  apyContinuousToApr,
  eulerRateToApr,
  eulerSupplyApr,
  growthApr,
  linearKinkIrmModel,
  linearKinkRate,
  priceProbeShares,
  type VaultConfig,
} from "../src/vault/index.js";

const E6 = 10n ** 6n;
const E12 = 10n ** 12n;
const RAY = 10n ** 27n;
const ACCOUNT = "0xa11ce00000000000000000000000000000000001" as Address;
const USDC = "0x0000000000000000000000000000000000005dc0" as Address;
const V_EULER = "0x00000000000000000000000000000000e1e1e1e1" as Address;
const V_GEN = "0x0000000000000000000000000000000000006e00" as Address;
const V_FLUID = "0x00000000000000000000000000000000f1f1f1f1" as Address;
const V_MM = "0x000000000000000000000000000000000000a0a0" as Address;
const FLUID_LIQ = "0x00000000000000000000000000000000f10f10f1" as Address;
const EULER_IRM = "0x00000000000000000000000000000000000001a1" as Address;
const EVC = "0x0000000000000000000000000000000000000ec0" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const BASE = getChainAddresses(8453);
const usdc: AssetRef = { chain: "base", symbol: "USDC", address: USDC, decimals: 6 };
const LATEST = 10_000_000n;
const T = 1_750_000_000n;
const BLOCK_S = 2n; // chains.ts base blockSeconds

// Euler IRMLinearKink: 0% base, 4% APR at kink 90%, 100% APR at 100% (RAY/s, uint32 utilization scale)
const U32 = 2n ** 32n - 1n;
const KINK = (U32 * 9n) / 10n;
const perSec = (apr: number) => BigInt(Math.round((apr / EULER_SECONDS_PER_YEAR) * 1e27));
const IRM = { baseRate: 0n, slope1: perSec(0.04) / KINK, slope2: (perSec(1) - perSec(0.04)) / (U32 - KINK), kink: KINK };

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

test("growthApr: daily-compounding APR of share-price growth", () => {
  assert.ok(Math.abs(growthApr(10_001n, 10_000n, 86_400) - 0.0365) < 1e-12);
  // a week of growth annualised the same way
  const week = Math.pow(1.0001, 7);
  assert.ok(Math.abs(growthApr(BigInt(Math.round(week * 1e15)), 10n ** 15n, 7 * 86_400) - 0.0365) < 1e-9);
  assert.ok(growthApr(9_999n, 10_000n, 86_400) < 0, "a loss is a negative APR");
  assert.throws(() => growthApr(1n, 0n, 86_400));
  assert.equal(priceProbeShares(18), 10n ** 27n);
});

test("Euler rate math matches IRMLinearKink and the lens formula", () => {
  assert.ok(Math.abs(eulerRateToApr(perSec(0.05)) - 0.05) < 1e-12);
  // supply = borrow x utilization x (1 - fee/1e4)
  assert.ok(Math.abs(eulerSupplyApr(0.1, 100n, 900n, 1000) - 0.1 * 0.9 * 0.9) < 1e-12);
  const r = linearKinkRate(IRM, 100n, 900n); // u = 90% = kink
  assert.ok(Math.abs(eulerRateToApr(r) - 0.04) < 1e-6);
  const m = linearKinkIrmModel(IRM, 1000);
  assert.ok(Math.abs(m.points[1]![0] - 0.9) < 1e-9 && Math.abs(m.points[1]![1] - 0.04) < 1e-6 && Math.abs(m.points[2]![1] - 1) < 1e-6);
  assert.equal(m.reserveFactor, 0.1);
  assert.ok(Math.abs(apyContinuousToApr(Math.expm1(0.05)) - 0.05) < 1e-15);
});

// ---------------------------------------------------------------------------
// In-memory ERC-4626 chain
// ---------------------------------------------------------------------------

type Flavor = VaultConfig["flavor"];
interface FV {
  address: Address;
  flavor: Flavor;
  totalAssets: bigint;
  totalSupply: bigint;
  shares: Map<string, bigint>;
  /** where the vault's liquid assets sit (the vault itself; Fluid: the Liquidity contract) */
  idleHolder: Address;
  maxDeposit: bigint;
  /** share-price growth per day, for history reads */
  dailyGrowth: number;
  /** fraction of `assets` a deposit actually pulls (to exercise the allowance reset) */
  pullFrac?: number;
  hookOps?: number;
  minDeposit?: bigint;
  /** extra liquidity limit (Fluid withdrawal limit) */
  withdrawLimit?: bigint;
}

const lc = (a: string) => a.toLowerCase();
const key = (a: string, b: string) => `${lc(a)}:${lc(b)}`;

class FakeVaults {
  archive = true;
  /** what MetaMorpho's MORPHO() returns */
  morphoOf: Address = BASE.blue;
  balances = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  vaults = new Map<string, FV>();
  sent: { to: Address; fn: string; args: readonly unknown[] }[] = [];
  simulated: string[] = [];
  bundles: number[] = [];
  /** next broadcast: "landed" = applied but submit times out; "lost" = not applied, submit times out */
  unconfirmed?: "landed" | "lost";
  rpcDown = false;
  raws = new Map<string, { to: Address; data: Hex }>();
  private nonce = 0;

  constructor() {
    this.bal(USDC, ACCOUNT, 1_000_000n * E6);
  }

  bal(token: string, who: string, set?: bigint): bigint {
    if (set !== undefined) this.balances.set(key(token, who), set);
    return this.balances.get(key(token, who)) ?? 0n;
  }

  add(v: Partial<FV> & { address: Address; flavor: Flavor; totalAssets: bigint; idle: bigint }): FV {
    const fv: FV = {
      totalSupply: v.totalAssets * E12, // 1 share (18 dec) = 1e-12 ... i.e. price 1 USDC per 1e18 shares
      shares: new Map(),
      idleHolder: v.flavor === "fluid" ? FLUID_LIQ : v.address,
      maxDeposit: 2n ** 256n - 1n,
      dailyGrowth: 0.0001,
      ...v,
    };
    this.vaults.set(lc(v.address), fv);
    this.bal(USDC, fv.idleHolder, this.bal(USDC, fv.idleHolder) + v.idle);
    return fv;
  }

  private v(a: string): FV {
    const fv = this.vaults.get(lc(a));
    if (!fv) throw new Error(`no vault ${a}`);
    return fv;
  }

  toAssets(fv: FV, s: bigint) {
    return fv.totalSupply === 0n ? s / E12 : (s * fv.totalAssets) / fv.totalSupply;
  }
  toShares(fv: FV, a: bigint) {
    return fv.totalAssets === 0n ? a * E12 : (a * fv.totalSupply) / fv.totalAssets;
  }
  liquid(fv: FV) {
    const idle = this.bal(USDC, fv.idleHolder);
    return fv.withdrawLimit !== undefined && fv.withdrawLimit < idle ? fv.withdrawLimit : idle;
  }
  maxRedeem(fv: FV, who: string) {
    const s = fv.shares.get(lc(who)) ?? 0n;
    const cap = this.toShares(fv, this.liquid(fv));
    return s < cap ? s : cap;
  }
  maxWithdraw(fv: FV, who: string) {
    const a = this.toAssets(fv, fv.shares.get(lc(who)) ?? 0n);
    const l = this.liquid(fv);
    return a < l ? a : l;
  }

  readContract = async (r: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> => {
    if (this.rpcDown) throw new Error("HTTP request failed: 503");
    const a = lc(r.address);
    const args = r.args ?? [];
    if (a === lc(USDC)) {
      switch (r.functionName) {
        case "balanceOf":
          return this.bal(USDC, args[0] as string);
        case "allowance":
          return this.allowances.get(key(args[0] as string, args[1] as string)) ?? 0n;
        case "decimals":
          return 6;
        case "symbol":
          return "USDC";
      }
    }
    if (a === lc(EULER_IRM)) return (IRM as Record<string, bigint>)[r.functionName];
    const fv = this.v(r.address);
    const old = r.blockNumber !== undefined && r.blockNumber < LATEST;
    if (old && !this.archive) throw new Error("missing trie node (historical state not available)");
    switch (r.functionName) {
      case "asset":
        return USDC;
      case "decimals":
        return 18;
      case "totalAssets":
        return fv.totalAssets;
      case "balanceOf":
        return fv.shares.get(lc(args[0] as string)) ?? 0n;
      case "convertToAssets":
      case "previewRedeem": {
        const now = this.toAssets(fv, args[0] as bigint);
        if (!old) return now;
        const days = Number((LATEST - r.blockNumber!) * BLOCK_S) / 86_400;
        return (now * 10n ** 12n) / BigInt(Math.round(Math.pow(1 + fv.dailyGrowth, days) * 1e12));
      }
      case "maxDeposit":
        return fv.maxDeposit;
      case "maxRedeem":
        return this.maxRedeem(fv, args[0] as string);
      case "maxWithdraw":
        return this.maxWithdraw(fv, args[0] as string);
      // Euler EVault
      case "EVC":
        return EVC;
      case "cash":
        return this.bal(USDC, fv.address);
      case "totalBorrows":
        return fv.totalAssets - this.bal(USDC, fv.address);
      case "interestRate":
        return linearKinkRate(IRM, this.bal(USDC, fv.address), fv.totalAssets - this.bal(USDC, fv.address));
      case "interestFee":
        return 1000;
      case "interestRateModel":
        return EULER_IRM;
      case "hookConfig":
        return [ZERO, fv.hookOps ?? 0];
      // Fluid fToken
      case "getData":
        return [FLUID_LIQ, ZERO, ZERO, ZERO, ZERO, true, fv.totalAssets, 10n ** 12n, 10n ** 12n];
      case "minDeposit":
        return fv.minDeposit ?? 1n;
      // MetaMorpho
      case "MORPHO":
        return this.morphoOf;
      default:
        throw new Error(`unmocked ${r.functionName} on ${r.address}`);
    }
  };

  clone() {
    const c = new FakeVaults();
    c.balances = new Map(this.balances);
    c.allowances = new Map(this.allowances);
    for (const [k, fv] of this.vaults) c.vaults.set(k, { ...fv, shares: new Map(fv.shares) });
    return c;
  }

  /** Apply a tx from ACCOUNT (throws like a revert). */
  apply(to: Address, data: Hex): { fn: string; args: readonly unknown[] } {
    if (lc(to) === lc(USDC)) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
      if (functionName !== "approve") throw new Error(`unexpected ${functionName}`);
      const [spender, amount] = args as readonly [Address, bigint];
      this.allowances.set(key(ACCOUNT, spender), amount);
      return { fn: functionName, args };
    }
    const fv = this.v(to);
    const { functionName, args } = decodeFunctionData({ abi: erc4626Abi, data });
    if (functionName === "deposit") {
      const [assets] = args as readonly [bigint, Address];
      if (assets > fv.maxDeposit) throw new Error("execution reverted: E_SupplyCapExceeded");
      if ((fv.hookOps ?? 0) & EULER_OP_DEPOSIT) throw new Error("execution reverted: E_OperationDisabled");
      const pulled = fv.pullFrac ? (assets * BigInt(Math.round(fv.pullFrac * 1e6))) / 1_000_000n : assets;
      const al = this.allowances.get(key(ACCOUNT, fv.address)) ?? 0n;
      if (al < pulled) throw new Error("execution reverted: ERC20: insufficient allowance");
      if (this.bal(USDC, ACCOUNT) < pulled) throw new Error("execution reverted: ERC20: transfer amount exceeds balance");
      this.allowances.set(key(ACCOUNT, fv.address), al - pulled);
      this.bal(USDC, ACCOUNT, this.bal(USDC, ACCOUNT) - pulled);
      this.bal(USDC, fv.idleHolder, this.bal(USDC, fv.idleHolder) + pulled);
      const minted = this.toShares(fv, pulled);
      fv.shares.set(lc(ACCOUNT), (fv.shares.get(lc(ACCOUNT)) ?? 0n) + minted);
      fv.totalSupply += minted;
      fv.totalAssets += pulled;
      return { fn: functionName, args };
    }
    if (functionName === "redeem") {
      const [shares] = args as readonly [bigint, Address, Address];
      const have = fv.shares.get(lc(ACCOUNT)) ?? 0n;
      if (shares > have) throw new Error("execution reverted: ERC4626ExceededMaxRedeem");
      if (shares > this.maxRedeem(fv, ACCOUNT)) throw new Error("execution reverted: E_InsufficientCash");
      const assets = this.toAssets(fv, shares);
      fv.shares.set(lc(ACCOUNT), have - shares);
      fv.totalSupply -= shares;
      fv.totalAssets -= assets;
      this.bal(USDC, fv.idleHolder, this.bal(USDC, fv.idleHolder) - assets);
      this.bal(USDC, ACCOUNT, this.bal(USDC, ACCOUNT) + assets);
      return { fn: functionName, args };
    }
    throw new Error(`unexpected vault call ${functionName}`);
  }

  publicClient(): PublicClient {
    const self = this;
    return {
      readContract: this.readContract,
      getBlock: async (p?: { blockNumber?: bigint }) => {
        const n = p?.blockNumber ?? LATEST;
        return { number: n, timestamp: T - (LATEST - n) * BLOCK_S };
      },
      getCode: async ({ address }: { address: Address }) => (self.vaults.has(lc(address)) || [lc(USDC), lc(FLUID_LIQ)].includes(lc(address)) ? "0x6080" : "0x"),
      getChainId: async () => 8453,
      getGasPrice: async () => 1_000_000_000n,
      estimateGas: async () => 150_000n,
      call: async ({ to, data }: { to: Address; data: Hex }) => {
        if (self.rpcDown) throw new Error("HTTP request failed: 503");
        const r = self.clone().apply(to, data);
        self.simulated.push(r.fn);
        return { data: "0x" };
      },
      simulateCalls: async ({ calls }: { calls: { to: Address; data: Hex }[] }) => {
        self.bundles.push(calls.length);
        const st = self.clone();
        const results = calls.map((c) => {
          try {
            self.simulated.push(st.apply(c.to, c.data).fn);
            return { status: "success", gasUsed: 100_000n, data: "0x" };
          } catch (e) {
            return { status: "failure", gasUsed: 0n, data: "0x", error: e as Error };
          }
        });
        return { results, assetChanges: [], block: {} };
      },
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        const tx = self.raws.get(serializedTransaction)!;
        const mode = self.unconfirmed;
        self.unconfirmed = undefined;
        if (mode !== "lost") {
          const r = self.apply(tx.to, tx.data);
          self.sent.push({ to: tx.to, ...r });
        }
        if (mode) throw new Error("HTTP request failed: 504 gateway timeout");
        return keccak256(serializedTransaction);
      },
      getTransaction: async () => null,
      waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n }),
    } as unknown as PublicClient;
  }

  walletClient(): WalletClient {
    const self = this;
    return {
      account: { address: ACCOUNT },
      prepareTransactionRequest: async (req: { to: Address; data: Hex }) => req,
      signTransaction: async ({ to, data }: { to: Address; data: Hex }) => {
        const raw = `0x${(++self.nonce).toString(16).padStart(8, "0")}${data.slice(2)}` as Hex;
        self.raws.set(raw, { to, data });
        return raw;
      },
    } as unknown as WalletClient;
  }

  env(): EvmEnv {
    return { chain: "base", viemChain: viemChainFor("base", "http://127.0.0.1:1"), publicClient: this.publicClient(), walletClient: this.walletClient(), account: ACCOUNT, lock: new Mutex() };
  }
}

function ctx(over: Partial<LiveContext> = {}): LiveContext {
  return {
    dryRun: true,
    log: () => {},
    limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 15, maxLoopIterations: 10 },
    priceUsd: async () => 1,
    nativePriceUsd: async () => 3000,
    ...over,
  };
}

function world() {
  const fc = new FakeVaults();
  // Euler: 10M supplied, 1M cash -> u = 90% (the kink: 4% borrow APR)
  fc.add({ address: V_EULER, flavor: "euler", totalAssets: 10_000_000n * E6, idle: 1_000_000n * E6 });
  fc.add({ address: V_GEN, flavor: "generic", totalAssets: 2_000_000n * E6, idle: 300_000n * E6, maxDeposit: 500_000n * E6 });
  fc.add({ address: V_FLUID, flavor: "fluid", totalAssets: 5_000_000n * E6, idle: 800_000n * E6, minDeposit: 10n * E6 });
  fc.add({ address: V_MM, flavor: "metamorpho", totalAssets: 250_000n * E6, idle: 50_000n * E6 });
  return fc;
}

/** A MetaMorpho vault: 200k in a 90%-utilized adaptive-curve market + 50k idle, 10% performance fee. */
function morphoVault(): AccrualVault {
  const r = (E6 * 10n ** 12n) / 10n / 31_536_000n; // 10% APR at target, per second (WAD)
  const params = new MarketParams({ loanToken: USDC, collateralToken: "0x00000000000000000000000000000000000c011a", oracle: "0x00000000000000000000000000000000000000c1", irm: BASE.adaptiveCurveIrm, lltv: 860_000_000_000_000_000n });
  const market = new Market({ params, totalSupplyAssets: 1_000_000n * E6, totalBorrowAssets: 900_000n * E6, totalSupplyShares: 1_000_000n * E12, totalBorrowShares: 900_000n * E12, lastUpdate: T, fee: 0n, rateAtTarget: r });
  const idleParams = MarketParams.idle(USDC);
  const idle = new Market({ params: idleParams, totalSupplyAssets: 50_000n * E6, totalBorrowAssets: 0n, totalSupplyShares: 50_000n * E12, totalBorrowShares: 0n, lastUpdate: T, fee: 0n });
  const cfg = (marketId: (typeof market)["id"]) => ({ vault: V_MM, marketId, cap: 10n ** 30n, pendingCap: { value: 0n, validAt: 0n }, removableAt: 0n, enabled: true });
  return new AccrualVault(
    {
      address: V_MM,
      name: "Test USDC",
      symbol: "tUSDC",
      decimalsOffset: 12n,
      asset: USDC,
      curator: "0x000000000000000000000000000000000000c0a7",
      owner: ZERO,
      guardian: ZERO,
      fee: 100_000_000_000_000_000n,
      feeRecipient: ZERO,
      skimRecipient: ZERO,
      pendingTimelock: { value: 0n, validAt: 0n },
      pendingGuardian: { value: ZERO, validAt: 0n },
      pendingOwner: ZERO,
      timelock: 86_400n,
      supplyQueue: [market.id, idle.id],
      totalSupply: 250_000n * E12 * E6,
      lastTotalAssets: 250_000n * E6,
    },
    [
      { config: cfg(market.id), position: new AccrualPosition({ user: V_MM, supplyShares: 200_000n * E12, borrowShares: 0n, collateral: 0n }, market) },
      { config: cfg(idle.id), position: new AccrualPosition({ user: V_MM, supplyShares: 50_000n * E12, borrowShares: 0n, collateral: 0n }, idle) },
    ]
  );
}

const CFG: VaultConfig[] = [
  { address: V_EULER, asset: usdc, flavor: "euler" },
  { address: V_GEN, asset: usdc, flavor: "generic", curator: "Steakhouse" },
  { address: V_FLUID, asset: usdc, flavor: "fluid" },
  { address: V_MM, asset: usdc, flavor: "metamorpho" },
];

function adapter(fc: FakeVaults, over: Partial<ConstructorParameters<typeof ERC4626VaultAdapter>[0]> = {}) {
  return new ERC4626VaultAdapter({ env: fc.env(), vaults: CFG, fetchMorphoVault: async () => morphoVault(), ...over });
}

const byId = async (a: ERC4626VaultAdapter) => new Map((await a.supplyMarkets()).map((m) => [m.marketId, m]));

// ---------------------------------------------------------------------------
// supplyMarkets
// ---------------------------------------------------------------------------

test("supplyMarkets: ids, protocols, Euler rate-model APR / cash / IRM", async () => {
  const fc = world();
  const a = adapter(fc);
  assert.equal(a.id, "vault:base");
  const m = await byId(a);
  assert.deepEqual([...m.keys()], [lc(V_EULER), lc(V_GEN), lc(V_FLUID), lc(V_MM)]);
  const e = m.get(lc(V_EULER))!;
  assert.equal(e.protocol, "euler");
  // borrow 4% at u = 90%, fee 10%: supply = 0.04 x 0.9 x 0.9
  assert.ok(Math.abs(e.supplyAprBase - 0.04 * 0.9 * 0.9) < 1e-6, `${e.supplyAprBase}`);
  assert.equal(e.totalSupplyUsd, 10_000_000);
  assert.equal(e.withdrawableUsd, 1_000_000);
  assert.equal(e.totalBorrowUsd, 9_000_000);
  assert.ok(e.irm && Math.abs(e.irm.points[1]![1] - 0.04) < 1e-6 && e.irm.reserveFactor === 0.1);
  assert.equal(e.paused, false);
  assert.equal(e.supplyCapRemainingUsd, undefined, "no cap");
  assert.deepEqual(e.asset, { symbol: "USDC", assetId: lc(USDC), priceUsd: 1 });
  assert.equal(e.dataAsOfMs, Number(T) * 1000);

  fc.vaults.get(lc(V_EULER))!.hookOps = EULER_OP_DEPOSIT;
  assert.equal((await byId(a)).get(lc(V_EULER))!.paused, true, "OP_DEPOSIT hooked with no target = deposits disabled");
});

test("supplyMarkets: generic APR from share-price growth, conservative withdrawable, cap, archive fallback", async () => {
  const fc = world();
  const a = adapter(fc);
  const g = (await byId(a)).get(lc(V_GEN))!;
  assert.equal(g.protocol, "erc4626");
  assert.ok(Math.abs(g.supplyAprBase - 0.0365) < 1e-6, `${g.supplyAprBase}`); // 0.01%/day
  assert.equal(g.withdrawableUsd, 300_000, "idle underlying only");
  assert.equal(g.totalBorrowUsd, 1_700_000);
  assert.equal(g.supplyCapRemainingUsd, 500_000);
  assert.match(g.note!, /curator Steakhouse.*24\.0h share-price growth/);

  // no archive: a fresh adapter reports APR unknown (NaN); a cached one keeps the last value
  fc.archive = false;
  const fresh = (await byId(adapter(fc))).get(lc(V_GEN))!;
  assert.ok(Number.isNaN(fresh.supplyAprBase));
  assert.match(fresh.note!, /APR unknown.*archive RPC/);
  const b = adapter(fc, { aprCacheMinutes: 0 });
  fc.archive = true;
  await b.supplyMarkets();
  fc.archive = false;
  const last = (await byId(b)).get(lc(V_GEN))!;
  assert.ok(Math.abs(last.supplyAprBase - 0.0365) < 1e-6);
  assert.match(last.note!, /last known APR/);
});

test("supplyMarkets: Fluid withdrawable is bounded by Liquidity idle and by my maxWithdraw when it binds", async () => {
  const fc = world();
  const a = adapter(fc);
  const f = (await byId(a)).get(lc(V_FLUID))!;
  assert.equal(f.protocol, "fluid");
  assert.ok(Math.abs(f.supplyAprBase - 0.0365) < 1e-6);
  assert.equal(f.withdrawableUsd, 800_000);
  assert.deepEqual(f.underlying, [`fluid-liquidity:base:${lc(FLUID_LIQ)}`]);
  assert.match(f.note!, /UPPER bound/);
  // my 1M position, withdrawal limit 200k: maxWithdraw(us) = 200k binds
  const fv = fc.vaults.get(lc(V_FLUID))!;
  fv.shares.set(lc(ACCOUNT), 1_000_000n * E6 * E12);
  fv.withdrawLimit = 200_000n * E6;
  const f2 = (await byId(adapter(fc))).get(lc(V_FLUID))!;
  assert.equal(f2.withdrawableUsd, 200_000);
  assert.equal(f2.myDepositUsd, 1_000_000);
});

test("supplyMarkets: MetaMorpho net APY + liquidity via the Morpho SDK", async () => {
  const fc = world();
  const mv = morphoVault();
  const m = (await byId(adapter(fc))).get(lc(V_MM))!;
  assert.equal(m.protocol, "morpho-vault");
  const expected = Math.log1p(mv.getNetApy(T));
  assert.ok(Math.abs(m.supplyAprBase - expected) < 1e-12);
  // independent: borrow 10% at u=90% -> market supply 9%; 200k of 250k earn it; minus 10% fee
  assert.ok(Math.abs(m.supplyAprBase - 0.1 * 0.9 * (200 / 250) * 0.9) < 1e-4, `${m.supplyAprBase}`);
  // liquidity: 100k free in the market + 50k idle
  assert.equal(m.withdrawableUsd, 150_000);
  assert.equal(m.totalBorrowUsd, 100_000);
  assert.equal(m.underlying!.length, 2);
  assert.ok(m.underlying!.every((u) => u.startsWith("morpho:base:0x")));
  assert.match(m.note!, /net of 10\.0% performance fee.*curator 0x/);
});

test("rewards: one supply-side query per vault keyed by vault address, Merkl protocol ids per flavor", async () => {
  const fc = world();
  const qs: RewardRateQuery[] = [];
  const a = adapter(fc, {
    extraRewards: async (q) => {
      qs.push(q);
      return q.protocol === "euler-v2" ? [{ token: "EUL", apr: 0.02 }] : [];
    },
  });
  const m = await byId(a);
  assert.deepEqual(m.get(lc(V_EULER))!.rewards, [{ token: "EUL", apr: 0.02 }]);
  assert.deepEqual(
    qs.map((q) => [q.protocol, q.marketId, q.side]).sort(),
    [
      ["erc4626", lc(V_GEN), "supply"],
      ["euler-v2", lc(V_EULER), "supply"],
      ["fluid", lc(V_FLUID), "supply"],
      ["morpho", lc(V_MM), "supply"],
    ].sort()
  );
  assert.ok(qs.every((q) => q.chain === "base" && q.asset.address === USDC));
});

// ---------------------------------------------------------------------------
// deposit / withdraw
// ---------------------------------------------------------------------------

test("deposit: dry-run bundles approve + deposit; live approves exactly, deposits, resets leftover allowance", async () => {
  const fc = world();
  const a = adapter(fc);
  const dry = await a.deposit(lc(V_GEN), 1_000n * E6, ctx());
  assert.equal(dry.ok, true, dry.detail);
  assert.deepEqual(fc.bundles, [2]);
  assert.deepEqual(fc.simulated, ["approve", "deposit"]);
  assert.equal(fc.sent.length, 0);

  fc.vaults.get(lc(V_GEN))!.pullFrac = 0.9; // a vault that pulls less than approved
  const r = await a.deposit(lc(V_GEN), 1_000n * E6, ctx({ dryRun: false }));
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual(fc.sent.map((s) => s.fn), ["approve", "deposit", "approve"]);
  assert.equal(fc.sent[0]!.args[1], 1_000n * E6, "exact approval");
  assert.equal(fc.sent[2]!.args[1], 0n, "leftover allowance reset to 0");
  assert.equal(fc.allowances.get(key(ACCOUNT, V_GEN)), 0n);
  assert.equal(r.amountUsd, 900);
  const p = (await a.supplyPosition(lc(V_GEN)))!;
  assert.equal(p.units, 900n * E6);
  assert.equal(p.depositUsd, 900);
});

test("deposit refusals: wallet, maxDeposit cap, Fluid minDeposit", async () => {
  const fc = world();
  const a = adapter(fc);
  assert.match((await a.deposit(lc(V_GEN), 2_000_000n * E6, ctx())).detail!, /wallet has/);
  assert.match((await a.deposit(lc(V_GEN), 600_000n * E6, ctx())).detail!, /vault cap: maxDeposit 500000000000 < amount/);
  fc.vaults.get(lc(V_GEN))!.maxDeposit = 0n;
  assert.match((await a.deposit(lc(V_GEN), 1n * E6, ctx())).detail!, /maxDeposit = 0/);
  assert.match((await a.deposit(lc(V_FLUID), 5n * E6, ctx())).detail!, /below Fluid minDeposit/);
  assert.equal(fc.sent.length + fc.simulated.length, 0);
});

test("withdraw: all = exact share balance; partial fraction; illiquid vault refused; dry-run", async () => {
  const fc = world();
  const a = adapter(fc);
  await a.deposit(lc(V_EULER), 10_000n * E6, ctx({ dryRun: false }));
  const shares = fc.vaults.get(lc(V_EULER))!.shares.get(lc(ACCOUNT))!;
  fc.sent = [];
  const half = await a.withdraw(lc(V_EULER), 0.5, ctx({ dryRun: false }));
  assert.equal(half.ok, true, half.detail);
  assert.equal(fc.sent[0]!.args[0], shares / 2n);
  // illiquid: cash below what the rest needs
  const fv = fc.vaults.get(lc(V_EULER))!;
  const cash = fc.bal(USDC, V_EULER);
  fc.bal(USDC, V_EULER, 1_000n * E6);
  fv.totalAssets -= cash - 1_000n * E6; // borrowed out
  const ill = await a.withdraw(lc(V_EULER), 1, ctx({ dryRun: false }));
  assert.equal(ill.ok, false);
  assert.match(ill.detail!, /illiquid: maxRedeem \d+ < \d+ shares needed/);
  assert.equal(await a.simulateWithdraw(lc(V_EULER), ctx()), false, "redeem(all) reverts");
  // liquidity back
  fc.bal(USDC, V_EULER, cash);
  fv.totalAssets += cash - 1_000n * E6;
  assert.equal(await a.simulateWithdraw(lc(V_EULER), ctx()), true);
  fc.simulated = [];
  const dry = await a.withdraw(lc(V_EULER), 1, ctx());
  assert.equal(dry.ok, true, dry.detail);
  assert.deepEqual(fc.simulated, ["redeem"]);
  fc.sent = [];
  const all = await a.withdraw(lc(V_EULER), 1, ctx({ dryRun: false }));
  assert.equal(all.ok, true, all.detail);
  assert.equal(fc.sent[0]!.args[0], shares - shares / 2n, "redeems exactly the remaining shares (no dust)");
  assert.equal(await a.supplyPosition(lc(V_EULER)), null);
  assert.equal((await a.withdraw(lc(V_EULER), 1, ctx({ dryRun: false }))).detail, `vault:base withdraw ${lc(V_EULER)}: no deposit`);
});

test("simulateWithdraw: no position = true; RPC errors throw (unknown, not a failure)", async () => {
  const fc = world();
  const a = adapter(fc);
  assert.equal(await a.simulateWithdraw(lc(V_GEN), ctx()), true);
  await a.deposit(lc(V_GEN), 1_000n * E6, ctx({ dryRun: false }));
  fc.rpcDown = true;
  await assert.rejects(a.simulateWithdraw(lc(V_GEN), ctx()), /503/);
});

test("BroadcastUnconfirmedError: re-read state — landed counts as done, lost is reported UNCONFIRMED", async () => {
  const fc = world();
  // the approve goes through; the deposit submit times out but the tx landed
  const live = ctx({ dryRun: false });
  let n = 0;
  const env = fc.env();
  const pc = env.publicClient as unknown as { sendRawTransaction: (x: { serializedTransaction: Hex }) => Promise<Hex> };
  const base = pc.sendRawTransaction;
  pc.sendRawTransaction = async (x) => {
    if (++n === 2) fc.unconfirmed = "landed";
    return base(x);
  };
  const b = new ERC4626VaultAdapter({ env, vaults: CFG, fetchMorphoVault: async () => morphoVault() });
  const r = await b.deposit(lc(V_GEN), 1_000n * E6, live);
  assert.equal(r.ok, true, r.detail);
  assert.match(r.detail!, /unconfirmed but the share balance shows it landed/);
  assert.ok(r.txs.some((t) => t.unconfirmed && t.id));

  n = 0;
  pc.sendRawTransaction = async (x) => {
    if (++n === 1) fc.unconfirmed = "lost";
    return base(x);
  };
  const w = await b.withdraw(lc(V_GEN), 1, live);
  assert.equal(w.ok, false);
  assert.match(w.detail!, /UNCONFIRMED: redeem 0x[0-9a-f]{64} .*may still land/);
  assert.ok(w.txs.some((t) => t.unconfirmed));
  assert.equal(fc.vaults.get(lc(V_GEN))!.shares.get(lc(ACCOUNT)), 1_000n * E6 * E12, "shares untouched by the lost redeem");
});

test("claimRewards is a no-op; walletBalance reads the token", async () => {
  const fc = world();
  const a = adapter(fc);
  const r = await a.claimRewards(ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.claimed, []);
  assert.equal(await a.walletBalance(usdc), 1_000_000n * E6);
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

test("verifyConfig: clean config passes; wrong asset / disabled deposits / no archive / MORPHO mismatch reported", async () => {
  const fc = world();
  assert.deepEqual(await adapter(fc).verifyConfig(), []);

  const wrong = await adapter(fc, { vaults: [{ address: V_GEN, asset: { ...usdc, address: "0x0000000000000000000000000000000000000bad" }, flavor: "generic" }] }).verifyConfig();
  assert.ok(wrong.some((i) => /asset\(\) .* != configured/.test(i)), wrong.join("\n"));

  fc.vaults.get(lc(V_EULER))!.hookOps = EULER_OP_DEPOSIT;
  fc.vaults.get(lc(V_GEN))!.maxDeposit = 0n;
  fc.archive = false;
  const issues = await adapter(fc, {
    fetchMorphoVault: async () => {
      throw new Error("UnknownOfFactory: not a MetaMorpho vault");
    },
  }).verifyConfig();
  assert.ok(issues.some((i) => /euler.*deposits disabled \(OP_DEPOSIT hooked/.test(i)), issues.join("\n"));
  assert.ok(issues.some((i) => /generic.*maxDeposit\(us\) = 0/.test(i)));
  assert.ok(issues.some((i) => /generic.*archive RPC/.test(i)));
  assert.ok(issues.some((i) => /fluid.*archive RPC/.test(i)));
  assert.ok(issues.some((i) => /metamorpho.*UnknownOfFactory/.test(i)));
  assert.ok(!issues.some((i) => /no code/.test(i)));
  fc.morphoOf = "0x000000000000000000000000000000000000dead";
  const mm = await adapter(fc, { vaults: [CFG[3]!] }).verifyConfig();
  assert.ok(mm.some((i) => /MORPHO\(\) 0x0+dead != registry Morpho/i.test(i)), mm.join("\n"));

  const none = await adapter(fc, { vaults: [{ address: "0x0000000000000000000000000000000000000404", asset: usdc, flavor: "generic" }] }).verifyConfig();
  assert.ok(none.some((i) => /has no code/.test(i)));
});

test("constructor: duplicate market ids and bad addresses are refused; explicit marketId / protocol kept", () => {
  const fc = world();
  assert.throws(() => adapter(fc, { vaults: [CFG[0]!, CFG[0]!] }), /duplicate marketId/);
  assert.throws(() => adapter(fc, { vaults: [{ ...CFG[0]!, address: "0x123" as Address }] }), /invalid/);
  const a = adapter(fc, { vaults: [{ ...CFG[1]!, marketId: "sUSDS", protocol: "sky" }] });
  return a.supplyMarkets().then(([m]) => {
    assert.equal(m!.marketId, "sUSDS");
    assert.equal(m!.protocol, "sky");
  });
});
