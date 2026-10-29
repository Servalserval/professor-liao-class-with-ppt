import type { Address, EvmEnv, Hex } from "@incentive-router/live-evm-base";

export type AggregatorName = "kyberswap" | "odos";

/** Normalized quote from one aggregator API (amounts already checked against the request). */
export interface AggQuote {
  aggregator: AggregatorName;
  chain: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  /** Router the API says it will use (KyberSwap returns it with the route; Odos only at assemble). */
  router?: Address;
  route: string;
  quotedAtMs: number;
  validUntilMs: number;
  /** The API's own USD numbers — logged for comparison only, never used for costBps. */
  apiUsd?: { in?: number; out?: number; gas?: number };
  /** Aggregator-specific data needed to build exactly this route (KyberSwap routeSummary / Odos pathId). */
  raw: unknown;
}

/** Transaction returned by the aggregator's build/assemble endpoint (UNTRUSTED until verified). */
export interface BuiltTx {
  to: Address;
  data: Hex;
  value: bigint;
  /** Output the API expects at build time (informational). */
  expectedOut?: bigint;
}

/** What we could decode out of the router calldata; every field is checked by the adapter. */
export interface DecodedSwap {
  fn: string;
  srcToken: Address;
  dstToken: Address;
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
  /** Sum of explicit fee amounts encoded in the call (must be 0: we never ask for fees). */
  feeTotal: bigint;
  /** Extra data that must be empty (e.g. KyberSwap permit). */
  unexpected?: string;
}

export interface AggregatorClient {
  readonly name: AggregatorName;
  readonly chain: string;
  quote(args: { tokenIn: Address; tokenOut: Address; amountIn: bigint; account: Address; slippageBps: number }): Promise<AggQuote>;
  /**
   * Build calldata for `q` such that the router enforces at least `minOut`
   * on-chain. May re-quote internally when the quote expired; the result is
   * still verified by the adapter against the ORIGINAL quote's min-out.
   */
  build(q: AggQuote, args: { account: Address; minOut: bigint }): Promise<BuiltTx>;
  /** Decode router calldata. Throws on any function we cannot fully verify. */
  decode(data: Hex): DecodedSwap;
  /** On-chain sanity check of one allowlisted router. Returns issues (empty = ok). */
  verifyRouter(env: EvmEnv, router: Address): Promise<string[]>;
}

/**
 * Largest slippage (bps, integer) such that `expectedOut * (1 - bps/1e4) >= minOut`.
 * Returns -1 when expectedOut < minOut (cannot satisfy).
 */
export function slippageBpsFor(expectedOut: bigint, minOut: bigint): number {
  if (expectedOut <= 0n || expectedOut < minOut) return -1;
  return Number(((expectedOut - minOut) * 10_000n) / expectedOut);
}
