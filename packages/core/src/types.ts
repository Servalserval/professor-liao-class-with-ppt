/**
 * Core data model of the incentive router.
 *
 * Everything here is chain-agnostic: an adapter (a "source") turns whatever a
 * protocol exposes into an `Opportunity`, and every risk rule only ever looks
 * at `Opportunity` + `Position`. That is the whole trick of the
 * generalization: the loop-farm rules (1/10 entry, 1/5 exit, utilization
 * exit, haircut, caps, hysteresis, cooldown ...) are rewritten against these
 * shapes instead of against a lending market.
 *
 * Conventions
 *  - APR values are yearly fractions (0.05 = 5%/yr), always ON POSITION EQUITY
 *    (i.e. already multiplied by leverage / notional-per-equity).
 *  - USD everywhere. Token amounts never leave the adapters.
 */

import type { FundingQuote } from "./xchain/types.js";

export type Kind = "lending_loop" | "lp_incentive" | "delta_neutral_perp" | "deposit";

/** 1 = blue chip, 2 = established but younger, 3 = new / unverified. */
export type Tier = 1 | 2 | 3;

export type StreamKind =
  | "base" // supply interest, staking yield ...
  | "fee" // LP swap fees
  | "borrow_cost" // negative: interest paid on debt
  | "reward" // incentive token emission (Merkl, protocol incentives ...)
  | "funding" // perp funding received (negative = paid)
  | "points"; // speculative points; never counted in net APR

export interface YieldStream {
  label: string;
  kind: StreamKind;
  /**
   * APR on position equity as a function of MY TOTAL equity in this
   * opportunity (USD, including what I already have). This is where
   * dilution / interest-rate-model impact lives: a fixed emission shared
   * pro-rata gets smaller as I add size, a lending IRM moves with utilization.
   */
  aprAt: (myEquityUsd: number) => number;
  /** Reward token symbol for kind "reward" (used for haircut + exposure caps). */
  rewardToken?: string;
  /** When the stream is known to stop (campaign end / epoch end). */
  endsAtMs?: number | null;
}

/**
 * Where the position's money physically sits. Caps are computed on legs, so a
 * cross-venue perp hedge counts against BOTH venues, a loop counts against
 * one venue, etc. `equityFrac` values of one opportunity should sum to ~1.
 */
export interface Leg {
  venue: string;
  chain: string;
  /** Asset actually held at this venue (net), for per-token caps. */
  token: string;
  equityFrac: number;
}

/**
 * The generalized "withdrawable liquidity".
 *  - lending:  available liquidity (supply - borrow)
 *  - LP:       depth to dump the volatile side within the configured impact
 *  - perp:     min order-book depth of both venues within X bps
 * `footprintPerEquity` is how much of that capacity one USD of my equity needs
 * on the way out (gross supply L for a loop, notional/equity for perps ...).
 */
export interface LiquidityView {
  exitCapacityUsd: number;
  footprintPerEquity: number;
  /** true when the capacity is a guess (discovery sources). */
  estimated?: boolean;
}

/** A level-type risk signal reported by the source (utilization, basis ...). */
export interface StressSignal {
  name: string;
  value: number;
  warnAt: number;
  exitAt: number;
  direction: "above" | "below";
}

/** A discrete condition (market paused, withdrawals disabled, depeg ...). */
export interface Flag {
  name: string;
  severity: "warn" | "exit";
  detail?: string;
}

/** Position health (loop LTV, perp liquidation distance ...). */
export interface HealthView {
  metric: string;
  value: number;
  rebalanceAt: number;
  criticalAt: number;
  direction: "above" | "below";
}

export interface CostModel {
  /** One-off costs as a fraction of the equity moved. */
  entryFrac: number;
  exitFrac: number;
  /** One-off fixed costs (gas, bridge). */
  fixedEntryUsd: number;
  fixedExitUsd: number;
  /** Running costs not already inside a stream (LVR, hedge funding, volume-farming fees). */
  ongoingApr: number;
}

export interface Opportunity {
  id: string;
  sourceId: string;
  kind: Kind;
  name: string;
  /** Venue whose tier governs entry thresholds. */
  primaryVenue: string;
  chain: string;
  legs: Leg[];
  streams: YieldStream[];
  costs: CostModel;
  liquidity: LiquidityView;
  signals: StressSignal[];
  /**
   * Signals as they would look after I hold `myEquityUsd` (e.g. utilization
   * after my loop is in). Entry is refused if any would be at warn level.
   */
  projectedSignals?: (myEquityUsd: number) => StressSignal[];
  flags: Flag[];
  /** Raw numbers worth tracking over time (borrow_apr, tvl ...) for spike rules. */
  metrics: Record<string, number>;
  health?: HealthView;
  /** Hard size limit from the protocol side (supply cap headroom, max OI ...). */
  maxEquityUsd?: number;
  /**
   * What must be on hand to enter: the asset (symbol) on the chain where the
   * position opens. The cross-chain funding planner uses it to decide whether
   * idle cash elsewhere has to be moved first. Defaults to the first leg.
   */
  funding?: { chain: string; asset: string };
  /** Speculative = the edge is mostly points. Gets its own budget and rules. */
  speculative?: boolean;
  /** Discovery-only opportunities are reported but never allocated to. */
  discoveryOnly?: boolean;
  /** My equity currently in this opportunity, as seen by the source. */
  myEquityUsd: number;
  observedAtMs: number;
  /**
   * When the underlying data was produced (block time, API updated_at).
   * Adapters should set it; data older than `portfolio.max_data_age_minutes`
   * is treated as not reported (blind), so a cached provider cannot keep a
   * position "seen" with stale numbers.
   */
  dataAsOfMs?: number;
  meta?: Record<string, unknown>;
}

export interface RewardState {
  unclaimedUsd: number;
  heldUsd: number;
  hedgedUsd: number;
  lastClaimAtMs: number;
}

export interface Position {
  oppId: string;
  sourceId: string;
  kind: Kind;
  primaryVenue: string;
  chain: string;
  legs: Leg[];
  speculative: boolean;
  equityUsd: number;
  openedAtMs: number;
  lastActionAtMs: number;
  rewards: Record<string, RewardState>;
  exitProbe: { lastOkAtMs: number | null; consecutiveFailures: number };
  /** Debounce counters for non-urgent exit reasons. */
  pending: Record<string, number>;
  /** When each debounced reason was first seen (time-based debounce). */
  pendingSince?: Record<string, number>;
  /** Consecutive cycles the source did not report this opportunity. */
  blindCycles: number;
  /**
   * A full exit that was decided but has not succeeded yet. Latched: it is
   * retried every cycle until the position is gone, even if the trigger
   * (a one-cycle spike, a kill switch, a manual /exit) is no longer present.
   */
  forcedExit?: { reason: string; urgent: boolean; sinceMs: number };
  /** Idle bucket (`chain:asset`) that funded the position; exit and reward proceeds go back there. */
  fundingAsset?: { chain: string; asset: string };
}

export type Action =
  | {
      type: "enter";
      oppId: string;
      deltaUsd: number;
      netApr: number;
      marginalApr: number;
      /** Set when idle is split per chain:asset: where the money comes from (non-empty path = bridge first). */
      funding?: FundingQuote;
    }
  | { type: "exit"; oppId: string; fraction: number; urgent: boolean; reason: string }
  | { type: "rebalance"; oppId: string; reason: string }
  | { type: "claim"; oppId: string; token: string; amountUsd: number; reason: string }
  | { type: "sell"; oppId: string; token: string; amountUsd: number; reason: string }
  | { type: "hedge"; token: string; targetShortUsd: number; reason: string }
  /** Status alerts carry a dedupe key (oppId + rule); event alerts never do. */
  | { type: "alert"; level: AlertLevel; message: string; dedupeKey?: string };

export type AlertLevel = "info" | "warn" | "critical";

/** Market data about a reward token, used by the haircut model. */
export interface TokenProfile {
  priceUsd?: number;
  /** USD that can be sold within 2% price impact. */
  depth2pctUsd?: number;
  /** Annualized realized volatility (0.8 = 80%). */
  vol?: number;
  /** Annualized drift observed recently (-0.9 = falling 90%/yr). */
  trendApr?: number;
  /** A liquid perp exists to hedge it. */
  perpAvailable?: boolean;
  /** Expected cost of holding the short hedge (funding), APR on hedged notional. */
  hedgeCostApr?: number;
}
