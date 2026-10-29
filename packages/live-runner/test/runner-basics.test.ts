import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Opportunity, Position } from "@incentive-router/core";
import type { AssetRef, LendingAdapter, LiveContext, LiveResult, LoopPositionView, SwapAdapter } from "@incentive-router/live-common";
import { configHash, liveBlockers, stableStringify } from "../src/gate.js";
import { expandEnv } from "../src/liveConfig.js";
import { LoopExecutor } from "../src/loopExecutor.js";
import { PriceFeed } from "../src/prices.js";

const USDC: AssetRef = { chain: "arbitrum", symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 };

const ctx: LiveContext = {
  dryRun: false,
  log: () => {},
  limits: { maxGasUsd: { default: 3 }, maxSlippageBps: 15, maxLoopIterations: 8 },
  priceUsd: async () => 1,
  nativePriceUsd: async () => 3000,
};

class FakeAdapter implements LendingAdapter {
  readonly id = "fake";
  readonly chain = "arbitrum";
  wallet = 50_000_000_000n; // 50k USDC
  equity = 0;
  calls: string[] = [];
  lastDryRun: boolean | undefined;
  async markets() {
    return [];
  }
  async position(): Promise<LoopPositionView | null> {
    return this.equity ? { pairId: "p", collateralUsd: this.equity * 3, debtUsd: this.equity * 2, ltv: 2 / 3, equityUsd: this.equity, rewardsUnclaimed: [], asOfMs: 0 } : null;
  }
  async open(_p: string, equity: bigint, _ltv: number, c: LiveContext): Promise<LiveResult> {
    this.calls.push(`open ${equity}`);
    this.lastDryRun = c.dryRun;
    if (!c.dryRun) {
      this.wallet -= equity;
      this.equity += Number(equity) / 1e6 - 3; // 3 USD of costs
    }
    return { ok: true, txs: [{ chain: "arbitrum", description: "open", simulated: c.dryRun }] };
  }
  async close(_p: string, fraction: number, c: LiveContext): Promise<LiveResult> {
    this.calls.push(`close ${fraction}`);
    if (!c.dryRun) {
      const out = this.equity * fraction;
      this.equity -= out;
      this.wallet += BigInt(Math.round(out * 1e6));
    }
    return { ok: true, txs: [] };
  }
  async deleverage(): Promise<LiveResult> {
    return { ok: true, txs: [] };
  }
  async simulateClose(): Promise<boolean> {
    return true;
  }
  async claimRewards() {
    return { ok: true, txs: [], claimed: [] };
  }
  async walletBalance(): Promise<bigint> {
    return this.wallet;
  }
}

const opp = { id: "fake:p", meta: { ltv: 0.7 }, costs: { entryFrac: 0.001, exitFrac: 0.001, fixedEntryUsd: 1, fixedExitUsd: 1, ongoingApr: 0 } } as unknown as Opportunity;
const pos = { oppId: "fake:p", equityUsd: 10_000 } as unknown as Position;

function exec(mode: "live" | "shadow", a: FakeAdapter, swappers: Record<string, SwapAdapter> = {}) {
  return new LoopExecutor({
    mode,
    ctx,
    bind: () => ({ adapter: a, pairId: "p", collateral: USDC }),
    swappers,
    rewardAssets: {},
    proceedsAsset: {},
  });
}

describe("LoopExecutor", () => {
  it("live: measures deployed equity and exit proceeds from chain state", async () => {
    const a = new FakeAdapter();
    const e = exec("live", a);
    const r = await e.enter(opp, 10_000);
    assert.equal(r.ok, true);
    assert.equal(a.lastDryRun, false);
    assert.ok(Math.abs(r.amountUsd! - 9_997) < 1e-6);
    assert.equal(r.spentUsd, 10_000);
    assert.equal(await e.markToMarket!(pos), 9_997);
    const x = await e.exit({ ...pos, equityUsd: 9_997 } as Position, 1, opp);
    assert.ok(Math.abs(x.amountUsd! - 9_997) < 1e-3);
  });
  it("shadow: simulates (dryRun=true) and books paper amounts; no markToMarket", async () => {
    const a = new FakeAdapter();
    const e = exec("shadow", a);
    const r = await e.enter(opp, 10_000);
    assert.equal(a.lastDryRun, true);
    assert.equal(a.wallet, 50_000_000_000n, "nothing moved");
    assert.ok(Math.abs(r.amountUsd! - (10_000 - 10 - 1)) < 1e-9);
    assert.equal(e.markToMarket, undefined);
    assert.equal(await e.simulateExit(pos), true);
  });
  it("refuses to enter without enough wallet balance or without a target ltv", async () => {
    const a = new FakeAdapter();
    a.wallet = 1_000_000n;
    assert.match((await exec("live", a).enter(opp, 10_000)).detail!, /wallet has/);
    const noLtv = { ...opp, meta: {} } as Opportunity;
    assert.match((await exec("live", new FakeAdapter()).enter(noLtv, 100)).detail!, /target ltv/);
  });
  it("cannot sell rewards without a configured swapper", async () => {
    assert.equal((await exec("live", new FakeAdapter()).sell(pos, "ARB", 50)).ok, false);
  });
});

describe("gate", () => {
  const env = { LIVE_CONFIRM: "yes" } as NodeJS.ProcessEnv;
  const hash = configHash({ b: 1, a: [1, 2] });
  it("hash is key-order independent", () => {
    assert.equal(stableStringify({ a: 1, b: { d: 2, c: 3 } }), stableStringify({ b: { c: 3, d: 2 }, a: 1 }));
    assert.equal(hash, configHash({ a: [1, 2], b: 1 }));
  });
  it("blocks without stamp, with stale/mismatched stamp, issues, or missing confirmation", () => {
    const base = { configHash: hash, nowMs: 10 * 86_400_000, maxAgeDays: 7, modeIsLive: true, env };
    assert.ok(liveBlockers({ ...base, stamp: null }).some((x) => x.includes("verify")));
    const good = { createdAtMs: 9 * 86_400_000, configHash: hash, results: { aave: [] } };
    assert.deepEqual(liveBlockers({ ...base, stamp: good }), []);
    assert.ok(liveBlockers({ ...base, stamp: { ...good, configHash: "x" } }).some((x) => x.includes("changed")));
    assert.ok(liveBlockers({ ...base, stamp: { ...good, createdAtMs: 0 } }).some((x) => x.includes("old")));
    assert.ok(liveBlockers({ ...base, stamp: { ...good, results: { aave: ["bad addr"] } } }).some((x) => x.includes("bad addr")));
    assert.ok(liveBlockers({ ...base, stamp: good, env: {} }).some((x) => x.includes("LIVE_CONFIRM")));
    assert.ok(liveBlockers({ ...base, stamp: good, modeIsLive: false }).length > 0);
  });
});

describe("config env expansion", () => {
  it("expands ${VARS} and reports missing ones", () => {
    const missing = new Set<string>();
    const out = expandEnv({ rpc: "${ARB_RPC}", list: ["x${NOPE}"] }, { ARB_RPC: "https://r" }, missing) as { rpc: string; list: string[] };
    assert.equal(out.rpc, "https://r");
    assert.equal(out.list[0], "x");
    assert.deepEqual([...missing], ["NOPE"]);
  });
});

describe("PriceFeed", () => {
  it("batches, caches, refuses stale and missing prices, honours overrides", async () => {
    let calls = 0;
    let now = 1_000_000_000_000;
    const t0 = now / 1000; // the feed keeps returning this (old) timestamp
    const feed = new PriceFeed({
      now: () => now,
      overrides: { "sui:0xabc::x::X": 2 },
      fetchImpl: async (url: string) => {
        calls++;
        assert.match(url, /prices\/current\//);
        return {
          ok: true,
          status: 200,
          json: async () => ({ coins: { "arbitrum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831": { price: 0.9998, timestamp: t0 }, "coingecko:ethereum": { price: 3100, timestamp: t0 } } }),
        };
      },
    });
    assert.equal(await feed.priceUsd(USDC), 0.9998);
    assert.equal(await feed.priceUsd(USDC), 0.9998);
    assert.equal(calls, 1);
    assert.equal(await feed.nativePriceUsd("arbitrum"), 3100);
    assert.equal(await feed.byKey("sui:0xabc::x::X"), 2);
    await assert.rejects(feed.byKey("base:0xdead"), /no price/);
    now += 11 * 60_000; // past maxAge; refetch returns the same old timestamp
    await assert.rejects(feed.priceUsd(USDC), /stale/);
  });
});

describe("LoopExecutor error paths", () => {
  it("books a partial entry when open() throws after broadcasting", async () => {
    const a = new FakeAdapter();
    a.open = async (_p: string, equity: bigint) => {
      a.wallet -= equity;
      a.equity += Number(equity) / 1e6 / 2; // half went in, then a receipt timeout
      throw new Error("timeout waiting for receipt");
    };
    const r = await exec("live", a).enter(opp, 10_000);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.amountUsd! - 5_000) < 1e-6);
    assert.match(r.detail!, /PARTIAL/);
  });
  it("reports a clean failure when nothing changed", async () => {
    const a = new FakeAdapter();
    a.open = async () => {
      throw new Error("simulation reverted");
    };
    const r = await exec("live", a).enter(opp, 10_000);
    assert.equal(r.ok, false);
    assert.match(r.detail!, /simulation reverted/);
  });
});
