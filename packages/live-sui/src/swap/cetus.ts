/**
 * Cetus aggregator (router v3) as a PtbSwapper: quote via the aggregator API
 * (by amount in), append the swap into any PTB.
 *
 * SDK: @cetusprotocol/aggregator-sdk 1.7.5, whose @mysten/sui is overridden to
 * the shared 2.38.0 (root package.json "overrides"), so its Transaction /
 * TransactionObjectArgument / SuiGrpcClient are the same types as ours.
 *
 * Min-out enforcement (two independent on-chain checks):
 *  1. Aggregator contract: routerSwapWithMaxAmountIn passes
 *     (quoteAmountOut = route amountOut, slippage = floor ppm of
 *     (amountOut - minOut) / amountOut) to `router::new_swap_context_v3`;
 *     `router::confirm_swap_v3` aborts (errors code 1,
 *     AmountOutSlippageCheckFailed) below its derived limit. The v3 Move
 *     source is not public, so the exact limit formula is not verifiable here.
 *  2. Ours, framework-only: right after confirm_swap_v3 we append
 *     SplitCoins(out, [minOut]) + MergeCoins(out, [piece]). SplitCoins fails
 *     the whole PTB (InsufficientCoinBalance) when out < minOut, so minOut
 *     holds exactly regardless of the aggregator's slippage semantics, overlay
 *     fees or a compromised router API.
 * Also: maxAmountIn = quote.amountIn (contract code 7, ExceedMaxAmountIn) so a
 * larger coin than quoted is never swapped.
 *
 * Trust boundary: the router API chooses the Move call targets (package ids in
 * route.packages / path.publishedAt) and the type arguments. We check the
 * route's coin types, providers and hops; pin packages with `allowedPackages`
 * for full control. Loss through a bad route is bounded by minOut either way.
 */
import {
  AFTERMATH,
  AggregatorClient,
  BLUEFIN,
  CETUS,
  DEEPBOOKV3,
  Env,
  FLOWXV3,
  KRIYAV3,
  MOMENTUM,
  TURBOS,
  getAllProviders,
  type FindRouterParams,
  type RouterDataV3,
} from "@cetusprotocol/aggregator-sdk";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  type PtbSwapQuote,
  type PtbSwapper,
  type SuiEnv,
  type Transaction,
  type TransactionObjectArgument,
} from "../common.js";
import { SwapRejected, contractSlippageFor, costBpsVsOracle, describeRoute, sameCoinType, validateRoute, type RouteSummary } from "./math.js";

/**
 * Conservative default allowlist: on-chain AMM / CLMM / order-book venues that
 * need no off-chain oracle update (no Pyth-based PMMs) and no signed RFQ
 * (CETUS_TIDE). Names come from the SDK's exported constants.
 */
export const DEFAULT_PROVIDERS: readonly string[] = [CETUS, BLUEFIN, MOMENTUM, DEEPBOOKV3, TURBOS, FLOWXV3, KRIYAV3, AFTERMATH];

/** The slice of AggregatorClient this module uses (mockable in tests). */
export type AggregatorLike = Pick<AggregatorClient, "findRouters" | "routerSwapWithMaxAmountIn">;

/** Build the SDK client on our shared gRPC client. No partner / overlay fee (overlay fees would skew the min-out math). */
export function createCetusAggregatorClient(env: Pick<SuiEnv, "grpc" | "address" | "network">, opts: { endpoint?: string; apiKey?: string } = {}): AggregatorClient {
  return new AggregatorClient({
    client: env.grpc,
    signer: env.address,
    env: env.network === "testnet" ? Env.Testnet : Env.Mainnet,
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
  });
}

/** Coin decimals from on-chain CoinMetadata, cached per type. */
export function coinDecimalsFromChain(env: Pick<SuiEnv, "grpc">): (coinType: string) => Promise<number> {
  const cache = new Map<string, Promise<number>>();
  return (coinType) => {
    const t = normalizeStructTag(coinType);
    let p = cache.get(t);
    if (!p) {
      p = env.grpc.core.getCoinMetadata({ coinType: t }).then((r) => {
        if (!r.coinMetadata) throw new Error(`no CoinMetadata for ${t}`);
        return r.coinMetadata.decimals;
      });
      p.catch(() => cache.delete(t));
      cache.set(t, p);
    }
    return p;
  };
}

export interface CetusPtbSwapperOptions {
  aggregator: AggregatorLike;
  /** Oracle USD price of a coin type (NOT derived from the route). */
  refPriceUsd: (coinType: string) => Promise<number>;
  /** Decimals of a coin type (e.g. coinDecimalsFromChain(env)). */
  decimals: (coinType: string) => Promise<number>;
  /** Reject quotes costing more than this vs oracle (fees + impact), bps. */
  maxCostBps: number;
  /** Allowed providers (SDK names). Default DEFAULT_PROVIDERS. */
  providers?: readonly string[];
  /** Max hops along any branch of the route. Default 2. */
  maxHops?: number;
  /** Pin the Move packages a route may call (aggregator_v3 + per-DEX wrappers). Off by default. */
  allowedPackages?: readonly string[];
  /** appendSwap refuses quotes older than this. Default 30s. */
  quoteTtlMs?: number;
  /** maxAmountIn = amountIn * (1 + slackBps/1e4) (contract-enforced). Default 0 = exactly the quoted amount. */
  maxAmountInSlackBps?: number;
  now?: () => number;
}

/** routeData carried by PtbSwapQuote from CetusPtbSwapper. */
export interface CetusRouteData {
  source: "cetus-aggregator";
  router: RouterDataV3;
  fromType: string;
  toType: string;
  quotedAtMs: number;
  summary: RouteSummary;
  /** Reference values used for costBps (for logs). */
  ref: { priceInUsd: number; priceOutUsd: number; decimalsIn: number; decimalsOut: number };
}

export class CetusPtbSwapper implements PtbSwapper {
  private readonly providers: string[];
  private readonly allowedProviders: ReadonlySet<string>;
  private readonly allowedPackages?: ReadonlySet<string>;
  private readonly maxHops: number;
  private readonly ttlMs: number;
  private readonly slackBps: number;
  private readonly now: () => number;
  /** routeData objects issued by this instance (appendSwap only accepts these). */
  private readonly issued = new WeakSet<object>();

  constructor(private readonly o: CetusPtbSwapperOptions) {
    if (!Number.isFinite(o.maxCostBps)) throw new Error("CetusPtbSwapper: maxCostBps must be a finite number");
    const known = new Set(getAllProviders());
    this.providers = [...(o.providers ?? DEFAULT_PROVIDERS)];
    if (!this.providers.length) throw new Error("CetusPtbSwapper: provider allowlist is empty");
    for (const p of this.providers) if (!known.has(p)) throw new Error(`CetusPtbSwapper: unknown provider "${p}" (SDK knows: ${[...known].join(",")})`);
    this.allowedProviders = new Set(this.providers);
    this.allowedPackages = o.allowedPackages ? new Set(o.allowedPackages.map((a) => normalizeSuiAddress(a))) : undefined;
    this.maxHops = o.maxHops ?? 2;
    if (!Number.isInteger(this.maxHops) || this.maxHops < 1) throw new Error(`CetusPtbSwapper: maxHops must be an integer >= 1`);
    this.ttlMs = o.quoteTtlMs ?? 30_000;
    this.slackBps = o.maxAmountInSlackBps ?? 0;
    if (!(this.slackBps >= 0 && this.slackBps <= 10_000)) throw new Error("CetusPtbSwapper: maxAmountInSlackBps out of range");
    this.now = o.now ?? Date.now;
  }

  async quote(fromType: string, toType: string, amountIn: bigint): Promise<PtbSwapQuote> {
    const from = normalizeStructTag(fromType);
    const to = normalizeStructTag(toType);
    if (from === to) throw new SwapRejected(`cetus: from == to (${from})`);
    if (amountIn <= 0n) throw new SwapRejected(`cetus: amountIn must be > 0 (got ${amountIn})`);

    const params: FindRouterParams = { from, target: to, amount: amountIn, byAmountIn: true, depth: this.maxHops, providers: this.providers };
    const router = await this.o.aggregator.findRouters(params);
    if (!router) throw new SwapRejected(`cetus: no response from aggregator for ${from} -> ${to}`);
    if (router.error) throw new SwapRejected(`cetus: aggregator error ${router.error.code}: ${router.error.msg}`);
    if (router.insufficientLiquidity) throw new SwapRejected(`cetus: insufficient liquidity for ${amountIn} ${from} -> ${to}`);
    if (!router.byAmountIn) throw new SwapRejected("cetus: route is not by-amount-in");
    if (!router.quoteID) throw new SwapRejected("cetus: route has no quoteID");

    const summary = validateRoute(router, { fromType: from, toType: to, allowedProviders: this.allowedProviders, maxHops: this.maxHops, allowedPackages: this.allowedPackages });
    const rIn = BigInt(router.amountIn.toString());
    const rOut = BigInt(router.amountOut.toString());
    if (rIn !== amountIn) throw new SwapRejected(`cetus: route amountIn ${rIn} != requested ${amountIn} (partial route)`);
    if (rOut <= 0n) throw new SwapRejected("cetus: route amountOut is 0");

    const [decimalsIn, decimalsOut, priceInUsd, priceOutUsd] = await Promise.all([
      this.o.decimals(from),
      this.o.decimals(to),
      this.o.refPriceUsd(from),
      this.o.refPriceUsd(to),
    ]);
    const costBps = costBpsVsOracle({ amountIn, decimalsIn, priceInUsd, amountOut: rOut, decimalsOut, priceOutUsd });
    if (costBps > this.o.maxCostBps) {
      throw new SwapRejected(`cetus: ${describeRoute(summary)} costs ${costBps.toFixed(2)} bps vs oracle > max ${this.o.maxCostBps}`);
    }
    const routeData: CetusRouteData = {
      source: "cetus-aggregator",
      router,
      fromType: from,
      toType: to,
      quotedAtMs: this.now(),
      summary,
      ref: { priceInUsd, priceOutUsd, decimalsIn, decimalsOut },
    };
    this.issued.add(routeData);
    return { amountIn, amountOut: rOut, costBps, routeData };
  }

  /** Human-readable route of a quote from this swapper. */
  describe(q: PtbSwapQuote): string {
    return describeRoute(this.routeDataOf(q).summary);
  }

  routeDataOf(q: PtbSwapQuote): CetusRouteData {
    const rd = q.routeData as CetusRouteData | undefined;
    if (!rd || typeof rd !== "object" || rd.source !== "cetus-aggregator" || !this.issued.has(rd)) {
      throw new SwapRejected("cetus: quote.routeData was not produced by this CetusPtbSwapper");
    }
    return rd;
  }

  async appendSwap(
    tx: Transaction,
    args: { fromType: string; toType: string; coinIn: TransactionObjectArgument; quote: PtbSwapQuote; minOut: bigint }
  ): Promise<TransactionObjectArgument> {
    const rd = this.routeDataOf(args.quote);
    if (!sameCoinType(args.fromType, rd.fromType) || !sameCoinType(args.toType, rd.toType)) {
      throw new SwapRejected(`cetus: appendSwap ${args.fromType} -> ${args.toType} does not match quote ${rd.fromType} -> ${rd.toType}`);
    }
    const rIn = BigInt(rd.router.amountIn.toString());
    const rOut = BigInt(rd.router.amountOut.toString());
    if (args.quote.amountIn !== rIn || args.quote.amountOut !== rOut) throw new SwapRejected("cetus: quote amounts differ from its route data");
    const age = this.now() - rd.quotedAtMs;
    if (age > this.ttlMs) throw new SwapRejected(`cetus: quote is ${age} ms old (> ${this.ttlMs} ms); re-quote`);

    // throws on minOut <= 0 or minOut > amountOut
    const slippage = contractSlippageFor(rOut, args.minOut);
    const maxIn = rIn + (rIn * BigInt(Math.round(this.slackBps * 100))) / 1_000_000n;
    // reuse the SDK's own (bundled) BN class for maxAmountIn
    const BNCtor = rd.router.amountIn.constructor as new (n: string, base?: number) => RouterDataV3["amountIn"];
    const out = await this.o.aggregator.routerSwapWithMaxAmountIn({
      router: rd.router,
      inputCoin: args.coinIn,
      slippage,
      txb: tx,
      maxAmountIn: new BNCtor(maxIn.toString(), 10),
    });
    // framework-level min-out guard: aborts the PTB if out < minOut
    const [piece] = tx.splitCoins(out, [args.minOut]);
    tx.mergeCoins(out, [piece!]);
    return out;
  }
}
