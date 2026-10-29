/**
 * USDT0 bridge over LayerZero V2 OFT (kind "usdt0_oft").
 *
 * quote: quoteOFT(SendParam) -> limits + amountReceivedLD (minAmountLD), then
 *        quoteSend(SendParam, false) -> MessagingFee.nativeFee.
 * send:  (Ethereum OFT Adapter only) approve exact USDT (ensureAllowance resets
 *        to 0 first) -> send(SendParam, {nativeFee*(1+margin), 0}, refund=us) with
 *        value = that nativeFee (OAppSender requires msg.value == fee.nativeFee;
 *        the endpoint refunds the unused part to the refund address).
 * status: destination OFTReceived(guid) log = completed (authoritative);
 *        LayerZero Scan only to detect failed / blocked messages.
 * No destination tx is needed (the LayerZero executor delivers), so no complete().
 *
 * send() contract: ok:false only when nothing left the wallet. After the OFT
 * send is broadcast we return ok:true + handle even if the receipt wait / the
 * OFTSent lookup fails (guid "-" in the handle; status() recovers it from the receipt).
 * Handle: usdt0_oft:<src>:<dst>:<txHash>:<guid|->:<dstFromBlock>:<expectedReceivedLD>:<amountSentLD>
 */
import type { AssetRef, BridgeAdapter, BridgeQuote, LiveContext, LiveResult, TxRecord } from "@incentive-router/live-common";
import { fromUnits, unitsToUsd } from "@incentive-router/live-common";
import { ensureAllowance, erc20Balance, sendTx, type EvmEnv } from "@incentive-router/live-evm-base";
import { encodeFunctionData, getAbiItem, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import {
  captureBroadcasts,
  decodeHandle,
  encodeHandle,
  errMsg,
  evmAddressToBytes32,
  gasToUsd,
  isOnChainFailure,
  plusBpsCeil,
  RECOVERABLE,
  sameEvmAddress,
  type FetchLike,
  type LiveBridgeStatus,
} from "../common.js";
import { oftAbi } from "./abi.js";
import { LZ_SCAN_MAINNET, USDT0_DEPLOYMENTS, USDT0_ETA_S, type Usdt0Deployment } from "./constants.js";
import { LzScanClient } from "./scan.js";

export interface SendParam {
  dstEid: number;
  to: Hex;
  amountLD: bigint;
  minAmountLD: bigint;
  extraOptions: Hex;
  composeMsg: Hex;
  oftCmd: Hex;
}

export interface MessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

/** Plain transfer SendParam: no extra options (USDT0 sets enforced options), no compose, no command. */
export function buildSendParam(a: { dstEid: number; to: string; amountLD: bigint; minAmountLD: bigint }): SendParam {
  return { dstEid: a.dstEid, to: evmAddressToBytes32(a.to), amountLD: a.amountLD, minAmountLD: a.minAmountLD, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" };
}

/** OFTCore._removeDust: floor to a multiple of 10^(localDecimals - sharedDecimals). */
export function removeDust(amountLD: bigint, localDecimals: number, sharedDecimals: number): bigint {
  if (sharedDecimals > localDecimals) throw new Error(`sharedDecimals ${sharedDecimals} > localDecimals ${localDecimals}`);
  const rate = 10n ** BigInt(localDecimals - sharedDecimals);
  return (amountLD / rate) * rate;
}

export function encodeOftSend(p: SendParam, fee: MessagingFee, refund: Address): Hex {
  return encodeFunctionData({ abi: oftAbi, functionName: "send", args: [p, fee, refund] });
}

export interface Usdt0GasUnits {
  approve: bigint;
  send: bigint;
}

export interface Usdt0OftAdapterOptions {
  envs: Record<string, EvmEnv>;
  /** Optional AssetRef per chain; overrides the table token (required to name Ethereum USDT unless read on-chain). */
  tokens?: Record<string, AssetRef>;
  scanBaseUrl?: string;
  fetch?: FetchLike;
  /** Extra native fee sent on top of quoteSend (refunded if unused). Default 1000 bps = +10%. */
  nativeFeeMarginBps?: number;
  gasUnits?: Partial<Usdt0GasUnits>;
  etaSeconds?: number;
  /** getLogs window per request and max windows per status() call on the destination. */
  logChunkBlocks?: bigint;
  maxLogChunks?: number;
  deployments?: Record<string, Usdt0Deployment>;
  allowForeignRecipient?: boolean;
}

const DEFAULT_GAS: Usdt0GasUnits = { approve: 60_000n, send: 300_000n };
const OFT_RECEIVED = getAbiItem({ abi: oftAbi, name: "OFTReceived" });

interface InternalQuote extends BridgeQuote {
  sendParam: SendParam;
  fee: MessagingFee;
}

export class Usdt0OftAdapter implements BridgeAdapter {
  readonly kind = "usdt0_oft" as const;
  private readonly deps: Record<string, Usdt0Deployment>;
  private readonly scan: LzScanClient;
  private readonly gas: Usdt0GasUnits;
  private readonly tokenChecked = new Map<string, Address>();

  constructor(private readonly o: Usdt0OftAdapterOptions) {
    this.deps = o.deployments ?? { ...USDT0_DEPLOYMENTS };
    this.scan = new LzScanClient(o.scanBaseUrl ?? LZ_SCAN_MAINNET, o.fetch);
    this.gas = { ...DEFAULT_GAS, ...(o.gasUnits ?? {}) };
  }

  private configuredToken(chain: string): string | undefined {
    return this.o.tokens?.[chain]?.address ?? this.deps[chain]?.token;
  }

  private assetOk(a: AssetRef): boolean {
    const d = this.deps[a.chain];
    if (!d) return false;
    const sym = a.symbol.toUpperCase();
    if (sym !== "USDT" && sym !== "USDT0") return false;
    const want = this.configuredToken(a.chain);
    // Ethereum USDT is not in the docs table: accept the AssetRef, it is checked against oft.token() before any tx.
    return want ? sameEvmAddress(a.address, want) : isAddress(a.address);
  }

  supports(from: AssetRef, to: AssetRef): boolean {
    if (from.chain === to.chain) return false;
    if (!this.o.envs[from.chain] || !this.o.envs[to.chain]) return false;
    return this.assetOk(from) && this.assetOk(to);
  }

  /** Read oft.token() once per chain and require it to equal the AssetRef we were given. */
  private async checkToken(a: AssetRef): Promise<void> {
    const cached = this.tokenChecked.get(a.chain);
    if (cached) {
      if (!sameEvmAddress(cached, a.address)) throw new Error(`usdt0: ${a.chain} OFT token is ${cached}, asset says ${a.address}`);
      return;
    }
    const env = this.o.envs[a.chain]!;
    const t = await env.publicClient.readContract({ address: this.deps[a.chain]!.oft, abi: oftAbi, functionName: "token" });
    this.tokenChecked.set(a.chain, t);
    if (!sameEvmAddress(t, a.address)) throw new Error(`usdt0: ${a.chain} OFT token is ${t}, asset says ${a.address}`);
  }

  // -------------------------------------------------------------------------
  // quote
  // -------------------------------------------------------------------------

  async quote(from: AssetRef, to: AssetRef, amount: bigint, ctx: LiveContext): Promise<BridgeQuote> {
    const { sendParam: _p, fee: _f, ...pub } = await this.quoteInternal(from, to, amount, this.o.envs[to.chain]?.account ?? "", ctx);
    return pub;
  }

  private async quoteInternal(from: AssetRef, to: AssetRef, amount: bigint, recipient: string, ctx: LiveContext): Promise<InternalQuote> {
    if (!this.supports(from, to)) throw new Error(`usdt0_oft: unsupported route ${from.chain}:${from.symbol} -> ${to.chain}:${to.symbol}`);
    if (amount <= 0n) throw new Error("usdt0_oft: amount must be > 0");
    const env = this.o.envs[from.chain]!;
    const src = this.deps[from.chain]!;
    const dst = this.deps[to.chain]!;
    const base = buildSendParam({ dstEid: dst.eid, to: recipient, amountLD: amount, minAmountLD: 0n });

    let minAmountLD: bigint;
    try {
      const [limit, , receipt] = await env.publicClient.readContract({ address: src.oft, abi: oftAbi, functionName: "quoteOFT", args: [base] });
      if (amount < limit.minAmountLD || amount > limit.maxAmountLD)
        throw new Error(`usdt0_oft: amount ${amount} outside OFT limits [${limit.minAmountLD}, ${limit.maxAmountLD}]`);
      minAmountLD = receipt.amountReceivedLD;
    } catch (e) {
      if (errMsg(e).includes("outside OFT limits")) throw e;
      let shared = from.decimals;
      try {
        shared = await env.publicClient.readContract({ address: src.oft, abi: oftAbi, functionName: "sharedDecimals" });
      } catch {
        /* assume no dust */
      }
      minAmountLD = removeDust(amount, from.decimals, shared);
      ctx.log("warn", `usdt0_oft: quoteOFT failed on ${from.chain}, using dust-removed amount`, { err: errMsg(e) });
    }
    if (minAmountLD <= 0n) throw new Error(`usdt0_oft: nothing would arrive (minAmountLD ${minAmountLD})`);
    const sendParam: SendParam = { ...base, minAmountLD };
    const msgFee = await env.publicClient.readContract({ address: src.oft, abi: oftAbi, functionName: "quoteSend", args: [sendParam, false] });
    const fee: MessagingFee = { nativeFee: plusBpsCeil(msgFee.nativeFee, this.o.nativeFeeMarginBps ?? 1000), lzTokenFee: 0n };

    const [price, nativePx, gasPrice] = await Promise.all([ctx.priceUsd(from), ctx.nativePriceUsd(from.chain), env.publicClient.getGasPrice()]);
    const nativeFeeUsd = (Number(msgFee.nativeFee) / 1e18) * nativePx;
    const tokenFeeUsd = unitsToUsd(amount - minAmountLD, price, from.decimals);
    const gasUnits = (src.adapter ? this.gas.approve : 0n) + this.gas.send;
    return {
      amountIn: amount,
      minAmountOut: minAmountLD,
      feeUsd: nativeFeeUsd + tokenFeeUsd,
      gasSrcUsd: gasToUsd(gasUnits, gasPrice, nativePx),
      gasDstUsd: 0,
      etaSeconds: this.o.etaSeconds ?? USDT0_ETA_S,
      sendParam,
      fee,
    };
  }

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  async send(from: AssetRef, to: AssetRef, amount: bigint, recipient: string, ctx: LiveContext): Promise<LiveResult & { handle?: string }> {
    const txs: TxRecord[] = [];
    try {
      const dstEnv = this.o.envs[to.chain];
      if (!dstEnv) return { ok: false, txs, detail: `usdt0_oft: no env for ${to.chain}` };
      if (!isAddress(recipient)) return { ok: false, txs, detail: `usdt0_oft: bad recipient ${recipient}` };
      if (!sameEvmAddress(recipient, dstEnv.account) && !this.o.allowForeignRecipient)
        return { ok: false, txs, detail: `usdt0_oft: recipient ${recipient} is not our ${to.chain} address ${dstEnv.account}` };
      await this.checkToken(from);
      await this.checkToken(to);

      const env = this.o.envs[from.chain]!;
      const src = this.deps[from.chain]!;
      const bal = await erc20Balance(env, from.address as Address);
      if (bal < amount) return { ok: false, txs, detail: `usdt0_oft: ${from.chain} balance ${bal} < ${amount}` };
      const q = await this.quoteInternal(from, to, amount, recipient, ctx);
      ctx.log("info", `usdt0_oft: ${from.chain} -> ${to.chain} ${fromUnits(amount, from.decimals)} ${from.symbol}`, {
        nativeFee: q.fee.nativeFee.toString(),
        minAmountLD: q.sendParam.minAmountLD.toString(),
      });

      if (src.adapter) {
        const approvals = await ensureAllowance(env, ctx, from.address as Address, src.oft, amount);
        txs.push(...approvals);
        if (ctx.dryRun && approvals.length > 0)
          return { ok: true, txs, detail: "dry-run: approve simulated; OFT send needs the allowance on-chain so it was not simulated" };
      }
      const dstFromBlock = await dstEnv.publicClient.getBlockNumber();
      const desc = `usdt0_oft send ${amount} ${from.chain} -> ${to.chain}`;
      const expected = q.sendParam.minAmountLD;
      const cap = captureBroadcasts(ctx);
      let rec: TxRecord;
      try {
        rec = await sendTx(env, cap.ctx, { to: src.oft, data: encodeOftSend(q.sendParam, q.fee, env.account), value: q.fee.nativeFee, description: desc });
      } catch (e) {
        const id = cap.ids[cap.ids.length - 1];
        if (!id || isOnChainFailure(e)) throw e; // nothing moved
        ctx.log("warn", `usdt0_oft: ${desc} broadcast as ${id} but confirmation failed; tracking it`, { err: errMsg(e) });
        txs.push({ chain: from.chain, id, description: desc, simulated: false });
        return { ok: true, txs, handle: encodeHandle(this.kind, [from.chain, to.chain, id, "-", dstFromBlock, expected, amount]), detail: `broadcast ${id}; confirmation pending` };
      }
      txs.push(rec);
      if (ctx.dryRun || !rec.id) return { ok: true, txs, detail: "dry-run: OFT send simulated" };

      // From here on the money has left: never return ok:false / throw.
      let guid = "-";
      let received = expected;
      try {
        const sent = await this.oftSent(from.chain, rec.id as Hex);
        if (sent !== "reverted" && sent !== "unknown") {
          guid = sent.guid;
          received = sent.received;
        }
      } catch (e) {
        ctx.log("warn", `usdt0_oft: OFTSent lookup failed for ${rec.id}; will retry in status()`, { err: errMsg(e) });
      }
      return { ok: true, txs, handle: encodeHandle(this.kind, [from.chain, to.chain, rec.id, guid, dstFromBlock, received, amount]) };
    } catch (e) {
      return { ok: false, txs, detail: `usdt0_oft: ${errMsg(e)}` };
    }
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  private async findReceived(dst: string, guid: Hex, fromBlock: bigint): Promise<{ tx: Hex; amount: bigint } | undefined> {
    const env = this.o.envs[dst];
    if (!env) throw new Error(`usdt0_oft: no env for ${dst}`);
    const oft = this.deps[dst]!.oft;
    const latest = await env.publicClient.getBlockNumber();
    const chunk = this.o.logChunkBlocks ?? 5_000n;
    const maxChunks = this.o.maxLogChunks ?? 20;
    let start = fromBlock;
    for (let i = 0; i < maxChunks && start <= latest; i++) {
      const end = start + chunk - 1n < latest ? start + chunk - 1n : latest;
      const logs = await env.publicClient.getLogs({ address: oft, event: OFT_RECEIVED, args: { guid }, fromBlock: start, toBlock: end });
      const hit = logs.find((l) => l.args.guid?.toLowerCase() === guid.toLowerCase());
      if (hit && hit.transactionHash) return { tx: hit.transactionHash, amount: hit.args.amountReceivedLD ?? 0n };
      start = end + 1n;
    }
    return undefined;
  }

  /** OFTSent(guid, amountReceivedLD) from the source receipt; "reverted" = nothing left; "unknown" = no receipt yet. */
  private async oftSent(chain: string, tx: Hex): Promise<{ guid: string; received: bigint } | "reverted" | "unknown"> {
    const env = this.o.envs[chain];
    if (!env) return "unknown";
    let receipt;
    try {
      receipt = await env.publicClient.getTransactionReceipt({ hash: tx });
    } catch {
      return "unknown";
    }
    if (receipt.status === "reverted") return "reverted";
    const oft = this.deps[chain]!.oft;
    const sent = parseEventLogs({ abi: oftAbi, eventName: "OFTSent", logs: receipt.logs }).find((l) => sameEvmAddress(l.address, oft));
    if (!sent) throw new Error(`no OFTSent event from ${oft} in ${tx}`);
    return { guid: sent.args.guid, received: sent.args.amountReceivedLD };
  }

  async status(handle: string, ctx: LiveContext): Promise<LiveBridgeStatus> {
    const [src, dst, tx, guidField, fromBlock, expectedField, sentField] = decodeHandle(this.kind, handle, 6, 7);
    let guid = guidField!;
    let expected = BigInt(expectedField!);
    if (guid === "-") {
      let r: Awaited<ReturnType<Usdt0OftAdapter["oftSent"]>>;
      try {
        r = await this.oftSent(src!, tx as Hex);
      } catch (e) {
        return { state: "pending", unconfirmed: `source receipt: ${errMsg(e)}` };
      }
      if (r === "reverted")
        return { state: "failed", detail: `source tx ${tx} reverted on-chain; nothing was sent`, refunded: sentField !== undefined ? BigInt(sentField) : undefined };
      if (r === "unknown") return { state: "pending", unconfirmed: `source tx ${tx} not found yet` };
      guid = r.guid;
      expected = r.received;
    }
    try {
      const got = await this.findReceived(dst!, guid as Hex, BigInt(fromBlock!));
      if (got) return { state: "completed", dstTx: got.tx, received: got.amount };
    } catch (e) {
      ctx.log("warn", `usdt0_oft: destination log scan failed`, { err: errMsg(e) });
    }
    let msgs;
    try {
      msgs = await this.scan.byTx(tx!);
    } catch (e) {
      return { state: "pending", unconfirmed: `LayerZero Scan unreachable: ${errMsg(e)}` };
    }
    const m = msgs.find((x) => x.guid?.toLowerCase() === guid.toLowerCase()) ?? (msgs.length === 1 ? msgs[0] : undefined);
    if (!m) return { state: "pending", unconfirmed: "LayerZero Scan has no message for this tx" };
    switch (m.state) {
      case "delivered":
        // Scan says delivered but our log scan missed it (RPC window). Trust Scan, report the OFTSent amount.
        return { state: "completed", dstTx: m.dstTxHash, received: expected };
      case "inflight":
        return { state: "pending" };
      case "failed":
        return { state: "failed", detail: `LayerZero ${m.statusName}${m.message ? `: ${m.message}` : ""}` };
      case "recoverable":
        return { state: "failed", detail: `${RECOVERABLE} LayerZero ${m.statusName} (retry lzReceive / unblock pathway; funds not lost)` };
      default:
        return { state: "pending", unconfirmed: `LayerZero Scan status "${m.statusName}" not understood` };
    }
  }
}
