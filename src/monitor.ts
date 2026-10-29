import { planAllocation } from "./allocator.js";
import type { RouterConfig } from "./config.js";
import type { Executor } from "./executor.js";
import { computeExposure } from "./exposure.js";
import type { DecisionContext } from "./gates/common.js";
import { decideExit } from "./gates/exit.js";
import type { Notifier, Command } from "./notify.js";
import { planRewards } from "./rewards.js";
import {
  derivedFlags,
  equityDrawdown,
  historyKeepMs,
  recordEquity,
  recordOpp,
  recordTokenPrice,
} from "./signals.js";
import type { RouterState, Store } from "./store.js";
import type { Source } from "./sources/types.js";
import type { Action, AlertLevel, Opportunity, Position, TokenProfile } from "./types.js";
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
  /** Status alerts are deduped; action alerts (ENTER/EXIT/failures) never are. */
  dedupe?: boolean;
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

export class Router {
  private readonly now: () => number;
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

    // --- token prices -------------------------------------------------------
    const tokens = await this.d.tokens();
    const prevPrices: Record<string, number> = {};
    for (const [t, arr] of Object.entries(st.history.tokenPrices)) {
      const last = arr[arr.length - 1];
      if (last) prevPrices[t] = last.p;
    }
    for (const [t, p] of Object.entries(tokens))
      if (p.priceUsd !== undefined) recordTokenPrice(st.history, t, p.priceUsd, now, keep);

    // --- observe --------------------------------------------------------------
    const myEquityByOpp: Record<string, number> = {};
    for (const p of st.positions) myEquityByOpp[p.oppId] = p.equityUsd;
    const opps = new Map<string, Opportunity>();
    const failedSources = new Set<string>();
    const results = await Promise.allSettled(this.d.sources.map((s) => s.fetch({ cfg, nowMs: now, myEquityByOpp })));
    results.forEach((r, i) => {
      const src = this.d.sources[i]!;
      if (r.status === "rejected") {
        failedSources.add(src.id);
        sourceErrors.push(`${src.id}: ${(r.reason as Error)?.message ?? String(r.reason)}`);
        return;
      }
      for (const o of r.value) {
        if (!this.d.executors[o.sourceId]) o.discoveryOnly = true;
        opps.set(o.id, o);
      }
    });
    for (const e of sourceErrors) alerts.push({ level: "warn", text: `source error ${e}`, dedupe: true });

    for (const p of st.positions) p.blindCycles = opps.has(p.oppId) ? 0 : p.blindCycles + 1;

    // --- paper accrual ----------------------------------------------------------
    if (this.d.paperAccrual && st.lastCycleAtMs !== null) {
      this.accrue(st, opps, tokens, prevPrices, now - st.lastCycleAtMs, now);
    }
    if (this.d.idleUsd) st.idleUsd = await this.d.idleUsd();

    const totalEquity = () =>
      st.idleUsd +
      st.positions.reduce(
        (a, p) => a + p.equityUsd + Object.values(p.rewards).reduce((b, r) => b + r.unclaimedUsd + r.heldUsd, 0),
        0
      );
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
    });

    // --- derived flags (compare with history BEFORE recording this cycle) ---------
    const derived = new Map<string, ReturnType<typeof derivedFlags>>();
    for (const o of opps.values()) derived.set(o.id, derivedFlags(o, st.history, cfg, now));
    for (const o of opps.values()) recordOpp(st.history, o, now, keep);

    // --- kill switch --------------------------------------------------------------
    const dd = equityDrawdown(st.history, cfg, now);
    if (dd >= cfg.portfolio.kill_drawdown_frac && !st.killed) {
      st.killed = true;
      st.paused = true;
      alerts.push({
        level: "critical",
        text: `KILL SWITCH: equity -${(dd * 100).toFixed(2)}% within ${cfg.portfolio.kill_window_hours}h — exiting everything, router paused (/resume to re-arm)`,
      });
      for (const p of [...st.positions])
        await this.execExit(st, p, opps.get(p.oppId), { type: "exit", oppId: p.oppId, fraction: 1, urgent: true, reason: "kill switch" }, executed, alerts, now);
    }

    // --- manual exits (telegram) ---------------------------------------------------
    for (const id of st.manualExit) {
      const p = st.positions.find((x) => x.oppId === id);
      if (p) await this.execExit(st, p, opps.get(id), { type: "exit", oppId: id, fraction: 1, urgent: true, reason: "manual /exit" }, executed, alerts, now);
    }
    st.manualExit = [];

    // --- exits: urgent first ----------------------------------------------------
    const decisions = st.positions.map((p) => ({ p, d: decideExit(p, opps.get(p.oppId), derived.get(p.oppId) ?? [], ctx()) }));
    decisions.sort((a, b) => urgency(b.d.actions) - urgency(a.d.actions));
    for (const { p, d } of decisions) {
      p.pending = d.pending;
      for (const a of d.actions) {
        if (a.type === "alert") alerts.push({ level: a.level, text: a.message, dedupe: a.dedupe });
        else if (a.type === "exit") await this.execExit(st, p, opps.get(p.oppId), a, executed, alerts, now);
        else if (a.type === "rebalance") {
          const opp = opps.get(p.oppId);
          const ex = this.d.executors[p.sourceId];
          if (!opp || !ex) continue;
          const r = await ex.rebalance(p, opp);
          executed.push({ action: a, ok: r.ok, detail: r.detail });
          if (!r.ok) alerts.push({ level: "critical", text: `rebalance FAILED ${p.oppId}: ${r.detail ?? ""}` });
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
        alerts.push({ level: "warn", text: `${p.oppId}: exit simulation failed (${p.exitProbe.consecutiveFailures}x)`, dedupe: true });
      }
    }

    // --- rewards -------------------------------------------------------------------
    for (const a of planRewards(ctx())) await this.execReward(st, a, executed, alerts, now);

    // --- allocation ------------------------------------------------------------------
    // After an urgent exit the market may be in contagion mode: let one cycle pass.
    const urgentExitThisCycle = executed.some((x) => x.ok && x.action.type === "exit" && x.action.urgent);
    if (urgentExitThisCycle && !st.paused)
      alerts.push({ level: "info", text: "allocation skipped this cycle after an urgent exit" });
    if (!st.paused && !urgentExitThisCycle) {
      const plan = planAllocation([...opps.values()], ctx());
      for (const e of plan.entries) {
        const opp = opps.get(e.oppId)!;
        const ex = this.d.executors[opp.sourceId];
        if (!ex) continue;
        const r = await ex.enter(opp, e.deltaUsd);
        executed.push({ action: e, ok: r.ok, detail: r.detail });
        if (!r.ok) {
          alerts.push({ level: "warn", text: `enter FAILED ${e.oppId}: ${r.detail ?? ""}` });
          continue;
        }
        const deployed = r.amountUsd ?? e.deltaUsd;
        st.idleUsd -= e.deltaUsd;
        upsertPosition(st, opp, deployed, now);
        alerts.push({
          level: "info",
          text: `ENTER ${e.oppId} +$${Math.round(e.deltaUsd)} net ${(e.netApr * 100).toFixed(2)}% (marginal ${(e.marginalApr * 100).toFixed(2)}%)`,
        });
      }
    }

    st.lastCycleAtMs = now;
    this.d.store.save(st);
    for (const x of executed) this.d.store.journal({ t: now, ...x.action, ok: x.ok, detail: x.detail });
    const repeatMs = cfg.portfolio.alert_repeat_hours * HOUR;
    for (const a of alerts) {
      if (a.dedupe) {
        const key = `${a.level}|${a.text.replace(/[-+$%.,\d]+/g, "#")}`;
        const last = st.alertSentAt[key];
        if (last !== undefined && now - last < repeatMs) continue;
        st.alertSentAt[key] = now;
      }
      await this.d.notifier.send(a.level, a.text);
    }
    for (const [k, t] of Object.entries(st.alertSentAt)) if (now - t > repeatMs * 4) delete st.alertSentAt[k];
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

  private async execExit(
    st: RouterState,
    p: Position,
    opp: Opportunity | undefined,
    a: Extract<Action, { type: "exit" }>,
    executed: ExecutedAction[],
    alerts: Alert[],
    now: number
  ) {
    if (!st.positions.includes(p)) return; // already closed this cycle
    const ex = this.d.executors[p.sourceId];
    if (!ex) {
      alerts.push({ level: "critical", text: `no executor for ${p.oppId} — cannot exit (${a.reason})` });
      return;
    }
    const r = await ex.exit(p, a.fraction, opp).catch((e: Error) => ({ ok: false, detail: e.message, amountUsd: 0 }));
    executed.push({ action: a, ok: r.ok, detail: r.detail });
    if (!r.ok) {
      alerts.push({ level: "critical", text: `exit FAILED ${p.oppId} (${a.reason}): ${r.detail ?? ""} — will retry next cycle` });
      return;
    }
    st.idleUsd += r.amountUsd ?? p.equityUsd * a.fraction;
    p.equityUsd *= 1 - Math.min(1, a.fraction);
    p.lastActionAtMs = now;
    const cfg = this.d.cfg;
    if (a.fraction >= 1 || p.equityUsd < cfg.caps.min_position_usd * 0.5) {
      // leftover dust is treated as closed; rewards stay claimable through the history
      st.positions = st.positions.filter((x) => x !== p);
      st.idleUsd += p.equityUsd;
      // Adapters claim + sell on a full exit; this approximates it for the books.
      for (const r of Object.values(p.rewards))
        st.idleUsd += r.heldUsd + r.unclaimedUsd * cfg.rewards.default_realizable;
      const hours = a.urgent ? cfg.caps.urgent_reentry_cooldown_hours : cfg.caps.reentry_cooldown_hours;
      st.cooldownUntil[p.oppId] = now + hours * HOUR;
    }
  }

  private async execReward(
    st: RouterState,
    a: Action,
    executed: ExecutedAction[],
    alerts: Alert[],
    now: number
  ) {
    if (a.type === "hedge") {
      const anyPos = st.positions.find((p) => p.rewards[a.token]);
      const ex = anyPos ? this.d.executors[anyPos.sourceId] : undefined;
      if (!ex) return;
      const r = await ex.hedge(a.token, a.targetShortUsd);
      executed.push({ action: a, ok: r.ok, detail: r.detail });
      if (!r.ok) return void alerts.push({ level: "warn", text: `hedge FAILED ${a.token}` });
      st.hedges[a.token] = a.targetShortUsd;
      // attribute the hedge to positions pro-rata to their exposure
      const holders = st.positions.filter((p) => p.rewards[a.token]);
      const tot = holders.reduce((s, p) => s + p.rewards[a.token]!.unclaimedUsd + p.rewards[a.token]!.heldUsd, 0);
      for (const p of holders) {
        const r0 = p.rewards[a.token]!;
        r0.hedgedUsd = tot > 0 ? (a.targetShortUsd * (r0.unclaimedUsd + r0.heldUsd)) / tot : 0;
      }
      return;
    }
    if (a.type !== "claim" && a.type !== "sell") return;
    const p = st.positions.find((x) => x.oppId === a.oppId);
    if (!p) return;
    const ex = this.d.executors[p.sourceId];
    const rs = p.rewards[a.token];
    if (!ex || !rs) return;
    if (a.type === "claim") {
      const r = await ex.claim(p, a.token, a.amountUsd);
      executed.push({ action: a, ok: r.ok, detail: r.detail });
      if (!r.ok) return void alerts.push({ level: "warn", text: `claim FAILED ${a.oppId} ${a.token}` });
      const got = r.amountUsd ?? a.amountUsd;
      rs.unclaimedUsd = Math.max(0, rs.unclaimedUsd - a.amountUsd);
      rs.heldUsd += got;
      rs.lastClaimAtMs = now;
    } else {
      const amt = Math.min(a.amountUsd, rs.heldUsd);
      if (amt <= 0) return;
      const r = await ex.sell(p, a.token, amt);
      executed.push({ action: a, ok: r.ok, detail: r.detail });
      if (!r.ok) return void alerts.push({ level: "warn", text: `sell FAILED ${a.token}` });
      rs.heldUsd -= amt;
      st.idleUsd += r.amountUsd ?? amt;
      if (a.reason !== "sell on claim" && amt >= this.d.cfg.rewards.default_token.claim_min_usd)
        alerts.push({ level: "warn", text: `SELL ${a.token} $${Math.round(amt)}: ${a.reason}` });
    }
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
      const v = valueAt(opp, p.equityUsd, vctx, { holding: true });
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
        reply = "resumed";
        break;
      case "/exit": {
        const id = c.args[0];
        if (!id || !st.positions.some((p) => p.oppId === id)) reply = `unknown position ${id ?? ""}`;
        else {
          st.manualExit.push(id);
          reply = `will exit ${id} next cycle`;
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
    lines.push(`- ${p.oppId} $${Math.round(p.equityUsd)} ${rw}`);
  }
  return lines.join("\n");
}
