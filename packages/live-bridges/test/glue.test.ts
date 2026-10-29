import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InFlightTransfer, RouteSpec } from "@incentive-router/core";
import type { AssetRef, BridgeAdapter, BridgeStatus, LiveContext, LiveResult } from "@incentive-router/live-common";
import { LiveBridgeExecutor, recipientsFromEnvs } from "../src/glue/index.js";
import { mockCtx } from "./mocks.js";

const USDC_ARB: AssetRef = { chain: "arbitrum", symbol: "USDC", address: "0x00000000000000000000000000000000000000a1", decimals: 6 };
const USDC_SUI: AssetRef = { chain: "sui", symbol: "USDC", address: "0x" + "cd".repeat(32) + "::usdc::USDC", decimals: 6 };
const ME_EVM = "0x1111111111111111111111111111111111111111";
const ME_SUI = "0x" + "ab".repeat(32);

class FakeAdapter implements BridgeAdapter {
  readonly kind = "cctp_v2_standard";
  sends: { from: AssetRef; to: AssetRef; amount: bigint; recipient: string; dryRun: boolean }[] = [];
  statuses: BridgeStatus[] = [];
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

function make(ctx: LiveContext) {
  const fake = new FakeAdapter();
  const ex = new LiveBridgeExecutor({
    adapters: [fake],
    registry: { arbitrum: { USDC: USDC_ARB }, sui: { USDC: USDC_SUI } },
    recipients: recipientsFromEnvs({ arbitrum: { account: ME_EVM } }, { address: ME_SUI }),
    ctx,
  });
  return { fake, ex };
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

  it("no ref keeps the current state", async () => {
    const { ex } = make(mockCtx());
    const r = await ex.poll(transfer({ state: "submitted" }));
    assert.equal(r.state, "submitted");
  });
});
