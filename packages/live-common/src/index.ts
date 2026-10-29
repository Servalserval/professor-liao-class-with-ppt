/**
 * Contracts shared by every live package. NO chain SDK imports here: the Sui
 * SDKs pin incompatible @mysten/sui majors, so each protocol package brings
 * its own SDK and only exchanges plain data through these interfaces.
 *
 * Conventions
 *  - Token amounts cross package boundaries as base-unit bigint + decimals.
 *  - USD values are numbers. APRs are yearly fractions.
 *  - Every write method honours `ctx.dryRun`: build + simulate, never broadcast.
 */
import type { LoopPair } from "@incentive-router/core";

export * from "./chains.js";
export * from "./keys.js";
export * from "./money.js";

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetRef {
  chain: string;
  /** Canonical symbol used by the core for caps (USDC, USDT, USDT0, USDsui ...). */
  symbol: string;
  /** EVM: checksummed 0x address. Sui: normalized coin type (0x...::module::NAME). */
  address: string;
  decimals: number;
}

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

export interface LiveLimits {
  /** Refuse a single transaction whose estimated gas exceeds this (USD) per chain. */
  maxGasUsd: Record<string, number>;
  /** Max slippage for swaps, bps. */
  maxSlippageBps: number;
  /** Max loop iterations when a protocol cannot loop atomically. */
  maxLoopIterations: number;
}

export interface LiveContext {
  /** true = build and simulate only; never sign+broadcast. Default must be true. */
  dryRun: boolean;
  log: Logger;
  limits: LiveLimits;
  /** USD price of an asset (stables usually ~1; adapters must not assume 1). */
  priceUsd(asset: AssetRef): Promise<number>;
  /** USD price of the chain's native gas token. */
  nativePriceUsd(chain: string): Promise<number>;
}

export interface TxRecord {
  chain: string;
  /** Tx hash / Sui digest. Absent in dry-run. */
  id?: string;
  description: string;
  gasUsd?: number;
  simulated: boolean;
}

export interface LiveResult {
  ok: boolean;
  txs: TxRecord[];
  detail?: string;
  /** Adapter-specific measured values (e.g. USD actually deployed / returned). */
  amountUsd?: number;
}

// ---------------------------------------------------------------------------
// Lending
// ---------------------------------------------------------------------------

export interface LoopPositionView {
  pairId: string;
  collateralUsd: number;
  debtUsd: number;
  /** debt / collateral using oracle prices of the protocol. */
  ltv: number;
  /** Protocol health factor if it has one (>1 = safe). */
  healthFactor?: number;
  /** collateralUsd - debtUsd */
  equityUsd: number;
  rewardsUnclaimed: { token: string; amount: bigint; decimals: number; usd: number }[];
  /** Block / checkpoint time of the read. */
  asOfMs: number;
}

/**
 * One lending protocol deployment (protocol x chain). Implementations:
 * packages/live-sui-navi, live-sui-suilend, live-sui-scallop, live-evm (Aave v3
 * family, Morpho Blue family, ...).
 */
export interface LendingAdapter {
  /** e.g. "navi", "suilend", "aave-v3:arbitrum", "morpho:base". Used as venue id in the core. */
  readonly id: string;
  readonly chain: string;
  /** Read every loopable pair this adapter is configured for (same-asset + configured stable pairs). */
  markets(): Promise<LoopPair[]>;
  /** Read my position in a pair (null when none). */
  position(pairId: string): Promise<LoopPositionView | null>;
  /**
   * Open or add to a loop: deposit `equity` of the collateral asset (base
   * units, must already be in the wallet on this chain) and lever up to
   * `targetLtv`. Must refuse if the post-trade LTV would exceed the pair's maxLtv.
   */
  open(pairId: string, equity: bigint, targetLtv: number, ctx: LiveContext): Promise<LiveResult>;
  /** Unwind `fraction` (0..1] of the position, returning collateral asset to the wallet. 1 = fully closed, debt 0. */
  close(pairId: string, fraction: number, ctx: LiveContext): Promise<LiveResult>;
  /** Bring LTV down to `targetLtv` without closing. */
  deleverage(pairId: string, targetLtv: number, ctx: LiveContext): Promise<LiveResult>;
  /** Build and simulate a full close without broadcasting. true = the exit path works right now. */
  simulateClose(pairId: string, ctx: LiveContext): Promise<boolean>;
  /** Claim all claimable rewards for the wallet (optionally one pair). */
  claimRewards(ctx: LiveContext, pairId?: string): Promise<LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] }>;
  /** Wallet balance of an asset on this chain (base units). */
  walletBalance(asset: AssetRef): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Swaps (same chain)
// ---------------------------------------------------------------------------

export interface SwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  /** Effective cost vs oracle prices, bps (fees + price impact). */
  costBps: number;
  route: string;
  validUntilMs: number;
  /** Opaque data the adapter needs to execute exactly this quote. */
  payload?: unknown;
}

export interface SwapAdapter {
  readonly id: string;
  readonly chain: string;
  quote(from: AssetRef, to: AssetRef, amountIn: bigint, ctx: LiveContext): Promise<SwapQuote>;
  /** Execute a quote with min-out protection = amountOut * (1 - maxSlippageBps). */
  swap(q: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext): Promise<LiveResult>;
}

// ---------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------

export interface BridgeQuote {
  amountIn: bigint;
  /** Minimum received on the destination, base units of the destination asset. */
  minAmountOut: bigint;
  feeUsd: number;
  gasSrcUsd: number;
  /** Estimated gas to complete on the destination (0 if relayed for free). */
  gasDstUsd: number;
  etaSeconds: number;
}

export type BridgeStatus =
  | { state: "pending" }
  | { state: "claimable"; detail?: string }
  | { state: "completed"; dstTx?: string; received?: bigint }
  | { state: "failed"; detail: string };

export interface BridgeAdapter {
  /** e.g. "cctp_v2_fast", "usdt0_oft" — matches core RouteKind. */
  readonly kind: string;
  supports(from: AssetRef, to: AssetRef): boolean;
  quote(from: AssetRef, to: AssetRef, amount: bigint, ctx: LiveContext): Promise<BridgeQuote>;
  /** Send to our own address on the destination chain. Returns a handle for status(). */
  send(from: AssetRef, to: AssetRef, amount: bigint, recipient: string, ctx: LiveContext): Promise<LiveResult & { handle?: string }>;
  status(handle: string, ctx: LiveContext): Promise<BridgeStatus>;
  /** Finish a claimable transfer when the protocol needs a destination tx (e.g. CCTP receiveMessage). */
  complete?(handle: string, ctx: LiveContext): Promise<LiveResult>;
}

// ---------------------------------------------------------------------------
// Rewards distribution (Merkl etc.)
// ---------------------------------------------------------------------------

export interface RewardClaimer {
  readonly id: string;
  readonly chain: string;
  claimable(owner: string): Promise<{ token: AssetRef; amount: bigint }[]>;
  claim(owner: string, ctx: LiveContext): Promise<LiveResult>;
}

// ---------------------------------------------------------------------------
// External reward rates (Merkl campaigns etc.) injected into lending market data
// ---------------------------------------------------------------------------

import type { RewardRate } from "@incentive-router/core";

export interface RewardRateQuery {
  /** Lending protocol id as used by the core venue (e.g. "aave-v3", "morpho", "euler-v2"). */
  protocol: string;
  chain: string;
  asset: AssetRef;
  side: "supply" | "borrow" | "collateral";
  /** Protocol market identifier when assets alone are ambiguous (Morpho market id, Euler vault ...). */
  marketId?: string;
}

/** Returns extra reward streams (APR on the side's pool, yearly fraction) for a market side. */
export type RewardRateProvider = (q: RewardRateQuery) => Promise<RewardRate[]>;
