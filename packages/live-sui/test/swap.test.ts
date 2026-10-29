import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CETUS, BLUEFIN, HAEDALPMM, ZERO, type AggregatorClient, type FindRouterParams, type RouterDataV3 } from "@cetusprotocol/aggregator-sdk";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { AssetRef, LiveContext } from "@incentive-router/live-common";
import { Mutex, Transaction, normalizeStructTag, type SuiEnv, type TransactionObjectArgument } from "../src/common.js";
import {
  CetusPtbSwapper,
  CetusSwapAdapter,
  SwapRejected,
  applyInputCoinPlan,
  contractSlippageFor,
  costBpsVsOracle,
  createCetusAggregatorClient,
  minOutForSlippage,
  planInputCoin,
  routeHops,
  validateRoute,
  type AggregatorLike,
} from "../src/swap/index.js";

// ---------------------------------------------------------------------------
// fixtures (fake ids / coin types only — no real addresses)
// ---------------------------------------------------------------------------

const hex = (c: string) => "0x" + c.repeat(64);
const USDC = `${hex("1")}::usdc::USDC`;
const USDT = `${hex("2")}::usdt::USDT`;
const MID = `${hex("3")}::mid::MID`;
const SUI = "0x2::sui::SUI";
const AGG_PKG = hex("9");
const DEX_PKG = hex("8");
const ME = hex("7");

type BN = typeof ZERO;
const BNCtor = ZERO.constructor as new (n: string, base?: number) => BN;
const bn = (v: bigint): BN => new BNCtor(v.toString(), 10);

function path(id: string, from: string, target: string, provider = CETUS, amountIn = "0", amountOut = "0") {
  return { id: hex(id), direction: true, provider, from, target, feeRate: 100, amountIn, amountOut, publishedAt: DEX_PKG };
}

function route(o: Partial<Omit<RouterDataV3, "amountIn" | "amountOut">> & { amountIn: bigint; amountOut: bigint }): RouterDataV3 {
  const { amountIn, amountOut, ...rest } = o;
  return {
    quoteID: "quote-1",
    byAmountIn: true,
    paths: [path("a", USDC, USDT, CETUS, amountIn.toString(), amountOut.toString())],
    insufficientLiquidity: false,
    deviationRatio: 0,
    packages: new Map([["aggregator_v3", AGG_PKG]]),
    ...rest,
    amountIn: bn(amountIn),
    amountOut: bn(amountOut),
  };
}

type SwapParams = Parameters<AggregatorClient["routerSwapWithMaxAmountIn"]>[0];

class FakeAggregator implements AggregatorLike {
  finds: FindRouterParams[] = [];
  swaps: SwapParams[] = [];
  constructor(public next: RouterDataV3 | null) {}
  async findRouters(p: FindRouterParams): Promise<RouterDataV3 | null> {
    this.finds.push(p);
    return this.next;
  }
  async routerSwapWithMaxAmountIn(p: SwapParams): Promise<TransactionObjectArgument> {
    this.swaps.push(p);
    const target = p.router.paths[p.router.paths.length - 1]!.target;
    return p.txb.moveCall({ target: `${AGG_PKG}::router::confirm_swap_v3`, typeArguments: [target], arguments: [p.inputCoin] });
  }
}

const prices: Record<string, number> = { [normalizeStructTag(USDC)]: 1, [normalizeStructTag(USDT)]: 1, [normalizeStructTag(SUI)]: 2, [normalizeStructTag(MID)]: 1 };
const decs: Record<string, number> = { [normalizeStructTag(USDC)]: 6, [normalizeStructTag(USDT)]: 6, [normalizeStructTag(SUI)]: 9, [normalizeStructTag(MID)]: 6 };

function swapper(agg: AggregatorLike, extra: Partial<ConstructorParameters<typeof CetusPtbSwapper>[0]> = {}) {
  return new CetusPtbSwapper({
    aggregator: agg,
    refPriceUsd: async (t) => prices[normalizeStructTag(t)]!,
    decimals: async (t) => decs[normalizeStructTag(t)]!,
    maxCostBps: 30,
    ...extra,
  });
}

function pureU64(tx: Transaction, arg: unknown): bigint {
  const a = arg as { $kind: string; Input?: number };
  assert.equal(a.$kind, "Input");
  const input = tx.getData().inputs[a.Input!] as { Pure?: { bytes: string } };
  return Buffer.from(input.Pure!.bytes, "base64").readBigUInt64LE(0);
}

// ---------------------------------------------------------------------------
// pure math
// ---------------------------------------------------------------------------

describe("swap math", () => {
  it("costBpsVsOracle measures value lost vs oracle across decimals", () => {
    // 1000 USDC -> 998.5 USDT at $1/$1 = 15 bps
    const c = costBpsVsOracle({ amountIn: 1_000_000_000n, decimalsIn: 6, priceInUsd: 1, amountOut: 998_500_000n, decimalsOut: 6, priceOutUsd: 1 });
    assert.ok(Math.abs(c - 15) < 1e-6);
    // 10 SUI @ $2 -> 19.9 USDC = 50 bps
    const s = costBpsVsOracle({ amountIn: 10_000_000_000n, decimalsIn: 9, priceInUsd: 2, amountOut: 19_900_000n, decimalsOut: 6, priceOutUsd: 1 });
    assert.ok(Math.abs(s - 50) < 1e-6);
    // better than oracle -> negative
    assert.ok(costBpsVsOracle({ amountIn: 1_000_000n, decimalsIn: 6, priceInUsd: 1, amountOut: 1_001_000n, decimalsOut: 6, priceOutUsd: 1 }) < 0);
    assert.throws(() => costBpsVsOracle({ amountIn: 1n, decimalsIn: 6, priceInUsd: 0, amountOut: 1n, decimalsOut: 6, priceOutUsd: 1 }), SwapRejected);
    assert.throws(() => costBpsVsOracle({ amountIn: 1n, decimalsIn: 6, priceInUsd: 1, amountOut: 1n, decimalsOut: 6, priceOutUsd: NaN }), SwapRejected);
    assert.throws(() => costBpsVsOracle({ amountIn: 0n, decimalsIn: 6, priceInUsd: 1, amountOut: 1n, decimalsOut: 6, priceOutUsd: 1 }), SwapRejected);
  });

  it("minOutForSlippage floors amountOut * (1 - bps/1e4)", () => {
    assert.equal(minOutForSlippage(1_000_000n, 15), 998_500n);
    assert.equal(minOutForSlippage(1_000_000n, 0), 1_000_000n);
    assert.equal(minOutForSlippage(1_000_000n, 0.5), 999_950n);
    assert.equal(minOutForSlippage(999n, 10), 998n); // 998.001 -> 998
    assert.throws(() => minOutForSlippage(1n, -1), SwapRejected);
    assert.throws(() => minOutForSlippage(1n, 10_000), SwapRejected);
    assert.throws(() => minOutForSlippage(1n, NaN), SwapRejected);
  });

  it("contractSlippageFor never lets the contract limit fall below minOut", () => {
    const sdkPpm = (s: number) => Math.floor(s * 1e6); // SDK slippageToContractValue
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const out = BigInt(Math.floor(rnd() * 1e12)) + 1n;
      const minOut = out - (out * BigInt(Math.floor(rnd() * 20_000))) / 1_000_000n; // up to 2% slippage
      if (minOut <= 0n) continue;
      const ppm = BigInt(sdkPpm(contractSlippageFor(out, minOut)));
      // both plausible contract formulas: floor(out*(1e6-s)/1e6) and out - floor(out*s/1e6)
      const l1 = (out * (1_000_000n - ppm)) / 1_000_000n;
      const l2 = out - (out * ppm) / 1_000_000n;
      assert.ok(l1 >= minOut && l2 >= minOut, `limit below minOut: out=${out} minOut=${minOut} ppm=${ppm}`);
      // and not much tighter than asked (<= ~1 ppm of out + rounding)
      assert.ok(l1 - minOut <= out / 500_000n + 2n, `limit too tight: out=${out} minOut=${minOut}`);
    }
    assert.equal(contractSlippageFor(1_000_000n, 1_000_000n), 0);
    assert.equal(contractSlippageFor(1_000_000n, 990_000n), 0.01);
    assert.throws(() => contractSlippageFor(1_000_000n, 0n), SwapRejected);
    assert.throws(() => contractSlippageFor(1_000_000n, 1_000_001n), SwapRejected);
    assert.throws(() => contractSlippageFor(0n, 1n), SwapRejected);
  });

  it("routeHops follows the longest branch of split routes", () => {
    assert.equal(routeHops([path("a", USDC, USDT)], USDC), 1);
    // split: USDC->USDT direct and USDC->MID->USDT
    assert.equal(routeHops([path("a", USDC, USDT), path("b", USDC, MID), path("c", MID, USDT)], USDC), 2);
    assert.throws(() => routeHops([path("c", MID, USDT)], USDC), SwapRejected);
    // short and long form of the same type are equal
    assert.equal(routeHops([path("a", "0x2::sui::SUI", USDC)], normalizeStructTag(SUI)), 1);
  });

  it("validateRoute enforces types, providers, hops and pinned packages", () => {
    const rules = { fromType: USDC, toType: USDT, allowedProviders: new Set([CETUS, BLUEFIN]), maxHops: 2 };
    const ok = validateRoute({ paths: [path("a", USDC, MID), path("b", MID, USDT, BLUEFIN)], packages: new Map([["aggregator_v3", AGG_PKG]]) }, rules);
    assert.deepEqual(ok.providers, [CETUS, BLUEFIN]);
    assert.equal(ok.hops, 2);
    assert.throws(() => validateRoute({ paths: [path("a", USDC, MID)] }, rules), /ends at/);
    assert.throws(() => validateRoute({ paths: [path("a", MID, USDT)] }, rules), /starts at/);
    assert.throws(() => validateRoute({ paths: [path("a", USDC, USDT, "TURBOS")] }, rules), /not in allowlist/);
    assert.throws(() => validateRoute({ paths: [] }, rules), /empty/);
    assert.throws(
      () => validateRoute({ paths: [path("a", USDC, MID), path("b", MID, USDC), path("c", USDC, USDT)] }, { ...rules, maxHops: 2 }),
      /3 hops > max 2/
    );
    const pinned = { ...rules, allowedPackages: new Set([AGG_PKG, DEX_PKG]) };
    assert.doesNotThrow(() => validateRoute({ paths: [path("a", USDC, USDT)], packages: new Map([["aggregator_v3", AGG_PKG]]) }, pinned));
    assert.throws(() => validateRoute({ paths: [path("a", USDC, USDT)], packages: new Map([["aggregator_v3", hex("6")]]) }, pinned), /not in allowedPackages/);
    assert.throws(() => validateRoute({ paths: [path("a", USDC, USDT)] }, pinned), /missing package id/);
  });
});

// ---------------------------------------------------------------------------
// coin planning
// ---------------------------------------------------------------------------

describe("input coin planning", () => {
  const base = { coinType: USDC, suiGasReserve: 100n, maxCoins: 256 };

  it("uses one exact coin without a split", () => {
    const p = planInputCoin({ ...base, amount: 500n, coins: [{ objectId: hex("a"), balance: 500n }, { objectId: hex("b"), balance: 100n }], totalBalance: 600n });
    assert.deepEqual(p, { kind: "objects", amount: 500n, primary: hex("a"), merge: [], split: false, selected: 500n });
  });

  it("merges largest coins first, then splits", () => {
    const coins = [
      { objectId: hex("a"), balance: 100n },
      { objectId: hex("b"), balance: 300n },
      { objectId: hex("c"), balance: 250n },
      { objectId: hex("d"), balance: 0n },
    ];
    const p = planInputCoin({ ...base, amount: 500n, coins, totalBalance: 650n });
    assert.deepEqual(p, { kind: "objects", amount: 500n, primary: hex("b"), merge: [hex("c")], split: true, selected: 550n });
  });

  it("falls back to the coinWithBalance intent when address balance is needed", () => {
    const p = planInputCoin({ ...base, amount: 500n, coins: [{ objectId: hex("a"), balance: 100n }], totalBalance: 900n });
    assert.equal(p.kind, "intent");
    const many = Array.from({ length: 5 }, (_, i) => ({ objectId: hex(String(i)), balance: 100n }));
    assert.equal(planInputCoin({ ...base, maxCoins: 3, amount: 500n, coins: many, totalBalance: 500n }).kind, "intent");
  });

  it("refuses when the wallet cannot cover the amount", () => {
    assert.throws(() => planInputCoin({ ...base, amount: 500n, coins: [], totalBalance: 499n }), SwapRejected);
    assert.throws(() => planInputCoin({ ...base, amount: 0n, coins: [], totalBalance: 1n }), SwapRejected);
  });

  it("SUI splits from gas and keeps the gas reserve", () => {
    assert.deepEqual(planInputCoin({ ...base, coinType: SUI, amount: 1000n, coins: [], totalBalance: 1100n }), { kind: "gas", amount: 1000n });
    assert.throws(() => planInputCoin({ ...base, coinType: SUI, amount: 1000n, coins: [], totalBalance: 1099n }), /gas reserve/);
  });

  it("applyInputCoinPlan emits merge + split commands", () => {
    const tx = new Transaction();
    applyInputCoinPlan(tx, USDC, { kind: "objects", amount: 500n, primary: hex("b"), merge: [hex("c")], split: true, selected: 550n });
    const cmds = tx.getData().commands.map((c) => c.$kind);
    assert.deepEqual(cmds, ["MergeCoins", "SplitCoins"]);
    const split = tx.getData().commands[1]!.SplitCoins!;
    assert.equal(pureU64(tx, split.amounts[0]), 500n);

    const g = new Transaction();
    applyInputCoinPlan(g, SUI, { kind: "gas", amount: 7n });
    assert.equal(g.getData().commands[0]!.SplitCoins!.coin.$kind, "GasCoin");

    const i = new Transaction();
    applyInputCoinPlan(i, USDC, { kind: "intent", amount: 9n });
    assert.equal(i.getData().commands[0]!.$kind, "$Intent");
  });
});

// ---------------------------------------------------------------------------
// CetusPtbSwapper (mocked aggregator)
// ---------------------------------------------------------------------------

describe("CetusPtbSwapper", () => {
  it("quotes by amount in with the provider allowlist and hop depth, cost vs oracle", async () => {
    const agg = new FakeAggregator(route({ amountIn: 1_000_000_000n, amountOut: 998_500_000n }));
    const s = swapper(agg, { providers: [CETUS, BLUEFIN], maxHops: 2 });
    const q = await s.quote(USDC, USDT, 1_000_000_000n);
    assert.equal(agg.finds[0]!.byAmountIn, true);
    assert.deepEqual(agg.finds[0]!.providers, [CETUS, BLUEFIN]);
    assert.equal(agg.finds[0]!.depth, 2);
    assert.equal(agg.finds[0]!.from, normalizeStructTag(USDC));
    assert.equal(q.amountOut, 998_500_000n);
    assert.ok(Math.abs(q.costBps - 15) < 1e-6);
    assert.match(s.describe(q), /CETUS hops=1 pools=1/);
  });

  it("measures cost against the oracle, not the route", async () => {
    // route says 1:1 but the oracle says USDT is worth $0.99 -> 100 bps
    const agg = new FakeAggregator(route({ amountIn: 1_000_000n, amountOut: 1_000_000n }));
    const s = new CetusPtbSwapper({
      aggregator: agg,
      refPriceUsd: async (t) => (normalizeStructTag(t) === normalizeStructTag(USDT) ? 0.99 : 1),
      decimals: async () => 6,
      maxCostBps: 30,
    });
    await assert.rejects(s.quote(USDC, USDT, 1_000_000n), /100\.00 bps vs oracle > max 30/);
  });

  it("rejects bad routes", async () => {
    const amt = 1_000_000n;
    const cases: [RouterDataV3 | null, RegExp][] = [
      [null, /no response/],
      [route({ amountIn: amt, amountOut: 0n, error: { code: 1007, msg: "no route" } }), /aggregator error 1007/],
      [route({ amountIn: amt, amountOut: 0n, insufficientLiquidity: true }), /insufficient liquidity/],
      [route({ amountIn: amt - 1n, amountOut: amt }), /partial route/],
      [route({ amountIn: amt, amountOut: amt, paths: [path("a", USDC, USDT, HAEDALPMM)] }), /not in allowlist/], // Pyth PMM: not a default provider
      [route({ amountIn: amt, amountOut: amt, paths: [path("a", USDC, MID), path("b", MID, USDT)] }), /2 hops > max 1/],
      [route({ amountIn: amt, amountOut: amt, paths: [path("a", USDC, MID)] }), /ends at/],
      [route({ amountIn: amt, amountOut: amt, quoteID: "" }), /no quoteID/],
    ];
    for (const [r, re] of cases) {
      await assert.rejects(swapper(new FakeAggregator(r), { maxHops: 1 }).quote(USDC, USDT, amt), re);
    }
    await assert.rejects(swapper(new FakeAggregator(null)).quote(USDC, USDC, amt), /from == to/);
    assert.throws(() => swapper(new FakeAggregator(null), { providers: ["NOPE"] }), /unknown provider/);
    assert.throws(() => swapper(new FakeAggregator(null), { providers: [] }), /empty/);
  });

  it("appendSwap sets contract slippage + maxAmountIn from the quote and adds a split guard at minOut", async () => {
    const agg = new FakeAggregator(route({ amountIn: 1_000_000n, amountOut: 1_000_000n }));
    const s = swapper(agg);
    const q = await s.quote(USDC, USDT, 1_000_000n);
    const tx = new Transaction();
    const coinIn = tx.object(hex("c"));
    const out = await s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: q, minOut: 998_500n });

    const p = agg.swaps[0]!;
    assert.equal(p.slippage, 0.0015);
    assert.equal(p.maxAmountIn.toString(), "1000000");
    assert.equal(p.inputCoin, coinIn);

    const cmds = tx.getData().commands;
    assert.deepEqual(cmds.map((c) => c.$kind), ["MoveCall", "SplitCoins", "MergeCoins"]);
    const split = cmds[1]!.SplitCoins!;
    assert.deepEqual(split.coin, { $kind: "Result", Result: 0 });
    assert.equal(pureU64(tx, split.amounts[0]), 998_500n);
    const merge = cmds[2]!.MergeCoins!;
    assert.deepEqual(merge.destination, { $kind: "Result", Result: 0 });
    assert.deepEqual(merge.sources[0], { $kind: "NestedResult", NestedResult: [1, 0] });
    assert.deepEqual(out, { $kind: "Result", Result: 0 });
  });

  it("appendSwap refuses mismatched, foreign, stale or unprotected quotes", async () => {
    let now = 1_000;
    const agg = new FakeAggregator(route({ amountIn: 1_000_000n, amountOut: 1_000_000n }));
    const s = swapper(agg, { now: () => now, quoteTtlMs: 5_000, maxAmountInSlackBps: 10 });
    const q = await s.quote(USDC, USDT, 1_000_000n);
    const tx = new Transaction();
    const coinIn = tx.object(hex("c"));
    await assert.rejects(s.appendSwap(tx, { fromType: USDT, toType: USDC, coinIn, quote: q, minOut: 1n }), /does not match/);
    await assert.rejects(s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: q, minOut: 0n }), /unprotected/);
    await assert.rejects(s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: q, minOut: 1_000_001n }), /minOut .* > quoted/);
    await assert.rejects(s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: { ...q, amountOut: 2_000_000n }, minOut: 1n }), /differ/);
    const other = swapper(agg);
    await assert.rejects(other.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: q, minOut: 1n }), /not produced by this/);
    // slack: 10 bps over the quoted input
    await s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: q, minOut: 1n });
    assert.equal(agg.swaps.at(-1)!.maxAmountIn.toString(), "1001000");
    now += 5_001;
    await assert.rejects(s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn, quote: q, minOut: 1n }), /re-quote/);
  });
});

// ---------------------------------------------------------------------------
// Real SDK client, offline: confirms it accepts our @mysten/sui Transaction and
// what it passes to router::new_swap_context_v3.
// ---------------------------------------------------------------------------

describe("aggregator SDK integration (offline)", () => {
  it("routerSwapWithMaxAmountIn builds new_swap_context_v3 / cetus::swap / confirm_swap_v3 on our Transaction", async () => {
    const env = { grpc: new SuiGrpcClient({ network: "mainnet", baseUrl: "http://127.0.0.1:9" }), address: ME, network: "mainnet" as const };
    const client = createCetusAggregatorClient(env);
    const r = route({ amountIn: 1_000_000n, amountOut: 2_000_000n });
    const fake = { findRouters: async () => r, routerSwapWithMaxAmountIn: client.routerSwapWithMaxAmountIn.bind(client) } satisfies AggregatorLike;
    const s = swapper(fake, { maxCostBps: 1e9 });
    const q = await s.quote(USDC, USDT, 1_000_000n);
    const tx = new Transaction();
    await s.appendSwap(tx, { fromType: USDC, toType: USDT, coinIn: tx.object(hex("c")), quote: q, minOut: 1_990_000n });

    const cmds = tx.getData().commands;
    const calls = cmds.filter((c) => c.$kind === "MoveCall").map((c) => `${c.MoveCall!.module}::${c.MoveCall!.function}`);
    assert.deepEqual(calls, ["router::new_swap_context_v3", "cetus::swap", "router::confirm_swap_v3"]);
    const ctxCall = cmds.find((c) => c.MoveCall?.function === "new_swap_context_v3")!.MoveCall!;
    assert.equal(ctxCall.package, AGG_PKG);
    assert.deepEqual(ctxCall.typeArguments.map((t) => normalizeStructTag(t)), [normalizeStructTag(USDC), normalizeStructTag(USDT)]);
    // args: quoteID, maxAmountIn, quoteAmountIn, quoteAmountOut, slippage(ppm), inputCoin, feeRate, feeRecipient
    assert.equal(pureU64(tx, ctxCall.arguments[1]), 1_000_000n);
    assert.equal(pureU64(tx, ctxCall.arguments[2]), 1_000_000n);
    assert.equal(pureU64(tx, ctxCall.arguments[3]), 2_000_000n);
    assert.equal(pureU64(tx, ctxCall.arguments[4]), 5_000n); // (2_000_000 - 1_990_000) / 2_000_000 = 0.5%
    // our guard follows confirm_swap_v3
    const tail = cmds.slice(-2).map((c) => c.$kind);
    assert.deepEqual(tail, ["SplitCoins", "MergeCoins"]);
    assert.equal(pureU64(tx, cmds.at(-2)!.SplitCoins!.amounts[0]), 1_990_000n);
  });
});

// ---------------------------------------------------------------------------
// CetusSwapAdapter (mocked SuiEnv; executePtb runs for real against the fake)
// ---------------------------------------------------------------------------

interface FakeChain {
  balances: Record<string, bigint>;
  coins: Record<string, { objectId: string; balance: bigint }[]>;
  simOk: boolean;
  sims: Transaction[];
  broadcasts: number;
}

function fakeEnv(chain: FakeChain): SuiEnv {
  const core = {
    getBalance: async ({ coinType }: { coinType: string }) => {
      const b = chain.balances[normalizeStructTag(coinType)] ?? 0n;
      return { balance: { coinType, balance: b.toString(), coinBalance: b.toString(), addressBalance: "0" } };
    },
    listCoins: async ({ coinType }: { coinType: string }) => ({
      objects: (chain.coins[normalizeStructTag(coinType)] ?? []).map((c) => ({ objectId: c.objectId, version: "1", digest: "d", owner: {}, type: coinType, balance: c.balance.toString() })),
      hasNextPage: false,
      cursor: null,
    }),
    simulateTransaction: async ({ transaction }: { transaction: Transaction }) => {
      chain.sims.push(transaction);
      return chain.simOk
        ? { $kind: "Transaction", gasPaymentMocked: false, Transaction: { effects: { gasUsed: { computationCost: "1000000", storageCost: "2000000", storageRebate: "1000000", nonRefundableStorageFee: "0" } } } }
        : { $kind: "FailedTransaction", FailedTransaction: { status: { success: false, error: { message: "MoveAbort(confirm_swap_v3, 1)" } } } };
    },
    signAndExecuteTransaction: async () => {
      chain.broadcasts++;
      throw new Error("must not broadcast in dry-run");
    },
  };
  return { network: "mainnet", grpc: { core } as unknown as SuiEnv["grpc"], jsonRpc: {} as SuiEnv["jsonRpc"], address: ME, lock: new Mutex() };
}

const ctx = (over: Partial<LiveContext> = {}): LiveContext => ({
  dryRun: true,
  log: () => {},
  limits: { maxGasUsd: { sui: 1 }, maxSlippageBps: 15, maxLoopIterations: 4 },
  priceUsd: async () => 1,
  nativePriceUsd: async () => 2,
  ...over,
});

const A_USDC: AssetRef = { chain: "sui", symbol: "USDC", address: USDC, decimals: 6 };
const A_USDT: AssetRef = { chain: "sui", symbol: "USDT", address: USDT, decimals: 6 };
const A_SUI: AssetRef = { chain: "sui", symbol: "SUI", address: SUI, decimals: 9 };

describe("CetusSwapAdapter", () => {
  const newChain = (over: Partial<FakeChain> = {}): FakeChain => ({
    balances: { [normalizeStructTag(USDC)]: 1_500_000n, [normalizeStructTag(SUI)]: 5_000_000_000n },
    coins: { [normalizeStructTag(USDC)]: [{ objectId: hex("a"), balance: 600_000n }, { objectId: hex("b"), balance: 900_000n }] },
    simOk: true,
    sims: [],
    broadcasts: 0,
    ...over,
  });

  it("dry-run: merges/splits the input, swaps with minOut from maxSlippageBps, transfers out, simulates only", async () => {
    const chain = newChain();
    const agg = new FakeAggregator(route({ amountIn: 1_000_000n, amountOut: 999_000n }));
    const ad = new CetusSwapAdapter({ env: fakeEnv(chain), swapper: swapper(agg) });
    assert.equal(ad.id, "cetus-aggregator");
    assert.equal(ad.chain, "sui");
    const q = await ad.quote(A_USDC, A_USDT, 1_000_000n, ctx());
    assert.equal(q.amountOut, 999_000n);
    assert.match(q.route, /CETUS/);

    const r = await ad.swap(q, A_USDC, A_USDT, ctx());
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.txs[0]!.simulated, true);
    assert.equal(r.txs[0]!.id, undefined);
    assert.ok(Math.abs(r.txs[0]!.gasUsd! - 0.004) < 1e-9);
    assert.equal(chain.broadcasts, 0);
    assert.equal(chain.sims.length, 1);

    const tx = chain.sims[0]!;
    assert.equal(tx.getData().sender, ME);
    const kinds = tx.getData().commands.map((c) => c.$kind);
    // merge(b <- a), split 1_000_000, swap, guard split/merge, transfer
    assert.deepEqual(kinds, ["MergeCoins", "SplitCoins", "MoveCall", "SplitCoins", "MergeCoins", "TransferObjects"]);
    const cmds = tx.getData().commands;
    assert.equal(pureU64(tx, cmds[1]!.SplitCoins!.amounts[0]), 1_000_000n);
    const minOut = (999_000n * (1_000_000n - 1_500n)) / 1_000_000n; // 15 bps
    assert.equal(pureU64(tx, cmds[3]!.SplitCoins!.amounts[0]), minOut);
    assert.equal(agg.swaps[0]!.slippage, Number(((999_000n - minOut) * 1_000_000n) / 999_000n) / 1e6);
  });

  it("SUI input is split from the gas coin", async () => {
    const chain = newChain();
    const agg = new FakeAggregator(route({ amountIn: 1_000_000_000n, amountOut: 1_990_000n, paths: [path("a", SUI, USDC, CETUS)] }));
    const ad = new CetusSwapAdapter({ env: fakeEnv(chain), swapper: swapper(agg, { maxCostBps: 100 }) });
    const q = await ad.quote(A_SUI, A_USDC, 1_000_000_000n, ctx());
    const r = await ad.swap(q, A_SUI, A_USDC, ctx());
    assert.equal(r.ok, true, r.detail);
    const first = chain.sims[0]!.getData().commands[0]!;
    assert.equal(first.SplitCoins!.coin.$kind, "GasCoin");
  });

  it("reports simulation failure, insufficient balance, expiry and foreign quotes as ok:false", async () => {
    const agg = new FakeAggregator(route({ amountIn: 1_000_000n, amountOut: 999_000n }));
    let now = 0;
    const failing = newChain({ simOk: false });
    const ad = new CetusSwapAdapter({ env: fakeEnv(failing), swapper: swapper(agg, { now: () => now }), now: () => now });
    const q = await ad.quote(A_USDC, A_USDT, 1_000_000n, ctx());
    const r = await ad.swap(q, A_USDC, A_USDT, ctx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /simulation failed/);

    const poor = new CetusSwapAdapter({ env: fakeEnv(newChain({ balances: {} })), swapper: swapper(agg) });
    const q2 = await poor.quote(A_USDC, A_USDT, 1_000_000n, ctx());
    const r2 = await poor.swap(q2, A_USDC, A_USDT, ctx());
    assert.equal(r2.ok, false);
    assert.match(r2.detail!, /balance 0 < 1000000/);

    now = 60_000;
    const r3 = await ad.swap(q, A_USDC, A_USDT, ctx());
    assert.equal(r3.ok, false);
    assert.match(r3.detail!, /expired/);

    const r4 = await ad.swap({ ...q, payload: { kind: "other" } }, A_USDC, A_USDT, ctx());
    assert.match(r4.detail!, /not from this adapter/);
    const r5 = await ad.swap(q, A_USDT, A_USDC, ctx());
    assert.match(r5.detail!, /quote is for/);
    await assert.rejects(ad.quote({ ...A_USDC, chain: "arbitrum" }, A_USDT, 1n, ctx()), /not sui/);
  });
});
