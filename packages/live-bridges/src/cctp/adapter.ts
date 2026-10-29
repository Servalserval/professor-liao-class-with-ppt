/**
 * CCTP V2 USDC bridge (EVM <-> EVM, EVM <-> Sui). One instance per mode:
 *   kind "cctp_v2_fast"     minFinalityThreshold 1000 (Fast Transfer, fee > 0, only from fast-capable sources)
 *   kind "cctp_v2_standard" minFinalityThreshold 2000 (Standard Transfer, fee 0 bps)
 *
 * Flow: quote (Iris fee API -> maxFee with margin) -> approve exact + depositForBurn
 * (or the Sui burn PTB) -> status via Iris /v2/messages + destination nonce
 * check -> complete() = receiveMessage on the destination (EVM sendTx / Sui
 * executePtb), always simulated first; dry-run never broadcasts.
 *
 * send() contract (core BridgeExecutor): ok:false only when nothing left the
 * wallet. Once the burn may have been broadcast (BroadcastUnconfirmedError from
 * sendTx / executePtb, or an unconfirmed record) we return ok:true + handle and
 * status() sorts it out: a burn tx that has no receipt and is unknown to the node
 * for > 15 min is reported failed with the full amount refunded (it never left).
 * Handle: <kind>:<src>:<dst>:<txHash|digest>:<amount>:<sentAtMs>:<guard>
 *   guard (see common.ts TxGuard): EVM nonce / Sui gas-coin version. A missing source tx is
 *   refunded only when the guard proves it can never land; without a guard it stays
 *   unconfirmed (glue -> stuck for the operator).
 * Expired attestations (expirationBlock, ~24h) are re-attested once via Iris;
 * if that does not help the status turns "recoverable:" (core: stuck).
 */
import type { AssetRef, BridgeAdapter, BridgeQuote, LiveContext, LiveResult, TxRecord } from "@incentive-router/live-common";
import { fromUnits, unitsToUsd } from "@incentive-router/live-common";
import { encodeFunctionData, isAddress, zeroHash, type Address, type Hex } from "viem";
import { ensureAllowance, erc20Balance, sendTx, type EvmEnv } from "@incentive-router/live-evm-base";
import { coinBalance, executePtb, normalizeStructTag, normalizeSuiAddress, type SuiEnv } from "@incentive-router/live-sui";
import {
  broadcastIdOnError,
  captureBroadcasts,
  decodeHandle,
  encodeHandle,
  errMsg,
  evmAddressToBytes32,
  gasToUsd,
  isNotFoundError,
  decodeGuard,
  encodeGuard,
  evmNoncePassed,
  MISSING_TX_REFUND_MS,
  RECOVERABLE,
  type TxGuard,
  sameEvmAddress,
  suiAddressToBytes32,
  type FetchLike,
  type LiveBridgeStatus,
} from "../common.js";
import { messageTransmitterV2Abi, tokenMessengerV2Abi } from "./abi.js";
import {
  CCTP_DOMAINS,
  CCTP_ETA_FAST_S,
  CCTP_ETA_STANDARD_S,
  CCTP_FAST_SOURCES,
  CCTP_V2_EVM_MAINNET,
  FINALITY_THRESHOLD_CONFIRMED,
  FINALITY_THRESHOLD_FINALIZED,
  IRIS_MAINNET,
  type CctpEvmContracts,
} from "./constants.js";
import { cctpMaxFee, decodeCctpMessage, IrisClient, isAttested, pickFee, receivedFromMessage, type IrisMessage } from "./iris.js";
import { buildSuiBurnPtb, buildSuiReceivePtb, SUI_CCTP_V2_MAINNET, suiNonceUsed, suiObjectAdvanced, suiOwnedRef, type SuiCctpConfig } from "./sui.js";

export type CctpMode = "fast" | "standard";

export interface CctpGasUnits {
  approve: bigint;
  depositForBurn: bigint;
  receiveMessage: bigint;
}

export interface CctpV2AdapterOptions {
  mode: CctpMode;
  /** EVM envs by live-common chain id (source signer and/or destination receiver). */
  envs: Record<string, EvmEnv>;
  /** USDC per chain (EVM checksummed address / Sui coin type). Required for every chain used. */
  usdc: Record<string, AssetRef>;
  /** Sui env + package config (defaults to SUI_CCTP_V2_MAINNET) to enable chain "sui". */
  sui?: { env: SuiEnv; config?: SuiCctpConfig };
  irisBaseUrl?: string;
  fetch?: FetchLike;
  /** Safety margin on top of the Iris minimumFee, bps of the fee (default 2000 = +20%, per Circle's guidance of 10–20%). */
  feeMarginBps?: number;
  /** Gas planning estimates (units) for quotes. Real txs are estimated by sendTx. */
  gasUnits?: Partial<CctpGasUnits>;
  /** SUI spent per Sui-side tx, for quotes (default 0.01). */
  suiGasPerTx?: number;
  etaSeconds?: Partial<Record<string, number>>;
  /** Overrides (tests / non-mainnet). */
  domains?: Record<string, number>;
  contracts?: CctpEvmContracts;
  /** Allow sending to an address other than our own env account on the destination (default false). */
  allowForeignRecipient?: boolean;
  /** After a re-attest request, how long an expired attestation may persist before "recoverable" (default 15 min). */
  reattestGraceMs?: number;
  now?: () => number;
}

const DEFAULT_GAS: CctpGasUnits = { approve: 60_000n, depositForBurn: 200_000n, receiveMessage: 250_000n };

interface InternalQuote extends BridgeQuote {
  maxFee: bigint;
  srcDomain: number;
  dstDomain: number;
}

interface Handle {
  src: string;
  dst: string;
  tx: string;
  /** Burned amount (absent in handles from before this field existed). */
  amount?: bigint;
  /** When send() returned (absent in old handles -> no missing-tx refund). */
  sentAtMs?: number;
  /** Replay guard (absent -> never auto-refund). */
  guard?: TxGuard;
}

/** Message + causes, so revert reasons nested in viem errors are visible. */
function fullErr(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur && i < 6; i++) {
    const c = cur as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    for (const k of [c.shortMessage, c.message, c.details]) if (typeof k === "string") parts.push(k);
    cur = c.cause;
  }
  return parts.join(" | ") || String(e);
}

export class CctpV2Adapter implements BridgeAdapter {
  readonly kind: "cctp_v2_fast" | "cctp_v2_standard";
  private readonly iris: IrisClient;
  private readonly domains: Record<string, number>;
  private readonly contracts: CctpEvmContracts;
  private readonly gas: CctpGasUnits;
  private readonly marginBps: number;
  private readonly threshold: number;
  private readonly suiCfg: SuiCctpConfig;
  /** nonce -> when we asked Iris to re-attest (once per process). */
  private readonly reattested = new Map<string, number>();

  constructor(private readonly o: CctpV2AdapterOptions) {
    this.kind = o.mode === "fast" ? "cctp_v2_fast" : "cctp_v2_standard";
    this.threshold = o.mode === "fast" ? FINALITY_THRESHOLD_CONFIRMED : FINALITY_THRESHOLD_FINALIZED;
    this.iris = new IrisClient(o.irisBaseUrl ?? IRIS_MAINNET, o.fetch);
    this.domains = o.domains ?? { ...CCTP_DOMAINS };
    this.contracts = o.contracts ?? CCTP_V2_EVM_MAINNET;
    this.gas = { ...DEFAULT_GAS, ...(o.gasUnits ?? {}) };
    this.marginBps = o.feeMarginBps ?? 2000;
    this.suiCfg = o.sui?.config ?? SUI_CCTP_V2_MAINNET;
  }

  // -------------------------------------------------------------------------
  // capability
  // -------------------------------------------------------------------------

  private hasEnv(chain: string): boolean {
    return chain === "sui" ? !!this.o.sui : !!this.o.envs[chain];
  }

  private isOurUsdc(a: AssetRef): boolean {
    const cfg = this.o.usdc[a.chain];
    if (!cfg || a.symbol.toUpperCase() !== "USDC") return false;
    if (a.chain === "sui") return normalizeStructTag(a.address) === normalizeStructTag(cfg.address);
    return sameEvmAddress(a.address, cfg.address);
  }

  supports(from: AssetRef, to: AssetRef): boolean {
    if (from.chain === to.chain) return false;
    if (this.domains[from.chain] === undefined || this.domains[to.chain] === undefined) return false;
    if (!this.hasEnv(from.chain) || !this.hasEnv(to.chain)) return false;
    if (!this.isOurUsdc(from) || !this.isOurUsdc(to)) return false;
    if (this.o.mode === "fast" && !CCTP_FAST_SOURCES.has(from.chain)) return false;
    return true;
  }

  /** Our own address on `chain` (the only allowed recipient unless allowForeignRecipient). */
  ownAddress(chain: string): string {
    if (chain === "sui") {
      if (!this.o.sui) throw new Error("cctp: no Sui env configured");
      return this.o.sui.env.address;
    }
    const env = this.o.envs[chain];
    if (!env) throw new Error(`cctp: no EVM env for ${chain}`);
    return env.account;
  }

  private recipient32(chain: string, recipient: string): Hex {
    if (chain === "sui") return suiAddressToBytes32(recipient);
    return evmAddressToBytes32(recipient);
  }

  // -------------------------------------------------------------------------
  // quote
  // -------------------------------------------------------------------------

  async quote(from: AssetRef, to: AssetRef, amount: bigint, ctx: LiveContext): Promise<BridgeQuote> {
    const q = await this.quoteInternal(from, to, amount, ctx);
    const { maxFee: _m, srcDomain: _s, dstDomain: _d, ...pub } = q;
    return pub;
  }

  private async quoteInternal(from: AssetRef, to: AssetRef, amount: bigint, ctx: LiveContext): Promise<InternalQuote> {
    if (!this.supports(from, to)) throw new Error(`${this.kind}: unsupported route ${from.chain}:${from.symbol} -> ${to.chain}:${to.symbol}`);
    if (amount <= 0n) throw new Error(`${this.kind}: amount must be > 0`);
    const srcDomain = this.domains[from.chain]!;
    const dstDomain = this.domains[to.chain]!;

    const entries = await this.iris.fees(srcDomain, dstDomain);
    const entry = pickFee(entries, this.threshold);
    if (!entry && this.o.mode === "fast") throw new Error(`${this.kind}: Iris offers no Fast Transfer for ${from.chain} -> ${to.chain}`);
    const feeBps = entry?.minimumFee ?? 0;
    let maxFee = cctpMaxFee(amount, feeBps, this.marginBps);
    const expectedFee = cctpMaxFee(amount, feeBps, 0);

    if (from.chain !== "sui" && this.o.mode === "standard") {
      // Fee switch (e.g. Sei): getMinFeeAmount reverts on older deployments -> ignore.
      try {
        const env = this.o.envs[from.chain]!;
        const onchain = await env.publicClient.readContract({
          address: this.contracts.tokenMessengerV2,
          abi: tokenMessengerV2Abi,
          functionName: "getMinFeeAmount",
          args: [amount],
        });
        if (onchain > maxFee) maxFee = onchain;
      } catch {
        /* not supported on this deployment */
      }
    }
    if (maxFee >= amount) throw new Error(`${this.kind}: maxFee ${maxFee} >= amount ${amount}`);

    if (this.o.mode === "fast") {
      const allowance = await this.iris.fastAllowance();
      if (allowance < amount)
        throw new Error(`${this.kind}: Fast Transfer allowance ${fromUnits(allowance, 6)} USDC < amount ${fromUnits(amount, from.decimals)}; use cctp_v2_standard`);
    }

    const price = await ctx.priceUsd(from);
    const feeUsd = unitsToUsd(expectedFee, price, from.decimals);
    const [gasSrcUsd, gasDstUsd] = await Promise.all([this.srcGasUsd(from.chain, ctx), this.dstGasUsd(to.chain, ctx)]);
    const eta =
      this.o.etaSeconds?.[from.chain] ?? (this.o.mode === "fast" ? CCTP_ETA_FAST_S : (CCTP_ETA_STANDARD_S[from.chain] ?? 30 * 60));
    return { amountIn: amount, minAmountOut: amount - maxFee, feeUsd, gasSrcUsd, gasDstUsd, etaSeconds: eta, maxFee, srcDomain, dstDomain };
  }

  private async srcGasUsd(chain: string, ctx: LiveContext): Promise<number> {
    if (chain === "sui") return (this.o.suiGasPerTx ?? 0.01) * (await ctx.nativePriceUsd("sui"));
    const env = this.o.envs[chain]!;
    const [gp, px] = await Promise.all([env.publicClient.getGasPrice(), ctx.nativePriceUsd(chain)]);
    return gasToUsd(this.gas.approve + this.gas.depositForBurn, gp, px);
  }

  private async dstGasUsd(chain: string, ctx: LiveContext): Promise<number> {
    if (chain === "sui") return (this.o.suiGasPerTx ?? 0.01) * (await ctx.nativePriceUsd("sui"));
    const env = this.o.envs[chain]!;
    const [gp, px] = await Promise.all([env.publicClient.getGasPrice(), ctx.nativePriceUsd(chain)]);
    return gasToUsd(this.gas.receiveMessage, gp, px);
  }

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  async send(from: AssetRef, to: AssetRef, amount: bigint, recipient: string, ctx: LiveContext): Promise<LiveResult & { handle?: string }> {
    const txs: TxRecord[] = [];
    try {
      const own = this.ownAddress(to.chain);
      const isOwn = to.chain === "sui" ? normalizeSuiAddress(recipient) === normalizeSuiAddress(own) : sameEvmAddress(recipient, own);
      if (!isOwn && !this.o.allowForeignRecipient) return { ok: false, txs, detail: `${this.kind}: recipient ${recipient} is not our ${to.chain} address ${own}` };
      if (to.chain !== "sui" && !isAddress(recipient)) return { ok: false, txs, detail: `${this.kind}: bad EVM recipient ${recipient}` };

      const q = await this.quoteInternal(from, to, amount, ctx);
      const mintRecipient = this.recipient32(to.chain, recipient);
      ctx.log("info", `${this.kind}: ${from.chain} -> ${to.chain} ${fromUnits(amount, from.decimals)} USDC`, {
        maxFee: q.maxFee.toString(),
        feeUsd: q.feeUsd,
      });

      if (from.chain === "sui") {
        const sui = this.o.sui!;
        const bal = await coinBalance(sui.env, from.address);
        if (bal < amount) return { ok: false, txs, detail: `${this.kind}: sui USDC balance ${bal} < ${amount}` };
        const tx = buildSuiBurnPtb(this.suiCfg, {
          usdcType: from.address,
          amount,
          destinationDomain: q.dstDomain,
          mintRecipient32: mintRecipient,
          maxFee: q.maxFee,
          minFinalityThreshold: this.threshold,
        });
        const desc = `${this.kind} burn ${amount} USDC sui -> ${to.chain}`;
        const cap = captureBroadcasts(ctx);
        let rec: TxRecord;
        try {
          rec = await executePtb(sui.env, cap.ctx, tx, desc);
        } catch (e) {
          const sent = this.afterBroadcastFailure(e, cap.ids, "sui", desc, from.chain, to.chain, amount, txs, ctx, suiOwnedRef(tx));
          if (sent) return sent;
          throw e;
        }
        txs.push(rec);
        if (ctx.dryRun || !rec.id) return { ok: true, txs, detail: "dry-run: burn PTB simulated" };
        const guard = encodeGuard(suiOwnedRef(tx));
        return { ok: true, txs, handle: encodeHandle(this.kind, [from.chain, to.chain, rec.id, amount, this.now(), guard]), detail: rec.unconfirmed ? "broadcast; confirmation pending" : undefined };
      }

      const env = this.o.envs[from.chain]!;
      const token = from.address as Address;
      const bal = await erc20Balance(env, token);
      if (bal < amount) return { ok: false, txs, detail: `${this.kind}: ${from.chain} USDC balance ${bal} < ${amount}` };
      const spender = this.contracts.tokenMessengerV2;
      const approvals = await ensureAllowance(env, ctx, token, spender, amount);
      txs.push(...approvals);
      if (ctx.dryRun && approvals.length > 0) {
        return { ok: true, txs, detail: "dry-run: approve simulated; depositForBurn needs the allowance on-chain so it was not simulated" };
      }
      const data = encodeFunctionData({
        abi: tokenMessengerV2Abi,
        functionName: "depositForBurn",
        args: [amount, q.dstDomain, mintRecipient, token, zeroHash, q.maxFee, this.threshold],
      });
      const desc = `${this.kind} depositForBurn ${amount} USDC ${from.chain} -> ${to.chain}`;
      const cap = captureBroadcasts(ctx);
      let rec: TxRecord;
      try {
        rec = await sendTx(env, cap.ctx, { to: spender, data, description: desc });
      } catch (e) {
        const n = (e as { nonce?: unknown }).nonce;
        const sent = this.afterBroadcastFailure(e, cap.ids, from.chain, desc, from.chain, to.chain, amount, txs, ctx, typeof n === "number" ? { nonce: n } : undefined);
        if (sent) return sent;
        throw e;
      }
      txs.push(rec);
      if (ctx.dryRun || !rec.id) return { ok: true, txs, detail: "dry-run: depositForBurn simulated" };
      const guard = encodeGuard(rec.nonce !== undefined ? { nonce: rec.nonce } : undefined);
      return { ok: true, txs, handle: encodeHandle(this.kind, [from.chain, to.chain, rec.id, amount, this.now(), guard]), detail: rec.unconfirmed ? "broadcast; confirmation pending" : undefined };
    } catch (e) {
      return { ok: false, txs, detail: `${this.kind}: ${errMsg(e)}` };
    }
  }

  /**
   * The burn tx was broadcast (hash captured) but the receipt wait failed. Unless
   * the tx itself failed on-chain (nothing moved), report success with a handle.
   */
  private afterBroadcastFailure(
    e: unknown,
    ids: string[],
    chain: string,
    description: string,
    src: string,
    dst: string,
    amount: bigint,
    txs: TxRecord[],
    ctx: LiveContext,
    guard: TxGuard | undefined
  ): (LiveResult & { handle: string }) | undefined {
    const id = broadcastIdOnError(e, ids);
    if (!id) return undefined;
    ctx.log("warn", `${this.kind}: ${description} submitted as ${id} but not confirmed; tracking it`, { err: errMsg(e) });
    txs.push({ chain, id, description, simulated: false, unconfirmed: true, nonce: guard && "nonce" in guard ? guard.nonce : undefined });
    return {
      ok: true,
      txs,
      handle: encodeHandle(this.kind, [src, dst, id, amount, this.now(), encodeGuard(guard)]),
      detail: `broadcast ${id}; confirmation pending (${errMsg(e)})`,
    };
  }

  // -------------------------------------------------------------------------
  // status / complete
  // -------------------------------------------------------------------------

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  private parse(handle: string): Handle {
    const [src, dst, tx, amount, sentAt, guard] = decodeHandle(this.kind, handle, 3, 6);
    return {
      src: src!,
      dst: dst!,
      tx: tx!,
      amount: amount !== undefined ? BigInt(amount) : undefined,
      sentAtMs: sentAt !== undefined ? Number(sentAt) : undefined,
      guard: decodeGuard(guard),
    };
  }

  private async fetchMessage(h: Handle): Promise<IrisMessage | undefined> {
    const srcDomain = this.domains[h.src];
    if (srcDomain === undefined) throw new Error(`${this.kind}: unknown source chain ${h.src}`);
    const msgs = await this.iris.messages(srcDomain, h.tx);
    const dstDomain = this.domains[h.dst];
    return msgs.find((m) => m.decodedMessage?.destinationDomain === undefined || Number(m.decodedMessage.destinationDomain) === dstDomain) ?? msgs[0];
  }

  private async nonceUsed(dst: string, nonce: Hex): Promise<boolean> {
    if (dst === "sui") return suiNonceUsed(this.o.sui!.env, this.suiCfg, nonce);
    const env = this.o.envs[dst];
    if (!env) throw new Error(`${this.kind}: no EVM env for ${dst}`);
    const used = await env.publicClient.readContract({
      address: this.contracts.messageTransmitterV2,
      abi: messageTransmitterV2Abi,
      functionName: "usedNonces",
      args: [nonce],
    });
    return used > 0n;
  }

  /**
   * "reverted" = failed on-chain, "missing" = no receipt and the node does not know the tx
   * (both: nothing left the wallet); "pending" = known but not mined; "unknown" = could not tell.
   */
  private async sourceTxState(h: Handle): Promise<"ok" | "reverted" | "pending" | "missing" | "unknown"> {
    if (h.src === "sui") {
      try {
        const r = await this.o.sui!.env.grpc.core.getTransaction({ digest: h.tx, include: { effects: true } });
        return r.$kind === "FailedTransaction" ? "reverted" : "ok";
      } catch (e) {
        return isNotFoundError(e) ? "missing" : "unknown";
      }
    }
    const env = this.o.envs[h.src];
    if (!env) return "unknown";
    try {
      const r = await env.publicClient.getTransactionReceipt({ hash: h.tx as Hex });
      return r.status === "reverted" ? "reverted" : "ok";
    } catch (e) {
      if (!isNotFoundError(e)) return "unknown";
    }
    try {
      const t = await env.publicClient.getTransaction({ hash: h.tx as Hex });
      return t ? "pending" : "missing";
    } catch (e) {
      return isNotFoundError(e) ? "missing" : "unknown";
    }
  }

  /** Proof that a missing source tx can never land, or undefined (stay stuck). */
  private async canNeverLand(h: Handle): Promise<string | undefined> {
    const g = h.guard;
    if (!g) return undefined;
    try {
      if ("nonce" in g) {
        const env = this.o.envs[h.src];
        if (!env || h.src === "sui") return undefined;
        return (await evmNoncePassed(env.publicClient, env.account, g.nonce)) ? `account nonce passed ${g.nonce}` : undefined;
      }
      if (h.src !== "sui" || !this.o.sui) return undefined;
      return (await suiObjectAdvanced(this.o.sui.env, g.objectId, g.version)) ? `input ${g.objectId} moved past version ${g.version}` : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Expired = receiveMessage would revert with "Message expired and must be re-signed".
   * EVM: decided by an eth_call of receiveMessage (Arbitrum-stack chains compare an L1
   * block number, so we let the chain decide). Sui: expiration is ms since epoch.
   * SOURCE: evm-cctp-contracts src/v2/TokenMessengerV2.sol _validatedReceivedMessage;
   *         sui-cctp handle_receive_message.move (EExpiredMessage, clock.timestamp_ms() < expiration)
   */
  private async isExpired(h: Handle, m: IrisMessage & { message: Hex; attestation: Hex }, expirationBlock: bigint): Promise<boolean> {
    if (expirationBlock === 0n) return false;
    if (h.dst === "sui") return expirationBlock <= BigInt(this.now());
    const env = this.o.envs[h.dst];
    if (!env) return false;
    try {
      await env.publicClient.call({
        account: env.account,
        to: this.contracts.messageTransmitterV2,
        data: encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: "receiveMessage", args: [m.message, m.attestation] }),
      });
      return false;
    } catch (e) {
      return /expired/i.test(fullErr(e));
    }
  }

  private async onExpired(nonceKey: string, ctx: LiveContext): Promise<LiveBridgeStatus> {
    const at = this.reattested.get(nonceKey);
    if (at === undefined) {
      this.reattested.set(nonceKey, this.now());
      try {
        const r = await this.iris.reattest(nonceKey);
        ctx.log("warn", `${this.kind}: attestation expired; re-attestation requested`, { nonce: nonceKey, reply: r?.message });
      } catch (e) {
        ctx.log("warn", `${this.kind}: attestation expired; re-attest request failed`, { nonce: nonceKey, err: errMsg(e) });
      }
      return { state: "pending" };
    }
    const waited = this.now() - at;
    if (waited < (this.o.reattestGraceMs ?? 15 * 60_000)) return { state: "pending" };
    return {
      state: "failed",
      detail: `${RECOVERABLE} attestation expired; re-attest requested ${Math.round(waited / 60_000)} min ago but Iris still serves an expired attestation (nonce ${nonceKey}); retry POST /v2/reattest`,
    };
  }

  async status(handle: string, ctx: LiveContext): Promise<LiveBridgeStatus> {
    const h = this.parse(handle);
    let m: IrisMessage | undefined;
    try {
      m = await this.fetchMessage(h);
    } catch (e) {
      return { state: "pending", unconfirmed: `iris: ${errMsg(e)}` };
    }
    if (!m) {
      const src = await this.sourceTxState(h);
      if (src === "reverted") return { state: "failed", detail: `source tx ${h.tx} failed on-chain; nothing was burned`, refunded: h.amount };
      if (src === "missing") {
        const age = h.sentAtMs !== undefined ? this.now() - h.sentAtMs : undefined;
        if (age !== undefined && age > MISSING_TX_REFUND_MS) {
          const dead = await this.canNeverLand(h);
          if (dead)
            return {
              state: "failed",
              detail: `source tx ${h.tx} never landed and can no longer land (${dead}); nothing was burned`,
              refunded: h.amount,
            };
          return { state: "pending", unconfirmed: `source tx ${h.tx} not found for ${Math.round(age / 60_000)} min but could still land (${h.guard ? "guard not passed" : "no replay guard in handle"}); check manually` };
        }
        return { state: "pending", unconfirmed: `source tx ${h.tx} not found (no receipt, not in the node's mempool)` };
      }
      if (src === "pending") return { state: "pending", unconfirmed: `source tx ${h.tx} not mined yet` };
      return { state: "pending", unconfirmed: src === "unknown" ? `source tx ${h.tx}: state unknown; Iris has no message` : `Iris has no message for mined burn ${h.tx}` };
    }
    if (!isAttested(m)) return { state: "pending" };
    const d = decodeCctpMessage(m.message);
    if (d.destinationDomain !== this.domains[h.dst]) return { state: "failed", detail: `message destination domain ${d.destinationDomain} != ${h.dst}` };
    if (await this.nonceUsed(h.dst, d.nonce)) {
      return { state: "completed", dstTx: m.destinationMintTxHash, received: receivedFromMessage(m) };
    }
    if (await this.isExpired(h, m, d.body?.expirationBlock ?? 0n)) return this.onExpired(m.eventNonce ?? d.nonce, ctx);
    return { state: "claimable", detail: `attested; nonce ${d.nonce} not yet received on ${h.dst}` };
  }

  async complete(handle: string, ctx: LiveContext): Promise<LiveResult> {
    const txs: TxRecord[] = [];
    try {
      const h = this.parse(handle);
      const m = await this.fetchMessage(h);
      if (!m || !isAttested(m)) return { ok: false, txs, detail: "not attested yet" };
      const d = decodeCctpMessage(m.message);
      if (d.destinationDomain !== this.domains[h.dst]) return { ok: false, txs, detail: `destination domain mismatch (${d.destinationDomain})` };
      if (await this.nonceUsed(h.dst, d.nonce)) return { ok: true, txs, detail: "already received" };
      if (h.dst === "sui") {
        const sui = this.o.sui!;
        const usdc = this.o.usdc.sui;
        if (!usdc) return { ok: false, txs, detail: "no Sui USDC configured" };
        const tx = buildSuiReceivePtb(this.suiCfg, usdc.address, m.message, m.attestation);
        txs.push(await executePtb(sui.env, ctx, tx, `${this.kind} receive on sui (nonce ${d.nonce})`));
      } else {
        const env = this.o.envs[h.dst]!;
        const data = encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: "receiveMessage", args: [m.message, m.attestation] });
        txs.push(
          await sendTx(env, ctx, { to: this.contracts.messageTransmitterV2, data, description: `${this.kind} receiveMessage on ${h.dst} (nonce ${d.nonce})` })
        );
      }
      return { ok: true, txs, detail: ctx.dryRun ? "dry-run: receive simulated" : undefined };
    } catch (e) {
      return { ok: false, txs, detail: `${this.kind} complete: ${errMsg(e)}` };
    }
  }
}
