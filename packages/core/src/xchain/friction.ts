import type { RouterConfig } from "../config.js";

const DAY_MS = 24 * 3600_000;
/** Float slack for the exact boundary (cost == one day of yield passes). */
const EPS = 1e-9;

export interface FrictionLedgerEntry {
  t: number;
  costUsd: number;
  transferId: string;
}

export type FrictionRule = "dest_apr" | "one_day_yield" | "payback" | "book_budget" | "min_move" | "in_flight";

export interface FrictionInput {
  cfg: RouterConfig;
  nowMs: number;
  /** USD to move. */
  amountUsd: number;
  /** All-in cost of the move: fees + gas + transit opportunity cost (USD). */
  costUsd: number;
  /** Net APR the moved money earns at the destination (marginal, after dilution). */
  destNetApr: number;
  /** Cross-chain costs already paid (the rolling 24h window is applied here). */
  ledger: FrictionLedgerEntry[];
  /** Costs of other moves already planned this cycle (not yet in the ledger). */
  plannedCostUsd: number;
  /**
   * Expected yield per year of the book WITHOUT this move: held positions
   * (equity x holding net APR). The move's own amount x destNetApr is added here.
   */
  bookYieldPerYearUsd: number;
  /** USD already in flight + other moves planned this cycle. */
  inFlightUsd: number;
  totalEquityUsd: number;
}

export interface FrictionCheck {
  ok: boolean;
  reasons: string[];
  rules: FrictionRule[];
  /** The numbers behind the decision (for reports and tests). */
  oneDayYieldUsd: number;
  maxCostUsd: number;
  spent24hUsd: number;
  bookBudgetUsd: number;
}

const usd = (x: number) => `$${x.toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function frictionSpent24h(ledger: FrictionLedgerEntry[], nowMs: number): number {
  return ledger.filter((e) => e.t > nowMs - DAY_MS && e.t <= nowMs).reduce((a, e) => a + e.costUsd, 0);
}

/**
 * The user's cross-chain friction rule set. ALL must hold:
 *  (a) one day:  cost <= max_cost_days_of_yield x amount x destNetApr / 365
 *  (b) payback:  (destNetApr - idle_apr) x amount x payback_days / 365 >= cost
 *  (c) book:     costs paid in the last 24h + planned this cycle + cost
 *                <= book_daily_budget_days x (book yield per day after this move)
 *  (d) size:     amount >= min_move_usd
 *  (e) in flight: in flight + amount <= max_in_flight_frac x total equity
 * A destination that does not earn (destNetApr <= 0) always fails.
 */
export function checkFriction(i: FrictionInput): FrictionCheck {
  const x = i.cfg.xchain;
  const reasons: string[] = [];
  const rules: FrictionRule[] = [];
  const fail = (rule: FrictionRule, text: string) => {
    rules.push(rule);
    reasons.push(`${rule}: ${text}`);
  };
  const finite = [i.amountUsd, i.costUsd, i.destNetApr, i.bookYieldPerYearUsd, i.inFlightUsd, i.totalEquityUsd, i.plannedCostUsd];
  const oneDayYieldUsd = (i.amountUsd * i.destNetApr) / 365;
  const maxCostUsd = x.max_cost_days_of_yield * oneDayYieldUsd;
  const spent24hUsd = frictionSpent24h(i.ledger, i.nowMs);
  const bookDailyYieldUsd = (i.bookYieldPerYearUsd + i.amountUsd * i.destNetApr) / 365;
  const bookBudgetUsd = x.book_daily_budget_days * bookDailyYieldUsd;
  const out = (): FrictionCheck => ({ ok: rules.length === 0, reasons, rules, oneDayYieldUsd, maxCostUsd, spent24hUsd, bookBudgetUsd });

  if (!finite.every(Number.isFinite) || !(i.costUsd >= 0)) {
    fail("dest_apr", "non-finite or negative inputs");
    return out();
  }
  if (!(i.destNetApr > 0)) fail("dest_apr", `destination net APR ${pct(i.destNetApr)} <= 0`);

  // (a) the user's hard requirement
  if (i.costUsd > maxCostUsd + EPS)
    fail(
      "one_day_yield",
      `cost ${usd(i.costUsd)} > ${x.max_cost_days_of_yield} day(s) of yield ${usd(maxCostUsd)} on $${Math.round(i.amountUsd)} at ${pct(i.destNetApr)}`
    );

  // (b) payback vs leaving it idle where it is
  const gainUsd = ((i.destNetApr - x.idle_apr) * i.amountUsd * x.payback_days) / 365;
  if (gainUsd + EPS < i.costUsd)
    fail("payback", `gain over idle (${pct(x.idle_apr)}) in ${x.payback_days}d ${usd(gainUsd)} < cost ${usd(i.costUsd)}`);

  // (c) rolling 24h budget for the whole book
  const used = spent24hUsd + i.plannedCostUsd + i.costUsd;
  if (used > bookBudgetUsd + EPS)
    fail(
      "book_budget",
      `24h cross-chain costs ${usd(spent24hUsd)} + planned ${usd(i.plannedCostUsd)} + this ${usd(i.costUsd)} > ${x.book_daily_budget_days} day(s) of book yield ${usd(bookBudgetUsd)}`
    );

  // (d) fixed costs dominate small moves
  if (i.amountUsd + EPS < x.min_move_usd) fail("min_move", `$${Math.round(i.amountUsd)} < min_move_usd $${x.min_move_usd}`);

  // (e) never have too much of the book on bridges at once
  const maxInFlight = x.max_in_flight_frac * i.totalEquityUsd;
  if (i.inFlightUsd + i.amountUsd > maxInFlight + EPS)
    fail(
      "in_flight",
      `in flight $${Math.round(i.inFlightUsd)} + $${Math.round(i.amountUsd)} > ${pct(x.max_in_flight_frac)} of equity ($${Math.round(maxInFlight)})`
    );
  return out();
}
