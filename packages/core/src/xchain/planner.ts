import type { RouterConfig } from "../config.js";
import type { Opportunity, Position } from "../types.js";
import { checkFriction, type FrictionLedgerEntry } from "./friction.js";
import { assetKey, parseAssetKey, RouteGraph } from "./routes.js";
import type { ChainAsset, FundingQuote, InFlightTransfer, RouteSpec } from "./types.js";

/** Where an opportunity must be funded: `opp.funding`, else its first leg's chain + token. */
export function fundingTarget(opp: Opportunity): ChainAsset {
  if (opp.funding) return { chain: opp.funding.chain, asset: opp.funding.asset };
  const l = opp.legs[0];
  return l ? { chain: l.chain, asset: l.token } : { chain: opp.chain, asset: "USD" };
}

/** Bucket that receives a position's exit / reward proceeds. */
export function positionFundingAsset(p: Position): ChainAsset {
  if (p.fundingAsset) return p.fundingAsset;
  const l = p.legs[0];
  return l ? { chain: l.chain, asset: l.token } : { chain: p.chain, asset: "USD" };
}

export function isFinalTransfer(t: InFlightTransfer): boolean {
  return t.state === "completed" || t.state === "failed";
}

/** USD a transfer currently represents in equity (0 once final or already visible in the wallet). */
export function transferValueUsd(t: InFlightTransfer): number {
  if (isFinalTransfer(t) || t.walletSeenAtMs !== undefined) return 0;
  return t.receivedUsd ?? t.amountUsd;
}

export function inFlightTotalUsd(transfers: InFlightTransfer[]): number {
  return transfers.reduce((a, t) => a + transferValueUsd(t), 0);
}

export interface PlannerInputs {
  cfg: RouterConfig;
  nowMs: number;
  /** Idle USD per `chain:asset` bucket. */
  idle: Record<string, number>;
  ledger: FrictionLedgerEntry[];
  transfers: InFlightTransfer[];
  totalEquityUsd: number;
  /** Σ held positions' equity x holding net APR (USD / year). */
  bookYieldPerYearUsd: number;
  /** Route ids not to plan over (cooling down after a failed / stuck transfer). */
  pausedRouteIds?: string[];
}

/** One planned cross-chain move (aggregated over the allocator's chunks). */
export interface PlannedMove extends FundingQuote {
  oppId: string;
  /** Expected USD / year the moved money earns at the destination (Σ chunk marginal x size). */
  yieldPerYearUsd: number;
  feesUsd: number;
}

interface Evaluation {
  oppId: string;
  srcKey: string;
  deltaUsd: number;
  marginalNetApr: number;
  local: boolean;
  /** remote only: the aggregated move after this chunk */
  move?: Omit<PlannedMove, "reason">;
}

const usd0 = (x: number) => `$${Math.round(x)}`;
const SLACK = 1e-9;

/**
 * Per-cycle funding planner used by the allocator.
 *
 *  - Money already at the opportunity's funding asset is used first, at zero cost.
 *  - Otherwise the single source bucket whose cheapest path passes every
 *    friction rule (xchain/friction.ts) with the lowest incremental cost wins.
 *  - Chunks for the same (opportunity, source) are aggregated into ONE move:
 *    the friction rules are checked on the aggregate (amount, cost, yield),
 *    and later chunks only pay their incremental cost (fixed fees and gas are
 *    paid once).
 *  - `commit` takes the money out of its bucket and books the planned cost,
 *    so later chunks see the rolling-24h budget and the in-flight cap used.
 */
export class FundingPlanner {
  readonly graph: RouteGraph;
  /** Sum of the idle buckets when the planner was created. */
  readonly idleTotalUsd: number;
  private readonly remaining: Record<string, number>;
  private readonly moves = new Map<string, Omit<PlannedMove, "reason">>();
  private readonly local: Record<string, number> = {};
  private readonly evals = new WeakMap<FundingQuote, Evaluation>();
  private readonly inFlightBaseUsd: number;

  constructor(private readonly i: PlannerInputs) {
    this.graph = RouteGraph.fromConfig(i.cfg, i.pausedRouteIds ?? []);
    this.remaining = {};
    for (const [k, v] of Object.entries(i.idle)) if (Number.isFinite(v)) this.remaining[k] = v;
    this.idleTotalUsd = Object.values(this.remaining).reduce((a, v) => a + v, 0);
    this.inFlightBaseUsd = inFlightTotalUsd(i.transfers);
  }

  /** Idle still available in a bucket after this cycle's commits. */
  available(key: string): number {
    return this.remaining[key] ?? 0;
  }

  /** Largest idle bucket other than the opportunity's own funding asset (0 when moves are disabled). */
  largestRemoteUsd(opp: Opportunity): number {
    if (!this.i.cfg.xchain.enabled) return 0;
    const tk = assetKey(fundingTarget(opp));
    let m = 0;
    for (const [k, v] of Object.entries(this.remaining)) if (k !== tk && v > m) m = v;
    return m;
  }

  /** USD already travelling towards an opportunity (counts as its size for caps and dilution). */
  inFlightFor(oppId: string): number {
    return this.i.transfers.filter((t) => t.forOppId === oppId).reduce((a, t) => a + transferValueUsd(t), 0);
  }

  private plannedCostUsd(): number {
    let s = 0;
    for (const m of this.moves.values()) s += m.costUsd;
    return s;
  }

  private plannedMoveUsd(): number {
    let s = 0;
    for (const m of this.moves.values()) s += m.amountUsd ?? 0;
    return s;
  }

  private fail(reason: string, target?: ChainAsset, amountUsd?: number): FundingQuote {
    return { ok: false, path: [], costUsd: 0, etaMinutes: 0, target, amountUsd, reason };
  }

  /**
   * Fund `deltaUsd` more for `opp`, whose marginal dollars earn `marginalNetApr`.
   * For a remote source the returned `costUsd` is this chunk's INCREMENTAL
   * cost; the aggregated move is available from `plannedMoves()`.
   */
  quote(opp: Opportunity, deltaUsd: number, marginalNetApr: number): FundingQuote {
    const { cfg } = this.i;
    const target = fundingTarget(opp);
    const tk = assetKey(target);
    if (!(deltaUsd > 0) || !Number.isFinite(deltaUsd)) return this.fail("funding: invalid amount", target, deltaUsd);
    const local = this.available(tk);
    if (local + SLACK >= deltaUsd) {
      const q: FundingQuote = { ok: true, path: [], costUsd: 0, etaMinutes: 0, source: target, target, amountUsd: deltaUsd };
      this.evals.set(q, { oppId: opp.id, srcKey: tk, deltaUsd, marginalNetApr, local: true });
      return q;
    }
    if (!cfg.xchain.enabled)
      return this.fail(`funding: only ${usd0(local)} idle at ${tk}; cross-chain moves disabled (xchain.enabled=false)`, target, deltaUsd);
    if (!Number.isFinite(marginalNetApr)) return this.fail("funding: marginal APR not finite", target, deltaUsd);

    const sources = Object.keys(this.remaining)
      .filter((k) => k !== tk && this.available(k) + SLACK >= deltaUsd)
      .sort();
    if (!sources.length)
      return this.fail(`funding: no idle bucket holds ${usd0(deltaUsd)} (${tk} has ${usd0(local)})`, target, deltaUsd);

    let best: { q: FundingQuote; ev: Evaluation; inc: number } | null = null;
    const failures: { cost: number; text: string }[] = [];
    const plannedCost = this.plannedCostUsd();
    const plannedMove = this.plannedMoveUsd();
    for (const k of sources) {
      const prev = this.moves.get(`${opp.id}|${k}`);
      const amount = (prev?.amountUsd ?? 0) + deltaUsd;
      const yieldPY = (prev?.yieldPerYearUsd ?? 0) + marginalNetApr * deltaUsd;
      const apr = yieldPY / amount;
      const src = parseAssetKey(k);
      const pr = this.graph.findPath(src, target, amount, apr);
      if (!pr) {
        failures.push({ cost: Infinity, text: `funding ${k}->${tk}: no enabled route for ${usd0(amount)}` });
        continue;
      }
      const chk = checkFriction({
        cfg,
        nowMs: this.i.nowMs,
        amountUsd: amount,
        costUsd: pr.costUsd,
        destNetApr: apr,
        ledger: this.i.ledger,
        plannedCostUsd: plannedCost - (prev?.costUsd ?? 0),
        // spec: book yield = held positions + THIS move (other moves planned this
        // cycle are not yield yet, but their costs count against the budget)
        bookYieldPerYearUsd: this.i.bookYieldPerYearUsd,
        inFlightUsd: this.inFlightBaseUsd + plannedMove - (prev?.amountUsd ?? 0),
        totalEquityUsd: this.i.totalEquityUsd,
      });
      if (!chk.ok) {
        failures.push({ cost: pr.costUsd, text: `funding ${k}->${tk} via ${pr.path.map((r) => r.id).join(">")}: ${chk.reasons.join("; ")}` });
        continue;
      }
      const inc = Math.max(0, pr.costUsd - (prev?.costUsd ?? 0));
      if (best && best.inc <= inc) continue;
      const move: Omit<PlannedMove, "reason"> = {
        ok: true,
        oppId: opp.id,
        path: pr.path,
        costUsd: pr.costUsd,
        feesUsd: pr.feesUsd,
        etaMinutes: pr.etaMinutes,
        source: src,
        target,
        amountUsd: amount,
        yieldPerYearUsd: yieldPY,
      };
      const q: FundingQuote = { ok: true, path: pr.path, costUsd: inc, etaMinutes: pr.etaMinutes, source: src, target, amountUsd: deltaUsd };
      best = { q, inc, ev: { oppId: opp.id, srcKey: k, deltaUsd, marginalNetApr, local: false, move } };
    }
    if (!best) {
      failures.sort((a, b) => a.cost - b.cost);
      return this.fail(failures[0]?.text ?? `funding: no source for ${tk}`, target, deltaUsd);
    }
    this.evals.set(best.q, best.ev);
    return best.q;
  }

  /** Book a quote returned by `quote()` (the allocator picked this chunk). */
  commit(opp: Opportunity, deltaUsd: number, quote: FundingQuote): void {
    const ev = this.evals.get(quote);
    if (!quote.ok || !ev) throw new Error("FundingPlanner.commit: quote is not an ok quote from this planner");
    if (ev.oppId !== opp.id || Math.abs(ev.deltaUsd - deltaUsd) > 1e-6)
      throw new Error("FundingPlanner.commit: quote does not match the opportunity / amount");
    this.remaining[ev.srcKey] = this.available(ev.srcKey) - deltaUsd;
    if (ev.local) this.local[opp.id] = (this.local[opp.id] ?? 0) + deltaUsd;
    else this.moves.set(`${opp.id}|${ev.srcKey}`, ev.move!);
    this.evals.delete(quote);
  }

  /** USD committed this cycle from the opportunity's own funding bucket. */
  localFor(oppId: string): number {
    return this.local[oppId] ?? 0;
  }

  /** Aggregated cross-chain moves committed this cycle (costUsd = the move's all-in cost). */
  plannedMoves(oppId?: string): PlannedMove[] {
    return [...this.moves.values()].filter((m) => oppId === undefined || m.oppId === oppId).map((m) => ({ ...m, path: [...m.path] as RouteSpec[] }));
  }
}
