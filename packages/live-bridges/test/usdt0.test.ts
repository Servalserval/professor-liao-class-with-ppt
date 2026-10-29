import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetRef } from "@incentive-router/live-common";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, pad, type Hex } from "viem";
import { evmAddressToBytes32 } from "../src/common.js";
import {
  USDT0_DEPLOYMENTS,
  Usdt0OftAdapter,
  buildSendParam,
  encodeOftSend,
  mapScanStatus,
  oftAbi,
  parseScanMessages,
  removeDust,
  verifyUsdt0,
} from "../src/usdt0/index.js";
import { mockCtx, mockEvm, mockFetch } from "./mocks.js";

const ME: Hex = "0x1111111111111111111111111111111111111111";
const D = USDT0_DEPLOYMENTS;
// Ethereum USDT is not in the docs table; test-only address.
const USDT_ETH: AssetRef = { chain: "ethereum", symbol: "USDT", address: "0x00000000000000000000000000000000000000e7", decimals: 6 };
const USDT0_ARB: AssetRef = { chain: "arbitrum", symbol: "USDT0", address: D.arbitrum!.token!, decimals: 6 };
const USDT0_PLASMA: AssetRef = { chain: "plasma", symbol: "USDT0", address: D.plasma!.token!, decimals: 6 };

const NATIVE_FEE = 100_000_000_000_000n; // 0.0001 ETH

function setup() {
  const eth = mockEvm("ethereum", ME);
  const arb = mockEvm("arbitrum", ME);
  const plasma = mockEvm("plasma", ME);
  for (const [m, tok] of [
    [eth, USDT_ETH.address],
    [arb, USDT0_ARB.address],
    [plasma, USDT0_PLASMA.address],
  ] as const) {
    m.setRead("balanceOf", () => 10n ** 12n);
    m.setRead("allowance", () => 0n);
    m.setRead("token", () => getAddress(tok));
    m.setRead("quoteOFT", (args) => {
      const p = args[0] as { amountLD: bigint };
      return [{ minAmountLD: 1n, maxAmountLD: 10n ** 15n }, [], { amountSentLD: p.amountLD, amountReceivedLD: p.amountLD }];
    });
    m.setRead("quoteSend", () => ({ nativeFee: NATIVE_FEE, lzTokenFee: 0n }));
  }
  const f = mockFetch();
  const adapter = new Usdt0OftAdapter({
    envs: { ethereum: eth.env, arbitrum: arb.env, plasma: plasma.env },
    tokens: { ethereum: USDT_ETH },
    fetch: f.fetch,
  });
  return { eth, arb, plasma, f, adapter };
}

describe("usdt0 encoding", () => {
  it("SendParam / send() round-trips through the ABI", () => {
    const p = buildSendParam({ dstEid: 30110, to: ME, amountLD: 123_456_789n, minAmountLD: 123_456_000n });
    assert.equal(p.to, evmAddressToBytes32(ME));
    const fee = { nativeFee: 42n, lzTokenFee: 0n };
    const data = encodeOftSend(p, fee, ME);
    const d = decodeFunctionData({ abi: oftAbi, data });
    assert.equal(d.functionName, "send");
    assert.deepEqual(d.args, [p, fee, getAddress(ME)]);
  });

  it("removeDust floors to the shared-decimals grid", () => {
    assert.equal(removeDust(1_234_567_891_234_567_891n, 18, 6), 1_234_567_000_000_000_000n);
    assert.equal(removeDust(1_234_567n, 6, 6), 1_234_567n);
    assert.throws(() => removeDust(1n, 6, 8));
  });

  it("deployment table: eids match LayerZero V2 mainnet ids", () => {
    assert.equal(D.ethereum!.eid, 30101);
    assert.equal(D.arbitrum!.eid, 30110);
    assert.equal(D.optimism!.eid, 30111);
    assert.equal(D.plasma!.eid, 30383);
    assert.equal(D.hyperevm!.eid, 30367);
    assert.equal(D.ethereum!.adapter, true);
    assert.ok(Object.entries(D).every(([c, d]) => c === "ethereum" || !d.adapter));
    assert.equal(D.base, undefined);
    assert.equal(D.sui, undefined);
  });
});

describe("Usdt0OftAdapter", () => {
  it("supports(): only deployed chains and matching tokens", () => {
    const { adapter } = setup();
    assert.equal(adapter.kind, "usdt0_oft");
    assert.equal(adapter.supports(USDT_ETH, USDT0_ARB), true);
    assert.equal(adapter.supports(USDT0_ARB, USDT0_PLASMA), true);
    assert.equal(adapter.supports(USDT0_ARB, { ...USDT0_PLASMA, address: "0x00000000000000000000000000000000000000ff" }), false);
    assert.equal(adapter.supports(USDT0_ARB, { ...USDT0_PLASMA, chain: "base" }), false);
    assert.equal(adapter.supports(USDT0_ARB, { ...USDT0_PLASMA, symbol: "USDC" }), false);
  });

  it("quote(): minAmountOut from quoteOFT, fee = LayerZero native fee in USD", async () => {
    const { adapter, arb } = setup();
    const q = await adapter.quote(USDT0_ARB, USDT0_PLASMA, 1_000_000_000n, mockCtx());
    assert.equal(q.minAmountOut, 1_000_000_000n);
    assert.ok(Math.abs(q.feeUsd - 0.3) < 1e-9); // 1e-4 ETH * $3000
    assert.equal(q.gasDstUsd, 0);
    const qs = arb.reads.find((r) => r.functionName === "quoteSend")!;
    const p = qs.args[0] as { dstEid: number; to: Hex; minAmountLD: bigint };
    assert.equal(p.dstEid, 30383);
    assert.equal(p.to, evmAddressToBytes32(ME));
    assert.equal(p.minAmountLD, 1_000_000_000n);
    assert.equal(qs.args[1], false);
  });

  it("quote(): falls back to dust removal when quoteOFT is unavailable", async () => {
    const { adapter, arb } = setup();
    arb.setRead("quoteOFT", () => {
      throw new Error("no quoteOFT");
    });
    arb.setRead("sharedDecimals", () => 6);
    const q = await adapter.quote(USDT0_ARB, USDT0_PLASMA, 7_654_321n, mockCtx());
    assert.equal(q.minAmountOut, 7_654_321n);
  });

  it("quote(): rejects amounts outside the OFT limits", async () => {
    const { adapter, arb } = setup();
    arb.setRead("quoteOFT", () => [{ minAmountLD: 1n, maxAmountLD: 10n }, [], { amountSentLD: 0n, amountReceivedLD: 0n }]);
    await assert.rejects(adapter.quote(USDT0_ARB, USDT0_PLASMA, 1_000n, mockCtx()), /outside OFT limits/);
  });

  it("send() from Ethereum: reset + exact approve to the OFT adapter, then send with value = fee", async () => {
    const { adapter, eth, arb } = setup();
    eth.setRead("allowance", () => 5n); // non-zero -> USDT needs reset to 0 first
    const guid = pad("0xbeef");
    const sendTxHash = "0x" + "3".padStart(64, "0"); // third tx from the mock wallet
    eth.receipts[sendTxHash] = {
      logs: [
        {
          address: D.ethereum!.oft,
          topics: encodeEventTopics({ abi: oftAbi, eventName: "OFTSent", args: { guid, fromAddress: ME } }),
          data: encodeAbiParameters([{ type: "uint32" }, { type: "uint256" }, { type: "uint256" }], [30110, 2_000_000n, 2_000_000n]),
          blockNumber: 1n,
          transactionHash: sendTxHash,
          logIndex: 0,
          blockHash: pad("0x01"),
          transactionIndex: 0,
          removed: false,
        },
      ],
    };
    arb.blockNumber = 777n;
    const res = await adapter.send(USDT_ETH, USDT0_ARB, 2_000_000n, ME, mockCtx(false));
    assert.equal(res.ok, true, res.detail);
    assert.equal(eth.sent.length, 3);
    const a0 = decodeFunctionData({ abi: erc20Abi, data: eth.sent[0]!.data });
    const a1 = decodeFunctionData({ abi: erc20Abi, data: eth.sent[1]!.data });
    assert.deepEqual(a0.args, [D.ethereum!.oft, 0n]);
    assert.deepEqual(a1.args, [D.ethereum!.oft, 2_000_000n]);
    const s = eth.sent[2]!;
    assert.equal(s.to, D.ethereum!.oft);
    assert.equal(s.value, 110_000_000_000_000n); // quoted fee + 10% (excess refunded)
    const d = decodeFunctionData({ abi: oftAbi, data: s.data });
    if (d.functionName !== "send") assert.fail(`decoded ${d.functionName}`);
    const [p, fee, refund] = d.args;
    assert.equal(p.dstEid, 30110);
    assert.equal(p.amountLD, 2_000_000n);
    assert.equal(p.minAmountLD, 2_000_000n);
    assert.equal(p.extraOptions, "0x");
    assert.equal(fee.nativeFee, s.value);
    assert.equal(refund, getAddress(ME));
    assert.equal(res.handle, `usdt0_oft:ethereum:arbitrum:${sendTxHash}:${guid}:777:2000000`);
  });

  it("send(): dry-run with a missing approval simulates the approve only", async () => {
    const { adapter, eth } = setup();
    const res = await adapter.send(USDT_ETH, USDT0_ARB, 2_000_000n, ME, mockCtx(true));
    assert.equal(res.ok, true);
    assert.equal(res.handle, undefined);
    assert.equal(eth.sent.length, 0);
    assert.match(res.detail!, /approve simulated/);
  });

  it("send(): non-adapter chains need no approval; refuses if OFT token mismatches", async () => {
    const { adapter, arb } = setup();
    const dry = await adapter.send(USDT0_ARB, USDT0_PLASMA, 1_000_000n, ME, mockCtx(true));
    assert.equal(dry.ok, true, dry.detail);
    assert.equal(arb.reads.filter((r) => r.functionName === "allowance").length, 0);
    assert.equal(dry.txs.length, 1);

    const { adapter: a2, plasma } = setup();
    plasma.setRead("token", () => "0x00000000000000000000000000000000000000Ff");
    const bad = await a2.send(USDT0_ARB, USDT0_PLASMA, 1_000_000n, ME, mockCtx(true));
    assert.equal(bad.ok, false);
    assert.match(bad.detail!, /OFT token/);
  });

  it("status(): destination OFTReceived(guid) log -> completed with received amount", async () => {
    const { adapter, arb } = setup();
    const guid = pad("0xbeef");
    arb.logs = [{ args: { guid, srcEid: 30101, toAddress: ME, amountReceivedLD: 1_999_999n }, transactionHash: pad("0xd5") }];
    const st = await adapter.status(`usdt0_oft:ethereum:arbitrum:${pad("0x01")}:${guid}:777:2000000`, mockCtx());
    assert.deepEqual(st, { state: "completed", dstTx: pad("0xd5"), received: 1_999_999n });
  });

  it("status(): falls back to LayerZero Scan for delivered / failed / recoverable / unknown", async () => {
    const { adapter, f } = setup();
    const guid = pad("0xbeef");
    const h = `usdt0_oft:ethereum:arbitrum:${pad("0x01")}:${guid}:777:2000000`;
    const ctx = mockCtx();
    assert.deepEqual(await adapter.status(h, ctx), { state: "pending" }); // scan 404

    const scanWith = (name: string) =>
      f.route("/messages/tx/", () => ({ status: 200, body: { data: [{ guid, status: { name }, destination: { tx: { txHash: pad("0xee") } } }] } }));
    scanWith("INFLIGHT");
    assert.deepEqual(await adapter.status(h, ctx), { state: "pending" });
    scanWith("DELIVERED");
    assert.deepEqual(await adapter.status(h, ctx), { state: "completed", dstTx: pad("0xee"), received: 2_000_000n });
    scanWith("FAILED");
    assert.equal((await adapter.status(h, ctx)).state, "failed");
    scanWith("PAYLOAD_STORED");
    const rec = await adapter.status(h, ctx);
    assert.equal(rec.state, "failed");
    assert.match((rec as { detail: string }).detail, /^recoverable:/);
    f.route("/messages/tx/", () => ({ status: 500, body: "boom" }));
    assert.deepEqual(await adapter.status(h, ctx), { state: "pending" });
  });

  it("scan parsing is defensive", () => {
    assert.equal(mapScanStatus("delivered"), "delivered");
    assert.equal(mapScanStatus("SOMETHING_NEW"), "unknown");
    assert.equal(mapScanStatus(undefined), "unknown");
    assert.deepEqual(parseScanMessages({ nope: 1 }), []);
    assert.equal(parseScanMessages({ data: [{ status: "BLOCKED" }] })[0]!.state, "recoverable");
  });
});

describe("verifyUsdt0", () => {
  it("passes when on-chain reads match the table, flags mismatches", async () => {
    const { arb, plasma } = setup();
    for (const [m, chain] of [
      [arb, "arbitrum"],
      [plasma, "plasma"],
    ] as const) {
      m.setRead("decimals", () => 6);
      m.setRead("symbol", () => "USD₮0");
      m.setRead("approvalRequired", () => false);
      m.setRead("endpoint", () => "0x000000000000000000000000000000000000E9D0");
      m.setRead("eid", () => D[chain]!.eid);
      m.setRead("peers", (args) => {
        const eid = args[0] as number;
        const peer = Object.values(D).find((d) => d.eid === eid)!;
        return evmAddressToBytes32(peer.oft);
      });
      m.setRead("enforcedOptions", () => "0x000301001101000000000000000000000000000ea60");
    }
    assert.deepEqual(await verifyUsdt0({ envs: { arbitrum: arb.env, plasma: plasma.env } }), []);
    plasma.setRead("eid", () => 30999);
    arb.setRead("peers", () => pad("0x00"));
    const issues = await verifyUsdt0({ envs: { arbitrum: arb.env, plasma: plasma.env } });
    assert.ok(issues.some((i) => i.includes("endpoint.eid() = 30999")));
    assert.ok(issues.some((i) => i.includes("peers(30383 plasma)")));
  });
});
