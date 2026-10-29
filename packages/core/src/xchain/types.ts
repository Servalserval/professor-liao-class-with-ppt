/**
 * Cross-chain funding contracts shared by the core (planner, friction
 * budget, router) and the live bridge adapters.
 *
 * Friction rule (the user's requirement): the all-in cost of moving money to
 * where it will be deployed — bridge fee + source gas + destination gas +
 * swap slippage + interest lost while in transit — must not exceed ONE DAY of
 * the net yield that money will earn at its destination. On top of that, all
 * cross-chain costs paid in any rolling 24h window must not exceed one day of
 * the whole book's expected yield.
 */

export interface ChainAsset {
  chain: string;
  asset: string; // canonical symbol: USDC, USDT, USDT0, USDsui ...
}

export type RouteKind =
  | "cctp_v2_fast"
  | "cctp_v2_standard"
  | "cctp_v1"
  | "usdt0_oft"
  | "wormhole"
  | "across"
  | "stargate"
  | "cex"
  | "swap" // same-chain stable swap (USDC <-> USDT ...)
  | "noop";

export interface RouteSpec {
  id: string;
  kind: RouteKind;
  from: ChainAsset;
  to: ChainAsset;
  /** Proportional fee (bridge protocol fee, swap slippage+fee), bps of amount. */
  feeBps: number;
  /** Fixed protocol fee in USD (e.g. LayerZero native fee, CEX withdrawal fee). */
  feeFixedUsd: number;
  gasSrcUsd: number;
  gasDstUsd: number;
  etaMinutes: number;
  minUsd?: number;
  maxUsd?: number;
  enabled: boolean;
  /** Free text: trust assumptions, who can freeze it. */
  notes?: string;
}

export interface FundingQuote {
  ok: boolean;
  /** Ordered hops (empty when the money is already there). */
  path: RouteSpec[];
  /** All-in cost incl. transit opportunity cost, USD. */
  costUsd: number;
  etaMinutes: number;
  /** Where the money comes from. */
  source?: ChainAsset;
  reason?: string;
}

export type TransferState = "planned" | "submitted" | "in_flight" | "claimable" | "completed" | "failed" | "stuck";

export interface InFlightTransfer {
  id: string;
  /** The opportunity this money is earmarked for (re-planned if it is gone on arrival). */
  forOppId?: string;
  path: RouteSpec[];
  hop: number;
  amountUsd: number;
  costUsd: number;
  state: TransferState;
  createdAtMs: number;
  updatedAtMs: number;
  /** Adapter-specific handle (tx hash, CCTP nonce, LayerZero guid ...). */
  ref?: string;
  detail?: string;
}

/**
 * Router-level bridge executor (USD interface). Live implementations live in
 * packages/live-bridges and convert to token amounts there.
 */
export interface BridgeExecutor {
  /** Start hop `t.hop` of the transfer. */
  send(t: InFlightTransfer): Promise<{ ok: boolean; ref?: string; detail?: string }>;
  /** Poll; may complete a "claimable" hop (e.g. CCTP receiveMessage on the destination). */
  poll(t: InFlightTransfer): Promise<{ state: TransferState; ref?: string; detail?: string; receivedUsd?: number }>;
}
