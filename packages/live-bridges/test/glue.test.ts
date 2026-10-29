import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InFlightTransfer, RouteSpec } from "@incentive-router/core";
import type { AssetRef, BridgeAdapter, LiveContext, LiveResult } from "@incentive-router/live-common";
import type { LiveBridgeStatus } from "../src/common.js";
import { LiveBridgeExecutor, recipientsFromEnvs } from "../src/glue/index.js";
import { mockCtx } from "./mocks.js";

const USDC_ARB: AssetRef = { chain: "arbitrum", symbol: "USDC", address: "0x00000000000000000000000000000000000000a1", decimals: 6 };
const USDC_SUI: AssetRef = { chain: "sui", symbol: "USDC", address: "0x" + "cd".repeat(32) + "::usdc::USDC", decimals: 6 };
const ME_EVM = "0x1111111111111111111111111111111111111111";
const ME_SUI = "0x" + "ab".repeat(32);

class FakeAdapter implements BridgeAdapter {
  readonly kind = "cctp_v2_standard";
  sends: { from: AssetRef; to: AssetRef; amount: bigint; recipient: string; dryRun: boolean }[] = [];
  statuses: LiveBridgeStatus[] = [];
  completes = 0;
  completeResult: LiveResult = { ok: true, txs: [{ chain: "sui", id: "DIGEST", description: "receive", simulated: false }] };
  supports(from: AssetRef, to: AssetRef) {
    return from.chain !== to.chain;
  }
  async quote() {
    return { amountIn: 0n, minAmountOut: 0n, feeUsd: 0, gasSrcUsd: 0, gasDstUsd: 0, etaSeconds: 0 };
  }
  async send(from: AssetRef, to: AssetRef, amount: bigint, recipient: string, ctx: LiveContext) {
    this.sends.push({ from, to, amount, recipient, dryRun: ctx.dryRun });
    return ctx.dryRun ? { ok: true, txs: [], detail: "simulated" } : { ok: true, txs: [], handle: "cctp_v2_standard:arbitrum:sui:0xabc" };
  }
  async status() {
    return this.statuses.shift() ?? { state: "pending" as const };
  }
  async complete() {
    this.completes++;
    return this.completeResult;
  }
}

const ROUTE: RouteSpec = {
  id: "cctp-arb-sui",
  kind: "cctp_v2_standard",
  from: { chain: "arbitrum", asset: "USDC" },
  to: { chain: "sui", asset: "USDC" },
  feeBps: 0,
  feeFixedUsd: 0,
  gasSrcUsd: 0.05,
  gasDstUsd: 0.02,
  etaMinutes: 20,
  enabled: true,
};

function transfer(over: Partial<InFlightTransfer> = {}): InFlightTransfer {
  return { id: "t1", path: [ROUTE], hop: 0, amountUsd: 1000, costUsd: 0.1, state: "planned", createdAtMs: 0, updatedAtMs: 0, ...over };
}

const T0 = Date.UTC(2026, 9, 29, 12);

function make(ctx: LiveContext, opts: { balance?: bigint; clock?: { t: number } } = {}) {
  const fake = new FakeAdapter();
  const clock = opts.clock ?? { t: T0 };
  const ex = new LiveBridgeExecutor({
    adapters: [fake],
    registry: { arbitrum: { USDC: USDC_ARB }, sui: { USDC: USDC_SUI } },
    recipients: recipientsFromEnvs({ arbitrum: { account: ME_EVM } }, { address: ME_SUI }),
    ctx,
    balance: opts.balance === undefined ? undefined : async () => opts.balance!,
    now: () => clock.t,
  });
  return { fake, ex, clock };
}

describe("LiveBridgeExecutor.send", () => {
  it("converts USD to source units at ctx.priceUsd and sends to our own destination address", async () => {
    const { fake, ex } = make(mockCtx(false, 0.998));
    const r = await ex.send(transfer());
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.ref, "cctp_v2_standard:arbitrum:sui:0xabc");
    assert.equal(fake.sends[0]!.amount, 1_002_004_008n); // 1000 / 0.998 = 1002.004008 USDC
    assert.equal(fake.sends[0]!.recipient, ME_SUI);
    assert.equal(fake.sends[0]!.from, USDC_ARB);
    assert.equal(fake.sends[0]!.to, USDC_SUI);
  });

  it("uses t.receivedUsd (what arrived at the end of the previous hop) when set", async () => {
    const { fake, ex } = make(mockCtx(false, 1));
    const r = await ex.send(transfer({ hop: 1, path: [ROUTE, ROUTE], amountUsd: 1000, receivedUsd: 999.5 }));
    assert.equal(r.ok, true);
    assert.equal(fake.sends[0]!.amount, 999_500_000n);
    assert.match(r.detail!, /^sent 999\.500000 USD/);
  });

  it("hop > 0 clamps to the wallet balance and reports the sent USD", async () => {
    const { fake, ex } = make(mockCtx(false, 1), { balance: 998_000_000n });
    const r = await ex.send(transfer({ hop: 1, path: [ROUTE, ROUTE], receivedUsd: 999.5 }));
    assert.equal(r.ok, true);
    assert.equal(fake.sends[0]!.amount, 998_000_000n);
    assert.match(r.detail!, /^sent 998\.000000 USD .*clamped to balance/);
    const none = await make(mockCtx(false, 1), { balance: 0n }).ex.send(transfer({ hop: 1, path: [ROUTE, ROUTE] }));
    assert.equal(none.ok, false);
  });

  it("hop 0 clamps only within 0.5% of the request, otherwise fails before sending", async () => {
    const near = make(mockCtx(false, 1), { balance: 996_000_000n }); // -0.4%
    const r1 = await near.ex.send(transfer());
    assert.equal(r1.ok, true);
    assert.equal(near.fake.sends[0]!.amount, 996_000_000n);

    const far = make(mockCtx(false, 1), { balance: 990_000_000n }); // -1%
    const r2 = await far.ex.send(transfer());
    assert.equal(r2.ok, false);
    assert.match(r2.detail!, /insufficient/);
    assert.equal(far.fake.sends.length, 0);

    const plenty = make(mockCtx(false, 1), { balance: 5_000_000_000n });
    await plenty.ex.send(transfer());
    assert.equal(plenty.fake.sends[0]!.amount, 1_000_000_000n);
  });

  it("dry-run returns ok without a ref", async () => {
    const { ex } = make(mockCtx(true));
    const r = await ex.send(transfer());
    assert.equal(r.ok, true);
    assert.equal(r.ref, undefined);
    assert.match(r.detail!, /dry-run/);
  });

  it("refuses unknown kinds, unknown assets and disabled routes", async () => {
    const { ex } = make(mockCtx());
    assert.equal((await ex.send(transfer({ path: [{ ...ROUTE, kind: "wormhole" }] }))).ok, false);
    assert.equal((await ex.send(transfer({ path: [{ ...ROUTE, to: { chain: "sui", asset: "USDT" } }] }))).ok, false);
    assert.equal((await ex.send(transfer({ path: [{ ...ROUTE, enabled: false }] }))).ok, false);
    assert.equal((await ex.send(transfer({ hop: 3 }))).ok, false);
  });

  it("noop hops complete immediately", async () => {
    const { ex } = make(mockCtx());
    const t = transfer({ path: [{ ...ROUTE, kind: "noop" }] });
    const r = await ex.send(t);
    assert.deepEqual(r, { ok: true, ref: "noop" });
    assert.deepEqual(await ex.poll({ ...t, ref: "noop" }), { state: "completed", ref: "noop", receivedUsd: 1000 });
  });
});

describe("LiveBridgeExecutor.poll", () => {
  const sent = transfer({ state: "in_flight", ref: "cctp_v2_standard:arbitrum:sui:0xabc" });

  it("pending -> in_flight", async () => {
    const { fake, ex } = make(mockCtx());
    fake.statuses = [{ state: "pending" }];
    assert.deepEqual(await ex.poll(sent), { state: "in_flight", ref: sent.ref });
  });

  it("claimable -> complete() -> completed with receivedUsd from received units", async () => {
    const { fake, ex } = make(mockCtx(false, 0.999));
    fake.statuses = [{ state: "claimable" }, { state: "completed", dstTx: "DIGEST", received: 999_000_000n }];
    const r = await ex.poll(sent);
    assert.equal(fake.completes, 1);
    assert.equal(r.state, "completed");
    assert.ok(Math.abs(r.receivedUsd! - 998.001) < 1e-9);
  });

  it("claimable -> complete() sent but not yet visible -> in_flight", async () => {
    const { fake, ex } = make(mockCtx());
    fake.statuses = [{ state: "claimable" }, { state: "claimable" }];
    const r = await ex.poll(sent);
    assert.equal(r.state, "in_flight");
    assert.match(r.detail!, /DIGEST/);
  });

  it("claimable + failing complete() stays claimable; dry-run stays claimable", async () => {
    const a = make(mockCtx());
    a.fake.statuses = [{ state: "claimable" }];
    a.fake.completeResult = { ok: false, txs: [], detail: "simulation reverted" };
    assert.deepEqual(await a.ex.poll(sent), { state: "claimable", ref: sent.ref, detail: "simulation reverted" });

    const b = make(mockCtx(true));
    b.fake.statuses = [{ state: "claimable" }];
    const r = await b.ex.poll(sent);
    assert.equal(r.state, "claimable");
    assert.match(r.detail!, /dry-run/);
    assert.equal(b.fake.completes, 1);
  });

  it("failed -> failed; recoverable failures -> stuck", async () => {
    const { fake, ex } = make(mockCtx());
    fake.statuses = [{ state: "failed", detail: "LayerZero FAILED" }, { state: "failed", detail: "recoverable: PAYLOAD_STORED" }];
    assert.equal((await ex.poll(sent)).state, "failed");
    assert.equal((await ex.poll(sent)).state, "stuck");
  });

  it("completed without a received amount leaves receivedUsd undefined", async () => {
    const { fake, ex } = make(mockCtx());
    fake.statuses = [{ state: "completed" }];
    const r = await ex.poll(sent);
    assert.equal(r.state, "completed");
    assert.equal(r.receivedUsd, undefined);
  });

  it("no ref: dry-run keeps the state; live in-flight without a handle -> stuck", async () => {
    assert.equal((await make(mockCtx(true)).ex.poll(transfer({ state: "submitted" }))).state, "submitted");
    const live = await make(mockCtx(false)).ex.poll(transfer({ state: "submitted" }));
    assert.equal(live.state, "stuck");
    assert.match(live.detail!, /^recoverable:/);
  });

  it("failed with refunded units -> refundedUsd at the source price", async () => {
    const { fake, ex } = make(mockCtx(false, 0.999));
    fake.statuses = [{ state: "failed", detail: "source tx reverted", refunded: 1_000_000_000n }];
    const r = await ex.poll(sent);
    assert.equal(r.state, "failed");
    assert.ok(Math.abs(r.refundedUsd! - 999) < 1e-9);
  });

  it("unconfirmed pending -> in_flight within 2x ETA, stuck (recoverable) after", async () => {
    const { fake, ex, clock } = make(mockCtx());
    const t = { ...sent, hopStartedAtMs: T0 };
    fake.statuses = [{ state: "pending", unconfirmed: "LayerZero Scan unreachable" }];
    clock.t = T0 + 39 * 60_000; // ETA 20 min -> limit 40 min
    const a = await ex.poll(t);
    assert.equal(a.state, "in_flight");
    assert.equal(a.detail, "LayerZero Scan unreachable");
    fake.statuses = [{ state: "pending", unconfirmed: "LayerZero Scan unreachable" }];
    clock.t = T0 + 41 * 60_000;
    const b = await ex.poll(t);
    assert.equal(b.state, "stuck");
    assert.match(b.detail!, /^recoverable: no confirmed progress for 41 min/);
    // plain pending never escalates
    fake.statuses = [{ state: "pending" }];
    assert.equal((await ex.poll(t)).state, "in_flight");
  });
});
