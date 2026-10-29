import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetRef } from "@incentive-router/live-common";
import { decodeFunctionData, encodePacked, getAddress, pad, toFunctionSelector, zeroHash, type Hex } from "viem";
import {
  CCTP_DOMAINS,
  CCTP_V2_EVM_MAINNET,
  CctpV2Adapter,
  SUI_CCTP_V2_MAINNET,
  buildSuiBurnPtb,
  buildSuiReceivePtb,
  cctpMaxFee,
  decodeCctpMessage,
  messageTransmitterV2Abi,
  suiNonceUsed,
  tokenMessengerV2Abi,
  verifyCctp,
  CCTP_FAST_SOURCES,
} from "../src/cctp/index.js";
import { bytes32ToEvmAddress, evmAddressToBytes32, suiAddressToBytes32 } from "../src/common.js";
import { staticBridgeChecks } from "../src/glue/index.js";
import { mockCtx, mockEvm, mockFetch, mockSui } from "./mocks.js";

const ME: Hex = "0x1111111111111111111111111111111111111111";
const SUI_ME = "0x" + "ab".repeat(32);
// Test-only token addresses (not real deployments).
const USDC_ARB: AssetRef = { chain: "arbitrum", symbol: "USDC", address: "0x00000000000000000000000000000000000000a1", decimals: 6 };
const USDC_BASE: AssetRef = { chain: "base", symbol: "USDC", address: "0x00000000000000000000000000000000000000b1", decimals: 6 };
const USDC_SUI: AssetRef = { chain: "sui", symbol: "USDC", address: "0x" + "cd".repeat(32) + "::usdc::USDC", decimals: 6 };

/** Packed CCTP V2 message (MessageV2 header + BurnMessageV2 body). */
function makeMessage(a: { src: number; dst: number; nonce: Hex; mintRecipient: Hex; amount: bigint; maxFee: bigint; feeExecuted: bigint }): Hex {
  return encodePacked(
    ["uint32", "uint32", "uint32", "bytes32", "bytes32", "bytes32", "bytes32", "uint32", "uint32"],
    [1, a.src, a.dst, a.nonce, pad("0x01"), pad("0x02"), zeroHash, 1000, 1000]
  ).concat(
    encodePacked(
      ["uint32", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256"],
      [1, pad(USDC_ARB.address as Hex), a.mintRecipient, a.amount, pad(ME), a.maxFee, a.feeExecuted, 0n]
    ).slice(2)
  ) as Hex;
}

function setup(mode: "fast" | "standard", feeBps = { fast: 1.4, std: 0 }, clock = { t: Date.UTC(2026, 9, 29) }) {
  const arb = mockEvm("arbitrum", ME);
  const base = mockEvm("base", ME);
  const sui = mockSui(SUI_ME);
  const f = mockFetch();
  f.route("/v2/burn/USDC/fees/", () => ({ status: 200, body: [{ finalityThreshold: 1000, minimumFee: feeBps.fast }, { finalityThreshold: 2000, minimumFee: feeBps.std }] }));
  f.route("/v2/fastBurn/USDC/allowance", () => ({ status: 200, body: { allowance: 5_000_000.5, lastUpdated: "2026-10-29T00:00:00Z" } }));
  for (const m of [arb, base]) {
    m.setRead("balanceOf", () => 10_000_000_000n);
    m.setRead("allowance", () => 0n);
    m.setRead("getMinFeeAmount", () => {
      throw new Error("not supported");
    });
    m.setRead("usedNonces", () => 0n);
  }
  const adapter = new CctpV2Adapter({
    mode,
    envs: { arbitrum: arb.env, base: base.env },
    usdc: { arbitrum: USDC_ARB, base: USDC_BASE, sui: USDC_SUI },
    sui: { env: sui.env },
    fetch: f.fetch,
    now: () => clock.t,
  });
  return { arb, base, sui, f, adapter, clock };
}

describe("cctp constants", () => {
  it("static tables pass checksum / uniqueness checks", () => {
    assert.deepEqual(staticBridgeChecks(), []);
  });
  it("domain table matches Circle docs and excludes bsc", () => {
    assert.equal(CCTP_DOMAINS.ethereum, 0);
    assert.equal(CCTP_DOMAINS.arbitrum, 3);
    assert.equal(CCTP_DOMAINS.base, 6);
    assert.equal(CCTP_DOMAINS.sui, 8);
    assert.equal(CCTP_DOMAINS.plasma, 33);
    assert.equal(CCTP_DOMAINS.monad, 15);
    assert.equal(CCTP_DOMAINS.xlayer, 37);
    assert.equal(CCTP_FAST_SOURCES.has("monad"), false); // Fast Transfer N/A as a source
    assert.equal(CCTP_FAST_SOURCES.has("xlayer"), true);
    assert.equal(CCTP_DOMAINS.bsc, undefined);
  });
});

describe("bytes32 padding", () => {
  it("left-pads EVM addresses and round-trips", () => {
    const b = evmAddressToBytes32("0xAbCdEf0123456789aBcDeF0123456789AbCdEf01");
    assert.equal(b, "0x000000000000000000000000abcdef0123456789abcdef0123456789abcdef01");
    assert.equal(bytes32ToEvmAddress(b), "0xabcdef0123456789abcdef0123456789abcdef01");
    assert.equal(bytes32ToEvmAddress(("0x" + "ff".repeat(32)) as Hex), undefined);
    assert.throws(() => evmAddressToBytes32("0x1234"));
  });
  it("normalizes Sui addresses to 32 bytes", () => {
    assert.equal(suiAddressToBytes32("0x6"), "0x" + "0".repeat(63) + "6");
    assert.equal(suiAddressToBytes32(SUI_ME.toUpperCase().replace("0X", "0x")), SUI_ME);
    assert.throws(() => suiAddressToBytes32("0xzz"));
  });
});

describe("cctp fee math", () => {
  it("applies fractional bps and margin with ceil", () => {
    // 1000 USDC * 1.3 bps * 1.2 = 0.156 USDC
    assert.equal(cctpMaxFee(1_000_000_000n, 1.3, 2000), 156_000n);
    assert.equal(cctpMaxFee(1_000_000_000n, 1.3, 0), 130_000n);
    assert.equal(cctpMaxFee(1_000_000_000n, 1, 1000), 110_000n);
    assert.equal(cctpMaxFee(1_000_001n, 1, 0), 101n); // 100.0001 -> 101
  });
  it("is 0 for free standard transfers and >= 1 unit otherwise", () => {
    assert.equal(cctpMaxFee(1_000_000_000n, 0, 2000), 0n);
    assert.equal(cctpMaxFee(10n, 1, 0), 1n);
    assert.throws(() => cctpMaxFee(1n, -1, 0));
  });
});

describe("cctp message decoding", () => {
  it("reads header + burn body fields", () => {
    const nonce = pad("0x2a");
    const msg = makeMessage({ src: 3, dst: 6, nonce, mintRecipient: evmAddressToBytes32(ME), amount: 1_000_000n, maxFee: 200n, feeExecuted: 140n });
    const d = decodeCctpMessage(msg);
    assert.equal(d.sourceDomain, 3);
    assert.equal(d.destinationDomain, 6);
    assert.equal(d.nonce, nonce);
    assert.equal(d.minFinalityThreshold, 1000);
    assert.equal(d.body?.amount, 1_000_000n);
    assert.equal(d.body?.maxFee, 200n);
    assert.equal(d.body?.feeExecuted, 140n);
    assert.equal(d.body?.mintRecipient, evmAddressToBytes32(ME));
  });
});

describe("CctpV2Adapter", () => {
  it("supports(): fast only from fast-capable sources, USDC only, never bsc", () => {
    const fast = setup("fast").adapter;
    const std = setup("standard").adapter;
    assert.equal(fast.kind, "cctp_v2_fast");
    assert.equal(std.kind, "cctp_v2_standard");
    assert.equal(fast.supports(USDC_ARB, USDC_BASE), true);
    assert.equal(fast.supports(USDC_SUI, USDC_ARB), false); // Sui: standard is already fast
    assert.equal(std.supports(USDC_SUI, USDC_ARB), true);
    assert.equal(std.supports(USDC_ARB, { ...USDC_BASE, address: "0x00000000000000000000000000000000000000ff" }), false);
    assert.equal(std.supports(USDC_ARB, { ...USDC_BASE, chain: "bsc" }), false);
    assert.equal(std.supports(USDC_ARB, USDC_ARB), false);
  });

  it("quote(): maxFee from Iris + 20% margin; fee USD from the unmargined fee", async () => {
    const { adapter, f } = setup("fast");
    const q = await adapter.quote(USDC_ARB, USDC_BASE, 1_000_000_000n, mockCtx());
    // 1.4 bps * 1.2 = 1.68 bps of 1000 USDC = 168000 units
    assert.equal(q.minAmountOut, 1_000_000_000n - 168_000n);
    assert.ok(Math.abs(q.feeUsd - 0.14) < 1e-9);
    assert.ok(q.gasSrcUsd > 0 && q.gasDstUsd > 0);
    assert.ok(f.urls.some((u) => u.endsWith("/v2/burn/USDC/fees/3/6")));
  });

  it("quote(): fast refuses when the Fast Transfer allowance is too small", async () => {
    const { adapter, f } = setup("fast");
    f.route("/v2/fastBurn/USDC/allowance", () => ({ status: 200, body: { allowance: 10, lastUpdated: "x" } }));
    await assert.rejects(adapter.quote(USDC_ARB, USDC_BASE, 100_000_000n, mockCtx()), /allowance/);
  });

  it("send(): approve exact then depositForBurn with the right encoding", async () => {
    const { adapter, arb } = setup("fast");
    const res = await adapter.send(USDC_ARB, USDC_BASE, 1_000_000_000n, ME, mockCtx(false));
    assert.equal(res.ok, true, res.detail);
    assert.equal(arb.sent.length, 2); // approve + depositForBurn
    const dep = arb.sent[1]!;
    assert.equal(dep.to, CCTP_V2_EVM_MAINNET.tokenMessengerV2);
    const d = decodeFunctionData({ abi: tokenMessengerV2Abi, data: dep.data });
    assert.equal(d.functionName, "depositForBurn");
    assert.deepEqual(d.args, [1_000_000_000n, 6, evmAddressToBytes32(ME), getAddress(USDC_ARB.address), zeroHash, 168_000n, 1000]);
    assert.match(res.handle!, /^cctp_v2_fast:arbitrum:base:0x[0-9a-f]{64}:1000000000$/);
  });

  it("send(): standard uses threshold 2000 and maxFee 0", async () => {
    const { adapter, arb } = setup("standard");
    arb.setRead("allowance", () => 10_000_000_000n);
    const res = await adapter.send(USDC_ARB, USDC_BASE, 5_000_000n, ME, mockCtx(false));
    assert.equal(res.ok, true, res.detail);
    const d = decodeFunctionData({ abi: tokenMessengerV2Abi, data: arb.sent[0]!.data });
    assert.equal(d.args[5], 0n);
    assert.equal(d.args[6], 2000);
  });

  it("send(): refuses foreign recipients; dry-run never broadcasts", async () => {
    const { adapter, arb } = setup("standard");
    const bad = await adapter.send(USDC_ARB, USDC_BASE, 5_000_000n, "0x2222222222222222222222222222222222222222", mockCtx(false));
    assert.equal(bad.ok, false);
    assert.match(bad.detail!, /not our base address/);
    const dry = await adapter.send(USDC_ARB, USDC_BASE, 5_000_000n, ME, mockCtx(true));
    assert.equal(dry.ok, true);
    assert.equal(dry.handle, undefined);
    assert.equal(arb.sent.length, 0);
    assert.ok(dry.txs.every((t) => t.simulated));
  });

  it("status(): 404 -> pending, unattested -> pending, attested -> claimable, nonce used -> completed", async () => {
    const { adapter, f, base } = setup("fast");
    const ctx = mockCtx();
    const h = "cctp_v2_fast:arbitrum:base:0x" + "12".repeat(32);
    const first = await adapter.status(h, ctx);
    assert.equal(first.state, "pending");
    assert.match((first as { unconfirmed?: string }).unconfirmed!, /not found/); // Iris 404 + no receipt -> unconfirmed

    f.route("/v2/messages/3", () => ({ status: 200, body: { messages: [{ message: "0x", attestation: "PENDING", status: "pending_confirmations" }] } }));
    assert.deepEqual(await adapter.status(h, ctx), { state: "pending" });

    const nonce = pad("0x99");
    const msg = makeMessage({ src: 3, dst: 6, nonce, mintRecipient: evmAddressToBytes32(ME), amount: 1_000_000_000n, maxFee: 168_000n, feeExecuted: 140_000n });
    f.route("/v2/messages/3", (url) => {
      assert.ok(url.includes("transactionHash=0x" + "12".repeat(32)));
      return { status: 200, body: { messages: [{ message: msg, attestation: "0xdeadbeef", status: "complete", decodedMessage: { destinationDomain: "6" } }] } };
    });
    const claim = await adapter.status(h, ctx);
    assert.equal(claim.state, "claimable");

    base.setRead("usedNonces", (args) => (args[0] === nonce ? 1n : 0n));
    assert.deepEqual(await adapter.status(h, ctx), { state: "completed", dstTx: undefined, received: 1_000_000_000n - 140_000n });
  });

  it("complete(): simulates then calls receiveMessage(message, attestation) on the destination", async () => {
    const { adapter, f, base } = setup("fast");
    const msg = makeMessage({ src: 3, dst: 6, nonce: pad("0x07"), mintRecipient: evmAddressToBytes32(ME), amount: 10n ** 9n, maxFee: 1n, feeExecuted: 1n });
    f.route("/v2/messages/3", () => ({ status: 200, body: { messages: [{ message: msg, attestation: "0xabcd", status: "complete" }] } }));
    const h = "cctp_v2_fast:arbitrum:base:0x" + "34".repeat(32);

    const dry = await adapter.complete(h, mockCtx(true));
    assert.equal(dry.ok, true);
    assert.equal(base.sent.length, 0);
    assert.equal(base.calls.length, 1); // simulated

    const live = await adapter.complete(h, mockCtx(false));
    assert.equal(live.ok, true, live.detail);
    assert.equal(base.sent.length, 1);
    assert.equal(base.sent[0]!.to, CCTP_V2_EVM_MAINNET.messageTransmitterV2);
    const d = decodeFunctionData({ abi: messageTransmitterV2Abi, data: base.sent[0]!.data });
    assert.equal(d.functionName, "receiveMessage");
    assert.deepEqual(d.args, [msg, "0xabcd"]);
  });

  it("complete(): a reverting simulation is reported, not broadcast", async () => {
    const { adapter, f, base } = setup("standard");
    const msg = makeMessage({ src: 3, dst: 6, nonce: pad("0x08"), mintRecipient: evmAddressToBytes32(ME), amount: 10n ** 9n, maxFee: 0n, feeExecuted: 0n });
    f.route("/v2/messages/3", () => ({ status: 200, body: { messages: [{ message: msg, attestation: "0xabcd", status: "complete" }] } }));
    base.revertSelector = toFunctionSelector("receiveMessage(bytes,bytes)");
    const r = await adapter.complete("cctp_v2_standard:arbitrum:base:0x" + "56".repeat(32), mockCtx(false));
    assert.equal(r.ok, false);
    assert.match(r.detail!, /simulation reverted/);
    assert.equal(base.sent.length, 0);
  });
});

describe("CCTP on Sui", () => {
  it("burn PTB: deposit_for_burn -> handler::burn -> complete_burn with the right types", () => {
    const tx = buildSuiBurnPtb(SUI_CCTP_V2_MAINNET, {
      usdcType: USDC_SUI.address,
      amount: 5_000_000n,
      destinationDomain: 3,
      mintRecipient32: evmAddressToBytes32(ME),
      maxFee: 0n,
      minFinalityThreshold: 2000,
    });
    const calls = tx.getData().commands.filter((c) => c.$kind === "MoveCall").map((c) => c.MoveCall!);
    assert.deepEqual(
      calls.map((c) => `${c.package}::${c.module}::${c.function}`),
      [
        `${SUI_CCTP_V2_MAINNET.tokenMessengerMinterPackage}::deposit_for_burn::deposit_for_burn`,
        `${SUI_CCTP_V2_MAINNET.stablecoinHandlerPackage}::handler::burn`,
        `${SUI_CCTP_V2_MAINNET.tokenMessengerMinterPackage}::deposit_for_burn::complete_burn`,
      ]
    );
    assert.deepEqual(calls[0]!.typeArguments, [USDC_SUI.address]);
    assert.deepEqual(calls[2]!.typeArguments, [USDC_SUI.address, `${SUI_CCTP_V2_MAINNET.stablecoinHandlerPackage}::handler::Auth`]);
    assert.equal(calls[0]!.arguments.length, 8);
    assert.equal(calls[1]!.arguments.length, 5);
  });

  it("receive PTB: receive_message -> prepare_mint -> handler::mint -> complete_mint", () => {
    const tx = buildSuiReceivePtb(SUI_CCTP_V2_MAINNET, USDC_SUI.address, "0x0102", "0x0304");
    const calls = tx.getData().commands.filter((c) => c.$kind === "MoveCall").map((c) => `${c.MoveCall!.module}::${c.MoveCall!.function}`);
    assert.deepEqual(calls, [
      "receive_message::receive_message",
      "handle_receive_message::prepare_mint",
      "handler::mint",
      "handle_receive_message::complete_mint",
    ]);
  });

  it("sui -> arbitrum send (standard) executes the burn PTB and queries Iris by base58 digest", async () => {
    const { adapter, sui, f } = setup("standard");
    sui.balance = 10_000_000n;
    const res = await adapter.send(USDC_SUI, USDC_ARB, 5_000_000n, ME, mockCtx(false));
    assert.equal(res.ok, true, res.detail);
    assert.equal(sui.executed.length, 1);
    assert.equal(res.handle, `cctp_v2_standard:sui:arbitrum:${sui.digest}:5000000`);
    assert.ok(f.urls.some((u) => u.endsWith("/v2/burn/USDC/fees/8/3")));
    await adapter.status(res.handle!, mockCtx());
    assert.ok(f.urls.some((u) => u.includes(`/v2/messages/8?transactionHash=${sui.digest}`)));
  });

  it("sui nonce check reads the bool return value", async () => {
    const { sui } = setup("standard");
    assert.equal(await suiNonceUsed(sui.env, SUI_CCTP_V2_MAINNET, pad("0x01")), false);
    sui.nonceUsed = true;
    assert.equal(await suiNonceUsed(sui.env, SUI_CCTP_V2_MAINNET, pad("0x01")), true);
  });

  it("arbitrum -> sui complete() runs the receive PTB (dry-run: simulate only)", async () => {
    const { adapter, sui, f } = setup("standard");
    const msg = makeMessage({ src: 3, dst: 8, nonce: pad("0x0a"), mintRecipient: suiAddressToBytes32(SUI_ME), amount: 10n ** 7n, maxFee: 0n, feeExecuted: 0n });
    f.route("/v2/messages/3", () => ({ status: 200, body: { messages: [{ message: msg, attestation: "0xabcd", status: "complete" }] } }));
    const r = await adapter.complete("cctp_v2_standard:arbitrum:sui:0x" + "78".repeat(32), mockCtx(true));
    assert.equal(r.ok, true, r.detail);
    assert.equal(sui.executed.length, 0);
    assert.equal(sui.simulated.length, 2); // nonce check + receive PTB
  });

  it("evm -> sui send pads the Sui recipient to bytes32", async () => {
    const { adapter, arb } = setup("standard");
    arb.setRead("allowance", () => 10n ** 12n);
    const res = await adapter.send(USDC_ARB, USDC_SUI, 1_000_000n, SUI_ME, mockCtx(false));
    assert.equal(res.ok, true, res.detail);
    const d = decodeFunctionData({ abi: tokenMessengerV2Abi, data: arb.sent[0]!.data });
    assert.equal(d.args[1], 8);
    assert.equal(d.args[2], SUI_ME);
  });
});

describe("verifyCctp", () => {
  it("passes on consistent reads and flags domain / token / Sui type mismatches", async () => {
    const { arb, base, sui } = setup("standard");
    const usdcBy: Record<string, AssetRef> = { arbitrum: USDC_ARB, base: USDC_BASE };
    for (const [m, ch] of [
      [arb, "arbitrum"],
      [base, "base"],
    ] as const) {
      m.setRead("localDomain", () => CCTP_DOMAINS[ch]);
      m.setRead("localMessageTransmitter", () => CCTP_V2_EVM_MAINNET.messageTransmitterV2);
      m.setRead("localMinter", () => CCTP_V2_EVM_MAINNET.tokenMinterV2);
      m.setRead("burnLimitsPerMessage", () => 10n ** 12n);
      m.setRead("remoteTokenMessengers", () => evmAddressToBytes32(CCTP_V2_EVM_MAINNET.tokenMessengerV2));
      m.setRead("getLocalToken", () => usdcBy[ch]!.address);
      m.setRead("decimals", () => 6);
      m.setRead("symbol", () => "USDC");
    }
    const C = SUI_CCTP_V2_MAINNET;
    const usdcT = USDC_SUI.address;
    sui.objectTypes = {
      [C.messageTransmitterPackage]: "package",
      [C.tokenMessengerMinterPackage]: "package",
      [C.stablecoinHandlerPackage]: "package",
      [C.messageTransmitterState]: `${C.messageTransmitterPackage}::state::State`,
      [C.tokenMessengerMinterState]: `${C.tokenMessengerMinterPackage}::state::State`,
      [C.stablecoinHandlerState]: `${C.stablecoinHandlerPackage}::state::State`,
      [C.usdcTreasury]: `0x0000000000000000000000000000000000000000000000000000000000000abc::treasury::Treasury<${usdcT}>`,
    };
    const args = { envs: { arbitrum: arb.env, base: base.env }, usdc: { arbitrum: USDC_ARB, base: USDC_BASE, sui: USDC_SUI }, sui: { env: sui.env } };
    assert.deepEqual(await verifyCctp(args), []);

    base.setRead("localDomain", () => 99);
    arb.setRead("getLocalToken", () => "0x0000000000000000000000000000000000000Bad");
    sui.objectTypes[C.usdcTreasury] = "0xabc::treasury::Treasury<0xdef::usdc::USDC>";
    const issues = await verifyCctp(args);
    assert.ok(issues.some((i) => i.includes("localDomain() = 99")), issues.join("\n"));
    assert.ok(issues.some((i) => i.includes("getLocalToken(base USDC")), issues.join("\n"));
    assert.ok(issues.some((i) => i.includes("usdcTreasury")), issues.join("\n"));
  });
});

describe("CCTP send/status robustness", () => {
  const RECEIVE_SEL = toFunctionSelector("receiveMessage(bytes,bytes)");

  it("receipt wait times out after broadcast -> ok:true with a handle (never ok:false once money left)", async () => {
    const { adapter, arb } = setup("standard");
    arb.setRead("allowance", () => 10n ** 12n);
    arb.receiptWait = "timeout";
    const res = await adapter.send(USDC_ARB, USDC_BASE, 5_000_000n, ME, mockCtx(false));
    assert.equal(res.ok, true, res.detail);
    assert.equal(arb.sent.length, 1);
    assert.match(res.handle!, /^cctp_v2_standard:arbitrum:base:0x0{63}1:5000000$/);
    assert.match(res.detail!, /confirmation pending/);
  });

  it("burn reverted on-chain -> ok:false (nothing left the wallet)", async () => {
    const { adapter, arb } = setup("standard");
    arb.setRead("allowance", () => 10n ** 12n);
    arb.receiptWait = "reverted";
    const res = await adapter.send(USDC_ARB, USDC_BASE, 5_000_000n, ME, mockCtx(false));
    assert.equal(res.ok, false);
    assert.match(res.detail!, /reverted on-chain/);
  });

  it("status(): Iris has nothing and the source receipt reverted -> failed with refunded amount", async () => {
    const { adapter, arb } = setup("standard");
    const tx = "0x" + "9a".repeat(32);
    arb.receipts[tx] = { logs: [], status: "reverted" };
    const st = await adapter.status(`cctp_v2_standard:arbitrum:base:${tx}:5000000`, mockCtx());
    assert.equal(st.state, "failed");
    assert.equal((st as { refunded?: bigint }).refunded, 5_000_000n);
  });

  it("status(): Sui source tx failed -> failed with refunded amount", async () => {
    const { adapter, sui } = setup("standard");
    sui.txKinds["BadDigest111"] = "FailedTransaction";
    const st = await adapter.status("cctp_v2_standard:sui:arbitrum:BadDigest111:7000000", mockCtx());
    assert.deepEqual(st, { state: "failed", detail: "source tx BadDigest111 failed on-chain; nothing was burned", refunded: 7_000_000n });
  });

  it("expired attestation: re-attest once, keep polling, then recoverable; fresh attestation -> claimable", async () => {
    const { adapter, f, base, clock } = setup("fast");
    const nonce = pad("0x77");
    const expired = makeMessage({ src: 3, dst: 6, nonce, mintRecipient: evmAddressToBytes32(ME), amount: 10n ** 9n, maxFee: 1n, feeExecuted: 1n });
    // put a non-zero expirationBlock into the body (last 32 bytes before hookData)
    const withExp = (expired.slice(0, expired.length - 64) + (123n).toString(16).padStart(64, "0")) as Hex;
    assert.equal(decodeCctpMessage(withExp).body?.expirationBlock, 123n);
    f.route("/v2/messages/3", () => ({ status: 200, body: { messages: [{ message: withExp, eventNonce: nonce, attestation: "0xabcd", status: "complete" }] } }));
    f.route("/v2/reattest/", (_u, method) => {
      assert.equal(method, "POST");
      return { status: 200, body: { message: "Re-attestation successfully requested for nonce.", nonce } };
    });
    base.revertSelector = RECEIVE_SEL;
    base.revertMessage = "execution reverted: Message expired and must be re-signed";
    const h = "cctp_v2_fast:arbitrum:base:0x" + "ab".repeat(32) + ":1000000000";
    const ctx = mockCtx();

    assert.deepEqual(await adapter.status(h, ctx), { state: "pending" });
    assert.equal(f.requests.filter((r) => r.startsWith("POST") && r.endsWith(`/v2/reattest/${nonce}`)).length, 1);
    clock.t += 5 * 60_000;
    assert.deepEqual(await adapter.status(h, ctx), { state: "pending" });
    assert.equal(f.requests.filter((r) => r.startsWith("POST")).length, 1); // only once
    clock.t += 20 * 60_000;
    const st = await adapter.status(h, ctx);
    assert.equal(st.state, "failed");
    assert.match((st as { detail: string }).detail, /^recoverable: attestation expired/);

    base.revertSelector = undefined; // Iris now serves a re-signed message
    assert.equal((await adapter.status(h, ctx)).state, "claimable");
  });

  it("Sui destination: expirationBlock is ms since epoch", async () => {
    const { adapter, f, clock, sui } = setup("standard");
    const msg = makeMessage({ src: 3, dst: 8, nonce: pad("0x0b"), mintRecipient: suiAddressToBytes32(SUI_ME), amount: 10n ** 7n, maxFee: 0n, feeExecuted: 0n });
    const exp = BigInt(clock.t - 1);
    const withExp = (msg.slice(0, msg.length - 64) + exp.toString(16).padStart(64, "0")) as Hex;
    f.route("/v2/messages/3", () => ({ status: 200, body: { messages: [{ message: withExp, attestation: "0xabcd", status: "complete" }] } }));
    f.route("/v2/reattest/", () => ({ status: 200, body: {} }));
    sui.nonceUsed = false;
    assert.deepEqual(await adapter.status("cctp_v2_standard:arbitrum:sui:0x" + "cd".repeat(32), mockCtx()), { state: "pending" });
    assert.ok(f.requests.some((r) => r.startsWith("POST") && r.includes("/v2/reattest/")));
  });
});
