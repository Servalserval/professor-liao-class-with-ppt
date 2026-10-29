import type { Opportunity, Position } from "./types.js";

export interface ExecResult {
  ok: boolean;
  /**
   * enter: USD actually deployed; exit: USD returned to idle;
   * sell: USD proceeds; claim: USD claimed; hedge: new short notional.
   */
  amountUsd?: number;
  detail?: string;
  txIds?: string[];
}

/**
 * What a protocol adapter must implement to be allocatable. Everything is
 * expressed in USD at the router boundary; token math stays in the adapter.
 * Existing loop-farm adapters map 1:1:
 *   enter        -> one-click loop PTB / zap
 *   exit         -> single-tx unwind (flashloan or iterative PTB), fraction < 1 = deleverage
 *   rebalance    -> deleverage back to target LTV / move margin between venues
 *   simulateExit -> devInspect / eth_call of the full unwind
 */
export interface Executor {
  enter(opp: Opportunity, deltaUsd: number): Promise<ExecResult>;
  exit(pos: Position, fraction: number, opp?: Opportunity): Promise<ExecResult>;
  rebalance(pos: Position, opp: Opportunity): Promise<ExecResult>;
  simulateExit(pos: Position, opp?: Opportunity): Promise<boolean>;
  claim(pos: Position, token: string, amountUsd: number): Promise<ExecResult>;
  sell(pos: Position, token: string, amountUsd: number): Promise<ExecResult>;
  hedge(token: string, targetShortUsd: number): Promise<ExecResult>;
}

export interface PaperOptions {
  /** Force simulateExit to fail for some positions (scenario testing). */
  failExitSim?: (pos: Position) => boolean;
  /** Fraction of a reward sale realized (slippage). */
  sellRealized?: (token: string) => number;
  /** Fail real exits too (a frozen market). */
  failExit?: (pos: Position) => boolean;
}

/** Dry-run executor: never touches a chain, applies the opportunity's cost model. */
export class PaperExecutor implements Executor {
  readonly log: string[] = [];
  constructor(private readonly opts: PaperOptions = {}) {}

  async enter(opp: Opportunity, deltaUsd: number): Promise<ExecResult> {
    const cost = deltaUsd * opp.costs.entryFrac + opp.costs.fixedEntryUsd;
    this.log.push(`enter ${opp.id} ${deltaUsd.toFixed(2)}`);
    return { ok: true, amountUsd: deltaUsd - cost, detail: `paper entry, cost $${cost.toFixed(2)}` };
  }

  async exit(pos: Position, fraction: number, opp?: Opportunity): Promise<ExecResult> {
    if (this.opts.failExit?.(pos)) return { ok: false, detail: "paper: exit forced to fail" };
    const gross = pos.equityUsd * Math.min(1, fraction);
    const cost = opp ? gross * opp.costs.exitFrac + opp.costs.fixedExitUsd : 0;
    this.log.push(`exit ${pos.oppId} ${fraction}`);
    return { ok: true, amountUsd: Math.max(0, gross - cost), detail: `paper exit, cost $${cost.toFixed(2)}` };
  }

  async rebalance(pos: Position): Promise<ExecResult> {
    this.log.push(`rebalance ${pos.oppId}`);
    return { ok: true, detail: "paper rebalance" };
  }

  async simulateExit(pos: Position): Promise<boolean> {
    return !(this.opts.failExitSim?.(pos) ?? false);
  }

  async claim(pos: Position, token: string, amountUsd: number): Promise<ExecResult> {
    this.log.push(`claim ${pos.oppId} ${token} ${amountUsd.toFixed(2)}`);
    return { ok: true, amountUsd };
  }

  async sell(pos: Position, token: string, amountUsd: number): Promise<ExecResult> {
    const f = this.opts.sellRealized?.(token) ?? 0.98;
    this.log.push(`sell ${token} ${amountUsd.toFixed(2)}`);
    return { ok: true, amountUsd: amountUsd * f };
  }

  async hedge(token: string, targetShortUsd: number): Promise<ExecResult> {
    this.log.push(`hedge ${token} ${targetShortUsd.toFixed(2)}`);
    return { ok: true, amountUsd: targetShortUsd };
  }
}
