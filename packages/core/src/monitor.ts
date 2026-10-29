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
import type { RouterState, Store } from "./store.js";
import type { Action, AlertLevel, Opportunity, Position, TokenProfile } from "./types.js";
import { validateOpportunity } from "./validate.js";
import { valueAt } from "./valuation.js";

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
  /** Live mode hook: authoritative idle USD (wallet balances). */
  idleUsd?: () => Promise<number>;
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
  opportunities: number;
  sourceErrors: string[];
  executed: ExecutedAction[];
  killed: boolean;
}

type ExitAction = Extract<Action, { type: "exit" }>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    let opps = new Map<string, Opportunity>();

    const totalEquity = () =>
      st.idleUsd +
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
      if (this.d.idleUsd) {
        try {
          const v = await this.d.idleUsd();
          if (Number.isFinite(v)) st.idleUsd = v;
        } catch (e) {
          alerts.push({ level: "warn", text: `idle balance read failed (${errMsg(e)}); keeping last value`, dedupeKey: "idle|read" });
        }
      }
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

      // --- kill switch (latched through forcedExit) -----------------------------------
      const dd = equityDrawdown(st.history, cfg, now);
      if (dd >= cfg.portfolio.kill_drawdown_frac && !st.killed) {
        st.killed = true;
        st.paused = true;
        alerts.push({
          level: "critical",
          text: `KILL SWITCH: equity -${(dd * 100).toFixed(2)}% within ${cfg.portfolio.kill_window_hours}h — exiting everything, router paused (/resume to re-arm)`,
        });
        for (const p of st.positions) p.forcedExit ??= { reason: "kill switch", urgent: true, sinceMs: now };
      }

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
            if (a.fraction >= 1) p.forcedExit ??= { reason: a.reason, urgent: a.urgent, sinceMs: now };
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
        const ok = await ex.simulateExit(p, opps.get(p.oppId)).catch(() => false);
        if (ok) p.exitProbe = { lastOkAtMs: now, consecutiveFailures: 0 };
        else {
          p.exitProbe.consecutiveFailures += 1;
          alerts.push({
            level: "warn",
            text: `${p.oppId}: exit simulation failed (${p.exitProbe.consecutiveFailures}x)`,
            dedupeKey: `${p.oppId}|probe`,
          });
        }
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
        const plan = planAllocation([...opps.values()], ctx());
        for (const e of plan.entries) {
          const opp = opps.get(e.oppId)!;
          const ex = this.d.executors[opp.sourceId];
          if (!ex) continue;
          const r = await safe(() => ex.enter(opp, e.deltaUsd));
          executed.push({ action: e, ok: r.ok, detail: r.detail });
          if (!r.ok) {
            alerts.push({ level: "warn", text: `enter FAILED ${e.oppId}: ${r.detail ?? ""}` });
            continue;
          }
          st.idleUsd -= r.spentUsd ?? e.deltaUsd;
          upsertPosition(st, opp, r.amountUsd ?? e.deltaUsd, now);
          this.d.store.save(st);
          alerts.push({
            level: "info",
            text: `ENTER ${e.oppId} +$${Math.round(e.deltaUsd)} net ${(e.netApr * 100).toFixed(2)}% (marginal ${(e.marginalApr * 100).toFixed(2)}%)`,
          });
        }
      }
    } finally {
      st.lastCycleAtMs = now;
      this.d.store.save(st);
      for (const x of executed) this.d.store.journal({ t: now, ...x.action, ok: x.ok, detail: x.detail });
    }

    await this.sendAlerts(st, alerts, now);
    this.d.store.save(st);

    return {
      nowMs: now,
      totalEquityUsd: totalEquity(),
      idleUsd: st.idleUsd,
      opportunities: opps.size,
      sourceErrors,
      executed,
      killed: st.killed,
    };
  }

  /** Fetch every source in isolation, validate what comes back. */
  private async observe(st: RouterState, now: number, alerts: Alert[], sourceErrors: string[]): Promise<Map<string, Opportunity>> {
    const { cfg } = this.d;
    const myEquityByOpp: Record<string, number> = {};
    for (const p of st.positions) myEquityByOpp[p.oppId] = p.equityUsd;
    const opps = new Map<string, Opportunity>();
    const results = await Promise.allSettled(this.d.sources.map((s) => s.fetch({ cfg, nowMs: now, myEquityByOpp })));
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
    st.idleUsd += r.amountUsd ?? p.equityUsd * Math.min(1, a.fraction);
    p.equityUsd *= 1 - Math.min(1, a.fraction);
    p.lastActionAtMs = now;
    if (a.fraction >= 1) {
      st.positions = st.positions.filter((x) => x !== p);
      // Adapters claim + sell on a full exit; this approximates it for the books.
      for (const rw of Object.values(p.rewards)) st.idleUsd += rw.heldUsd + rw.unclaimedUsd * cfg.rewards.default_realizable;
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
      st.idleUsd += r.amountUsd ?? amt;
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
        reply = "resumed (kill-switch window reset)";
        break;
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

function urgency(actions: Action[]): number {
  return actions.some((a) => a.type === "exit" && a.urgent) ? 2 : actions.some((a) => a.type === "exit") ? 1 : 0;
}

export function upsertPosition(st: RouterState, opp: Opportunity, deployedUsd: number, now: number) {
  const p = st.positions.find((x) => x.oppId === opp.id);
  if (p) {
    p.equityUsd += deployedUsd;
    p.legs = opp.legs;
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
  });
}

export function statusText(st: RouterState): string {
  const lines = [
    `${st.paused ? "PAUSED" : "running"}${st.killed ? " (KILLED)" : ""} | idle $${Math.round(st.idleUsd)} | ${st.positions.length} positions`,
  ];
  for (const p of st.positions) {
    const rw = Object.entries(p.rewards)
      .map(([t, r]) => `${t}:${Math.round(r.unclaimedUsd + r.heldUsd)}`)
      .join(" ");
    lines.push(`- ${p.oppId} $${Math.round(p.equityUsd)}${p.forcedExit ? ` EXITING(${p.forcedExit.reason})` : ""} ${rw}`);
  }
  return lines.join("\n");
}
