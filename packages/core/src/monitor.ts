import { planAllocation } from "./allocator.js";
import type { RouterConfig } from "./config.js";
import type { Executor, ExecResult } from "./executor.js";
import { computeExposure } from "./exposure.js";
import type { DecisionContext } from "./gates/common.js";
import { decideExit } from "./gates/exit.js";
import type { Command, Notifier } from "./notify.js";
import { planRewards } from "./rewards.js";
import {
  derivedFlags,
  equityDrawdown,
  historyKeepMs,
  pruneHistory,
  recordEquity,
  recordOpp,
  recordTokenPrice,
} from "./signals.js";
import type { Source } from "./sources/types.js";
import { bucketMode, creditIdle, debitIdle, setIdleBuckets, type RouterState, type Store } from "./store.js";
import type { Action, AlertLevel, Opportunity, Position, TokenProfile } from "./types.js";
import { validateOpportunity } from "./validate.js";
import { valueAt } from "./valuation.js";
import {
  FundingPlanner,
  fundingTarget,
  inFlightTotalUsd,
  isFinalTransfer,
  positionFundingAsset,
} from "./xchain/planner.js";
import { assetKey, routeCostUsd } from "./xchain/routes.js";
import type { BridgeExecutor, BridgePollResult, InFlightTransfer } from "./xchain/types.js";

const HOUR = 3600_000;
const YEAR_MS = 365 * 24 * HOUR;

export interface RouterDeps {
  cfg: RouterConfig;
  sources: Source[];
  /** Executor per sourceId. Opportunities from a source without one are discovery-only. */
  executors: Record<string, Executor>;
  store: Store;
  notifier: Notifier;
  tokens: () => Promise<Record<string, TokenProfile>> | Record<string, TokenProfile>;
  now?: () => number;
  /** Paper mode: accrue PnL and rewards from valuations between cycles. */
  paperAccrual?: boolean;
  /** Live mode hook: authoritative idle USD (wallet balances). Legacy single-bucket mode only. */
  idleUsd?: () => Promise<number>;
  /** Bridge executor per RouteKind (cross-chain funding). */
  bridges?: Record<string, BridgeExecutor>;
  /**
   * Live mode hook: idle USD per `chain:asset` wallet bucket. When given it
   * overrides `state.idle` every cycle (and idleUsd = its sum); money in
   * flight is tracked by the router, not by this read.
   */
  idleBalances?: () => Promise<Record<string, number>>;
}

/** What happened to cross-chain transfers this cycle (also journaled). */
export interface TransferEvent {
  kind: "sent" | "send_failed" | "send_unknown" | "hop" | "arrived" | "failed" | "refunded" | "stuck" | "wallet_seen";
  id: string;
  forOppId?: string;
  amountUsd: number;
  costUsd?: number;
  from: string;
  to: string;
  route: string;
  detail?: string;
}

interface Alert {
  level: AlertLevel;
  text: string;
  /** Status alerts carry a key and are deduped; event alerts (ENTER/EXIT/failures) never are. */
  dedupeKey?: string;
}

export interface ExecutedAction {
  action: Action;
  ok: boolean;
  detail?: string;
}

export interface CycleReport {
  nowMs: number;
  totalEquityUsd: number;
  idleUsd: number;
  /** Idle per chain:asset (empty in legacy single-bucket mode). */
  idle: Record<string, number>;
  /** USD on bridges (counted in totalEquityUsd). */
  inFlightUsd: number;
  opportunities: number;
  sourceErrors: string[];
  executed: ExecutedAction[];
  /** Cross-chain transfer events (sent / arrived / failed / stuck ...). */
  transfers: TransferEvent[];
  /** Why opportunities got no (more) money this cycle (allocation ran only). */
  allocationRejected?: Record<string, string[]>;
  killed: boolean;
}

type ExitAction = Extract<Action, { type: "exit" }>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const usd0 = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const routeName = (t: { path: { id: string }[] }) => t.path.map((r) => r.id).join(">");
const finiteNonNeg = (x: number | undefined) => (x !== undefined && Number.isFinite(x) && x >= 0 ? x : undefined);

/** Never let one adapter call take the whole cycle (and its state save) down. */
async function safe(p: () => Promise<ExecResult>): Promise<ExecResult> {
  try {
    return await p();
  } catch (e) {
    return { ok: false, detail: `threw: ${errMsg(e)}` };
  }
}

/**
 * NOTE on concurrency: `cycle()` and `handleCommand()` both load and save the
 * whole state. Call them from one loop, one after the other (the CLI does);
 * never concurrently.
 */
export class Router {
  private readonly now: () => number;
  private lastTokens: Record<string, TokenProfile> = {};
  constructor(private readonly d: RouterDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  async cycle(): Promise<CycleReport> {
    const { cfg } = this.d;
    const now = this.now();
    const st = this.d.store.load();
    const keep = historyKeepMs(cfg);
    const executed: ExecutedAction[] = [];
    const alerts: Alert[] = [];
    const sourceErrors: string[] = [];
    const xfers: TransferEvent[] = [];
    let allocationRejected: Record<string, string[]> | undefined;
    let opps = new Map<string, Opportunity>();

    // Money on a bridge is still ours: it counts in equity, so a move never
    // looks like a drawdown to the kill switch.
    const totalEquity = () =>
      st.idleUsd +
      inFlightTotalUsd(st.transfers) +
      st.positions.reduce(
        (a, p) => a + p.equityUsd + Object.values(p.rewards).reduce((b, r) => b + r.unclaimedUsd + r.heldUsd, 0),
        0
      );

    try {
      // --- token prices -------------------------------------------------------
      let tokens: Record<string, TokenProfile>;
      try {
        tokens = await this.d.tokens();
        this.lastTokens = tokens;
      } catch (e) {
        tokens = this.lastTokens;
        alerts.push({ level: "warn", text: `token feed failed (${errMsg(e)}); using last known profiles`, dedupeKey: "tokens|feed" });
      }
      const prevPrices: Record<string, number> = {};
      for (const [t, arr] of Object.entries(st.history.tokenPrices)) {
        const last = arr[arr.length - 1];
        if (last) prevPrices[t] = last.p;
      }
      for (const [t, p] of Object.entries(tokens))
        if (p.priceUsd !== undefined && Number.isFinite(p.priceUsd)) recordTokenPrice(st.history, t, p.priceUsd, now, keep);

      // --- observe --------------------------------------------------------------
      opps = await this.observe(st, now, alerts, sourceErrors);
      for (const p of st.positions) p.blindCycles = opps.has(p.oppId) ? 0 : p.blindCycles + 1;

      // --- valuation of what we hold ------------------------------------------------
      if (this.d.paperAccrual && st.lastCycleAtMs !== null) this.accrue(st, opps, tokens, prevPrices, now - st.lastCycleAtMs, now);
      for (const p of st.positions) {
        const ex = this.d.executors[p.sourceId];
        if (!ex?.markToMarket || this.d.paperAccrual) continue;
        try {
          const v = await ex.markToMarket(p, opps.get(p.oppId));
          if (Number.isFinite(v) && v >= 0) p.equityUsd = v;
          else throw new Error(`invalid value ${v}`);
        } catch (e) {
          alerts.push({ level: "warn", text: `${p.oppId}: mark-to-market failed (${errMsg(e)})`, dedupeKey: `${p.oppId}|mtm` });
        }
      }
      // --- wallet snapshot FIRST (live): taken before any action of this cycle ------
      if (this.d.idleBalances) {
        try {
          const m = await this.d.idleBalances();
          const bad = Object.entries(m).filter(([k, v]) => !Number.isFinite(v) || v < 0 || !/^[^:]+:.+$/.test(k));
          if (bad.length) throw new Error(`invalid balances for ${bad.map(([k]) => k).join(", ")}`);
          // the read may be PARTIAL (a bucket whose read failed is omitted): missing keys keep their last value
          this.markWalletSeen(st, m, now, xfers);
          setIdleBuckets(st, { ...st.idle, ...m });
        } catch (e) {
          alerts.push({ level: "warn", text: `idle balances read failed (${errMsg(e)}); keeping last values`, dedupeKey: "idle|read" });
        }
      } else if (this.d.idleUsd) {
        if (bucketMode(st))
          alerts.push({
            level: "warn",
            text: "idleUsd hook ignored: idle is split per chain:asset (wire idleBalances instead)",
            dedupeKey: "idle|hook",
          });
        else
          try {
            const v = await this.d.idleUsd();
            if (Number.isFinite(v)) st.idleUsd = v;
          } catch (e) {
            alerts.push({ level: "warn", text: `idle balance read failed (${errMsg(e)}); keeping last value`, dedupeKey: "idle|read" });
          }
      }
      // --- cross-chain transfers (after the wallet snapshot: every effect of a
      //     poll — a credit on arrival, a debit when the next hop leaves — is a
      //     delta on top of it; funds the snapshot already showed are wallet-seen
      //     and never credited twice) ---------------------------------------------
      st.frictionLedger = st.frictionLedger.filter((e) => e.t > now - 48 * HOUR);
      if (st.transfers.length) await this.pollTransfers(st, now, alerts, xfers);

      recordEquity(st.history, totalEquity(), now, keep);

      const ctx = (): DecisionContext => ({
        cfg,
        nowMs: now,
        tokens,
        totalEquityUsd: totalEquity(),
        positions: st.positions,
        exposure: computeExposure(st.positions),
        history: st.history,
        cooldownUntil: st.cooldownUntil,
        paused: st.paused,
        idleUsd: st.idleUsd,
        hedges: st.hedges,
      });

      // --- derived flags: compare with history BEFORE recording this cycle, then
      //     merge into the opportunity so entry gates see them too ----------------
      const held = new Set(st.positions.map((p) => p.oppId));
      for (const o of opps.values()) {
        if (o.discoveryOnly && !held.has(o.id)) continue; // keep state small: no series for pure discovery
        o.flags = [...o.flags, ...derivedFlags(o, st.history, cfg, now)];
        recordOpp(st.history, o, now, keep);
      }
      pruneHistory(st.history, now, keep);

      // --- latches caused by missing data / failed simulations: cleared when the
      //     trigger is gone before the exit executed (BEFORE the kill switch, so a
      //     kill-switch latch is never cleared by this) ---------------------------------
      await this.clearRecoveredLatches(st, opps, alerts, now);

      // --- kill switch (latched through forcedExit) -----------------------------------
      // The drawdown must persist kill_confirm_cycles consecutive cycles: one bad
      // read (a wallet, a mark-to-market) must not liquidate the book.
      const dd = equityDrawdown(st.history, cfg, now);
      if (dd >= cfg.portfolio.kill_drawdown_frac && !st.killed) {
        st.killPending = (st.killPending ?? 0) + 1;
        if (st.killPending >= cfg.portfolio.kill_confirm_cycles) {
          st.killed = true;
          st.paused = true;
          st.killPending = 0;
          alerts.push({
            level: "critical",
            text: `KILL SWITCH: equity -${(dd * 100).toFixed(2)}% within ${cfg.portfolio.kill_window_hours}h — exiting everything, router paused (/resume to re-arm)`,
          });
          for (const p of st.positions) p.forcedExit ??= { reason: "kill switch", urgent: true, sinceMs: now };
        } else
          alerts.push({
            level: "critical",
            text: `drawdown -${(dd * 100).toFixed(2)}% within ${cfg.portfolio.kill_window_hours}h (${st.killPending}/${cfg.portfolio.kill_confirm_cycles}) — kill switch fires if it persists`,
            dedupeKey: "kill|pending",
          });
      } else st.killPending = 0;

      // --- manual exits (telegram) are latched too ---------------------------------
      for (const id of st.manualExit) {
        const p = st.positions.find((x) => x.oppId === id);
        if (p) p.forcedExit ??= { reason: "manual /exit", urgent: true, sinceMs: now };
      }
      st.manualExit = [];
      this.d.store.save(st);

      // --- exits: urgent first ----------------------------------------------------
      const decisions = st.positions.map((p) => ({ p, d: decideExit(p, opps.get(p.oppId), [], ctx()) }));
      decisions.sort((a, b) => urgency(b.d.actions) - urgency(a.d.actions));
      for (const { p, d } of decisions) {
        p.pending = d.pending;
        p.pendingSince = d.pendingSince;
        for (const a of d.actions) {
          if (a.type === "alert") alerts.push({ level: a.level, text: a.message, dedupeKey: a.dedupeKey });
          else if (a.type === "exit") {
            // latch full exits before trying, so a failure (or a one-cycle trigger) is retried
            if (a.fraction >= 1) p.forcedExit ??= { reason: a.reason, urgent: a.urgent, sinceMs: now, ...(a.cause ? { cause: a.cause } : {}) };
            await this.execExit(st, p, opps.get(p.oppId), a, executed, alerts, now);
          } else if (a.type === "rebalance") {
            const opp = opps.get(p.oppId);
            const ex = this.d.executors[p.sourceId];
            if (!opp || !ex) continue;
            const r = await safe(() => ex.rebalance(p, opp));
            executed.push({ action: a, ok: r.ok, detail: r.detail });
            if (!r.ok) alerts.push({ level: "critical", text: `rebalance FAILED ${p.oppId}: ${r.detail ?? ""}` });
            this.d.store.save(st);
          }
        }
      }

      // --- exit probes ----------------------------------------------------------------
      for (const p of st.positions) {
        const ex = this.d.executors[p.sourceId];
        if (!ex) continue;
        const age = p.exitProbe.lastOkAtMs === null ? Infinity : now - p.exitProbe.lastOkAtMs;
        if (age < cfg.exit_probe.max_age_minutes * 60_000) continue;
        const res = await this.probeExit(p, opps.get(p.oppId));
        this.applyProbe(p, res, alerts, now);
      }
      this.d.store.save(st);

      // --- rewards -------------------------------------------------------------------
      for (const a of planRewards(ctx())) await this.execReward(st, a, executed, alerts, now);

      // --- allocation ------------------------------------------------------------------
      // While any exit is urgent (decided, executed or failed) the market may be in
      // contagion mode: no new money this cycle.
      const urgentExit =
        st.positions.some((p) => p.forcedExit?.urgent) ||
        executed.some((x) => x.action.type === "exit" && x.action.urgent);
      if (urgentExit && !st.paused) alerts.push({ level: "info", text: "allocation skipped this cycle: urgent exit in progress" });
      if (!st.paused && !urgentExit) {
        if (cfg.xchain.enabled && !bucketMode(st) && st.idleUsd > 0)
          alerts.push({
            level: "warn",
            text: "xchain.enabled but idle is not split per chain:asset — single-bucket mode, no cross-chain moves",
            dedupeKey: "xchain|legacy",
          });
        const c = ctx();
        // Idle split per chain:asset -> every chunk is funded through the planner
        // (local money is free; a move must pass the friction rules).
        if (bucketMode(st))
          c.funding = new FundingPlanner({
            cfg,
            nowMs: now,
            idle: st.idle,
            ledger: st.frictionLedger,
            transfers: st.transfers,
            totalEquityUsd: c.totalEquityUsd,
            bookYieldPerYearUsd: bookYieldPerYear(st.positions, opps, c),
            pausedRouteIds: pausedRoutes(st, now),
            deployedUsd: c.exposure.totalDeployedUsd,
          });
        const plan = planAllocation([...opps.values()], c);
        allocationRejected = plan.rejected;
        for (const e of plan.entries) {
          const opp = opps.get(e.oppId)!;
          const ex = this.d.executors[opp.sourceId];
          if (!ex) continue;
          if (e.funding && e.funding.path.length > 0) {
            // the money is elsewhere: move it first; the allocator deploys it once it arrives
            await this.startTransfer(st, opp, e, alerts, xfers, now);
            continue;
          }
          const r = await safe(() => ex.enter(opp, e.deltaUsd));
          executed.push({ action: e, ok: r.ok, detail: r.detail });
          if (!r.ok) {
            alerts.push({ level: "warn", text: `enter FAILED ${e.oppId}: ${r.detail ?? ""}` });
            continue;
          }
          const srcKey = assetKey(e.funding?.source ?? fundingTarget(opp));
          debitIdle(st, srcKey, r.spentUsd ?? e.deltaUsd);
          upsertPosition(st, opp, r.amountUsd ?? e.deltaUsd, now);
          this.d.store.save(st);
          alerts.push({
            level: "info",
            text: `ENTER ${e.oppId} +$${Math.round(e.deltaUsd)} net ${(e.netApr * 100).toFixed(2)}% (marginal ${(e.marginalApr * 100).toFixed(2)}%)${bucketMode(st) ? ` from ${srcKey}` : ""}`,
          });
        }
      }
    } finally {
      st.lastCycleAtMs = now;
      this.d.store.save(st);
      for (const x of executed) this.d.store.journal({ t: now, ...x.action, ok: x.ok, detail: x.detail });
      for (const x of xfers) this.d.store.journal({ t: now, type: "transfer", ...x });
    }

    await this.sendAlerts(st, alerts, now);
    this.d.store.save(st);

    return {
      nowMs: now,
      totalEquityUsd: totalEquity(),
      idleUsd: st.idleUsd,
      idle: { ...st.idle },
      inFlightUsd: inFlightTotalUsd(st.transfers),
      opportunities: opps.size,
      sourceErrors,
      executed,
      transfers: xfers,
      allocationRejected,
      killed: st.killed,
    };
  }

  /** true / false = the simulation ran; "error" = it could not run (RPC), which proves nothing. */
  private async probeExit(p: Position, opp: Opportunity | undefined): Promise<boolean | "error"> {
    const ex = this.d.executors[p.sourceId];
    if (!ex) return "error";
    try {
      return (await ex.simulateExit(p, opp)) === true;
    } catch {
      return "error";
    }
  }

  private applyProbe(p: Position, res: boolean | "error", alerts: Alert[], now: number) {
    const cfg = this.d.cfg;
    if (res === true) {
      p.exitProbe = { lastOkAtMs: now, consecutiveFailures: 0, consecutiveErrors: 0 };
      return;
    }
    if (res === false) {
      p.exitProbe.consecutiveFailures += 1;
      alerts.push({
        level: "warn",
        text: `${p.oppId}: exit simulation failed (${p.exitProbe.consecutiveFailures}x)`,
        dedupeKey: `${p.oppId}|probe`,
      });
      return;
    }
    // could not run: never counts toward max_consecutive_failures
    p.exitProbe.consecutiveErrors = (p.exitProbe.consecutiveErrors ?? 0) + 1;
    if (p.exitProbe.consecutiveErrors >= cfg.exit_probe.error_alert_after)
      alerts.push({
        level: "warn",
        text: `${p.oppId}: exit simulation could not run ${p.exitProbe.consecutiveErrors}x (RPC error?) — exit path unverified, not counted as failures`,
        dedupeKey: `${p.oppId}|probe_error`,
      });
  }

  /**
   * A full exit latched because the data went blind or the exit simulation
   * failed is dropped when, before it executed, the data is back (valid) or a
   * fresh simulation passes. The normal rules then decide again this cycle.
   */
  private async clearRecoveredLatches(st: RouterState, opps: Map<string, Opportunity>, alerts: Alert[], now: number) {
    for (const p of st.positions) {
      const f = p.forcedExit;
      if (!f?.cause) continue;
      let why: string | null = null;
      if (f.cause === "blind" && opps.has(p.oppId) && p.blindCycles === 0) why = "source reports valid data again";
      if (f.cause === "probe") {
        const res = await this.probeExit(p, opps.get(p.oppId));
        this.applyProbe(p, res, alerts, now);
        if (res === true) why = "exit simulation passes again";
      }
      if (!why) continue;
      p.forcedExit = undefined;
      this.d.store.journal({ t: now, type: "latch_cleared", oppId: p.oppId, cause: f.cause, reason: f.reason, why });
      alerts.push({ level: "warn", text: `${p.oppId}: latched exit cleared (${f.reason}) — ${why}` });
    }
    this.d.store.save(st);
  }

  // -------------------------------------------------------------------------
  // Cross-chain transfers
  // -------------------------------------------------------------------------

  /**
   * Book the move, persist it, then send hop 0. An explicit refusal (ok:false)
   * leaves the money idle where it was; a send that THROWS has an unknown
   * outcome (the tx may be out) and is kept as a stuck transfer, never
   * credited back automatically.
   */
  private async startTransfer(
    st: RouterState,
    opp: Opportunity,
    e: Extract<Action, { type: "enter" }>,
    alerts: Alert[],
    xfers: TransferEvent[],
    now: number
  ): Promise<void> {
    const q = e.funding!;
    const first = q.path[0]!;
    const lastHop = q.path[q.path.length - 1]!;
    const srcKey = assetKey(q.source ?? first.from);
    const dstKey = assetKey(q.target ?? lastHop.to);
    const route = routeName(q);
    if (!this.d.cfg.xchain.enabled) return; // the planner never plans moves then; belt and braces
    const bridge = this.d.bridges?.[first.kind];
    if (!bridge) {
      alerts.push({
        level: "critical",
        text: `no bridge executor for ${first.kind}: cannot move ${usd0(e.deltaUsd)} ${srcKey} -> ${dstKey} for ${opp.id}; money stays idle on ${srcKey}`,
        dedupeKey: `bridge|${first.kind}|noexec`,
      });
      return;
    }
    const t: InFlightTransfer = {
      id: `xf-${now}-${e.oppId}-${srcKey}`,
      forOppId: e.oppId,
      path: q.path,
      hop: 0,
      amountUsd: e.deltaUsd,
      costUsd: q.costUsd,
      state: "planned",
      createdAtMs: now,
      updatedAtMs: now,
      hopStartedAtMs: now,
    };
    // Books first, side effect second: a crash during send leaves a tracked
    // "planned" transfer (flagged stuck on restart, never re-sent), never vanished money.
    debitIdle(st, srcKey, t.amountUsd);
    st.transfers.push(t);
    this.d.store.save(st);
    let r: { ok: boolean; ref?: string; detail?: string };
    try {
      r = await bridge.send(t);
    } catch (err) {
      this.markSendUnknown(st, t, first.id, `send threw: ${errMsg(err)}`, now, alerts, xfers);
      st.frictionLedger.push({ t: now, costUsd: q.costUsd, transferId: t.id }); // assume paid (conservative)
      this.d.store.save(st);
      return;
    }
    if (!r.ok) {
      st.transfers = st.transfers.filter((x) => x !== t);
      creditIdle(st, srcKey, t.amountUsd);
      alerts.push({
        level: "critical",
        text: `bridge send FAILED ${usd0(t.amountUsd)} ${srcKey} -> ${dstKey} via ${route} for ${opp.id}: ${r.detail ?? ""} — kept idle on ${srcKey}`,
      });
      xfers.push(this.transferEvent(t, "send_failed", r.detail));
      this.pauseRoute(st, first.id, now, alerts, "send refused");
      this.d.store.save(st);
      return;
    }
    t.state = "submitted";
    t.ref = r.ref;
    t.detail = r.detail;
    st.frictionLedger.push({ t: now, costUsd: q.costUsd, transferId: t.id });
    this.d.store.save(st);
    xfers.push(this.transferEvent(t, "sent", r.detail));
    alerts.push({
      level: "info",
      text: `BRIDGE ${usd0(t.amountUsd)} ${srcKey} -> ${dstKey} via ${route} for ${opp.id}: cost $${q.costUsd.toFixed(2)}, eta ${q.etaMinutes} min`,
    });
  }

  /** Outcome of a hop's send is unknown: keep it in flight, stuck, until resolved by hand. */
  private markSendUnknown(
    st: RouterState,
    t: InFlightTransfer,
    routeId: string,
    detail: string | undefined,
    now: number,
    alerts: Alert[],
    xfers: TransferEvent[]
  ) {
    const was = t.state === "stuck";
    t.state = "stuck";
    t.sendUnknownAtMs ??= now;
    if (detail !== undefined) t.detail = `${detail} — outcome unknown`;
    t.updatedAtMs = now;
    if (!was) {
      xfers.push(this.transferEvent(t, "send_unknown", t.detail, t.receivedUsd ?? t.amountUsd));
      this.pauseRoute(st, routeId, now, alerts, "send outcome unknown");
    }
    alerts.push({
      level: "critical",
      text: `transfer ${t.id}: hop ${t.hop + 1}/${t.path.length} ${routeId} ${t.detail}; ${usd0(t.receivedUsd ?? t.amountUsd)} kept as in flight, NOT sent again — check the wallets / explorer and resolve with /transfer ${t.id} arrived|failed|refunded [usd]`,
      dedupeKey: `xfer|${t.id}|unknown`,
    });
  }

  /** Poll every unfinished transfer; credit arrivals / refunds; flag stuck hops. Never resends a stuck hop. */
  private async pollTransfers(st: RouterState, now: number, alerts: Alert[], xfers: TransferEvent[]): Promise<void> {
    const x = this.d.cfg.xchain;
    for (const t of st.transfers) {
      if (isFinalTransfer(t)) continue;
      const wasStuck = t.state === "stuck";
      const hop0 = t.path[t.hop];
      if (!hop0) {
        t.state = "failed";
        alerts.push({ level: "critical", text: `transfer ${t.id}: invalid hop ${t.hop} — removed from the books, check by hand` });
        continue;
      }
      // A hop still "planned" here was persisted but its send never confirmed
      // (crash / restart between save and send), or a send threw: the outcome
      // is unknown. Never send it again automatically, never poll without a handle.
      if (t.state === "planned" || t.sendUnknownAtMs !== undefined) {
        const first = t.sendUnknownAtMs === undefined ? "hop persisted but its send was never confirmed (restart?)" : undefined;
        this.markSendUnknown(st, t, hop0.id, first, now, alerts, xfers);
        this.d.store.save(st);
        continue;
      }
      const bridge = this.d.bridges?.[hop0.kind];
      if (!bridge) {
        alerts.push({
          level: "critical",
          text: `transfer ${t.id}: no bridge executor for ${hop0.kind}; cannot track ${usd0(t.amountUsd)}`,
          dedupeKey: `xfer|${t.id}|noexec`,
        });
      } else {
        let r: BridgePollResult | null = null;
        try {
          r = await bridge.poll(t);
        } catch (e) {
          alerts.push({ level: "warn", text: `transfer ${t.id}: poll failed (${errMsg(e)})`, dedupeKey: `xfer|${t.id}|poll` });
        }
        if (r) await this.applyPoll(st, t, r, now, alerts, xfers);
      }
      if (isFinalTransfer(t) || t.sendUnknownAtMs !== undefined) continue;
      const hop = t.path[t.hop]!;
      const started = t.hopStartedAtMs ?? t.createdAtMs;
      const limitMin = Math.max(x.stuck_min_minutes, hop.etaMinutes * x.stuck_eta_multiple);
      const overdue = now - started > limitMin * 60_000;
      if (overdue || t.state === "stuck") {
        t.state = "stuck";
        if (!wasStuck) {
          xfers.push(this.transferEvent(t, "stuck", t.detail));
          this.pauseRoute(st, hop.id, now, alerts, "transfer stuck");
        }
        alerts.push({
          level: "critical",
          text: `transfer ${t.id} STUCK: hop ${t.hop + 1}/${t.path.length} ${hop.id} (${usd0(t.receivedUsd ?? t.amountUsd)}) not done after ${Math.round((now - started) / 60_000)} min (eta ${hop.etaMinutes}); NOT resent automatically — check ${t.ref ?? "the bridge"} by hand, then /transfer ${t.id} arrived|failed|refunded [usd]`,
          dedupeKey: `xfer|${t.id}|stuck`,
        });
      }
      this.d.store.save(st);
    }
    if (st.transfers.some(isFinalTransfer)) st.transfers = st.transfers.filter((t) => !isFinalTransfer(t));
    this.d.store.save(st);
  }

  private transferEvent(t: InFlightTransfer, kind: TransferEvent["kind"], detail?: string, amountUsd?: number): TransferEvent {
    return {
      kind,
      id: t.id,
      forOppId: t.forOppId,
      amountUsd: amountUsd ?? t.amountUsd,
      costUsd: t.costUsd,
      from: assetKey(t.path[0]!.from),
      to: assetKey(t.path[t.path.length - 1]!.to),
      route: routeName(t),
      detail,
    };
  }

  private async applyPoll(
    st: RouterState,
    t: InFlightTransfer,
    r: BridgePollResult,
    now: number,
    alerts: Alert[],
    xfers: TransferEvent[]
  ): Promise<void> {
    if (r.ref) t.ref = r.ref;
    t.updatedAtMs = now;
    const hop = t.path[t.hop]!;
    const input = t.receivedUsd ?? t.amountUsd;
    const last = t.hop === t.path.length - 1;
    if (r.state === "completed") {
      const got = finiteNonNeg(r.receivedUsd) ?? Math.max(0, input - routeCostUsd(hop, input));
      t.receivedUsd = got;
      if (last) {
        t.state = "completed";
        // already inside the wallet read (live): crediting again would double count
        if (t.walletSeenAtMs === undefined) creditIdle(st, assetKey(hop.to), got);
        xfers.push(this.transferEvent(t, "arrived", r.detail, got));
        alerts.push({
          level: "info",
          text: `ARRIVED ${usd0(got)} on ${assetKey(hop.to)} (${t.id}${t.forOppId ? ` for ${t.forOppId}` : ""}); deployed by the allocator`,
        });
        return;
      }
      // intermediate hop done: persist the NEXT hop as planned before sending it
      const hubKey = assetKey(hop.to);
      t.hop += 1;
      t.hopStartedAtMs = now;
      t.state = "planned";
      t.ref = undefined;
      t.detail = r.detail;
      if (t.walletSeenAtMs !== undefined) {
        // the wallet read already holds this money in the hub bucket; it leaves with the next hop
        debitIdle(st, hubKey, t.walletSeenUsd ?? got);
        t.walletSeenAtMs = undefined;
        t.walletSeenUsd = undefined;
      }
      xfers.push(this.transferEvent(t, "hop", `hop ${t.hop}/${t.path.length} reached ${hubKey}`, got));
      this.d.store.save(st);
      const next = t.path[t.hop]!;
      const b = this.d.bridges?.[next.kind];
      let s: { ok: boolean; ref?: string; detail?: string };
      if (!b) s = { ok: false, detail: `no bridge executor for ${next.kind}` };
      else
        try {
          s = await b.send(t);
        } catch (e) {
          this.markSendUnknown(st, t, next.id, `send threw: ${errMsg(e)}`, now, alerts, xfers);
          return;
        }
      if (s.ok) {
        t.state = "submitted";
        if (s.ref) t.ref = s.ref;
        if (s.detail) t.detail = s.detail;
        return;
      }
      // refused: the money sits on the intermediate chain, book it there as idle
      t.state = "failed";
      creditIdle(st, hubKey, got);
      xfers.push(this.transferEvent(t, "failed", s.detail, got));
      this.pauseRoute(st, next.id, now, alerts, "send refused");
      alerts.push({
        level: "critical",
        text: `transfer ${t.id}: next hop ${next.id} could not be sent (${s.detail ?? ""}); ${usd0(got)} kept idle on ${hubKey}`,
      });
      return;
    }
    if (r.state === "failed") {
      t.state = "failed";
      t.detail = r.detail;
      const refund = finiteNonNeg(r.refundedUsd) ?? 0;
      if (refund > 0 && t.walletSeenAtMs === undefined) creditIdle(st, assetKey(hop.from), refund);
      xfers.push(this.transferEvent(t, refund > 0 ? "refunded" : "failed", r.detail, refund > 0 ? refund : input));
      this.pauseRoute(st, hop.id, now, alerts, "transfer failed");
      alerts.push({
        level: "critical",
        text:
          `transfer ${t.id} FAILED on hop ${t.hop + 1}/${t.path.length} ${hop.id}: ${r.detail ?? ""} — ` +
          (refund > 0
            ? `${usd0(refund)} refunded to ${assetKey(hop.from)}`
            : `${usd0(input)} NOT returned; removed from the books (equity drops) — recover by hand`),
      });
      return;
    }
    // still moving: keep our "stuck" label once set (cleared only by a final state)
    if (t.state !== "stuck") t.state = r.state;
    if (r.detail) t.detail = r.detail;
  }

  /**
   * A route whose transfer failed, was refused or got stuck is not planned
   * over again for reentry_cooldown_hours: otherwise a broken route would be
   * retried every cycle, paying gas each time.
   */
  private pauseRoute(st: RouterState, routeId: string, now: number, alerts: Alert[], why: string) {
    const until = now + this.d.cfg.caps.reentry_cooldown_hours * HOUR;
    st.cooldownUntil[`${ROUTE_COOLDOWN_PREFIX}${routeId}`] = until;
    alerts.push({
      level: "warn",
      text: `route ${routeId} paused until ${new Date(until).toISOString()} (${why}); no new moves over it`,
      dedupeKey: `route|${routeId}|paused`,
    });
  }

  /**
   * Live mode: the wallet snapshot is taken at the start of the cycle, before
   * transfers are polled. If the wallet at the end of a transfer's CURRENT hop
   * (final destination or an intermediate hub) already received about the
   * expected amount (inflow not explained by our own books) while the hop is
   * still in flight in our books, it would be counted twice (wallet + in
   * flight) — a fake equity peak that later looks like a drawdown. Mark it
   * wallet-seen: it stops counting as in flight; on completion it is not
   * credited again (final hop) or is debited from the hub bucket when it
   * leaves with the next hop. `read` may be partial: buckets not read are skipped.
   */
  private markWalletSeen(st: RouterState, read: Record<string, number>, now: number, xfers: TransferEvent[]) {
    const inflow: Record<string, number> = {};
    for (const [k, v] of Object.entries(read)) inflow[k] = Math.max(0, v - (st.idle[k] ?? 0));
    for (const t of st.transfers) {
      if (isFinalTransfer(t) || t.walletSeenAtMs !== undefined || t.state === "planned" || t.sendUnknownAtMs !== undefined) continue;
      const hop = t.path[t.hop]!;
      const k = assetKey(hop.to);
      if (!(k in inflow)) continue;
      const input = t.receivedUsd ?? t.amountUsd;
      const expected = Math.max(0, input - routeCostUsd(hop, input));
      if (expected > 0 && inflow[k]! >= 0.95 * expected) {
        t.walletSeenAtMs = now;
        t.walletSeenUsd = expected;
        inflow[k] = inflow[k]! - expected;
        xfers.push(this.transferEvent(t, "wallet_seen", `${k} wallet shows the funds of hop ${t.hop + 1}/${t.path.length}; awaiting adapter confirmation`, expected));
      }
    }
  }

  /** Fetch every source in isolation, validate what comes back. */
  private async observe(st: RouterState, now: number, alerts: Alert[], sourceErrors: string[]): Promise<Map<string, Opportunity>> {
    const { cfg } = this.d;
    const myEquityByOpp: Record<string, number> = {};
    for (const p of st.positions) myEquityByOpp[p.oppId] = p.equityUsd;
    const opps = new Map<string, Opportunity>();
    const results = await Promise.allSettled(this.d.sources.map((s) => s.fetch({ cfg, nowMs: now, myEquityByOpp, history: st.history })));
    results.forEach((r, i) => {
      const src = this.d.sources[i]!;
      if (r.status === "rejected") {
        sourceErrors.push(`${src.id}: ${errMsg(r.reason)}`);
        alerts.push({ level: "warn", text: `source ${src.id} failed: ${errMsg(r.reason)}`, dedupeKey: `source|${src.id}` });
        return;
      }
      for (const o of r.value) {
        if (!this.d.executors[o.sourceId]) o.discoveryOnly = true;
        const issues = validateOpportunity(o, cfg, now);
        if (issues.length) {
          // invalid / stale data is treated as not reported: held positions go blind
          if (st.positions.some((p) => p.oppId === o.id))
            alerts.push({ level: "warn", text: `${o.id}: data rejected (${issues.slice(0, 2).join("; ")})`, dedupeKey: `${o.id}|invalid` });
          continue;
        }
        opps.set(o.id, o);
      }
    });
    return opps;
  }

  private async sendAlerts(st: RouterState, alerts: Alert[], now: number) {
    const repeatMs = this.d.cfg.portfolio.alert_repeat_hours * HOUR;
    for (const a of alerts) {
      if (a.dedupeKey) {
        const key = `${a.level}|${a.dedupeKey}`;
        const last = st.alertSentAt[key];
        if (last !== undefined && now - last < repeatMs) continue;
        st.alertSentAt[key] = now;
      }
      try {
        await this.d.notifier.send(a.level, a.text);
      } catch (e) {
        console.error("notifier failed:", errMsg(e));
      }
    }
    for (const [k, t] of Object.entries(st.alertSentAt)) if (now - t > repeatMs * 4) delete st.alertSentAt[k];
  }

  private async execExit(
    st: RouterState,
    p: Position,
    opp: Opportunity | undefined,
    a: ExitAction,
    executed: ExecutedAction[],
    alerts: Alert[],
    now: number
  ): Promise<void> {
    if (!st.positions.includes(p)) return; // already closed this cycle
    const cfg = this.d.cfg;
    const ex = this.d.executors[p.sourceId];
    if (!ex) {
      alerts.push({ level: "critical", text: `no executor for ${p.oppId} — cannot exit (${a.reason})`, dedupeKey: `${p.oppId}|noexec` });
      return;
    }
    const r = await safe(() => ex.exit(p, a.fraction, opp));
    executed.push({ action: a, ok: r.ok, detail: r.detail });
    if (!r.ok) {
      alerts.push({ level: "critical", text: `exit FAILED ${p.oppId} (${a.reason}): ${r.detail ?? ""} — latched, retrying every cycle` });
      this.d.store.save(st);
      return;
    }
    const bucket = assetKey(positionFundingAsset(p));
    creditIdle(st, bucket, r.amountUsd ?? p.equityUsd * Math.min(1, a.fraction));
    p.equityUsd *= 1 - Math.min(1, a.fraction);
    p.lastActionAtMs = now;
    if (a.fraction >= 1) {
      st.positions = st.positions.filter((x) => x !== p);
      // Adapters claim + sell on a full exit; this approximates it for the books.
      for (const rw of Object.values(p.rewards)) creditIdle(st, bucket, rw.heldUsd + rw.unclaimedUsd * cfg.rewards.default_realizable);
      const hours = a.urgent || p.forcedExit?.urgent ? cfg.caps.urgent_reentry_cooldown_hours : cfg.caps.reentry_cooldown_hours;
      st.cooldownUntil[p.oppId] = now + hours * HOUR;
      this.d.store.save(st);
      return;
    }
    this.d.store.save(st);
    // A trim that leaves dust: close the rest for real instead of pretending it is cash.
    if (p.equityUsd < cfg.caps.min_position_usd * 0.5) {
      const rest: ExitAction = { type: "exit", oppId: p.oppId, fraction: 1, urgent: a.urgent, reason: `dust after trim (${a.reason})` };
      p.forcedExit ??= { reason: rest.reason, urgent: a.urgent, sinceMs: now };
      await this.execExit(st, p, opp, rest, executed, alerts, now);
    }
  }

  private async execReward(st: RouterState, a: Action, executed: ExecutedAction[], alerts: Alert[], now: number) {
    if (a.type === "hedge") {
      const holder = st.positions.find((p) => p.rewards[a.token]);
      const exId = holder?.sourceId ?? st.hedgeExecutor[a.token];
      const ex = exId ? this.d.executors[exId] : undefined;
      if (!ex) {
        if ((st.hedges[a.token] ?? 0) > 0)
          alerts.push({ level: "critical", text: `cannot adjust ${a.token} hedge: no executor`, dedupeKey: `hedge|${a.token}` });
        return;
      }
      const r = await safe(() => ex.hedge(a.token, a.targetShortUsd));
      executed.push({ action: a, ok: r.ok, detail: r.detail });
      if (!r.ok) return void alerts.push({ level: "warn", text: `hedge FAILED ${a.token}: ${r.detail ?? ""}` });
      if (a.targetShortUsd > 0) {
        st.hedges[a.token] = a.targetShortUsd;
        st.hedgeExecutor[a.token] = exId!;
      } else {
        delete st.hedges[a.token];
        delete st.hedgeExecutor[a.token];
      }
      // attribute the hedge to positions pro-rata to their exposure
      const holders = st.positions.filter((p) => p.rewards[a.token]);
      const tot = holders.reduce((s, p) => s + p.rewards[a.token]!.unclaimedUsd + p.rewards[a.token]!.heldUsd, 0);
      for (const p of holders) {
        const r0 = p.rewards[a.token]!;
        r0.hedgedUsd = tot > 0 ? (a.targetShortUsd * (r0.unclaimedUsd + r0.heldUsd)) / tot : 0;
      }
      this.d.store.save(st);
      return;
    }
    if (a.type !== "claim" && a.type !== "sell") return;
    const p = st.positions.find((x) => x.oppId === a.oppId);
    if (!p) return;
    const ex = this.d.executors[p.sourceId];
    const rs = p.rewards[a.token];
    if (!ex || !rs) return;
    if (a.type === "claim") {
      const r = await safe(() => ex.claim(p, a.token, a.amountUsd));
      executed.push({ action: a, ok: r.ok, detail: r.detail });
      if (!r.ok) return void alerts.push({ level: "warn", text: `claim FAILED ${a.oppId} ${a.token}: ${r.detail ?? ""}` });
      const got = r.amountUsd ?? a.amountUsd;
      rs.unclaimedUsd = Math.max(0, rs.unclaimedUsd - a.amountUsd);
      rs.heldUsd += got;
      rs.lastClaimAtMs = now;
    } else {
      const amt = Math.min(a.amountUsd, rs.heldUsd);
      if (amt <= 0) return;
      const r = await safe(() => ex.sell(p, a.token, amt));
      executed.push({ action: a, ok: r.ok, detail: r.detail });
      if (!r.ok) return void alerts.push({ level: "warn", text: `sell FAILED ${a.token}: ${r.detail ?? ""}` });
      rs.heldUsd -= amt;
      creditIdle(st, assetKey(positionFundingAsset(p)), r.amountUsd ?? amt);
      if (a.reason !== "sell on claim" && amt >= this.d.cfg.rewards.default_token.claim_min_usd)
        alerts.push({ level: "warn", text: `SELL ${a.token} $${Math.round(amt)}: ${a.reason}` });
    }
    this.d.store.save(st);
  }

  /** Paper mode only: let time pass using the current valuations. */
  private accrue(
    st: RouterState,
    opps: Map<string, Opportunity>,
    tokens: Record<string, TokenProfile>,
    prevPrices: Record<string, number>,
    dtMs: number,
    now: number
  ) {
    const yr = dtMs / YEAR_MS;
    const vctx = { cfg: this.d.cfg, nowMs: now, tokens };
    for (const p of st.positions) {
      // mark reward balances to market
      for (const [t, r] of Object.entries(p.rewards)) {
        const prev = prevPrices[t];
        const cur = tokens[t]?.priceUsd;
        if (prev && cur && prev > 0) {
          const k = cur / prev;
          r.unclaimedUsd *= k;
          r.heldUsd *= k;
        }
      }
      const opp = opps.get(p.oppId);
      if (!opp) continue;
      const v = valueAt(opp, p.equityUsd, vctx, { holding: true, noTimeWeight: true });
      let baseApr = -opp.costs.ongoingApr;
      for (const s of v.streams) {
        if (s.kind === "points") continue;
        if (s.kind === "reward") {
          const tok = opp.streams.find((x) => x.label === s.label)?.rewardToken ?? "?";
          const alive = s.timeWeight > 0 ? 1 : 0;
          const r = (p.rewards[tok] ??= { unclaimedUsd: 0, heldUsd: 0, hedgedUsd: 0, lastClaimAtMs: now });
          r.unclaimedUsd += p.equityUsd * s.rawApr * yr * alive;
        } else {
          baseApr += s.rawApr;
        }
      }
      p.equityUsd *= 1 + baseApr * yr;
    }
  }

  handleCommand(c: Command): string {
    const st = this.d.store.load();
    let reply: string;
    switch (c.cmd) {
      case "/pause":
        st.paused = true;
        reply = "paused: no new entries (exits still run)";
        break;
      case "/resume":
        st.paused = false;
        st.killed = false;
        // Re-arm the kill switch from here: otherwise the old peak in the window
        // re-triggers it on the very next cycle.
        st.history.equity = [];
        st.killPending = 0;
        reply = "resumed (kill-switch window reset)";
        break;
      case "/transfer": {
        const [id, outcome, usdArg] = c.args;
        const r = resolveTransfer(st, id ?? "", outcome ?? "", usdArg);
        if (r.ok) this.d.store.journal({ t: this.now(), type: "transfer_resolved", ...r.event });
        reply = r.text;
        break;
      }
      case "/exit": {
        const id = c.args[0];
        if (!id || !st.positions.some((p) => p.oppId === id)) reply = `unknown position ${id ?? ""}`;
        else {
          st.manualExit.push(id);
          reply = `will exit ${id} next cycle (retried until it succeeds)`;
        }
        break;
      }
      case "/exitall":
        st.manualExit.push(...st.positions.map((p) => p.oppId));
        st.paused = true;
        reply = `exiting ${st.positions.length} positions next cycle; paused`;
        break;
      case "/status":
      default:
        reply = statusText(st);
    }
    this.d.store.save(st);
    return reply;
  }
}

export type TransferOutcome = "arrived" | "failed" | "refunded";

/**
 * Operator resolution of a transfer the router cannot settle by itself (stuck,
 * send outcome unknown, adapter lost track):
 *   arrived  [usd]  money is at the final destination: credit that bucket
 *                   (default: what is in flight minus the remaining hops' fees)
 *   refunded [usd]  money is back where the current hop started: credit that
 *                   bucket (default: what is in flight)
 *   failed          money is gone: nothing credited
 * The transfer leaves the books and the kill-switch equity window is reset
 * (the books jump by whatever was wrong). Money the live wallet read already
 * shows (wallet-seen) is not credited twice.
 */
export function resolveTransfer(
  st: RouterState,
  id: string,
  outcome: string,
  usdArg?: string
): { ok: boolean; text: string; event?: Record<string, unknown> } {
  const usage = "usage: /transfer <id> arrived|failed|refunded [usd]";
  const t = st.transfers.find((x) => x.id === id);
  if (!t) return { ok: false, text: `unknown transfer ${id || "(none)"}; ${usage}` };
  if (outcome !== "arrived" && outcome !== "failed" && outcome !== "refunded") return { ok: false, text: usage };
  let usd: number | undefined;
  if (usdArg !== undefined) {
    usd = Number(usdArg);
    if (!(Number.isFinite(usd) && usd >= 0)) return { ok: false, text: `invalid usd "${usdArg}"; ${usage}` };
  }
  const hop = t.path[t.hop] ?? t.path[t.path.length - 1]!;
  const input = t.receivedUsd ?? t.amountUsd;
  const lastHop = t.path[t.path.length - 1]!;
  const seenKey = t.walletSeenAtMs !== undefined ? assetKey(hop.to) : undefined;
  let credited = 0;
  let bucket: string | undefined;
  if (outcome === "arrived") {
    bucket = assetKey(lastHop.to);
    const fees = t.path.slice(t.hop).reduce((a, r) => a + routeCostUsd(r, input), 0);
    credited = usd ?? Math.max(0, input - fees);
    if (seenKey === bucket) credited = 0; // the wallet read already holds it
    else if (seenKey) debitIdle(st, seenKey, t.walletSeenUsd ?? 0); // it left the hub
  } else if (outcome === "refunded") {
    bucket = assetKey(hop.from);
    credited = usd ?? input;
    if (seenKey) debitIdle(st, seenKey, t.walletSeenUsd ?? 0);
  } else if (seenKey) debitIdle(st, seenKey, t.walletSeenUsd ?? 0);
  if (bucket && credited > 0) creditIdle(st, bucket, credited);
  st.transfers = st.transfers.filter((x) => x !== t);
  st.history.equity = []; // the books jump: re-arm the kill-switch window from here
  st.killPending = 0;
  const event = { id: t.id, outcome, creditedUsd: credited, bucket, amountUsd: t.amountUsd, hop: t.hop };
  return {
    ok: true,
    event,
    text: `transfer ${t.id} resolved as ${outcome}${bucket ? `: $${Math.round(credited)} credited to ${bucket}` : ": nothing credited"} (kill-switch window reset)`,
  };
}

function urgency(actions: Action[]): number {
  return actions.some((a) => a.type === "exit" && a.urgent) ? 2 : actions.some((a) => a.type === "exit") ? 1 : 0;
}

export function upsertPosition(st: RouterState, opp: Opportunity, deployedUsd: number, now: number) {
  const p = st.positions.find((x) => x.oppId === opp.id);
  if (p) {
    p.equityUsd += deployedUsd;
    p.legs = opp.legs;
    p.fundingAsset ??= fundingTarget(opp);
    p.lastActionAtMs = now;
    for (const s of opp.streams)
      if (s.kind === "reward" && s.rewardToken && !p.rewards[s.rewardToken])
        p.rewards[s.rewardToken] = { unclaimedUsd: 0, heldUsd: 0, hedgedUsd: 0, lastClaimAtMs: now };
    return;
  }
  const rewards: Position["rewards"] = {};
  for (const s of opp.streams)
    if (s.kind === "reward" && s.rewardToken)
      rewards[s.rewardToken] = { unclaimedUsd: 0, heldUsd: 0, hedgedUsd: 0, lastClaimAtMs: now };
  st.positions.push({
    oppId: opp.id,
    sourceId: opp.sourceId,
    kind: opp.kind,
    primaryVenue: opp.primaryVenue,
    chain: opp.chain,
    legs: opp.legs,
    speculative: opp.speculative ?? false,
    equityUsd: deployedUsd,
    openedAtMs: now,
    lastActionAtMs: now,
    rewards,
    exitProbe: { lastOkAtMs: null, consecutiveFailures: 0 },
    pending: {},
    pendingSince: {},
    blindCycles: 0,
    fundingAsset: fundingTarget(opp),
  });
}

/** `cooldownUntil` keys for routes paused after a failure (opportunity ids never start with it). */
export const ROUTE_COOLDOWN_PREFIX = "route:";

export function pausedRoutes(st: RouterState, now: number): string[] {
  return Object.entries(st.cooldownUntil)
    .filter(([k, until]) => k.startsWith(ROUTE_COOLDOWN_PREFIX) && until > now)
    .map(([k]) => k.slice(ROUTE_COOLDOWN_PREFIX.length));
}

/** Expected USD/year of what the book holds (holding net APR; blind positions count 0). */
export function bookYieldPerYear(positions: Position[], opps: Map<string, Opportunity>, ctx: DecisionContext): number {
  let s = 0;
  for (const p of positions) {
    const o = opps.get(p.oppId);
    if (!o || p.equityUsd <= 0) continue;
    const v = valueAt(o, p.equityUsd, ctx, { holding: true }).netApr * p.equityUsd;
    if (Number.isFinite(v)) s += v;
  }
  return s;
}

export function statusText(st: RouterState): string {
  const lines = [
    `${st.paused ? "PAUSED" : "running"}${st.killed ? " (KILLED)" : ""} | idle $${Math.round(st.idleUsd)} | ${st.positions.length} positions`,
  ];
  if (bucketMode(st))
    lines.push(`  idle: ${Object.entries(st.idle).map(([k, v]) => `${k} $${Math.round(v)}`).join(" | ")}`);
  for (const t of st.transfers)
    lines.push(`  ⇄ ${t.id} ${t.state} hop ${t.hop + 1}/${t.path.length} $${Math.round(t.amountUsd)} ${routeName(t)}${t.forOppId ? ` for ${t.forOppId}` : ""}`);
  for (const p of st.positions) {
    const rw = Object.entries(p.rewards)
      .map(([t, r]) => `${t}:${Math.round(r.unclaimedUsd + r.heldUsd)}`)
      .join(" ");
    lines.push(`- ${p.oppId} $${Math.round(p.equityUsd)}${p.forcedExit ? ` EXITING(${p.forcedExit.reason})` : ""} ${rw}`);
  }
  return lines.join("\n");
}
