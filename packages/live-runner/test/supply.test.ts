import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Opportunity, Position, SupplyMarket } from "@incentive-router/core";
import type { AssetRef, LiveContext, LiveResult, SupplyAdapter, SupplyPositionView } from "@incentive-router/live-common";
import { SupplyExecutor } from "../src/supplyExecutor.js";
import { SupplyRegistry, supplySourceId } from "../src/supplyRegistry.js";

const ctx: LiveContext = {
  dryRun: false,
  log: () => {},
  limits: { maxGasUsd: { default: 3 }, maxSlippageBps: 15, maxLoopIterations: 8 },
  priceUsd: async () => 1,
  nativePriceUsd: async () => 1,
};
const USDC: AssetRef = { chain: "base", symbol: "USDC", address: "0x0c", decimals: 6 };
const U = (usd: number) => BigInt(Math.round(usd * 1e6));

/** One-market in-memory supply venue: wallet <-> deposit, optional failures. */
class FakeSupply implements SupplyAdapter {
  readonly id = "fake-lend";
  readonly chain = "base";
  wallet = U(10_000);
  dep = 0n;
  depositThrowsAfter = false;
  withdrawRevert = false;
  /** Next N supplyPosition reads throw (RPC down). */
  failPositionReads = 0;
  /** Next N supplyPosition reads return null although a deposit exists (lagging node). */
  lagReads = 0;
  /** deposit outcome override: approve broadcast then fail / broadcast with unknown confirmation (lands or not). */
  depositMode: "normal" | "approveOnly" | "unconfirmedLands" | "unconfirmedLost" = "normal";
  failWalletReads = 0;
  calls: string[] = [];
  market(): SupplyMarket {
    return {
      protocol: "fake",
      chain: "base",
      marketId: "0xVAULT",
      asset: { symbol: "USDC", priceUsd: 1 },
      totalSupplyUsd: 5_000_000,
      totalBorrowUsd: 4_000_000,
      supplyAprBase: 0.06,
      rewards: [],
    };
  }
  async supplyMarkets() {
    return [this.market()];
  }
  async supplyPosition(marketId: string): Promise<SupplyPositionView | null> {
    if (marketId.toLowerCase() !== "0xvault") throw new Error(`unknown market ${marketId}`);
    if (this.failPositionReads > 0) {
      this.failPositionReads--;
      throw new Error("rpc 503");
    }
    if (this.lagReads > 0) {
      this.lagReads--;
      return null;
    }
    if (this.dep === 0n) return null;
    return { marketId, depositUsd: Number(this.dep) / 1e6, units: this.dep, rewardsUnclaimed: [], asOfMs: Date.now() };
  }
  async deposit(_m: string, amount: bigint, c: LiveContext): Promise<LiveResult> {
    this.calls.push(`deposit ${amount} dry=${c.dryRun}`);
    if (c.dryRun) return { ok: true, txs: [{ chain: "base", description: "supply", simulated: true }] };
    if (this.depositMode === "approveOnly")
      return { ok: false, txs: [{ chain: "base", id: "0xapprove", description: "approve", simulated: false }], detail: "supply reverted" };
    if (this.depositMode === "unconfirmedLost")
      return { ok: false, txs: [{ chain: "base", id: "0xsup", description: "supply", simulated: false, unconfirmed: true }], detail: "UNCONFIRMED" };
    if (this.depositMode === "unconfirmedLands") {
      this.wallet -= amount;
      this.dep += amount;
      this.lagReads = 1; // not visible yet
      return { ok: false, txs: [{ chain: "base", id: "0xsup", description: "supply", simulated: false, unconfirmed: true }], detail: "UNCONFIRMED" };
    }
    this.wallet -= amount;
    this.dep += amount;
    if (this.depositThrowsAfter) throw new Error("rpc dropped after broadcast");
    return { ok: true, txs: [{ chain: "base", id: "0xtx", description: "supply", simulated: false }] };
  }
  async withdraw(_m: string, fraction: number, c: LiveContext): Promise<LiveResult> {
    this.calls.push(`withdraw ${fraction} dry=${c.dryRun}`);
    if (c.dryRun) return { ok: true, txs: [{ chain: "base", description: "withdraw", simulated: true }] };
    const amt = fraction >= 1 ? this.dep : (this.dep * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    this.dep -= amt;
    this.wallet += amt;
    return { ok: true, txs: [{ chain: "base", id: "0xtx2", description: "withdraw", simulated: false }] };
  }
  async simulateWithdraw() {
    return !this.withdrawRevert;
  }
  async claimRewards() {
    return { ok: true, txs: [], claimed: [] };
  }
  async walletBalance() {
    if (this.failWalletReads > 0) {
      this.failWalletReads--;
      throw new Error("rpc 429");
    }
    return this.wallet;
  }
}

const opp = (id: string): Opportunity =>
  ({
    id,
    sourceId: supplySourceId("fake-lend"),
    kind: "deposit",
    costs: { entryFrac: 0.0005, exitFrac: 0.0005, fixedEntryUsd: 0.5, fixedExitUsd: 0.5 },
  }) as unknown as Opportunity;

describe("SupplyRegistry", () => {
  it("matches by marketId (case-insensitive), overrides price, binds ids; falls back to config before the first read", async () => {
    const a = new FakeSupply();
    const warns: string[] = [];
    const reg = new SupplyRegistry({ marketPrice: async () => 0.9995, log: (_l, m) => warns.push(m) });
    const src = reg.source(a, [{ marketId: "0xvault", asset: USDC }]);
    assert.equal(src.id, "fake-lend#supply");
    const id = "fake-lend#supply:fake:0xVAULT";
    assert.equal(reg.bind(id)?.marketId, "0xvault", "config fallback before the first read");
    const ms: SupplyMarket[] = [];
    // Read the provider through the source's private provider: fetch() needs core's supplyOpportunity,
    // so call the adapter path the registry wraps.
    const provider = (src as unknown as { provider: () => Promise<SupplyMarket[]> }).provider;
    ms.push(...(await provider()));
    assert.equal(ms.length, 1);
    assert.equal(ms[0]!.asset.priceUsd, 0.9995, "market price overrides protocol price");
    assert.equal(reg.bind(id)?.marketId, "0xVAULT");
    assert.equal(warns.length, 0);
  });
  it("ignores an unconfigured market and refuses an ambiguous symbol match", async () => {
    const a = new FakeSupply();
    const warns: string[] = [];
    const reg = new SupplyRegistry({ marketPrice: async () => 1, log: (_l, m) => warns.push(m) });
    const src = reg.source(a, [{ asset: USDC }, { asset: { ...USDC, address: "0x0d" } }]);
    const provider = (src as unknown as { provider: () => Promise<SupplyMarket[]> }).provider;
    assert.equal((await provider()).length, 0);
    assert.match(warns[0]!, /unconfigured supply market/);
  });
});

describe("SupplyExecutor", () => {
  const mk = (mode: "live" | "shadow", a: FakeSupply) =>
    new SupplyExecutor({
      mode,
      ctx,
      bind: () => ({ adapter: a, marketId: "0xVAULT", asset: USDC }),
      swappers: {},
      rewardAssets: {},
      proceedsAsset: {},
    });

  it("live: enter books the measured deposit growth; exit books the wallet delta", async () => {
    const a = new FakeSupply();
    const ex = mk("live", a);
    const r = await ex.enter(opp("x"), 3_000);
    assert.equal(r.ok, true);
    assert.equal(r.amountUsd, 3_000);
    const pos = { oppId: "x", equityUsd: 3_000 } as Position;
    assert.equal(await ex.markToMarket!(pos), 3_000);
    const e = await ex.exit(pos, 0.5);
    assert.equal(e.ok, true);
    assert.equal(e.amountUsd, 1_500);
    assert.equal(a.dep, U(1_500));
  });

  it("live: refuses an entry the wallet cannot fund; clamps a rounding shortfall", async () => {
    const a = new FakeSupply();
    a.wallet = U(999.5);
    const ex = mk("live", a);
    const r = await ex.enter(opp("x"), 1_000); // 0.05% short = rounding -> clamp to the wallet
    assert.equal(r.ok, true);
    assert.equal(a.wallet, 0n);
    a.wallet = U(100);
    const r2 = await ex.enter(opp("x"), 1_000);
    assert.equal(r2.ok, false);
    assert.match(r2.detail!, /wallet has 100\.00/);
  });

  it("live: an error after broadcast is booked from the measured deposit, not dropped", async () => {
    const a = new FakeSupply();
    a.depositThrowsAfter = true;
    const r = await mk("live", a).enter(opp("x"), 2_000);
    assert.equal(r.ok, true, "money moved: must be booked");
    assert.equal(r.amountUsd, 2_000);
    assert.match(r.detail!, /PARTIAL after error/);
  });

  it("shadow: every write is a dry run, booked on paper net of costs; no markToMarket", async () => {
    const a = new FakeSupply();
    const ex = mk("shadow", a);
    assert.equal(ex.markToMarket, undefined);
    const r = await ex.enter(opp("x"), 1_000);
    assert.equal(r.ok, true);
    assert.ok(Math.abs(r.amountUsd! - (1_000 - 0.5 - 0.5)) < 1e-9);
    assert.equal(a.dep, 0n);
    assert.deepEqual(a.calls, ["deposit 1000000000 dry=true"]);
    const e = await ex.exit({ oppId: "x", equityUsd: 999 } as Position, 1, opp("x"));
    assert.equal(e.ok, true);
    assert.equal(a.calls[1], "withdraw 1 dry=true");
    assert.equal(await ex.simulateExit({ oppId: "x" } as Position), true);
  });

  it("live: simulateExit forwards the adapter's answer; markToMarket keeps book value on transient nulls", async () => {
    const a = new FakeSupply();
    a.withdrawRevert = true;
    const ex = mk("live", a);
    assert.equal(await ex.simulateExit({ oppId: "x" } as Position), false);
    const pos = { oppId: "x", equityUsd: 500 } as Position;
    await assert.rejects(ex.markToMarket!(pos), /no deposit \(1x\)/);
    await assert.rejects(ex.markToMarket!(pos), /no deposit \(2x\)/);
    assert.equal(await ex.markToMarket!(pos), 0, "third consecutive null = really gone");
  });

  it("live: a failed baseline read sends nothing", async () => {
    const a = new FakeSupply();
    a.failPositionReads = 1;
    const r = await mk("live", a).enter(opp("x"), 1_000);
    assert.equal(r.ok, false);
    assert.match(r.detail!, /nothing sent/);
    assert.equal(a.calls.length, 0);
  });

  it("live: approve broadcast + failed supply with a clean re-read is a failure, not a phantom deposit", async () => {
    const a = new FakeSupply();
    a.depositMode = "approveOnly";
    const r = await mk("live", a).enter(opp("x"), 2_000);
    assert.equal(r.ok, false);
    assert.equal(a.dep, 0n);
  });

  it("live: an unconfirmed deposit is tracked at $0 without debiting idle, blocks re-entry, and the next mark picks it up", async () => {
    const a = new FakeSupply();
    a.depositMode = "unconfirmedLands";
    const ex = mk("live", a);
    const r = await ex.enter(opp("x"), 2_000);
    assert.equal(r.ok, true);
    assert.equal(r.amountUsd, 0);
    assert.equal(r.spentUsd, 0, "idle is settled by the wallet snapshot, not debited on a guess");
    assert.match(r.detail!, /outcome unknown/);
    a.depositMode = "normal";
    const again = await ex.enter(opp("x"), 2_000);
    assert.equal(again.ok, false);
    assert.match(again.detail!, /unresolved/);
    assert.equal(await ex.markToMarket!({ oppId: "x", equityUsd: 0 } as Position), 2_000);
    const lost = new FakeSupply();
    lost.depositMode = "unconfirmedLost";
    const ex2 = mk("live", lost);
    const r2 = await ex2.enter(opp("x"), 2_000);
    assert.equal(r2.ok, true);
    assert.equal(r2.amountUsd, 0);
    assert.equal(await ex2.markToMarket!({ oppId: "x", equityUsd: 0 } as Position), 0, "a $0 placeholder with no deposit marks to 0 at once");
  });

  it("live: a top-up with a lagging baseline read books at most what was sent", async () => {
    const a = new FakeSupply();
    const ex = mk("live", a);
    await ex.enter(opp("x"), 5_000);
    a.lagReads = 1; // the baseline read misses the existing $5k
    const r = await ex.enter(opp("x"), 1_000);
    assert.equal(r.ok, true);
    assert.equal(r.amountUsd, 1_000);
  });

  it("live: exit never fails after a successful withdraw; a full exit attempt makes the next empty read final", async () => {
    const a = new FakeSupply();
    const ex = mk("live", a);
    await ex.enter(opp("x"), 3_000);
    const pos = { oppId: "x", equityUsd: 3_000 } as Position;
    // wallet read after the withdraw fails
    let calls = 0;
    const orig = a.walletBalance.bind(a);
    a.walletBalance = async () => (++calls === 2 ? Promise.reject(new Error("rpc 429")) : orig());
    const e = await ex.exit(pos, 1);
    assert.equal(e.ok, true);
    assert.equal(e.amountUsd, 3_000, "falls back to the book value");
    assert.equal(await ex.markToMarket!(pos), 0, "no 3-strike wait after a full exit attempt");
  });

  it("live: an exit that sees no deposit is confirmed by a second read before the position is dropped", async () => {
    const a = new FakeSupply();
    const ex = mk("live", a);
    await ex.enter(opp("x"), 3_000);
    // the adapter's own read lags -> it reports "no deposit" without sending anything
    a.withdraw = async () => ({ ok: true, txs: [], detail: "no deposit" });
    const e = await ex.exit({ oppId: "x", equityUsd: 3_000 } as Position, 1);
    assert.equal(e.ok, false);
    assert.match(e.detail!, /re-read shows \$3000\.00/);
  });

  it("rebalance is a no-op for a plain deposit", async () => {
    const r = await mk("live", new FakeSupply()).rebalance();
    assert.equal(r.ok, true);
  });
});
