/**
 * Odos Smart Order Router API client (fallback aggregator).
 *
 * Docs (read 2026-10-29):
 *   https://docs.odos.xyz/api/sor/quote      (POST /sor/quote/v3)
 *   https://docs.odos.xyz/api/sor/assemble   (POST /sor/assemble)
 *   https://docs.odos.xyz/build/api_pricing  (free plan: 600 req / 5 min per IP)
 *   router: https://github.com/odos-xyz/odos-router-v2 (contracts/OdosRouterV2.sol)
 *
 * Endpoints / fields relied on:
 *   POST {base}/sor/quote/{v3|v2}
 *        body { chainId, inputTokens:[{tokenAddress, amount}], outputTokens:[{tokenAddress, proportion:1}],
 *               userAddr, slippageLimitPercent, compact:false }
 *        -> pathId, inTokens[], inAmounts[], outTokens[], outAmounts[], gasEstimateValue, priceImpact
 *   POST {base}/sor/assemble  body { userAddr, pathId, simulate:false }
 *        -> transaction.{to, data, value}, outputTokens[0].amount
 *   pathId is valid for 60 s. `compact:false` makes the router call the plain
 *   `swap(swapTokenInfo, bytes, address, uint32)` entry point, which we decode and verify.
 *   The docs' examples now target https://enterprise-api.odos.xyz with `x-api-key`;
 *   the free plan base (default here: https://api.odos.xyz) must be confirmed live.
 */
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { chainInfo } from "@incentive-router/live-common";
import type { Address, EvmEnv, Hex } from "@incentive-router/live-evm-base";
import { arr, big, httpJson, num, obj, sameAddr, str, type HttpFetch } from "./http.js";
import { slippageBpsFor, type AggQuote, type AggregatorClient, type BuiltTx, type DecodedSwap } from "./types.js";

/**
 * SOURCE: https://github.com/odos-xyz/odos-router-v2/blob/main/contracts/OdosRouterV2.sol
 *   struct swapTokenInfo { inputToken, inputAmount, inputReceiver, outputToken, outputQuote, outputMin, outputReceiver }
 *   function swap(swapTokenInfo memory tokenInfo, bytes calldata pathDefinition, address executor, uint32 referralCode) external payable returns (uint256 amountOut)
 *   uint256 public swapMultiFee;
 */
export const ODOS_ROUTER_V2_ABI = parseAbi([
  "struct SwapTokenInfo { address inputToken; uint256 inputAmount; address inputReceiver; address outputToken; uint256 outputQuote; uint256 outputMin; address outputReceiver; }",
  "function swap(SwapTokenInfo tokenInfo, bytes pathDefinition, address executor, uint32 referralCode) payable returns (uint256 amountOut)",
  "function swapMultiFee() view returns (uint256)",
]);

export interface OdosOptions {
  /** Default https://api.odos.xyz (free plan). Enterprise: https://enterprise-api.odos.xyz + apiKey. */
  baseUrl?: string;
  apiKey?: string;
  /** Default "v3". */
  quoteVersion?: "v2" | "v3";
  /** Quote validity we report. pathId lives 60 s; default 50_000. */
  quoteTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface OdosRaw {
  pathId: string;
  slippageBps: number;
}

export class OdosClient implements AggregatorClient {
  readonly name = "odos" as const;
  private readonly base: string;
  private readonly chainId: number;
  private readonly now: () => number;

  constructor(
    readonly chain: string,
    private readonly opts: OdosOptions = {},
    private readonly fetchImpl: HttpFetch
  ) {
    const id = chainInfo(chain).evmChainId;
    if (id === undefined) throw new Error(`odos: ${chain} is not an EVM chain`);
    this.chainId = id;
    this.base = (opts.baseUrl ?? "https://api.odos.xyz").replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
  }

  private headers(): Record<string, string> {
    return this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {};
  }

  async quote(args: { tokenIn: Address; tokenOut: Address; amountIn: bigint; account: Address; slippageBps: number }): Promise<AggQuote> {
    // 1 bp tighter than allowed so Odos' own rounding of outputMin can never land below our min-out.
    const slip = Math.max(0, Math.floor(args.slippageBps) - 1);
    const body = {
      chainId: this.chainId,
      inputTokens: [{ tokenAddress: args.tokenIn, amount: args.amountIn.toString() }],
      outputTokens: [{ tokenAddress: args.tokenOut, proportion: 1 }],
      userAddr: args.account,
      slippageLimitPercent: slip / 100,
      compact: false,
    };
    const url = `${this.base}/sor/quote/${this.opts.quoteVersion ?? "v3"}`;
    const j = obj(await httpJson(this.fetchImpl, url, { method: "POST", headers: this.headers(), body, timeoutMs: this.opts.timeoutMs }));
    const pathId = str(j?.pathId);
    if (!j || !pathId) throw new Error(`odos quote: no pathId (${JSON.stringify(j ?? null).slice(0, 200)})`);
    const inTokens = arr(j.inTokens).map((x) => str(x));
    const outTokens = arr(j.outTokens).map((x) => str(x));
    if (inTokens.length && (inTokens.length !== 1 || !sameAddr(inTokens[0], args.tokenIn))) throw new Error("odos quote: inTokens mismatch");
    if (outTokens.length && (outTokens.length !== 1 || !sameAddr(outTokens[0], args.tokenOut))) throw new Error("odos quote: outTokens mismatch");
    const amountIn = big(arr(j.inAmounts)[0]);
    const amountOut = big(arr(j.outAmounts)[0]);
    if (amountIn !== args.amountIn) throw new Error(`odos quote: inAmounts[0] ${String(arr(j.inAmounts)[0])} != requested ${args.amountIn}`);
    if (!amountOut) throw new Error(`odos quote: bad outAmounts ${JSON.stringify(j.outAmounts)}`);
    const now = this.now();
    return {
      aggregator: "odos",
      chain: this.chain,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn,
      amountOut,
      route: `odos:${pathId.slice(0, 10)}`,
      quotedAtMs: now,
      validUntilMs: now + (this.opts.quoteTtlMs ?? 50_000),
      apiUsd: { out: num(j.netOutValue), gas: num(j.gasEstimateValue) },
      raw: { pathId, slippageBps: slip } satisfies OdosRaw,
    };
  }

  private async assemble(pathId: string, account: Address): Promise<BuiltTx> {
    const url = `${this.base}/sor/assemble`;
    const j = obj(await httpJson(this.fetchImpl, url, { method: "POST", headers: this.headers(), body: { userAddr: account, pathId, simulate: false }, timeoutMs: this.opts.timeoutMs }));
    const tx = obj(j?.transaction);
    const to = str(tx?.to);
    const data = str(tx?.data);
    if (!tx || !to || !data || !/^0x[0-9a-fA-F]*$/.test(data)) throw new Error(`odos assemble: malformed transaction (${JSON.stringify(j ?? null).slice(0, 200)})`);
    const from = str(tx.from);
    if (from && !sameAddr(from, account)) throw new Error(`odos assemble: transaction.from ${from} is not our account`);
    const value = big(tx.value ?? "0");
    if (value === undefined) throw new Error(`odos assemble: bad value ${String(tx.value)}`);
    return { to: getAddress(to) as Address, data: data as Hex, value, expectedOut: big(obj(arr(j?.outputTokens)[0])?.amount) };
  }

  async build(q: AggQuote, args: { account: Address; minOut: bigint }): Promise<BuiltTx> {
    let raw = q.raw as OdosRaw;
    const allowed = slippageBpsFor(q.amountOut, args.minOut);
    if (allowed < 0) throw new Error(`odos: quote out ${q.amountOut} < required min-out ${args.minOut}`);
    if (this.now() > q.validUntilMs || allowed - 1 < raw.slippageBps) {
      // pathId expired, or the min-out now asked for is tighter than the quote's: re-quote once
      // with the slippage the ORIGINAL quote allows. If the price moved against us the router's
      // outputMin ends up below our min-out and the adapter rejects the calldata.
      const r = await this.quote({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, account: args.account, slippageBps: allowed });
      raw = r.raw as OdosRaw;
    }
    return this.assemble(raw.pathId, args.account);
  }

  decode(data: Hex): DecodedSwap {
    const d = decodeFunctionData({ abi: ODOS_ROUTER_V2_ABI, data });
    if (d.functionName !== "swap") throw new Error(`odos: unexpected router function ${d.functionName}`);
    const t = d.args[0];
    return {
      fn: "swap",
      srcToken: t.inputToken,
      dstToken: t.outputToken,
      amountIn: t.inputAmount,
      minOut: t.outputMin,
      recipient: t.outputReceiver,
      feeTotal: 0n,
      unexpected: t.outputMin > t.outputQuote ? "outputMin > outputQuote" : undefined,
    };
  }

  async verifyRouter(env: EvmEnv, router: Address): Promise<string[]> {
    const code = await env.publicClient.getCode({ address: router });
    if (!code || code === "0x") return [`odos router ${router} has no code on ${env.chain}`];
    try {
      await env.publicClient.readContract({ address: router, abi: ODOS_ROUTER_V2_ABI, functionName: "swapMultiFee" });
    } catch (e) {
      return [`odos router ${router}: swapMultiFee() call failed (${(e as Error).message.split("\n")[0]}) — not an OdosRouterV2?`];
    }
    return [];
  }
}
