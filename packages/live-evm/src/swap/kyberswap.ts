/**
 * KyberSwap Aggregator API v1 client (primary aggregator; works without an API key).
 *
 * Docs (read 2026-10-29):
 *   https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps
 *   https://docs.kyberswap.com/developer-guide/aggregator-api/how-to-guides/execute-a-swap-with-the-aggregator-api
 *   demo: https://github.com/KyberNetwork/ks-aggregator-api-demo (src/apis/V1Get.ts, V1Post.ts)
 *
 * Endpoints / fields relied on:
 *   GET  {base}/{chain}/api/v1/routes?tokenIn&tokenOut&amountIn[&excludeRFQSources&gasInclude]
 *        header X-Client-Id (required on GET; stricter rate limit without it)
 *        -> data.routerAddress, data.routeSummary.{tokenIn,tokenOut,amountIn,amountOut,amountInUsd,amountOutUsd,gasUsd,route,routeID}
 *   POST {base}/{chain}/api/v1/route/build
 *        body { routeSummary (verbatim), sender, recipient, slippageTolerance (bps, 0..2000), deadline (unix s), source, origin }
 *        -> data.{routerAddress, data (calldata), amountIn, amountOut, transactionValue}
 *   base = https://aggregator-api.kyberswap.com (keyless, rate-limited). The keyed gateway
 *   https://api.kyberswap.com/swap (X-Api-Key) can be configured via baseUrl + apiKey.
 *
 * Calldata is decoded with the MetaAggregationRouterV2 ABI below so the
 * recipient, tokens, amount, min-out and fees are verified before anything is signed.
 */
import { decodeFunctionData, getAddress, parseAbi } from "viem";
import type { Address, EvmEnv, Hex } from "@incentive-router/live-evm-base";
import { KYBERSWAP_CHAIN_PATHS } from "./addresses.js";
import { big, httpJson, num, obj, sameAddr, str, type HttpFetch } from "./http.js";
import { slippageBpsFor, type AggQuote, type AggregatorClient, type BuiltTx, type DecodedSwap } from "./types.js";

/**
 * MetaAggregationRouterV2 (0x6131B5fa…37b5) swap entry points + one getter.
 * SOURCE: Etherscan-verified source of 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5, as
 * re-published in npm @gitmyabi/metaaggregationrouterv2@1.0.0 contracts/MetaAggregationRouterV2_json.ts
 * (swap / swapGeneric / swapSimpleMode / WETH signatures copied from that ABI JSON).
 */
export const KYBER_META_ROUTER_V2_ABI = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapGeneric(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
  "function WETH() view returns (address)",
]);

export interface KyberSwapOptions {
  /** Default https://aggregator-api.kyberswap.com */
  baseUrl?: string;
  /** Sent as X-Client-Id (and `source` in build). Default "incentive-router". */
  clientId?: string;
  /** Only for the keyed gateway. */
  apiKey?: string;
  /** Default true: RFQ legs need fresh maker quotes at build time and fail more often. */
  excludeRFQSources?: boolean;
  /** Build deadline, seconds from now. Default 600. */
  deadlineSec?: number;
  /** Quote validity we report (KyberSwap: do not cache routes > 5-10 s). Default 10_000. */
  quoteTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

interface KyberRaw {
  routeSummary: Record<string, unknown>;
}

export class KyberSwapClient implements AggregatorClient {
  readonly name = "kyberswap" as const;
  private readonly base: string;
  private readonly path: string;
  private readonly now: () => number;

  constructor(
    readonly chain: string,
    private readonly opts: KyberSwapOptions = {},
    private readonly fetchImpl: HttpFetch
  ) {
    const p = KYBERSWAP_CHAIN_PATHS[chain];
    if (!p) throw new Error(`kyberswap: chain ${chain} not supported`);
    this.path = p;
    this.base = (opts.baseUrl ?? "https://aggregator-api.kyberswap.com").replace(/\/+$/, "");
    this.now = opts.now ?? Date.now;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "X-Client-Id": this.opts.clientId ?? "incentive-router" };
    if (this.opts.apiKey) h["X-Api-Key"] = this.opts.apiKey;
    return h;
  }

  async quote(args: { tokenIn: Address; tokenOut: Address; amountIn: bigint; account: Address; slippageBps: number }): Promise<AggQuote> {
    const qs = new URLSearchParams({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn: args.amountIn.toString(),
      gasInclude: "true",
    });
    if (this.opts.excludeRFQSources ?? true) qs.set("excludeRFQSources", "true");
    const url = `${this.base}/${this.path}/api/v1/routes?${qs}`;
    const j = obj(await httpJson(this.fetchImpl, url, { headers: this.headers(), timeoutMs: this.opts.timeoutMs }));
    const data = obj(j?.data);
    const rs = obj(data?.routeSummary);
    if (!data || !rs) throw new Error(`kyberswap routes: no routeSummary (code ${String(j?.code)}: ${String(j?.message ?? "")})`);
    const amountIn = big(rs.amountIn);
    const amountOut = big(rs.amountOut);
    if (amountIn !== args.amountIn) throw new Error(`kyberswap routes: amountIn ${String(rs.amountIn)} != requested ${args.amountIn}`);
    if (!sameAddr(str(rs.tokenIn), args.tokenIn) || !sameAddr(str(rs.tokenOut), args.tokenOut))
      throw new Error(`kyberswap routes: token mismatch (${String(rs.tokenIn)} -> ${String(rs.tokenOut)})`);
    if (amountOut === undefined || amountOut === 0n) throw new Error(`kyberswap routes: bad amountOut ${String(rs.amountOut)}`);
    const routerStr = str(data.routerAddress);
    const now = this.now();
    const hops = Array.isArray(rs.route) ? (rs.route as unknown[]).flat().map((h) => str(obj(h)?.exchange)).filter((x): x is string => !!x) : [];
    return {
      aggregator: "kyberswap",
      chain: this.chain,
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      amountIn,
      amountOut,
      router: routerStr ? (getAddress(routerStr) as Address) : undefined,
      route: [...new Set(hops)].join("+") || "kyberswap",
      quotedAtMs: now,
      validUntilMs: now + (this.opts.quoteTtlMs ?? 10_000),
      apiUsd: { in: num(rs.amountInUsd), out: num(rs.amountOutUsd), gas: num(rs.gasUsd) },
      raw: { routeSummary: rs } satisfies KyberRaw,
    };
  }

  private async buildOnce(rs: Record<string, unknown>, account: Address, slippageBps: number): Promise<BuiltTx & { router: Address }> {
    if (!(slippageBps >= 0 && slippageBps <= 2000)) throw new Error(`kyberswap build: slippage ${slippageBps} bps outside [0, 2000]`);
    const url = `${this.base}/${this.path}/api/v1/route/build`;
    const body = {
      routeSummary: rs,
      sender: account,
      recipient: account,
      origin: account,
      slippageTolerance: slippageBps,
      deadline: Math.floor(this.now() / 1000) + (this.opts.deadlineSec ?? 600),
      source: this.opts.clientId ?? "incentive-router",
    };
    const j = obj(await httpJson(this.fetchImpl, url, { method: "POST", headers: this.headers(), body, timeoutMs: this.opts.timeoutMs }));
    const d = obj(j?.data);
    const data = str(d?.data);
    const router = str(d?.routerAddress);
    if (!d || !data || !/^0x[0-9a-fA-F]*$/.test(data) || !router) throw new Error(`kyberswap build: malformed response (code ${String(j?.code)}: ${String(j?.message ?? "")})`);
    const value = big(d.transactionValue ?? "0");
    if (value === undefined) throw new Error(`kyberswap build: bad transactionValue ${String(d.transactionValue)}`);
    return { to: getAddress(router) as Address, router: getAddress(router) as Address, data: data as Hex, value, expectedOut: big(d.amountOut) };
  }

  async build(q: AggQuote, args: { account: Address; minOut: bigint }): Promise<BuiltTx> {
    let rs = (q.raw as KyberRaw).routeSummary;
    let expected = q.amountOut;
    if (this.now() > q.validUntilMs) {
      // Route is stale: re-route the same trade. Min-out stays anchored to the ORIGINAL quote.
      const fresh = await this.quote({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, account: args.account, slippageBps: 0 });
      rs = (fresh.raw as KyberRaw).routeSummary;
      expected = fresh.amountOut;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const slip = slippageBpsFor(expected, args.minOut);
      if (slip < 0) throw new Error(`kyberswap: expected out ${expected} < required min-out ${args.minOut} (price moved)`);
      const built = await this.buildOnce(rs, args.account, slip);
      const dec = this.decode(built.data);
      if (dec.minOut >= args.minOut) return built;
      // KyberSwap derives minReturnAmount from its build-time amountOut; recompute slippage from that once.
      if (built.expectedOut === undefined || built.expectedOut === expected) break;
      expected = built.expectedOut;
    }
    throw new Error(`kyberswap: router min-out below required ${args.minOut}`);
  }

  decode(data: Hex): DecodedSwap {
    const d = decodeFunctionData({ abi: KYBER_META_ROUTER_V2_ABI, data });
    let desc;
    if (d.functionName === "swap" || d.functionName === "swapGeneric") desc = d.args[0].desc;
    else if (d.functionName === "swapSimpleMode") desc = d.args[1];
    else throw new Error(`kyberswap: unexpected router function ${d.functionName}`);
    const feeTotal = desc.feeAmounts.reduce((a, b) => a + b, 0n);
    return {
      fn: d.functionName,
      srcToken: desc.srcToken,
      dstToken: desc.dstToken,
      amountIn: desc.amount,
      minOut: desc.minReturnAmount,
      recipient: desc.dstReceiver,
      feeTotal,
      unexpected: desc.permit !== "0x" ? "permit data present" : undefined,
    };
  }

  async verifyRouter(env: EvmEnv, router: Address): Promise<string[]> {
    const code = await env.publicClient.getCode({ address: router });
    if (!code || code === "0x") return [`kyberswap router ${router} has no code on ${env.chain}`];
    try {
      const weth = await env.publicClient.readContract({ address: router, abi: KYBER_META_ROUTER_V2_ABI, functionName: "WETH" });
      const wcode = await env.publicClient.getCode({ address: weth });
      if (!wcode || wcode === "0x") return [`kyberswap router ${router}: WETH() = ${weth} has no code`];
    } catch (e) {
      return [`kyberswap router ${router}: WETH() call failed (${(e as Error).message.split("\n")[0]}) — not a MetaAggregationRouterV2?`];
    }
    return [];
  }
}
