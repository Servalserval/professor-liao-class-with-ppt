import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, type LoopPair, type Position, type RouterConfig } from "@incentive-router/core";
import type { AssetRef, LendingAdapter, LiveContext, RewardClaimer, SwapAdapter, SwapQuote } from "@incentive-router/live-common";
import { BucketReader } from "../src/balances.js";
import { applyCanaryToRouterConfig, CanaryExecutor } from "../src/guards.js";
import { PairRegistry } from "../src/pairs.js";
import { RewardKeeper } from "../src/rewardKeeper.js";
import { SwapRouteAdapter } from "../src/swapRoute.js";

const ctx: LiveContext = {
  dryRun: false,
  log: () => {},
  limits: { maxGasUsd: { default: 3 }, maxSlippageBps: 15, maxLoopIterations: 8 },
  priceUsd: async () => 1,
  nativePriceUsd: async () => 1,
};
const A = (chain: string, symbol: string, address: string, decimals = 6): AssetRef => ({ chain, symbol, address, decimals });
const USDT0 = A("plasma", "USDT0", "0x01");
const USDE = A("plasma", "USDe", "0x02", 18);

describe("CanaryExecutor", () => {
  const pos = (oppId: string, equityUsd: number) => ({ oppId, equityUsd }) as Position;
  it("caps a position and the total; never blocks exits", async () => {
    const lim = { max_position_usd: 2_000, max_total_deployed_usd: 5_000 };
    assert.equal(CanaryExecutor.check(lim, [], "a", 2_000), null);
    assert.match(CanaryExecutor.check(lim, [pos("a", 1_500)], "a", 600)!, /max_position_usd/);
    assert.match(CanaryExecutor.check(lim, [pos("a", 2_000), pos("b", 2_000)], "c", 1_500)!, /max_total_deployed_usd/);
    let exited = false;
    const inner = {
      enter: async () => ({ ok: true }),
      exit: async () => ((exited = true), { ok: true }),
      rebalance: async () => ({ ok: true }),
      simulateExit: async () => true,
      claim: async () => ({ ok: true }),
      sell: async () => ({ ok: true }),
      hedge: async () => ({ ok: false }),
    };
    const ex = new CanaryExecutor(inner, lim, () => [pos("a", 2_000)]);
    assert.equal((await ex.enter({ id: "a" } as never, 100)).ok, false);
    await ex.exit(pos("a", 2_000), 1);
    assert.equal(exited, true);
    assert.equal(ex.markToMarket, undefined);
  });
  it("clamps the router's max_position_usd", () => {
    const cfg = applyCanaryToRouterConfig(DEFAULT_CONFIG as RouterConfig, { max_position_usd: 2_000, max_total_deployed_usd: 10_000 });
    assert.equal(cfg.caps.max_position_usd, 2_000);
    assert.equal((DEFAULT_CONFIG as RouterConfig).caps.max_position_usd, 100_000, "original untouched");
  });
});

function fakeSwapper(costBps: number, out: (inp: bigint) => bigint, onSwap?: () => void): SwapAdapter {
  return {
    id: "fake-swap",
    chain: "plasma",
    quote: async (_f, _t, amountIn): Promise<SwapQuote> => ({ amountIn, amountOut: out(amountIn), costBps, route: "x", validUntilMs: 0 }),
    swap: async (_q, _f, _t, c) => (onSwap?.(), { ok: true, txs: [{ chain: "plasma", description: "swap", simulated: c.dryRun }] }),
  };
}

describe("SwapRouteAdapter", () => {
  it("refuses a hop whose live cost exceeds the allowance; measures received from the wallet", async () => {
    let bal = 0n;
    const conv = (x: bigint) => x * 10n ** 12n;
    const sw = fakeSwapper(2, conv, () => (bal += conv(1_000_000_000n) - 5n));
    const ad = new SwapRouteAdapter({ swappers: { plasma: sw }, balance: async () => bal, maxCostBps: () => 3 });
    assert.equal(ad.supports(USDT0, USDE), true);
    assert.equal(ad.supports(USDT0, USDT0), false);
    assert.equal(ad.supports(USDT0, A("arbitrum", "USDe", "0x02")), false);
    const q = await ad.quote(USDT0, USDE, 1_000_000_000n, ctx);
    assert.ok(Math.abs(q.feeUsd - 0.2) < 1e-9);
    const r = await ad.send(USDT0, USDE, 1_000_000_000n, "me", ctx);
    assert.equal(r.ok, true);
    const st = await ad.status(r.handle!);
    assert.equal(st.state, "completed");
    assert.equal((st as { received: bigint }).received, conv(1_000_000_000n) - 5n);
    const tooDear = new SwapRouteAdapter({ swappers: { plasma: fakeSwapper(9, conv) }, balance: async () => 0n, maxCostBps: () => 3 });
    assert.match((await tooDear.send(USDT0, USDE, 1n, "me", ctx)).detail!, /> allowed/);
  });
});

describe("PairRegistry", () => {
  const leg = (symbol: string, priceUsd: number) => ({
    symbol,
    priceUsd,
    totalSupplyUsd: 1e8,
    totalBorrowUsd: 5e7,
    supplyAprBase: 0.05,
    borrowAprBase: 0.04,
    supplyRewards: [],
    borrowRewards: [],
  });
  const pair: LoopPair = { protocol: "aave-v3", chain: "plasma", pairId: "USDe-USDT0", collateral: leg("USDe", 1), debt: leg("USDT0", 1), maxLtv: 0.9, liqLtv: 0.93, swapCostFrac: 0.0002, swapDepthUsd: 5e6 };
  const adapter = { id: "aave-v3:plasma", chain: "plasma", markets: async () => [pair] } as unknown as LendingAdapter;
  it("overrides protocol prices with market prices and binds opportunity ids", async () => {
    const reg = new PairRegistry({ marketPrice: async (a) => (a.symbol === "USDe" ? 0.985 : 1), log: () => {} });
    const src = reg.source(adapter, [{ pairId: "USDe-USDT0", collateral: USDE, debt: USDT0 }]);
    const opps = await src.fetch({ cfg: DEFAULT_CONFIG as RouterConfig, nowMs: 1, myEquityByOpp: {} });
    assert.equal(opps.length, 1);
    const o = opps[0]!;
    assert.equal(o.id, "aave-v3:plasma:aave-v3:USDe-USDT0");
    assert.ok(Math.abs((o.metrics as Record<string, number>).depeg! - (1 / 0.985 - 1)) < 1e-9, "depeg seen from market prices");
    assert.equal(reg.bind(o.id)?.collateral.symbol, "USDe");
  });
  it("binds from config before any markets() read (restart with RPC down)", () => {
    const reg = new PairRegistry({ marketPrice: async () => 1, log: () => {} });
    reg.source(adapter, [{ pairId: "USDe-USDT0", collateral: USDE, debt: USDT0 }]);
    assert.equal(reg.bind("aave-v3:plasma:aave-v3:USDe-USDT0")?.pairId, "USDe-USDT0");
    assert.equal(reg.bind("other:x:USDe-USDT0"), undefined);
  });
  it("keeps the protocol price when the market price is unavailable", async () => {
    const warns: string[] = [];
    const reg = new PairRegistry({ marketPrice: async () => Promise.reject(new Error("stale price")), log: (_l, m) => warns.push(m) });
    const src = reg.source(adapter, [{ pairId: "USDe-USDT0", collateral: USDE, debt: USDT0 }]);
    const opps = await src.fetch({ cfg: DEFAULT_CONFIG as RouterConfig, nowMs: 1, myEquityByOpp: {} });
    assert.equal(opps.length, 1);
    assert.ok(warns.some((w) => w.includes("no market price")));
  });
});

describe("BucketReader", () => {
  it("omits buckets whose read failed (router keeps its value); throws only when every read fails", async () => {
    let fail = new Set<string>();
    const r = new BucketReader({
      assets: [USDT0, USDE, USDT0],
      balance: async (a) => {
        if (fail.has(a.symbol)) throw new Error("rpc down");
        return a.symbol === "USDe" ? 3n * 10n ** 18n : 2_000_000n;
      },
      priceUsd: async () => 1,
      log: () => {},
    });
    assert.deepEqual(r.keys(), ["plasma:USDT0", "plasma:USDe"]);
    assert.deepEqual(await r.read(), { "plasma:USDT0": 2, "plasma:USDe": 3 });
    fail = new Set(["USDe"]);
    assert.deepEqual(await r.read(), { "plasma:USDT0": 2 }, "no stale substitution");
    fail = new Set(["USDe", "USDT0"]);
    await assert.rejects(r.read(), /every wallet balance read failed/);
  });
  it("rejects one symbol configured with two addresses", () => {
    assert.throws(() => new BucketReader({ assets: [USDT0, A("plasma", "USDT0", "0x99")], balance: async () => 0n, priceUsd: async () => 1, log: () => {} }), /two addresses/);
  });
});

describe("RewardKeeper", () => {
  it("claims Merkl above the minimum, sells reward tokens, respects the interval, simulates in shadow", async () => {
    const WMON = A("monad", "WMON", "0x0a", 18);
    const CASH = A("monad", "USDT0", "0x0b");
    const dry: boolean[] = [];
    const claimer: RewardClaimer = {
      id: "merkl:monad",
      chain: "monad",
      claimable: async () => [{ token: WMON, amount: 30n * 10n ** 18n }],
      claim: async (_o, c) => (dry.push(c.dryRun), { ok: true, txs: [] }),
    };
    let sold = 0;
    let now = 0;
    const mk = (mode: "live" | "shadow") =>
      new RewardKeeper({
        mode,
        ctx: { ...ctx, priceUsd: async (a) => (a.symbol === "WMON" ? 0.5 : 1) },
        claimers: [claimer],
        lending: [],
        owner: () => "0xme",
        sellables: { monad: [WMON] },
        cash: { monad: CASH },
        swappers: { monad: { ...fakeSwapper(10, (x) => x / 10n ** 12n), swap: async (_q, _f, _t, c) => (sold++, dry.push(c.dryRun), { ok: true, txs: [] }) } },
        balance: async (a) => (a.symbol === "WMON" ? 30n * 10n ** 18n : 0n),
        statePath: join(mkdtempSync(join(tmpdir(), "rk-")), "rewards.json"),
        opts: { intervalHours: 2, minClaimUsd: 10, minSellUsd: 5 },
        now: () => now,
      });
    const k = mk("live");
    const lines = await k.run();
    assert.ok(lines.some((l) => l.includes("claim $15.00 OK")), lines.join("\n"));
    assert.equal(sold, 1);
    assert.deepEqual(await k.run(), [], "not due yet");
    now = 2 * 3_600_000;
    assert.ok((await k.run()).length > 0, "due again after the interval");
    const s = mk("shadow");
    dry.length = 0;
    await s.run();
    assert.ok(dry.length > 0 && dry.every((x) => x === true), "shadow simulates only");
  });
});

describe("PairRegistry depeg reference", () => {
  const leg = (symbol: string, priceUsd: number) => ({
    symbol,
    priceUsd,
    totalSupplyUsd: 1e8,
    totalBorrowUsd: 5e7,
    supplyAprBase: 0.05,
    borrowAprBase: 0.04,
    supplyRewards: [],
    borrowRewards: [],
  });
  const SUSDE = A("ethereum", "sUSDe", "0x03", 18);
  const USDC = A("ethereum", "USDC", "0x04");
  const pair: LoopPair = { protocol: "morpho:ethereum", chain: "ethereum", pairId: "m1", collateral: leg("sUSDe", 1.17), debt: leg("USDC", 1), maxLtv: 0.86, liqLtv: 0.915, swapCostFrac: 0.0003, swapDepthUsd: 5e6 };
  const adapter = { id: "morpho:ethereum", chain: "ethereum", markets: async () => [pair] } as unknown as LendingAdapter;
  const market = async (a: AssetRef) => (a.symbol === "sUSDe" ? 1.168 : 1);
  it("stable default (1:1) flags a yield-bearing pair; 'oracle' measures market vs oracle", async () => {
    const run = async (expectedPriceRatio?: number | "oracle") => {
      const reg = new PairRegistry({ marketPrice: market, log: () => {} });
      const src = reg.source(adapter, [{ pairId: "m1", collateral: SUSDE, debt: USDC, expectedPriceRatio }]);
      const [o] = await src.fetch({ cfg: DEFAULT_CONFIG as RouterConfig, nowMs: 1, myEquityByOpp: {} });
      return (o!.metrics as Record<string, number>).depeg!;
    };
    assert.ok((await run()) > 0.1, "1:1 reference: sUSDe looks depegged (would force exit)");
    const d = await run("oracle");
    assert.ok(Math.abs(d - (1.17 / 1.168 - 1)) < 1e-9, `market vs oracle ratio, got ${d}`);
  });
});

describe("runner safety: lock, mode marker, gate, stablecoin scope", async () => {
  const { takeLock, checkModeMarker } = await import("../src/cli-lib.js");
  it("lock: second holder refused while the first is alive; stale lock taken over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const release = takeLock(dir);
    assert.throws(() => takeLock(dir), /another runner/);
    release();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "runner.lock"), "999999"); // dead pid
    const r2 = takeLock(dir);
    r2();
  });
  it("mode marker: a shadow state dir cannot be reused for live", () => {
    const dir = mkdtempSync(join(tmpdir(), "mode-"));
    checkModeMarker(dir, "shadow");
    checkModeMarker(dir, "shadow");
    assert.throws(() => checkModeMarker(dir, "live"), /separate state_dir/);
  });
  it("canary executor refuses entries while the live gate is closed, exits still run", async () => {
    let reason: string | null = "live gate closed: stamp 8 days old";
    let exits = 0;
    const inner = {
      enter: async () => ({ ok: true }),
      exit: async () => (exits++, { ok: true }),
      rebalance: async () => ({ ok: true }),
      simulateExit: async () => true,
      claim: async () => ({ ok: true }),
      sell: async () => ({ ok: true }),
      hedge: async () => ({ ok: false }),
    };
    const ex = new CanaryExecutor(inner, { max_position_usd: 1e6, max_total_deployed_usd: 1e7 }, () => [], () => reason);
    assert.match((await ex.enter({ id: "a" } as never, 100)).detail!, /gate closed/);
    await ex.exit({ oppId: "a", equityUsd: 1 } as never, 1);
    assert.equal(exits, 1);
    reason = null;
    assert.equal((await ex.enter({ id: "a" } as never, 100)).ok, true);
  });
  it("live config refuses non-stable loop assets unless explicitly allowed", async () => {
    const { validateLiveConfig } = await import("../src/liveConfig.js");
    const base = {
      mode: "shadow",
      chains: { arbitrum: { rpc: "x" } },
      assets: { arbitrum: { WETH: { address: "0x1", decimals: 18 }, USDC: { address: "0x2", decimals: 6 } } },
      lending: [{ type: "aave-v3", chain: "arbitrum", market: "AaveV3Arbitrum", pairs: [{ pairId: "w", collateral: "WETH", debt: "WETH" }] }],
      canary: { max_position_usd: 1, max_total_deployed_usd: 1 },
      limits: { max_slippage_bps: 10, max_gas_usd: {}, max_loop_iterations: 8 },
    } as never;
    assert.ok(validateLiveConfig(base).some((x) => x.includes("not a stablecoin")));
    assert.ok(!validateLiveConfig({ ...(base as object), allow_non_stable: true } as never).some((x) => x.includes("not a stablecoin")));
  });
});
